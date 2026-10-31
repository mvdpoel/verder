import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import type { ChainEvent } from "@verder/core";
import { storeFile } from "@verder/api/src/storage";
import { makeLedgerRecompute } from "@verder/api/src/verification";
import { pollGmail, rateLimitedUntil } from "../gmail";
import { suggestEntry, type LlmPort } from "../ollama";
import { suggestTask } from "../task-mine";
import { fakeNotify } from "../test-support/fake-notify";
import {
  findSentWith, finishSent, FINISH_MAX_FAILURES, sendApproved,
  type FinalReply, type SendDeps, type SendPort, type SentMatch,
} from "./send";

// Runs as verder_worker, the role the send job meets in production. Every test
// but one is a transaction that is ROLLED BACK: the shared dev database is
// never truncated, and no ledger event a test appends survives it. NOTHING is
// sent anywhere: the port is a fake Sent folder in memory.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
let admin: { db: Db; pool: { end(): Promise<void> } };
const vaultDir = mkdtempSync(join(tmpdir(), "proposal-send-vault-"));

beforeAll(() => { conn = createDb(URL); admin = createDb(ADMIN_URL); });
afterAll(async () => { await conn.pool.end(); await admin.pool.end(); });

const env = { own: process.env.MAIL_OWN_ADDRESSES };
beforeEach(() => { process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro"; });
afterEach(() => {
  if (env.own === undefined) delete process.env.MAIL_OWN_ADDRESSES;
  else process.env.MAIL_OWN_ADDRESSES = env.own;
});

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>, on = () => conn): Promise<void> {
  try {
    await on().db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();
const MIN = 60_000;

/** A controlled clock far past anything the shared dev database holds, so a
 *  Gmail deadline another suite committed can never leak into these ticks. */
function clock() {
  let t = Date.parse("2031-01-06T09:00:00Z") + Math.floor(Math.random() * 1000) * MIN;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

// ---------------------------------------------------------------------------
// A fake Gmail: a Sent folder in memory, searched through the REAL algorithm.
// ---------------------------------------------------------------------------

interface SentCopy { id: string; threadId: string; raw: Buffer; messageId: string; subject: string; at: Date }

function header(raw: Buffer, name: string): string {
  const text = raw.toString("utf8");
  const block = text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
  const line = block.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : "";
}
const decodeWords = (v: string) => !/=\?UTF-8\?B\?/.test(v) ? v : v.split(/\s+/).map((w) => {
  const m = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(w);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : w;
}).join("");

function fakeGmail(o: { now: () => Date; keepsMessageId?: boolean }) {
  const folder: SentCopy[] = [];
  const calls = { send: 0, list: 0, find: 0 };
  let sendImpl: ((raw: Buffer, threadId?: string) => Promise<SentMatch>) | null = null;
  let findImpl: SendPort["findSent"] | null = null;
  const put = (raw: Buffer, threadId?: string): SentMatch => {
    const id = `gm-${uid()}`;
    const copy: SentCopy = { id, threadId: threadId ?? `th-${uid()}`, raw,
      // Whether Gmail keeps a client Message-ID is unmeasured (Task 21 Step 7):
      // both answers are modelled.
      messageId: o.keepsMessageId === false ? `<${uid()}@mail.gmail.com>` : header(raw, "Message-ID"),
      subject: decodeWords(header(raw, "Subject")), at: o.now() };
    folder.push(copy);
    return { id, threadId: copy.threadId };
  };
  const port: SendPort = {
    async send(raw, threadId) {
      calls.send++;
      if (sendImpl) return sendImpl(raw, threadId);
      return put(raw, threadId);
    },
    async findSent(q) {
      calls.find++;
      if (findImpl) return findImpl(q);
      return findSentWith({
        async list(query) {
          calls.list++;
          const byId = /^rfc822msgid:(.*)$/.exec(query);
          if (byId) return folder.filter((c) => c.messageId.replace(/^<|>$/g, "") === byId[1])
            .map((c) => ({ id: c.id, threadId: c.threadId }));
          return folder.map((c) => ({ id: c.id, threadId: c.threadId }));
        },
        async meta(id) {
          const c = folder.find((x) => x.id === id)!;
          return { subject: c.subject, internalDate: c.at };
        },
      }, q);
    },
  };
  return {
    port, folder, calls, put,
    onSend: (f: typeof sendImpl) => { sendImpl = f; },
    onFind: (f: typeof findImpl) => { findImpl = f; },
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function user(db: Db) {
  const [u] = await db.insert(schema.users)
    .values({ email: `send-${uid()}@test.local`, name: "Martin" }).returning();
  return u;
}

async function party(db: Db) {
  const [p] = await db.insert(schema.parties).values({ kind: "organization",
    name: `Team Opstart Testfixture ${uid()}`, email: `opstart-${uid()}@verdergroep.nl` }).returning();
  return p;
}

async function vaultDoc(db: Db, title: string, bytes = Buffer.from(`%PDF-1.4 ${uid()}`)) {
  const { sha256 } = await storeFile(vaultDir, bytes);
  const [d] = await db.insert(schema.documents).values({
    sha256, title, mime: "application/pdf", sizeBytes: bytes.length, source: "upload",
    sourceRef: `send-test-${uid()}`, receivedAt: new Date("2026-10-30T09:00:00Z"),
  }).returning();
  return { ...d, bytes };
}

function reply(o: Partial<FinalReply> = {}): FinalReply {
  return {
    to: [`opstart-${uid()}@verdergroep.nl`], cc: [], subject: "Re: Informatie over uw dossier",
    body: "Beste Team Opstart,\n\nHierbij de loonstroken.\n\nMet vriendelijke groet,\nMartin van der Poel",
    attachmentDocumentIds: [], entrySummary: "Loonstroken gestuurd aan Team Opstart", ...o,
  };
}

async function approved(db: Db, o: {
  userId: string | null; partyId?: string | null; final?: FinalReply;
  triggerDocumentId?: string; gmailThreadId?: string | null;
  status?: string; messageId?: string; sendingAt?: Date;
}) {
  const final = o.final ?? reply();
  // A Gmail thread exists only for a mail that arrived over Gmail: the trigger
  // is then a `source='gmail'` raw email, as in production.
  let triggerRawEmailId: string | undefined;
  if (o.gmailThreadId && !o.triggerDocumentId) {
    const { sha256 } = await storeFile(vaultDir, Buffer.from(`trigger ${uid()}`));
    const [r] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `trig-${uid()}`, gmailThreadId: o.gmailThreadId,
      fromAddr: "Team Opstart <opstart@verdergroep.nl>", toAddr: "martin@vanderpoel.pro",
      subject: "Informatie over uw dossier", sentAt: new Date(), rawRfc822Sha256: sha256,
      bodyText: "graag de loonstroken", source: "gmail", suggestQueuedAt: new Date(),
    }).returning();
    triggerRawEmailId = r.id;
  }
  const [p] = await db.insert(schema.proposals).values({
    kind: "reply", status: o.status ?? "approved", priority: "verder",
    ...(o.triggerDocumentId ? { triggerDocumentId: o.triggerDocumentId }
      : triggerRawEmailId ? { triggerRawEmailId }
        : { triggerExternal: { gmailId: `x-${uid()}`, subject: "Informatie over uw dossier" } }),
    partyId: o.partyId ?? null,
    context: {
      gmailThreadId: o.gmailThreadId ?? null,
      reply: { inReplyTo: `<parent-${uid()}@verdergroep.nl>`, subject: final.subject },
      addresses: final.to, attachable: [],
    },
    payload: { ask: "Loonstrook oktober aanleveren", entrySummary: final.entrySummary },
    finalPayload: final, verdict: "approved", decidedAt: new Date(), decidedBy: o.userId,
    messageId: o.messageId, sendingAt: o.sendingAt,
  }).returning();
  return p;
}

const byId = async (db: Db, id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0];

const entryFor = async (db: Db, proposalId: string) =>
  db.select().from(schema.logEntries).where(eq(schema.logEntries.sourceRef, `proposal:${proposalId}`));

function depsFor(db: Db, g: ReturnType<typeof fakeGmail>, c: ReturnType<typeof clock>,
  extra: Partial<SendDeps> = {}) {
  const n = fakeNotify();
  return { deps: { db, port: g.port, vaultDir, notify: n.notify, now: c.now, ...extra } as SendDeps, sent: n.sent };
}

const RATE_LIMIT = (at: Date) => new Error(`User-rate limit exceeded.  Retry after ${at.toISOString()}`);
const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

/** A send whose worker died after Gmail accepted it and before ANYTHING was
 *  recorded: the row holds only the claim. */
async function crashedSend(db: Db, g: ReturnType<typeof fakeGmail>, c: ReturnType<typeof clock>, o: {
  userId: string; final?: FinalReply; gmailThreadId?: string | null; inFolder?: boolean;
}) {
  const p = await approved(db, { userId: o.userId, final: o.final, gmailThreadId: o.gmailThreadId });
  const { deps } = depsFor(db, g, c, { finish: async () => { throw new Error("worker died"); } });
  await sendApproved(deps);
  // The process died before the failure was recorded: undo what tryFinish wrote.
  await db.update(schema.proposals).set({ gmailMessageId: null, gmailThreadId: null, finishFailures: 0, error: null })
    .where(eq(schema.proposals.id, p.id));
  if (o.inFolder === false) g.folder.length = 0;
  return byId(db, p.id);
}

// ---------------------------------------------------------------------------

describe("sendApproved", () => {
  it("stores the Message-ID before the Gmail call, sends once, and writes one outbound entry", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db); const pt = await party(db);
      const p = await approved(db, { userId: u.id, partyId: pt.id, gmailThreadId: "th-gmail-1" });
      let seenAtSend: typeof p | undefined;
      let threadAtSend: string | undefined;
      g.onSend(async (raw, threadId) => {
        seenAtSend = await byId(db, p.id);
        threadAtSend = threadId;
        expect(header(raw, "Message-ID")).toBe(seenAtSend.messageId);
        return g.put(raw, threadId);
      });
      const { deps } = depsFor(db, g, c);
      expect(await sendApproved(deps)).toEqual({ sent: 1, recovered: 0, failed: 0 });
      expect(seenAtSend!.status).toBe("sending");
      expect(seenAtSend!.messageId).toMatch(/^<[0-9a-f-]{36}@verder\.vanderpoel\.pro>$/);
      expect(threadAtSend).toBe("th-gmail-1");
      const done = await byId(db, p.id);
      expect(done.status).toBe("sent");
      expect(done.gmailMessageId).toBe(g.folder[0].id);
      const entries = await entryFor(db, p.id);
      expect(entries).toHaveLength(1);
      expect(done.resultEntryId).toBe(entries[0].id);
      const parts = await db.select().from(schema.entryParticipants)
        .where(eq(schema.entryParticipants.entryId, entries[0].id));
      expect(parts.map((x) => x.partyId)).toEqual([pt.id]);
      // A second tick finds nothing to do.
      expect(await sendApproved(deps)).toEqual({ sent: 0, recovered: 0, failed: 0 });
      expect(g.calls.send).toBe(1);
    });
  });

  it("crash after send is recovered, not resent", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await approved(db, { userId: u.id });
      let throws = true;
      const { deps } = depsFor(db, g, c, { finish: async (...a) => {
        if (throws) { throws = false; throw new Error("database went away"); }
        return finishSent(...a);
      } });
      await sendApproved(deps);
      const after1 = await byId(db, p.id);
      expect(after1.status).toBe("sending");
      expect(after1.finishFailures).toBe(1);
      // The Gmail id is kept on the failure: proof that it went.
      expect(after1.gmailMessageId).toBe(g.folder[0].id);
      c.advance(11 * MIN);
      expect((await sendApproved(deps)).recovered).toBe(1);
      expect((await byId(db, p.id)).status).toBe("sent");
      expect(await entryFor(db, p.id)).toHaveLength(1);
      expect(g.calls.send).toBe(1);
    });
  });

  it("a worker that died after the Gmail call is found by its Message-ID, never resent", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id });
      expect(p.status).toBe("sending");
      // Younger than ten minutes: a send in flight, not a stuck one.
      const { deps } = depsFor(db, g, c);
      c.advance(5 * MIN);
      await sendApproved(deps);
      expect(g.calls.find).toBe(0);
      c.advance(6 * MIN);
      expect((await sendApproved(deps)).recovered).toBe(1);
      expect(g.calls.list).toBe(1); // found by rfc822msgid: on the first call
      expect((await byId(db, p.id)).status).toBe("sent");
      expect(await entryFor(db, p.id)).toHaveLength(1);
      expect(g.calls.send).toBe(1);
    });
  });

  it("recovery falls back to thread and subject when the Message-ID is not found", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now, keepsMessageId: false });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id, gmailThreadId: "th-fallback" });
      // An unrelated sent mail in another thread with the same subject.
      g.folder.push({ ...g.folder[0], id: `gm-${uid()}`, threadId: "th-other" });
      c.advance(11 * MIN);
      const { deps } = depsFor(db, g, c);
      expect((await sendApproved(deps)).recovered).toBe(1);
      expect(g.calls.list).toBe(2);
      const done = await byId(db, p.id);
      expect(done.status).toBe("sent");
      expect(done.gmailMessageId).toBe(g.folder[0].id);
      expect(g.calls.send).toBe(1);
    });
  });

  it("two fallback matches recover nothing", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now, keepsMessageId: false });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id, gmailThreadId: "th-twice" });
      g.folder.push({ ...g.folder[0], id: `gm-${uid()}` });
      const { deps, sent } = depsFor(db, g, c);
      c.advance(11 * MIN);
      expect((await sendApproved(deps)).recovered).toBe(0);
      const mid = await byId(db, p.id);
      expect(mid.status).toBe("sending");
      expect(mid.error).toMatch(/meerdere/);
      c.advance(20 * MIN);
      await sendApproved(deps);
      expect((await byId(db, p.id)).status).toBe("failed");
      expect(await entryFor(db, p.id)).toHaveLength(0);
      expect(sent.filter((n) => n.dedupKey === `send-uncertain:${p.id}`)).toHaveLength(1);
      expect(g.calls.send).toBe(1);
    });
  });

  it("not found after 30 min becomes failed and notifies that the mail MAY have gone", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id, inFolder: false });
      const { deps, sent } = depsFor(db, g, c);
      c.advance(11 * MIN);
      await sendApproved(deps);
      expect((await byId(db, p.id)).status).toBe("sending"); // not yet: maybe Gmail is slow
      c.advance(20 * MIN);
      expect((await sendApproved(deps)).failed).toBe(1);
      const done = await byId(db, p.id);
      expect(done.status).toBe("failed");
      expect(done.error).toBe("niet gevonden in Verzonden");
      const n = sent.find((x) => x.dedupKey === `send-uncertain:${p.id}`)!;
      expect(n.title).toMatch(/^Versturen onzeker: /);
      expect(n.body).toContain("MOGELIJK verstuurd");
      expect(n.body).not.toMatch(/niet verstuurd/i);
      expect(n.level).toBe("time-sensitive");
      // Never re-sent, and nothing more is asked of Gmail once it is final.
      const finds = g.calls.find;
      c.advance(MIN);
      await sendApproved(deps);
      expect(g.calls.find).toBe(finds);
      expect(g.calls.send).toBe(1);
    });
  });

  it("finishSent error after a found message stops calling Gmail after N ticks", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id });
      let finishes = 0;
      const { deps, sent } = depsFor(db, g, c, { finish: async () => {
        finishes++; throw new Error('invalid input value for enum entry_source: "proposal"');
      } });
      c.advance(11 * MIN);
      for (let i = 0; i < FINISH_MAX_FAILURES + 2; i++) { await sendApproved(deps); c.advance(MIN); }
      expect(finishes).toBe(FINISH_MAX_FAILURES);
      // Asked once; the Gmail id it found is kept, so no tick asks again.
      expect(g.calls.find).toBe(1);
      const row = await byId(db, p.id);
      expect(row.status).toBe("sending");
      expect(row.finishFailures).toBe(FINISH_MAX_FAILURES);
      expect(row.error).toMatch(/entry_source/);
      const alerts = sent.filter((n) => n.dedupKey === `finish-failed:${p.id}`);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].title).toBe("Mail VERSTUURD, logboek ontbreekt");
      expect(alerts[0].body).toContain(g.folder[0].id);
      expect(g.calls.send).toBe(1);
      // Re-armed by hand after the human fix: the next tick finishes it.
      await db.update(schema.proposals).set({ finishFailures: 0 }).where(eq(schema.proposals.id, p.id));
      expect((await sendApproved({ ...deps, finish: finishSent })).recovered).toBe(1);
      expect(await entryFor(db, p.id)).toHaveLength(1);
    });
  });

  it("a letter proposal with no party sends and writes an entry with no participant", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const letter = await vaultDoc(db, "Brief Verder.pdf");
      const p = await approved(db, { userId: u.id, partyId: null, triggerDocumentId: letter.id });
      const { deps } = depsFor(db, g, c);
      expect((await sendApproved(deps)).sent).toBe(1);
      const [entry] = await entryFor(db, p.id);
      const parts = await db.select().from(schema.entryParticipants)
        .where(eq(schema.entryParticipants.entryId, entry.id));
      expect(parts).toHaveLength(0);
    });
  });

  it("entry summary is the approved entrySummary and details hold the full body", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const att = await vaultDoc(db, "Loonstrook september.pdf");
      const body = `Beste Team Opstart,\n\n${"Een lange alinea over de stukken. ".repeat(200)}\n\nMartin`;
      const final = reply({ body, cc: ["demi@verdergroep.nl"], attachmentDocumentIds: [att.id],
        entrySummary: "Loonstrook september gestuurd" });
      const p = await approved(db, { userId: u.id, final });
      const { deps } = depsFor(db, g, c);
      await sendApproved(deps);
      const [entry] = await entryFor(db, p.id);
      expect(entry.summary).toBe("Loonstrook september gestuurd");
      expect(entry.summary).not.toBe("Loonstrook oktober aanleveren"); // never the model's ask
      expect(entry.details).toBe(
        `Aan: ${final.to[0]}\nCc: demi@verdergroep.nl\nOnderwerp: ${final.subject}\n\n${body}`);
      expect(entry.direction).toBe("outbound");
      expect(entry.channel).toBe("email");
      expect(entry.createdBy).toBe(u.id);
      const docs = await db.select().from(schema.entryDocuments)
        .where(eq(schema.entryDocuments.entryId, entry.id));
      expect(docs.map((d) => d.documentId)).toEqual([att.id]);
      // Exactly one ledger event for the send, and it is the entry's.
      const events = await db.select().from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.entityId, entry.id));
      expect(events.map((e) => e.eventType)).toEqual(["entry.created"]);
      // The attachment really went, byte for byte.
      expect(g.folder[0].raw.toString("utf8")).toContain(att.bytes.toString("base64").slice(0, 20));
    });
  });

  it("recovery honours rateLimitedUntil", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await crashedSend(db, g, c, { userId: u.id });
      c.advance(11 * MIN);
      const deadline = new Date(c.now().getTime() + 10 * MIN);
      await db.insert(schema.workerRuns).values({ worker: "gmail", status: "error",
        detail: { message: "429", retryAfter: deadline.toISOString() }, ranAt: c.now() });
      const { deps } = depsFor(db, g, c);
      c.advance(1000);
      await sendApproved(deps);
      expect(g.calls.find).toBe(0);
      expect((await byId(db, p.id)).status).toBe("sending");
      const [row] = await db.select().from(schema.workerRuns)
        .where(and(eq(schema.workerRuns.worker, "proposal-send"), eq(schema.workerRuns.ranAt, c.now())));
      expect(row.status).toBe("ok");
      expect(row.detail).toEqual({ skipped: "rate-limited", retryAfter: deadline.toISOString() });
    });
  });

  it("a 429 on recovery mutes gmail.poll and the next tick", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      await crashedSend(db, g, c, { userId: u.id });
      c.advance(11 * MIN);
      const deadline = new Date(c.now().getTime() + 15 * MIN);
      g.onFind(async () => { throw RATE_LIMIT(deadline); });
      const { deps } = depsFor(db, g, c);
      await sendApproved(deps);
      expect(g.calls.find).toBe(1);
      expect((await rateLimitedUntil(db, c.now()))?.toISOString()).toBe(deadline.toISOString());
      // gmail.poll, reading the deadline exactly as it does in production.
      let listed = 0;
      await pollGmail({ db, vaultDir, enqueueSuggest: async () => {},
        gmail: { listMessageIds: async () => { listed++; return []; },
          getMessage: async () => { throw new Error("unreachable"); } } });
      expect(listed).toBe(0);
      c.advance(MIN);
      await sendApproved(deps);
      expect(g.calls.find).toBe(1);
      expect(g.calls.send).toBe(1);
    });
  });

  it("a 429 on send un-claims to approved, never failed, and sends after the deadline", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await approved(db, { userId: u.id });
      const deadline = new Date(c.now().getTime() + 15 * MIN);
      let firstMid = "";
      g.onSend(async (raw) => { firstMid = header(raw, "Message-ID"); throw RATE_LIMIT(deadline); });
      const { deps, sent } = depsFor(db, g, c);
      await sendApproved(deps);
      const back = await byId(db, p.id);
      expect(back.status).toBe("approved");
      expect(back.messageId).toBeNull();
      expect(back.sendingAt).toBeNull();
      expect(sent).toHaveLength(0);
      g.onSend(null);
      c.advance(5 * MIN);
      await sendApproved(deps);
      expect(g.calls.send).toBe(1); // still inside the deadline
      c.advance(11 * MIN);
      expect((await sendApproved(deps)).sent).toBe(1);
      const done = await byId(db, p.id);
      expect(done.status).toBe("sent");
      expect(done.messageId).not.toBe(firstMid); // a fresh Message-ID
      expect(g.calls.send).toBe(2);
    });
  });

  it("a Gmail 4xx before acceptance is failed and notified; a timeout is left for recovery", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const refused = await approved(db, { userId: u.id });
      g.onSend(async () => { throw httpError(400, "Invalid To header"); });
      const { deps, sent } = depsFor(db, g, c);
      expect((await sendApproved(deps)).failed).toBe(1);
      expect((await byId(db, refused.id)).status).toBe("failed");
      expect(sent.find((n) => n.dedupKey === `send-failed:${refused.id}`)?.title)
        .toMatch(/^Niet verstuurd: /);

      const unknown = await approved(db, { userId: u.id });
      g.onSend(async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); });
      await sendApproved(deps);
      expect((await byId(db, unknown.id)).status).toBe("sending");
      g.onSend(async () => { throw httpError(503); });
      const flaky = await approved(db, { userId: u.id });
      await sendApproved(deps);
      expect((await byId(db, flaky.id)).status).toBe("sending");
    });
  });

  it("a purged attachment fails before sending", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const att = await vaultDoc(db, "Paspoort.pdf");
      const p = await approved(db, { userId: u.id, final: reply({ attachmentDocumentIds: [att.id] }) });
      await db.insert(schema.documentPurges).values({ documentId: att.id, sha256: att.sha256,
        sizeBytes: att.sizeBytes, reason: "test", createdBy: u.id });
      const { deps, sent } = depsFor(db, g, c);
      expect((await sendApproved(deps)).failed).toBe(1);
      const done = await byId(db, p.id);
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/definitief verwijderd/);
      expect(g.calls.send).toBe(0);
      expect(sent.map((n) => n.dedupKey)).toEqual([`send-failed:${p.id}`]);
    });
  });

  it("a discarded attachment fails before sending", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const att = await vaultDoc(db, "Logo.pdf");
      const p = await approved(db, { userId: u.id, final: reply({ attachmentDocumentIds: [att.id] }) });
      await db.insert(schema.documentStatusChanges).values({ documentId: att.id, status: "discarded" });
      const { deps } = depsFor(db, g, c);
      await sendApproved(deps);
      expect((await byId(db, p.id)).error).toMatch(/weggegooid/);
      expect(g.calls.send).toBe(0);
    });
  });

  it("entry is outbound with source proposal and the event recomputes green", async () => {
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db); const pt = await party(db);
      const att = await vaultDoc(db, "Loonstrook.pdf");
      const p = await approved(db, { userId: u.id, partyId: pt.id,
        final: reply({ attachmentDocumentIds: [att.id] }) });
      await sendApproved(depsFor(db, g, c).deps);
      const [entry] = await entryFor(db, p.id);
      expect(entry.source).toBe("proposal");
      expect(entry.sourceRef).toBe(`proposal:${p.id}`);
      expect(entry.direction).toBe("outbound");
      const [ev] = await db.select().from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.entityId, entry.id));
      const recompute = makeLedgerRecompute(db, vaultDir, {
        linkedLater: new Map(), resolvedLinkHash: new Map(), resolvedStatusHash: new Map() });
      const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType, entityType: ev.entityType,
        entityId: ev.entityId, payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
      expect(await recompute(event)).toBe(ev.payloadHash);
    });
  });

  it("tampering with source_ref turns verify red", async () => {
    // On the ADMIN role, because only the owner can UPDATE log_entries; still
    // one rolled-back transaction, so nothing survives.
    await isolated(async (db) => {
      const c = clock(); const g = fakeGmail({ now: c.now });
      const u = await user(db);
      const p = await approved(db, { userId: u.id });
      await sendApproved(depsFor(db, g, c).deps);
      const [entry] = await entryFor(db, p.id);
      const [ev] = await db.select().from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.entityId, entry.id));
      const recompute = makeLedgerRecompute(db, vaultDir, {
        linkedLater: new Map(), resolvedLinkHash: new Map(), resolvedStatusHash: new Map() });
      const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType, entityType: ev.entityType,
        entityId: ev.entityId, payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
      expect(await recompute(event)).toBe(ev.payloadHash);
      await db.execute(sql`UPDATE log_entries SET source_ref = ${`proposal:${uid()}`} WHERE id = ${entry.id}`);
      expect(await recompute(event)).not.toBe(ev.payloadHash);
    }, () => admin);
  });
});

describe("the sent mail coming back through the poll", () => {
  const llmMustNotRun: LlmPort = { chatJson: async () => { throw new Error("the LLM must not be asked"); } };

  async function reingest(db: Db, o: { messageId: string | null; gmailMessageId: string }) {
    const raw = Buffer.from(`Message-ID: ${o.messageId ?? "<none>"}\r\n\r\nbody`);
    const { sha256 } = await storeFile(vaultDir, raw);
    const [row] = await db.insert(schema.rawEmails).values({
      gmailMessageId: o.gmailMessageId, gmailThreadId: `th-${uid()}`,
      fromAddr: "Martin van der Poel <martin@vanderpoel.pro>", toAddr: "opstart@verdergroep.nl",
      subject: "Re: Informatie over uw dossier", sentAt: new Date(), rawRfc822Sha256: sha256,
      bodyText: "body", source: "gmail", messageId: o.messageId?.replace(/^<|>$/g, "") ?? null,
      suggestQueuedAt: new Date(),
    }).returning();
    return row;
  }
  const suggestionsFor = (db: Db, rawEmailId: string) => db.select().from(schema.suggestions)
    .where(sql`${schema.suggestions.rawEmailId} = ${rawEmailId} OR ${schema.suggestions.proposed} ->> 'rawEmailId' = ${rawEmailId}`);

  it("re-ingest during sending creates no suggestion", async () => {
    await isolated(async (db) => {
      const u = await user(db);
      const mid = `<${uid()}@verder.vanderpoel.pro>`;
      const p = await approved(db, { userId: u.id, status: "sending", messageId: mid, sendingAt: new Date() });
      const row = await reingest(db, { messageId: mid, gmailMessageId: `gm-${uid()}` });
      await suggestEntry({ db, llm: llmMustNotRun }, row.id);
      await suggestTask({ db, llm: llmMustNotRun }, row.id);
      expect(await suggestionsFor(db, row.id)).toHaveLength(0);
      const runs = await db.select().from(schema.workerRuns).where(and(
        inArray(schema.workerRuns.worker, ["ollama", "task-mine"]),
        sql`${schema.workerRuns.detail} ->> 'proposalId' = ${p.id}`));
      expect(runs.map((r) => [r.worker, r.status, (r.detail as { skipped: string }).skipped]).sort())
        .toEqual([["ollama", "ok", "sent-by-verder"], ["task-mine", "ok", "sent-by-verder"]]);
    });
  });

  it("re-ingested sent mail creates no suggestion", async () => {
    await isolated(async (db) => {
      // Gmail REPLACED the Message-ID here, so only the Gmail id can match.
      const c = clock(); const g = fakeGmail({ now: c.now, keepsMessageId: false });
      const u = await user(db);
      const p = await approved(db, { userId: u.id });
      await sendApproved(depsFor(db, g, c).deps);
      expect((await byId(db, p.id)).status).toBe("sent");
      const row = await reingest(db, { messageId: g.folder[0].messageId, gmailMessageId: g.folder[0].id });
      await suggestEntry({ db, llm: llmMustNotRun }, row.id);
      await suggestTask({ db, llm: llmMustNotRun }, row.id);
      expect(await suggestionsFor(db, row.id)).toHaveLength(0);
      expect(await entryFor(db, p.id)).toHaveLength(1);
    });
  });
});

describe("concurrency", () => {
  it("two workers claim once", async () => {
    // The one COMMITTED test: two pools, two sendApproved at once, one claim.
    // The send is refused with a 400 so the claim ends in `failed` and writes
    // no entry and no ledger event; the proposal and the run rows it wrote are
    // removed afterwards.
    const a = createDb(URL); const b = createDb(URL);
    // An hour ahead of the real clock: past any 15-minute Gmail deadline a
    // concurrently running suite may have committed, and the rows written at
    // that instant are deleted below.
    const t = new Date(Date.now() + 60 * MIN);
    const now = () => t;
    let sends = 0;
    // A barrier: `ready` is asked AFTER each worker has listed the approved
    // rows and BEFORE either claims, so both are guaranteed to have seen the
    // row as `approved` — the race the conditional UPDATE has to win.
    let arrived = 0;
    let release!: () => void;
    const bothListed = new Promise<void>((r) => { release = r; });
    const port: SendPort = {
      async ready() {
        if (++arrived === 2) release();
        await bothListed;
        return null;
      },
      async send() {
        sends++;
        await new Promise((r) => setTimeout(r, 50));
        throw httpError(400, "refused in test");
      },
      async findSent() { throw new Error("no recovery expected"); },
    };
    const [p] = await a.db.insert(schema.proposals).values({
      kind: "reply", status: "approved", priority: "verder",
      triggerExternal: { gmailId: `x-${uid()}` }, context: {}, payload: { ask: "test" },
      finalPayload: reply(), decidedAt: new Date(),
    }).returning();
    try {
      const n = fakeNotify();
      const results = await Promise.all([
        sendApproved({ db: a.db, port, vaultDir, notify: n.notify, now }),
        sendApproved({ db: b.db, port, vaultDir, notify: n.notify, now }),
      ]);
      expect(sends).toBe(1);
      expect(results.map((r) => r.failed).sort()).toEqual([0, 1]);
      expect((await byId(a.db, p.id)).status).toBe("failed");
      expect(n.sent).toHaveLength(1);
    } finally {
      await a.db.delete(schema.proposals).where(eq(schema.proposals.id, p.id));
      await admin.db.delete(schema.workerRuns).where(and(
        eq(schema.workerRuns.worker, "proposal-send"), gte(schema.workerRuns.ranAt, t)));
      await a.pool.end(); await b.pool.end();
    }
  });
});
