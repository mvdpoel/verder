import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { storeFile } from "@verder/api/src/storage";
import type { RetrieveRefsFn } from "../retrieval-refs";
import { createProposal, proposalsForMail, supersedeOnOwnReply } from "./create";

// Runs as verder_worker, the role suggest.entry meets in production. Every test
// is a transaction that is ROLLED BACK: the shared dev database is never
// truncated.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
const vaultDir = mkdtempSync(join(tmpdir(), "proposal-create-vault-"));
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
const HOUR = 3_600_000;
const MARTIN = "Martin van der Poel <martin@vanderpoel.pro>";

async function mail(db: Db, o: {
  threadId: string; from: string; to?: string; messageId?: string; sentAt: Date; subject?: string;
}) {
  const messageId = o.messageId ?? `${uid()}@mail.example`;
  const to = o.to ?? "martin@vanderpoel.pro";
  const subject = o.subject ?? "Informatie over uw dossier";
  const raw = Buffer.from([
    `From: ${o.from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${messageId}>`,
    "", "Beste Martin, graag uw loonstroken.",
  ].join("\r\n"));
  const { sha256 } = await storeFile(vaultDir, raw);
  const [row] = await db.insert(schema.rawEmails).values({
    gmailMessageId: `create-${uid()}`, gmailThreadId: o.threadId, fromAddr: o.from, toAddr: to,
    subject, sentAt: o.sentAt, rawRfc822Sha256: sha256,
    bodyText: "Beste Martin, graag uw loonstroken.", source: "gmail", messageId,
    suggestQueuedAt: new Date(),
  }).returning();
  return row;
}

const verder = () => `Team Opstart <opstart-${uid()}@verdergroep.nl>`;
const deps = (db: Db) => ({ db, retrieveRefs, vaultDir });
const byId = async (db: Db, id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0];

describe("createProposal", () => {
  it("one proposal per trigger", async () => {
    await isolated(async (db) => {
      const m = await mail(db, { threadId: `t-${uid()}`, from: verder(), sentAt: new Date() });
      const a = await createProposal(deps(db), { rawEmailId: m.id }, "verder");
      const b = await createProposal(deps(db), { rawEmailId: m.id }, "verder");
      expect(a.created).toBe(true);
      expect(b).toEqual({ id: a.id, created: false });
      // And through the suggest.entry path, which is at-least-once.
      const c = await proposalsForMail(deps(db), m.id);
      expect(c).toMatchObject({ created: false, proposalId: a.id });
      const rows = await db.select().from(schema.proposals)
        .where(eq(schema.proposals.triggerRawEmailId, m.id));
      expect(rows).toHaveLength(1);
      const p = rows[0];
      expect(p).toMatchObject({
        kind: "reply", status: "drafting", priority: "verder",
        threadKey: `gmail:${m.gmailThreadId}`, senderGuess: null,
      });
      expect((p.context as { trigger: { id: string } }).trigger.id).toBe(m.id);
    });
  });

  it("stores the prompt the injected builder made", async () => {
    await isolated(async (db) => {
      const m = await mail(db, { threadId: `t-${uid()}`, from: verder(), sentAt: new Date() });
      const { id } = await createProposal(
        { ...deps(db), buildPrompt: (ctx, kind) => `${kind}:${ctx.trigger.id}` },
        { rawEmailId: m.id }, "verder");
      expect((await byId(db, id)).prompt).toBe(`reply:${m.id}`);
    });
  });

  it("newer mail in the thread supersedes the older pending proposal", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const m1 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 2 * HOUR) });
      const p1 = await createProposal(deps(db), { rawEmailId: m1.id }, "verder");
      await db.update(schema.proposals).set({ status: "pending" }).where(eq(schema.proposals.id, p1.id));
      // An APPROVED proposal is Martin's decision and is never taken back.
      const m0 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 3 * HOUR) });
      const p0 = await createProposal(deps(db), { rawEmailId: m0.id }, "verder");
      await db.update(schema.proposals).set({ status: "approved" }).where(eq(schema.proposals.id, p0.id));
      // Another thread is untouched.
      const other = await mail(db, { threadId: `t-${uid()}`, from: verder(), sentAt: new Date(now - 4 * HOUR) });
      const pOther = await createProposal(deps(db), { rawEmailId: other.id }, "verder");

      const m2 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - HOUR) });
      const p2 = await createProposal(deps(db), { rawEmailId: m2.id }, "verder");

      expect(await byId(db, p1.id)).toMatchObject({
        status: "superseded", error: `superseded: newer inbound ${m2.id}`,
      });
      expect((await byId(db, p0.id)).status).toBe("approved");
      expect((await byId(db, pOther.id)).status).toBe("drafting");
      expect((await byId(db, p2.id)).status).toBe("drafting");
    });
  });

  it("an older mail processed after a newer one is born superseded", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const older = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 2 * HOUR) });
      const newer = await mail(db, { threadId, from: verder(), sentAt: new Date(now - HOUR) });
      const pNew = await createProposal(deps(db), { rawEmailId: newer.id }, "verder");
      const pOld = await createProposal(deps(db), { rawEmailId: older.id }, "verder");
      expect(pOld.created).toBe(true);
      expect(await byId(db, pOld.id)).toMatchObject({
        status: "superseded", error: `superseded: newer inbound ${newer.id}`,
      });
      expect((await byId(db, pNew.id)).status).toBe("drafting");
    });
  });

  it("other-priority mail creates none", async () => {
    await isolated(async (db) => {
      const m = await mail(db, {
        threadId: `t-${uid()}`, from: `Nieuwsbrief <news-${uid()}@example.com>`, sentAt: new Date(),
      });
      const spoof = await mail(db, {
        threadId: `t-${uid()}`, from: '"demi@verdergroep.nl" <attacker@evil.tld>', sentAt: new Date(),
      });
      expect(await proposalsForMail(deps(db), m.id)).toEqual({ priority: "other", created: false, superseded: 0 });
      expect((await proposalsForMail(deps(db), spoof.id)).priority).toBe("other");
      const rows = await db.select().from(schema.proposals)
        .where(eq(schema.proposals.triggerRawEmailId, m.id));
      expect(rows).toHaveLength(0);
    });
  });

  it("creditor mail creates an active-priority proposal", async () => {
    await isolated(async (db) => {
      const email = `incasso-${uid()}@stam-fixture.nl`;
      const [party] = await db.insert(schema.parties).values({
        kind: "organization", name: `Stam Testfixture ${uid()}`, email,
      }).returning();
      const [debt] = await db.insert(schema.debts).values({
        creditorName: `PLM Testfixture ${uid()}`, claimedCents: 100,
      }).returning();
      await db.insert(schema.debtParties).values({ debtId: debt.id, partyId: party.id, role: "incasso" });
      const m = await mail(db, { threadId: `t-${uid()}`, from: `Stam <${email}>`, sentAt: new Date() });
      const r = await proposalsForMail(deps(db), m.id);
      expect(r).toMatchObject({ priority: "creditor", created: true });
      expect(await byId(db, r.proposalId!)).toMatchObject({ priority: "creditor", partyId: party.id });
    });
  });

  it("an unfiled letter proposal stores party NULL and sender_guess", async () => {
    await isolated(async (db) => {
      const [d] = await db.insert(schema.documents).values({
        sha256: uid().replace(/-/g, "").padEnd(64, "0"), title: `Brief ${uid()}.pdf`,
        mime: "application/pdf", sizeBytes: 10, source: "nas-scan", receivedAt: new Date(),
      }).returning();
      await db.insert(schema.documentTexts).values({
        documentId: d.id, sha256: d.sha256, text: "", charCount: 0, extractor: "none",
      });
      const trigger = { documentId: d.id, senderGuess: { kind: "verder" as const } };
      const a = await createProposal(deps(db), trigger, "verder");
      const b = await createProposal(deps(db), trigger, "verder");
      expect(b).toEqual({ id: a.id, created: false });
      expect(await byId(db, a.id)).toMatchObject({
        kind: "reply", status: "drafting", partyId: null, threadKey: null,
        senderGuess: { kind: "verder" }, triggerDocumentId: d.id, triggerRawEmailId: null,
      });
    });
  });

  it("a follow-up is exempt from the trigger index and does not supersede", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const m1 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 9 * 24 * HOUR) });
      const p1 = await createProposal(deps(db), { rawEmailId: m1.id }, "verder");
      await db.update(schema.proposals).set({ status: "pending" }).where(eq(schema.proposals.id, p1.id));
      const own = await mail(db, { threadId, from: MARTIN, to: "x@verdergroep.nl", sentAt: new Date(now - 8 * 24 * HOUR) });
      const f = await createProposal(deps(db), { rawEmailId: own.id }, "verder", "follow-up");
      expect(f.created).toBe(true);
      expect(await byId(db, f.id)).toMatchObject({ kind: "follow-up", status: "drafting" });
      expect((await byId(db, p1.id)).status).toBe("pending");
    });
  });
});

describe("supersedeOnOwnReply", () => {
  it("Martin's own reply in the thread supersedes the pending draft and cancels its reminder", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const m = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 2 * HOUR) });
      const p = await createProposal(deps(db), { rawEmailId: m.id }, "verder");
      await db.update(schema.proposals).set({ status: "pending" }).where(eq(schema.proposals.id, p.id));
      const reply = await mail(db, { threadId, from: MARTIN, to: "opstart@verdergroep.nl", sentAt: new Date(now - HOUR) });

      const r = await proposalsForMail(deps(db), reply.id);
      expect(r).toEqual({ priority: "other", created: false, superseded: 1 });
      expect(await byId(db, p.id)).toMatchObject({
        status: "superseded", error: `superseded: Martin replied himself ${reply.id}`,
      });
      // Task 17 reminds only `pending` rows: the reminder is gone with it.
      const reminders = await db.select().from(schema.proposals)
        .where(eq(schema.proposals.status, "pending"));
      expect(reminders.map((x) => x.id)).not.toContain(p.id);
      // Idempotent: a re-run of the job supersedes nothing more.
      expect(await supersedeOnOwnReply(db, reply.id)).toBe(0);
    });
  });

  it("an own reply OLDER than the trigger supersedes nothing", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const reply = await mail(db, { threadId, from: MARTIN, sentAt: new Date(now - 3 * HOUR) });
      const m = await mail(db, { threadId, from: verder(), sentAt: new Date(now - HOUR) });
      const p = await createProposal(deps(db), { rawEmailId: m.id }, "verder");
      expect(await supersedeOnOwnReply(db, reply.id)).toBe(0);
      expect((await byId(db, p.id)).status).toBe("drafting");
    });
  });

  it("a proposal's own sent mail does not supersede anything", async () => {
    await isolated(async (db) => {
      const threadId = `t-${uid()}`;
      const now = Date.now();
      const m0 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 3 * HOUR) });
      const pending = await createProposal(deps(db), { rawEmailId: m0.id }, "verder");
      await db.update(schema.proposals).set({ status: "pending" }).where(eq(schema.proposals.id, pending.id));

      const m1 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 4 * HOUR) });
      const sent = await createProposal(deps(db), { rawEmailId: m1.id }, "verder");
      const mid = `${uid()}@verder.vanderpoel.pro`;
      await db.update(schema.proposals).set({ status: "sent", messageId: `<${mid}>`, sentAt: new Date() })
        .where(eq(schema.proposals.id, sent.id));
      // Still `sending` counts too: the re-ingest can overtake finishSent.
      const m2 = await mail(db, { threadId, from: verder(), sentAt: new Date(now - 5 * HOUR) });
      const sending = await createProposal(deps(db), { rawEmailId: m2.id }, "verder");
      const gid = `gmail-${uid()}`;
      await db.update(schema.proposals).set({ status: "sending", messageId: `<${uid()}@x>`, gmailMessageId: gid })
        .where(eq(schema.proposals.id, sending.id));

      const back = await mail(db, { threadId, from: MARTIN, to: "x@verdergroep.nl", messageId: mid, sentAt: new Date(now - HOUR) });
      expect(await proposalsForMail(deps(db), back.id)).toEqual({ priority: "other", created: false, superseded: 0 });

      const [back2] = await db.insert(schema.rawEmails).values({
        gmailMessageId: gid, gmailThreadId: threadId, fromAddr: MARTIN, toAddr: "x@verdergroep.nl",
        subject: "Re: x", sentAt: new Date(now - HOUR), rawRfc822Sha256: back.rawRfc822Sha256,
        bodyText: "", source: "gmail", messageId: null, suggestQueuedAt: new Date(),
      }).returning();
      expect(await supersedeOnOwnReply(db, back2.id)).toBe(0);
      expect((await byId(db, pending.id)).status).toBe("pending");
    });
  });
});

describe("createProposal with the drafter's prompt", () => {
  it("stores the exact prompt the host drafter will pipe into claude", async () => {
    const { buildProposalPrompt } = await import("./draft-prompt");
    await isolated(async (db) => {
      const m = await mail(db, { threadId: `t-${uid()}`, from: verder(), sentAt: new Date() });
      const { id } = await createProposal({ ...deps(db), buildPrompt: buildProposalPrompt },
        { rawEmailId: m.id }, "verder");
      const row = await byId(db, id);
      expect(row.prompt).toBe(buildProposalPrompt(row.context as never, "reply"));
      expect(row.prompt).toContain(`id=${m.id}`);
      expect(row.prompt).toContain("<<<DATA");
    });
  });
});
