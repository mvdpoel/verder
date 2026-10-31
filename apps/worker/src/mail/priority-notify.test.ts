import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { notify, type NotifyFn, type NotifyInput } from "../notify/notify";
import { notifyForMail } from "./priority-notify";

// Runs as verder_worker, the role suggest.entry meets in production. Every test
// is a transaction that is ROLLED BACK: the shared dev database is never
// truncated, and raw_emails/notifications have no DELETE grant.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };

beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

const env = {
  senders: process.env.RELEVANT_SENDERS,
  own: process.env.MAIL_OWN_ADDRESSES,
  user: process.env.JMAP_USER,
};
beforeEach(() => {
  process.env.RELEVANT_SENDERS = "@verdergroep.nl,@verderbewindmidden.nl";
  process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
  delete process.env.JMAP_USER;
});
afterEach(() => {
  for (const [k, v] of [["RELEVANT_SENDERS", env.senders], ["MAIL_OWN_ADDRESSES", env.own],
    ["JMAP_USER", env.user]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

async function rawEmail(db: Db, over: { fromAddr: string; subject?: string; source?: string }) {
  const [row] = await db.insert(schema.rawEmails).values({
    gmailMessageId: `prio-notify-${crypto.randomUUID()}`, gmailThreadId: `t-${crypto.randomUUID()}`,
    fromAddr: over.fromAddr, toAddr: "martin@vanderpoel.pro",
    subject: over.subject ?? "Informatie over uw dossier", sentAt: new Date(),
    rawRfc822Sha256: "c".repeat(64), bodyText: "Beste Martin, ...",
    source: over.source ?? "gmail",
  }).returning();
  return row;
}

async function entrySuggestion(db: Db, rawEmailId: string,
  opts: { summary: string; status?: "pending" | "needs-manual" }) {
  await db.insert(schema.suggestions).values({
    kind: "log-entry", rawEmailId, status: opts.status ?? "pending",
    proposed: { direction: "inbound", summary: opts.summary, details: "", actionItems: [] },
  });
}

function recorder(): { fn: NotifyFn; calls: NotifyInput[] } {
  const calls: NotifyInput[] = [];
  const fn: NotifyFn = async (n) => {
    calls.push(n);
    return { notificationId: "x", duplicate: false, delivered: 1, failed: 0, skipped: 0 };
  };
  return { fn, calls };
}

describe("notifyForMail", () => {
  it("verder mail notifies time-sensitive with the summary", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "Demi Willemse <demi@verdergroep.nl>" });
      await entrySuggestion(db, e.id, { summary: "Verder vraagt je loonstroken van oktober" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({
        kind: "verder-mail", level: "time-sensitive", title: "Verder: Demi Willemse",
        body: "Verder vraagt je loonstroken van oktober", dedupKey: `mail:${e.id}`,
      });
    });
  });

  it("needs-manual falls back to the subject", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "demi@verdergroep.nl", subject: "Stukken aanleveren" });
      await entrySuggestion(db, e.id, { summary: "ignored", status: "needs-manual" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls[0]?.body).toBe("Stukken aanleveren");
    });
  });

  it("no suggestion at all falls back to the subject", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "demi@verdergroep.nl", subject: "Herinnering" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls[0]?.body).toBe("Herinnering");
    });
  });

  it("the newest log-entry suggestion wins", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "demi@verdergroep.nl" });
      await db.insert(schema.suggestions).values({ kind: "log-entry", rawEmailId: e.id,
        proposed: { summary: "oud" }, createdAt: new Date(Date.now() - 60_000) });
      await entrySuggestion(db, e.id, { summary: "nieuw" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls[0]?.body).toBe("nieuw");
    });
  });

  it("second run sends no second push", async () => {
    await isolated(async (db) => {
      // No live destination in this transaction, and no APNs key or VAPID
      // keys: the REAL notify() decides the dedup, and nothing can be sent.
      await db.update(schema.pushDevices).set({ revokedAt: new Date(), revokedReason: "test-isolation" });
      await db.update(schema.pushSubscriptions).set({ revoked: true });
      const results: Awaited<ReturnType<NotifyFn>>[] = [];
      const real: NotifyFn = async (n) => {
        const res = await notify({ db, apns: async () => null, webPush: () => null }, n);
        results.push(res);
        return res;
      };
      const e = await rawEmail(db, { fromAddr: "demi@verdergroep.nl" });
      await entrySuggestion(db, e.id, { summary: "Samenvatting" });
      await notifyForMail({ db, notify: real }, e.id);
      await notifyForMail({ db, notify: real }, e.id);
      expect(results.map((r) => r.duplicate)).toEqual([false, true]);
      const rows = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `mail:${e.id}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "verder-mail", level: "time-sensitive" });
    });
  });

  it("creditor mail notifies active, titled with the party name", async () => {
    await isolated(async (db) => {
      const addr = `incasso-${crypto.randomUUID()}@creditor.example`;
      const name = `Incasso Testfixture ${crypto.randomUUID()}`;
      const [party] = await db.insert(schema.parties).values({
        kind: "organization", name, email: addr.toUpperCase() }).returning();
      await db.insert(schema.debts).values({ creditorPartyId: party.id, creditorName: name });
      const e = await rawEmail(db, { fromAddr: `Incasso <${addr}>` });
      await entrySuggestion(db, e.id, { summary: "Aanmaning" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({ kind: "creditor-mail", level: "active", title: name,
        body: "Aanmaning", dedupKey: `mail:${e.id}`, link: "verder://inbox" });
    });
  });

  it("other relevant mail sends nothing", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "Stranger <someone@example.test>" });
      await entrySuggestion(db, e.id, { summary: "x" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls).toHaveLength(0);
    });
  });

  it("own outbound to verder sends nothing", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "Martin van der Poel <martin@vanderpoel.pro>" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls).toHaveLength(0);
    });
  });

  it("display-name spoof of a Verder address sends nothing", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: '"demi@verdergroep.nl" <attacker@evil.tld>' });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls).toHaveLength(0);
    });
  });

  it("a JMAP-source row is handled the same", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "team.opstart@verderbewindmidden.nl", source: "jmap" });
      await entrySuggestion(db, e.id, { summary: "Opstart vraagt stukken" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls[0]).toMatchObject({ kind: "verder-mail", level: "time-sensitive",
        title: "Verder: team.opstart@verderbewindmidden.nl", body: "Opstart vraagt stukken" });
    });
  });

  it("a Gmail-era whole header is parsed, never lower()-ed", async () => {
    await isolated(async (db) => {
      // Upper case ASCII folds; a KELVIN SIGN (U+212A) would fold to "k" under
      // a Unicode lower() and must NOT reach the Verder domain.
      const ok = await rawEmail(db, { fromAddr: '"Willemse, Demi" <Demi@VerderGroep.NL>' });
      const kelvin = await rawEmail(db, { fromAddr: "Demi <demi@verdergroep.nK>" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, ok.id);
      await notifyForMail({ db, notify: r.fn }, kelvin.id);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({ kind: "verder-mail", title: "Verder: Willemse, Demi" });
    });
  });

  it("mail push links to the inbox and carries collapse id mail:<rawEmailId>", async () => {
    await isolated(async (db) => {
      const e = await rawEmail(db, { fromAddr: "demi@verdergroep.nl" });
      const r = recorder();
      await notifyForMail({ db, notify: r.fn }, e.id);
      expect(r.calls[0]).toMatchObject({
        link: "verder://inbox", collapseId: `mail:${e.id}`, threadId: `mail:${e.id}`,
      });
    });
  });

  it("a missing raw email sends nothing", async () => {
    const r = recorder();
    await notifyForMail({ db: conn.db, notify: r.fn }, crypto.randomUUID());
    expect(r.calls).toHaveLength(0);
  });
});
