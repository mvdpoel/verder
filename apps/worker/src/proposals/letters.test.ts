import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import type { DocSource } from "@verder/db/doc-sources";
import { appRouter } from "@verder/api/src/root";
import { createContext } from "@verder/api/src/trpc";
import { notify, type NotifyFn, type NotifyInput } from "../notify/notify";
import type { RetrieveRefsFn } from "../retrieval-refs";
import type { ProposalContext } from "./context";
import { buildProposalPrompt } from "./draft-prompt";
import { proposalForLetter } from "./letters";
import { validateDraft } from "./validate-draft";

// Runs as verder_worker, the role suggest.docmeta meets in production. Every
// test is a transaction that is ROLLED BACK: the shared dev database is never
// truncated, and a fixture document can never grow pendingDocMeta's backlog.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
const vaultDir = mkdtempSync(join(tmpdir(), "proposal-letters-vault-"));
const retrieveRefs: RetrieveRefsFn = async () => [];

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

const uid = () => crypto.randomUUID();
const VERDER_TEXT = [
  "Verder Bewind Midden", "Postbus 123, 1300 AA Almere", "www.verdergroep.nl",
  "", "Geachte heer Van der Poel,", "Wij verzoeken u de loonstrook van oktober aan te leveren.",
].join("\n");

async function letter(db: Db, o: { text: string; source?: DocSource; title?: string }) {
  const [d] = await db.insert(schema.documents).values({
    sha256: (uid() + uid()).replaceAll("-", ""), title: o.title ?? `Brief ${uid()}.pdf`,
    mime: "application/pdf", sizeBytes: 10, source: o.source ?? "nas-scan",
    sourceRef: `letters-test-${uid()}`, receivedAt: new Date(),
  }).returning();
  await db.insert(schema.documentTexts).values({
    documentId: d.id, sha256: d.sha256, text: o.text, charCount: o.text.length, extractor: "none",
  });
  return d;
}

function recorder(): { fn: NotifyFn; calls: NotifyInput[] } {
  const calls: NotifyInput[] = [];
  const fn: NotifyFn = async (n) => {
    calls.push(n);
    return { notificationId: "x", duplicate: false, delivered: 1, failed: 0, skipped: 0 };
  };
  return { fn, calls };
}

const deps = (db: Db, n: NotifyFn) => ({ db, notify: n, retrieveRefs, vaultDir, buildPrompt: buildProposalPrompt });
const proposalsFor = (db: Db, documentId: string) =>
  db.select().from(schema.proposals).where(eq(schema.proposals.triggerDocumentId, documentId));

describe("proposalForLetter", () => {
  it("a verder letter notifies time-sensitive and creates one proposal", async () => {
    await isolated(async (db) => {
      // No live destination in this transaction and no APNs/VAPID keys: the
      // REAL notify() decides the dedup, and nothing can be sent.
      await db.update(schema.pushDevices).set({ revokedAt: new Date(), revokedReason: "test-isolation" });
      await db.update(schema.pushSubscriptions).set({ revoked: true });
      const results: Awaited<ReturnType<NotifyFn>>[] = [];
      const calls: NotifyInput[] = [];
      const real: NotifyFn = async (n) => {
        calls.push(n);
        const res = await notify({ db, apns: async () => null, webPush: () => null }, n);
        results.push(res);
        return res;
      };
      const d = await letter(db, { text: VERDER_TEXT, title: "Brief Verder loonstrook.pdf" });
      const a = await proposalForLetter(deps(db, real), d.id, VERDER_TEXT);
      const b = await proposalForLetter(deps(db, real), d.id, VERDER_TEXT);

      expect(calls[0]).toMatchObject({
        kind: "verder-mail", level: "time-sensitive", title: "Brief lijkt van Verder",
        body: "Brief Verder loonstrook.pdf", dedupKey: `letter:${d.id}`, collapseId: `letter:${d.id}`,
        link: "verder://inbox",
      });
      expect(results.map((r) => r.duplicate)).toEqual([false, true]);
      expect(await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `letter:${d.id}`))).toHaveLength(1);

      const rows = await proposalsFor(db, d.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "reply", status: "drafting", priority: "verder" });
      expect(a).toMatchObject({ sender: { kind: "verder" }, proposalId: rows[0].id, created: true });
      expect(b).toMatchObject({ proposalId: rows[0].id, created: false });
      // The prompt is stored at creation, as for mail: the host drafter only pipes it.
      expect(rows[0].prompt).toContain("www.verdergroep.nl");
    });
  });

  it("the push uses the effective title, so a rename is what Martin reads", async () => {
    await isolated(async (db) => {
      const d = await letter(db, { text: VERDER_TEXT, title: "scan0042.pdf" });
      await db.insert(schema.documentStatusChanges)
        .values({ documentId: d.id, status: "inbox", title: "Brief Verder — loonstrook oktober" });
      const r = recorder();
      await proposalForLetter(deps(db, r.fn), d.id, VERDER_TEXT);
      expect(r.calls[0]?.body).toBe("Brief Verder — loonstrook oktober");
    });
  });

  it("a creditor letter notifies active and guesses the creditor as party", async () => {
    await isolated(async (db) => {
      const name = `Incassobureau Testfixture ${uid()}`;
      const email = `incasso-${uid()}@letters.example`;
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name, email }).returning();
      await db.insert(schema.debts).values({ creditorName: name, creditorPartyId: party.id, claimedCents: 100 });
      // Recognised by its EMAIL: a creditor's name alone never counts (priority.ts).
      const text = `${name}\n${email}\nBetreft: openstaande vordering\nGeachte heer,`;
      const d = await letter(db, { text });
      const r = recorder();
      await proposalForLetter(deps(db, r.fn), d.id, text);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({
        kind: "creditor-mail", level: "active", title: `Brief lijkt van ${name}`,
        dedupKey: `letter:${d.id}`, collapseId: `letter:${d.id}`,
      });
      const [p] = await proposalsFor(db, d.id);
      expect(p).toMatchObject({
        priority: "creditor", partyId: party.id, senderGuess: { kind: "creditor", partyId: party.id },
      });
    });
  });

  it("a letter from nobody known does nothing", async () => {
    await isolated(async (db) => {
      const text = "Wij gaan verder met uw aanvraag. Met vriendelijke groet, de gemeente.";
      const d = await letter(db, { text });
      const r = recorder();
      expect(await proposalForLetter(deps(db, r.fn), d.id, text)).toMatchObject({ sender: null, created: false });
      expect(r.calls).toHaveLength(0);
      expect(await proposalsFor(db, d.id)).toHaveLength(0);
    });
  });

  it("a discarded scan does nothing", async () => {
    await isolated(async (db) => {
      const d = await letter(db, { text: VERDER_TEXT });
      await db.insert(schema.documentStatusChanges).values({ documentId: d.id, status: "discarded" });
      const r = recorder();
      await proposalForLetter(deps(db, r.fn), d.id, VERDER_TEXT);
      expect(r.calls).toHaveLength(0);
      expect(await proposalsFor(db, d.id)).toHaveLength(0);
    });
  });

  it("a purged scan does nothing", async () => {
    await isolated(async (db) => {
      const d = await letter(db, { text: VERDER_TEXT });
      const [u] = await db.insert(schema.users).values({ email: `letters-${uid()}@test.local`, name: "M" }).returning();
      await db.insert(schema.documentPurges)
        .values({ documentId: d.id, sha256: d.sha256, sizeBytes: d.sizeBytes, reason: "test", createdBy: u.id });
      const r = recorder();
      await proposalForLetter(deps(db, r.fn), d.id, VERDER_TEXT);
      expect(r.calls).toHaveLength(0);
      expect(await proposalsFor(db, d.id)).toHaveLength(0);
    });
  });

  it("a mail attachment is not treated as a letter", async () => {
    await isolated(async (db) => {
      // It already rode notifyForMail and its mail's proposal.
      const d = await letter(db, { text: VERDER_TEXT, source: "email-attachment" });
      const r = recorder();
      await proposalForLetter(deps(db, r.fn), d.id, VERDER_TEXT);
      expect(r.calls).toHaveLength(0);
      expect(await proposalsFor(db, d.id)).toHaveLength(0);
    });
  });

  it("phone scans, shares and uploads are letters too", async () => {
    await isolated(async (db) => {
      for (const source of ["phone-scan", "phone-share", "upload"] as const) {
        const d = await letter(db, { text: VERDER_TEXT, source });
        const r = recorder();
        await proposalForLetter(deps(db, r.fn), d.id, VERDER_TEXT);
        expect(r.calls).toHaveLength(1);
        expect(await proposalsFor(db, d.id)).toHaveLength(1);
      }
    });
  });

  it("no known address yields a question, not a reply", async () => {
    await isolated(async (db) => {
      // A Verder domain no party in the dev database lives under: the letter
      // reads as Verder's, and nobody is addressable.
      const domain = `verder-${uid().slice(0, 8)}.nl`;
      process.env.RELEVANT_SENDERS = `@${domain}`;
      const text = `Verder Bewind\nwww.${domain}\nGeachte heer, graag uw loonstrook.`;
      const d = await letter(db, { text });
      await proposalForLetter(deps(db, recorder().fn), d.id, text);
      const [p] = await proposalsFor(db, d.id);
      const ctx = p.context as ProposalContext;
      expect(ctx.addresses).toEqual([]);
      expect(p.prompt).toContain("There is no address you may write to");

      const base = { ask: "Loonstrook aanleveren", dueAt: null, missing: [], entrySummary: "Loonstrook gestuurd",
        task: null, reliedOn: [{ type: "document", id: d.id, why: "de brief" }] };
      const invented = validateDraft(JSON.stringify({ ...base, question: null,
        reply: { to: ["info@" + domain], cc: [], subject: "Loonstrook", body: "Hierbij.", attachmentDocumentIds: [] } }), ctx);
      expect(invented.ok).toBe(false);
      const question = validateDraft(JSON.stringify({ ...base, reply: null,
        question: { prompt: "Aan wie moet dit antwoord?", options: [
          { action: "create-task", title: "Adres van Verder opzoeken", dueAt: null, label: "Adres opzoeken" },
          { action: "none", label: "Niets doen" },
        ] } }), ctx);
      expect(question.ok).toBe(true);
    });
  });

  it("an unfiled verder letter proposal has party NULL and sender_guess stored", async () => {
    await isolated(async (db) => {
      const d = await letter(db, { text: VERDER_TEXT });
      await proposalForLetter(deps(db, recorder().fn), d.id, VERDER_TEXT);
      const [p] = await proposalsFor(db, d.id);
      expect(p).toMatchObject({
        partyId: null, threadKey: null, senderGuess: { kind: "verder" }, triggerRawEmailId: null,
      });
    });
  });

  it("senderUnconfirmed clears once the document is filed under a Verder party", async () => {
    await isolated(async (db) => {
      const addr = `opstart-${uid()}@verdergroep.nl`;
      const [verder] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Team Opstart Testfixture ${uid()}`, email: addr }).returning();
      const [u] = await db.insert(schema.users).values({ email: `letters-${uid()}@test.local`, name: "M" }).returning();
      const d = await letter(db, { text: VERDER_TEXT });
      await proposalForLetter(deps(db, recorder().fn), d.id, VERDER_TEXT);
      const [p] = await proposalsFor(db, d.id);
      expect((p.context as ProposalContext).addresses).toContain(addr);

      const c = appRouter.createCaller(createContext({ db, userId: u.id }));
      expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(true);
      await db.insert(schema.documentStatusChanges)
        .values({ documentId: d.id, status: "filed", partyId: verder.id });
      expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(false);
    });
  });
});
