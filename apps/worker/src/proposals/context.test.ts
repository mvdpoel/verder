import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { storeFile } from "@verder/api/src/storage";
import { setTaskStatus } from "@verder/api/src/task-decide";
import type { RetrieveRefsFn } from "../retrieval-refs";
import { gatherContext, type ProposalContext } from "./context";

// Runs as verder_worker, the role suggest.entry meets in production. Every test
// is a transaction that is ROLLED BACK: the shared dev database is never
// truncated, and most of these tables have no DELETE grant.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
const vaultDir = mkdtempSync(join(tmpdir(), "proposal-context-vault-"));

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

/** One message as RFC822 bytes, stored in the vault, with its raw_emails row. */
async function mail(db: Db, o: {
  threadId: string; from: string; to: string; cc?: string; subject?: string;
  messageId?: string; references?: string; source?: "gmail" | "jmap"; sentAt?: Date;
}) {
  const gmailMessageId = `ctx-${uid()}`;
  const messageId = o.messageId ?? `${uid()}@mail.example`;
  const headers = [
    `From: ${o.from}`, `To: ${o.to}`, ...(o.cc ? [`Cc: ${o.cc}`] : []),
    `Subject: ${o.subject ?? "Informatie over uw dossier"}`, `Message-ID: <${messageId}>`,
    ...(o.references ? [`References: ${o.references}`] : []),
  ];
  const raw = Buffer.from([...headers, "", "Beste Martin, graag uw loonstroken."].join("\r\n"));
  const { sha256 } = await storeFile(vaultDir, raw);
  const [row] = await db.insert(schema.rawEmails).values({
    gmailMessageId, gmailThreadId: o.threadId, fromAddr: o.from, toAddr: o.to,
    subject: o.subject ?? "Informatie over uw dossier", sentAt: o.sentAt ?? new Date(),
    rawRfc822Sha256: sha256, bodyText: "Beste Martin, graag uw loonstroken.",
    source: o.source ?? "gmail", messageId, suggestQueuedAt: new Date(),
  }).returning();
  return row;
}

async function doc(db: Db, o: { title?: string; sourceRef?: string; partyId?: string } = {}) {
  const [d] = await db.insert(schema.documents).values({
    sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"),
    title: o.title ?? `Fixture ${uid()}.pdf`, mime: "application/pdf", sizeBytes: 10,
    source: o.sourceRef ? "email-attachment" : "upload", sourceRef: o.sourceRef,
    receivedAt: new Date(), partyId: o.partyId,
  }).returning();
  await db.insert(schema.documentTexts).values({
    documentId: d.id, sha256: d.sha256, text: "", charCount: 0, extractor: "none",
  });
  return d;
}

interface World {
  user: { id: string }; party: { id: string; email: string | null };
  trigger: { id: string; gmailThreadId: string; messageId: string | null };
  attachment: { id: string }; discarded: { id: string }; purged: { id: string };
  entry: { id: string }; sentDoc: { id: string }; debt: { id: string }; debtDoc: { id: string };
  openTask: { id: string }; doneTask: { id: string }; stop: { id: string };
  kbDoc: { id: string }; jmapTwin: { id: string }; own: { id: string; messageId: string | null };
  spoof: { id: string };
  contextCc: string;
}

async function world(db: Db): Promise<World> {
  const [user] = await db.insert(schema.users).values({
    email: `ctx-${uid()}@example.test`, name: "Fixture",
  }).returning();
  const partyEmail = `incasso-${uid()}@stam-fixture.nl`;
  const [party] = await db.insert(schema.parties).values({
    kind: "organization", name: `Stam Testfixture ${uid()}`, email: partyEmail,
  }).returning();
  const threadId = `thread-${uid()}`;
  const contextCc = `opstart-${uid()}@verdergroep.nl`;

  // Martin wrote first, then the creditor answered — with Verder in Cc.
  const own = await mail(db, {
    threadId, from: "Martin van der Poel <martin@vanderpoel.pro>", to: partyEmail,
    subject: "Uw brief", sentAt: new Date(Date.now() - 3 * 86_400_000),
  });
  const spoof = await mail(db, {
    threadId, from: '"demi@verdergroep.nl" <attacker@evil.tld>',
    to: "martin@vanderpoel.pro", sentAt: new Date(Date.now() - 2 * 86_400_000),
  });
  const trigger = await mail(db, {
    threadId, from: `Stam Incasso <${partyEmail}>`, to: "martin@vanderpoel.pro",
    cc: `"Opstart, Team" <${contextCc}>, Iemand (comment) <stranger@else.tld>`,
    subject: "Re: Uw brief", references: `<${own.messageId}>`,
    sentAt: new Date(Date.now() - 86_400_000),
  });
  // Same Gmail-looking thread id, other namespace: must never join.
  const jmapTwin = await mail(db, {
    threadId, from: `Stam Incasso <${partyEmail}>`, to: "martin@vanderpoel.pro", source: "jmap",
  });

  const attachment = await doc(db, { sourceRef: trigger.gmailMessageId, partyId: party.id });
  const discarded = await doc(db, { sourceRef: trigger.gmailMessageId });
  await db.insert(schema.documentStatusChanges).values({ documentId: discarded.id, status: "discarded" });
  const purged = await doc(db, { sourceRef: trigger.gmailMessageId });
  await db.insert(schema.documentPurges).values({
    documentId: purged.id, sha256: purged.sha256, sizeBytes: 10, createdBy: user.id,
  });

  const [entry] = await db.insert(schema.logEntries).values({
    occurredAt: new Date(), channel: "email", direction: "outbound",
    summary: "Betalingsregeling voorgesteld", source: "manual", createdBy: user.id,
  }).returning();
  await db.insert(schema.entryParticipants).values({ entryId: entry.id, partyId: party.id });
  const sentDoc = await doc(db);
  await db.insert(schema.entryDocuments).values({ entryId: entry.id, documentId: sentDoc.id });

  const [debt] = await db.insert(schema.debts).values({
    creditorName: `PLM Testfixture ${uid()}`, claimedCents: 12_345,
  }).returning();
  await db.insert(schema.debtParties).values({ debtId: debt.id, partyId: party.id, role: "incasso" });
  const debtDoc = await doc(db);
  await db.insert(schema.debtDocuments).values({ debtId: debt.id, documentId: debtDoc.id });

  const [openTask] = await db.insert(schema.tasks).values({
    title: `Betalingsregeling ${uid()}`, debtId: debt.id, createdBy: user.id,
  }).returning();
  const [doneTask] = await db.insert(schema.tasks).values({
    title: `Afgerond ${uid()}`, debtId: debt.id, createdBy: user.id,
  }).returning();
  await setTaskStatus(db, user.id, { taskId: doneTask.id, status: "done" });

  let [root] = await db.select().from(schema.tracks).where(isNull(schema.tracks.parentTrackId));
  if (!root) [root] = await db.insert(schema.tracks).values({ title: "Bewindvoering" }).returning();
  const [track] = await db.insert(schema.tracks).values({
    title: `Vordering ${uid()}`, parentTrackId: root.id,
  }).returning();
  const [stop] = await db.insert(schema.stops).values({
    trackId: track.id, orderIndex: 0, title: `Regeling ${uid()}`, state: "open", taskId: openTask.id,
  }).returning();

  const kbDoc = await doc(db);
  return { user, party, trigger, attachment, discarded, purged, entry, sentDoc, debt, debtDoc,
    openTask, doneTask, stop, kbDoc, jmapTwin, own, spoof, contextCc };
}

const kbFor = (w: World): RetrieveRefsFn => async () => [
  { entityType: "document", entityId: w.kbDoc.id, title: "Beschikking", score: 1, snippet: "..." },
  { entityType: "entry", entityId: w.entry.id, title: "Regeling", score: 0.5, snippet: "..." },
];

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const gather = (db: Db, w: World): Promise<ProposalContext> =>
  gatherContext({ db, retrieveRefs: kbFor(w), vaultDir }, { rawEmailId: w.trigger.id });

describe("gatherContext", () => {
  it("cites every item by id", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ctx.trigger).toMatchObject({ type: "email", id: w.trigger.id });
      expect(ids(ctx.thread)).toEqual([w.own.id, w.spoof.id, w.trigger.id]);
      expect(ctx.party?.id).toBe(w.party.id);
      expect(ids(ctx.entries)).toContain(w.entry.id);
      expect(ids(ctx.debts)).toEqual([w.debt.id]);
      expect(ctx.debts[0].label).toContain("incasso");
      expect(ids(ctx.tasks)).toEqual([w.openTask.id]);
      expect(ids(ctx.stops)).toEqual([w.stop.id]);
      expect(ids(ctx.kb)).toEqual([w.kbDoc.id, w.entry.id]);
      expect(ids(ctx.sentDocuments)).toEqual([w.sentDoc.id]);
      expect(ids(ctx.attachable).sort()).toEqual(
        [w.attachment.id, w.sentDoc.id, w.debtDoc.id, w.kbDoc.id].sort());
      const triggerItem = ctx.thread.find((t) => t.id === w.trigger.id)!;
      expect(ids(triggerItem.attachments ?? [])).toEqual([w.attachment.id]);
      expect(ctx.threadKey).toBe(`gmail:${w.trigger.gmailThreadId}`);
      expect(ctx.gmailThreadId).toBe(w.trigger.gmailThreadId);
      expect(ctx.reply).toEqual({
        inReplyTo: `<${w.trigger.messageId}>`,
        references: `<${w.own.messageId}> <${w.trigger.messageId}>`,
        subject: "Re: Uw brief",
      });
    });
  });

  it("excludes a discarded document from attachable", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ids(ctx.attachable)).not.toContain(w.discarded.id);
      expect(ctx.thread.flatMap((t) => ids(t.attachments ?? []))).not.toContain(w.discarded.id);
    });
  });

  it("excludes a purged document", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ids(ctx.attachable)).not.toContain(w.purged.id);
      expect(ctx.thread.flatMap((t) => ids(t.attachments ?? []))).not.toContain(w.purged.id);
    });
  });

  it("does not join a jmap thread to a gmail thread", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ids(ctx.thread)).not.toContain(w.jmapTwin.id);
      const fromJmap = await gatherContext({ db, retrieveRefs: kbFor(w), vaultDir },
        { rawEmailId: w.jmapTwin.id });
      expect(ids(fromJmap.thread)).toEqual([w.jmapTwin.id]);
      expect(fromJmap.threadKey).toBeNull();
      expect(fromJmap.gmailThreadId).toBeNull();
    });
  });

  it("addresses exclude Martin's own", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ctx.addresses).toContain(w.party.email);
      expect(ctx.addresses).toContain(w.contextCc);
      expect(ctx.addresses).not.toContain("martin@vanderpoel.pro");
    });
  });

  it("spoofed display-name address never enters ctx.addresses", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      const ctx = await gather(db, w);
      expect(ctx.addresses).not.toContain("demi@verdergroep.nl");
      expect(ctx.addresses).not.toContain("attacker@evil.tld");
      // A refused mailbox (a comment) contributes nothing either.
      expect(ctx.addresses).not.toContain("stranger@else.tld");
      expect([...ctx.addresses].sort()).toEqual([w.party.email, w.contextCc].sort());
    });
  });

  it("a task trigger has no thread and no reply headers", async () => {
    await isolated(async (db) => {
      const w = await world(db);
      await db.update(schema.tasks).set({ assigneePartyId: w.party.id })
        .where(eq(schema.tasks.id, w.openTask.id));
      const ctx = await gatherContext({ db, retrieveRefs: kbFor(w), vaultDir }, { taskId: w.openTask.id });
      expect(ctx.trigger).toMatchObject({ type: "task", id: w.openTask.id });
      expect(ctx.thread).toEqual([]);
      expect(ctx.reply).toBeNull();
      expect(ctx.party?.id).toBe(w.party.id);
      expect(ctx.addresses).toEqual([w.party.email]);
    });
  });
});
