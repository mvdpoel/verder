import { and, asc, eq, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { insertEntry } from "@verder/api/src/routers/entries";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { readFilePath } from "@verder/api/src/storage";
import { PROPOSAL_SEND_WORKER_NAME } from "@verder/api/src/worker-names";
import { readFile } from "node:fs/promises";
import { rateLimitedUntil, retryAfterFrom } from "../gmail";
import { ownMailboxAddresses } from "../mail/relevance";
import type { NotifyFn } from "../notify/notify";
import { buildMime, newMessageId, SEND_MAX_BYTES, type MimeAttachment } from "./mime";

/**
 * SENDING AN APPROVED PROPOSAL, EXACTLY ONCE (Plan 2 Task 16, spec §12.3).
 *
 * `approved → sending → sent | failed`, and the one law under all of it: a
 * proposal gives AT MOST ONE message, and a message Gmail may have accepted is
 * NEVER sent again. So:
 *   - the claim is one conditional UPDATE (`WHERE status = 'approved'`), and
 *     the RFC 5322 Message-ID is generated and stored IN that same statement —
 *     before Gmail is called — so recovery can always ask for it;
 *   - the outbound log entry and its `entry.created` are written only once the
 *     message is known to have gone (`finishSent`, one transaction);
 *   - a row stuck in `sending` is resolved by ASKING Gmail (read-only) and
 *     never by sending again;
 *   - only an answer that PROVES non-delivery may mark `failed` or un-claim:
 *     a refusal before anything was sent, a Gmail 4xx, or a 429. A timeout, a
 *     socket reset or a 5xx leaves the row in `sending` for recovery.
 *
 * NOT EVIDENCE, EXCEPT FOR THE ONE ENTRY. `proposals` appends nothing; a send
 * appends exactly one `entry.created` through the existing `insertEntry`, with
 * `source: "proposal"` and `sourceRef: "proposal:<id>"` — fields
 * `entryEventPayload` already carries, so no payload shape and no event type
 * changes, and the existing verifier recomputes it.
 */

export { SEND_MAX_BYTES };

/** `finishSent` failures AFTER Gmail accepted the message before the row stops
 *  being retried (and stops costing Gmail calls) and a human is told. */
export const FINISH_MAX_FAILURES = 3;
/** Gmail `messages.list` calls recovery may spend per tick, across all rows. */
export const RECOVERY_MAX_PER_TICK = 3;
/** A `sending` row younger than this is a send in flight, not a stuck one. */
export const RECOVERY_AFTER_MS = 10 * 60_000;
/** Not found in Sent this long after the claim: `failed`, MAYBE sent. */
export const NOT_FOUND_FAIL_MS = 30 * 60_000;
/** A 429 that carries no `Retry after` instant still gets a deadline: the
 *  fifteen minutes every measured Gmail lockout used. */
export const DEFAULT_RATE_LIMIT_MS = 15 * 60_000;

export interface SentMatch { id: string; threadId: string }

export interface FindSentQuery {
  messageId: string; gmailThreadId: string | null; subject: string; sentAfter: Date;
  /** How many `messages.list` calls this search may make (1 or 2). */
  maxCalls: number;
}

export interface FindSentResult {
  match: SentMatch | null;
  /** `messages.list` calls actually made, counted against the tick's cap. */
  calls: number;
  /** Both searches ran (or the first found it): a null match is a real "not found". */
  conclusive: boolean;
  /** The fallback matched more than one message, so it picked none. */
  ambiguous: boolean;
}

export interface SendPort {
  /** null when sending is configured; a reason otherwise. Checked BEFORE a
   *  claim, so a missing token keeps the approval waiting instead of failing it. */
  ready?(): Promise<string | null>;
  send(raw: Buffer, threadId?: string): Promise<SentMatch>;
  findSent(q: FindSentQuery): Promise<FindSentResult>;
}

/** An error that PROVES nothing left the house (thrown before any network I/O). */
export class NotSentError extends Error {
  readonly notSent = true;
}

type Proposal = typeof schema.proposals.$inferSelect;

export interface FinalReply {
  to: string[]; cc: string[]; subject: string; body: string;
  attachmentDocumentIds: string[]; entrySummary: string;
}

export interface SendDeps {
  db: Db; port: SendPort; vaultDir: string; notify: NotifyFn;
  /** Whose approval this send carries out: the entry's `created_by`. */
  userIdFor?: (p: Proposal) => string;
  now?: () => Date;
  /** Injectable for tests only: the transaction that records `sent`. */
  finish?: typeof finishSent;
}

export interface SendResult { sent: number; recovered: number; failed: number }

// ---------------------------------------------------------------------------
// Searching Sent — the Gmail algorithm, written against two primitives so it
// is tested without googleapis (gmail-send.ts binds them to the real client).
// ---------------------------------------------------------------------------

export interface GmailSearch {
  /** ONE `messages.list` call. */
  list(q: string): Promise<SentMatch[]>;
  /** One `messages.get` with format=metadata. */
  meta(id: string): Promise<{ subject: string; internalDate: Date }>;
}

/** Candidates the fallback inspects at most, so a busy Sent folder cannot turn
 *  one recovery into dozens of `messages.get` calls. */
export const FALLBACK_MAX_CANDIDATES = 10;

const bare = (mid: string) => mid.trim().replace(/^<(.*)>$/, "$1");
const unfold = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Find the message verder sent, read-only.
 *
 * First `rfc822msgid:<id>`. Whether Gmail KEEPS a client-generated Message-ID
 * on `users.messages.send` is unmeasured (Plan 2 Task 21 Step 7), so when that
 * finds nothing the FALLBACK lists `in:sent` from a day before the claim with
 * the subject, scoped to the Gmail thread when known, and accepts a candidate
 * only on the EXACT subject and an internalDate at or after the claim. Exactly
 * one match or nothing: two matches is `ambiguous` and never a guess, because a
 * wrong match would mark a mail sent that may not have gone.
 */
export async function findSentWith(g: GmailSearch, q: FindSentQuery): Promise<FindSentResult> {
  if (q.maxCalls < 1) return { match: null, calls: 0, conclusive: false, ambiguous: false };
  const byId = await g.list(`rfc822msgid:${bare(q.messageId)}`);
  if (byId.length > 0) return { match: byId[0], calls: 1, conclusive: true, ambiguous: false };
  if (q.maxCalls < 2) return { match: null, calls: 1, conclusive: false, ambiguous: false };

  const after = Math.floor(q.sentAfter.getTime() / 1000) - 86_400;
  const subjectTerm = q.subject.replace(/["\\]/g, " ").trim();
  const listed = await g.list(`in:sent after:${after}${subjectTerm ? ` subject:"${subjectTerm}"` : ""}`);
  const scoped = q.gmailThreadId ? listed.filter((m) => m.threadId === q.gmailThreadId) : listed;
  const want = unfold(q.subject);
  const matches: SentMatch[] = [];
  for (const m of scoped.slice(0, FALLBACK_MAX_CANDIDATES)) {
    const meta = await g.meta(m.id);
    if (unfold(meta.subject) === want && meta.internalDate >= q.sentAfter) matches.push(m);
  }
  if (matches.length === 1) return { match: matches[0], calls: 2, conclusive: true, ambiguous: false };
  return { match: null, calls: 2, conclusive: true, ambiguous: matches.length > 1 };
}

// ---------------------------------------------------------------------------
// The outbound entry.
// ---------------------------------------------------------------------------

export function finalReplyOf(p: Pick<Proposal, "finalPayload">): FinalReply {
  const f = p.finalPayload as Partial<FinalReply> | null;
  if (!f || !Array.isArray(f.to) || typeof f.subject !== "string" || typeof f.body !== "string"
    || typeof f.entrySummary !== "string") {
    throw new Error("proposal has no approved reply in final_payload");
  }
  return { to: f.to, cc: f.cc ?? [], subject: f.subject, body: f.body,
    attachmentDocumentIds: f.attachmentDocumentIds ?? [], entrySummary: f.entrySummary };
}

/** The FULL sent text, uncut — the entry's `details`, so the logbook holds
 *  what went and the ledger delta of a send stays +1 (no `.eml` document). */
export function sentText(f: FinalReply): string {
  return [
    `Aan: ${f.to.join(", ")}`,
    ...(f.cc.length ? [`Cc: ${f.cc.join(", ")}`] : []),
    `Onderwerp: ${f.subject}`,
    "",
    f.body,
  ].join("\n");
}

/**
 * Record `sent` and write the outbound entry, in ONE transaction. A row no
 * longer in `sending` (another tick finished it) is left alone and writes no
 * second entry.
 *
 * `participantPartyIds` is `[party_id]` only when there IS a party: a letter or
 * an external mail may have none, `entry_participants.party_id` is NOT NULL,
 * and a NULL there would fail after Gmail accepted the message, on every
 * recovery tick, forever.
 */
export async function finishSent(
  db: Db, p: Proposal, sent: SentMatch, sentAt: Date, userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(schema.proposals).set({
      status: "sent", gmailMessageId: sent.id,
      gmailThreadId: sent.threadId || p.gmailThreadId, sentAt, updatedAt: sentAt,
    }).where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "sending"))).returning();
    if (!row) return;
    const f = finalReplyOf(row);
    const entry = await insertEntry(tx as unknown as Db, userId, {
      occurredAt: sentAt, channel: "email", direction: "outbound",
      summary: f.entrySummary, details: sentText(f),
      source: "proposal", sourceRef: `proposal:${row.id}`,
      participantPartyIds: row.partyId ? [row.partyId] : [],
      documentIds: [...new Set(f.attachmentDocumentIds)],
      actionItems: [],
    }, { eventType: "entry.created" });
    await tx.update(schema.proposals).set({ resultEntryId: entry.id })
      .where(eq(schema.proposals.id, row.id));
  });
}

// ---------------------------------------------------------------------------
// One tick.
// ---------------------------------------------------------------------------

function httpStatus(err: unknown): number | null {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.response?.status, e?.code]) {
    if (typeof v === "number" && v >= 100 && v < 600) return v;
    if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
  }
  return null;
}

/** The deadline a Gmail 429 sets, or null when this was not a 429. */
function rateLimitDeadline(err: unknown, now: Date): Date | null {
  const when = retryAfterFrom(err);
  if (when) return when;
  return httpStatus(err) === 429 ? new Date(now.getTime() + DEFAULT_RATE_LIMIT_MS) : null;
}

const askOf = (p: Proposal): string => {
  const ask = (p.payload as { ask?: unknown } | null)?.ask;
  if (typeof ask === "string" && ask.trim()) return ask.trim();
  const subject = (p.finalPayload as { subject?: unknown } | null)?.subject;
  return typeof subject === "string" ? subject : "voorstel";
};

const short = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 500);

interface Context {
  gmailThreadId?: string | null;
  reply?: { inReplyTo?: string; references?: string } | null;
}

/** The bytes of one approved proposal, or the reason it cannot be sent. */
async function build(
  db: Db, vaultDir: string, p: Proposal, date: Date,
): Promise<{ raw: Buffer } | { refused: string }> {
  const f = finalReplyOf(p);
  const attachments: MimeAttachment[] = [];
  let total = 0;
  for (const id of [...new Set(f.attachmentDocumentIds)]) {
    // Re-checked at SEND time, not trusted from approval: a discard is never
    // written back to documents.status, and a purge is a row of its own.
    const d = await effectiveDocument(db, id);
    if (d.effectiveStatus === "discarded") return { refused: `bijlage ${d.effectiveTitle} is weggegooid` };
    if (d.purge !== null) return { refused: `bijlage ${d.effectiveTitle} is definitief verwijderd` };
    let bytes: Buffer;
    try { bytes = await readFile(readFilePath(vaultDir, d.sha256)); }
    catch { return { refused: `bijlage ${d.effectiveTitle} ontbreekt in de kluis` }; }
    total += bytes.length;
    if (total > SEND_MAX_BYTES) return { refused: "de bijlagen zijn samen te groot om te versturen" };
    attachments.push({ fileName: d.effectiveTitle, mime: d.mime, bytes });
  }
  const ctx = (p.context ?? {}) as Context;
  const own = ownMailboxAddresses()[0] ?? "martin@vanderpoel.pro";
  const raw = buildMime({
    from: `Martin van der Poel <${own}>`, to: f.to, cc: f.cc, subject: f.subject, body: f.body,
    messageId: p.messageId!, inReplyTo: ctx.reply?.inReplyTo, references: ctx.reply?.references,
    date, attachments,
  });
  if (raw.length > SEND_MAX_BYTES) return { refused: "het bericht is te groot om te versturen" };
  return { raw };
}

/**
 * The Gmail thread to file the send under: only for a mail that arrived over
 * Gmail (or a follow-up on one). A JMAP thread id is a Stalwart id, and the
 * mail agent's external trigger relies on the threading headers alone.
 */
function gmailThreadFor(p: Proposal): string | undefined {
  if (p.triggerExternal != null) return undefined;
  const id = (p.context as Context | null)?.gmailThreadId;
  return typeof id === "string" && id ? id : undefined;
}

export async function sendApproved(deps: SendDeps): Promise<SendResult> {
  const { db, port, notify } = deps;
  const now = deps.now ?? (() => new Date());
  const finish = deps.finish ?? finishSent;
  const userIdFor = deps.userIdFor ?? ((p: Proposal) => {
    if (!p.decidedBy) throw new Error("proposal has no decided_by");
    return p.decidedBy;
  });
  const result: SendResult = { sent: 0, recovered: 0, failed: 0 };
  const errors: { proposalId: string; message: string }[] = [];
  const record = (status: "ok" | "error", detail: unknown) =>
    db.insert(schema.workerRuns).values({ worker: PROPOSAL_SEND_WORKER_NAME, status,
      detail: JSON.parse(JSON.stringify(detail)), ranAt: now() });

  // 0. One account, one user-rate limit: while ANY Gmail path holds a live
  //    deadline the whole tick is skipped, carrying the instant forward.
  const until = await rateLimitedUntil(db, now());
  if (until) {
    await record("ok", { skipped: "rate-limited", retryAfter: until.toISOString() });
    return result;
  }
  const rateLimited = async (err: unknown, deadline: Date, extra: object) => {
    await record("error", { ...result, ...extra, message: short(err),
      retryAfter: deadline.toISOString(), errors });
    return result;
  };

  const markFailed = async (p: Proposal, reason: string, title: string, body: string, dedup: string) => {
    const rows = await db.update(schema.proposals)
      .set({ status: "failed", error: reason, updatedAt: now() })
      .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "sending")))
      .returning({ id: schema.proposals.id });
    if (rows.length === 0) return;
    result.failed++;
    await notify({ kind: "system", level: "time-sensitive", title, body,
      link: `verder://proposal/${p.id}`, dedupKey: dedup });
  };
  const notSent = (p: Proposal, reason: string) => markFailed(p, reason,
    `Niet verstuurd: ${askOf(p)}`, `${reason}. Er is niets verzonden.`,
    `send-failed:${p.id}`);

  /** finishSent, and on failure the poison guard. True when it is recorded sent. */
  const tryFinish = async (p: Proposal, sent: SentMatch, sentAt: Date): Promise<boolean> => {
    try {
      await finish(db, p, sent, sentAt, userIdFor(p));
      return true;
    } catch (err) {
      const message = short(err);
      errors.push({ proposalId: p.id, message });
      // Own short statement. The Gmail id is kept too: it is proof the message
      // went, it lets the re-ingest skip match even if Gmail replaced the
      // Message-ID, and recovery then needs no Gmail call at all.
      const [row] = await db.update(schema.proposals).set({
        finishFailures: sql`${schema.proposals.finishFailures} + 1`,
        error: `logboek niet geschreven: ${message}`,
        gmailMessageId: sql`COALESCE(${schema.proposals.gmailMessageId}, ${sent.id})`,
        gmailThreadId: sql`COALESCE(${schema.proposals.gmailThreadId}, ${sent.threadId || null})`,
        updatedAt: now(),
      }).where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "sending")))
        .returning({ finishFailures: schema.proposals.finishFailures });
      if (row && row.finishFailures === FINISH_MAX_FAILURES) {
        await notify({ kind: "system", level: "time-sensitive",
          title: "Mail VERSTUURD, logboek ontbreekt",
          body: `${askOf(p)} — de mail is verzonden (Gmail ${sent.id}), maar de logboekregel kon niet worden geschreven: ${message}`,
          link: `verder://proposal/${p.id}`, dedupKey: `finish-failed:${p.id}` });
      }
      return false;
    }
  };

  // 1. Recover first: a row stuck in `sending` is ASKED about, never re-sent.
  const stuckBefore = new Date(now().getTime() - RECOVERY_AFTER_MS);
  const stuck = await db.select().from(schema.proposals).where(and(
    eq(schema.proposals.status, "sending"),
    lt(schema.proposals.sendingAt, stuckBefore),
    lt(schema.proposals.finishFailures, FINISH_MAX_FAILURES),
  )).orderBy(asc(schema.proposals.sendingAt));
  let budget = RECOVERY_MAX_PER_TICK;
  for (const p of stuck) {
    let found: SentMatch | null = p.gmailMessageId
      ? { id: p.gmailMessageId, threadId: p.gmailThreadId ?? "" } : null;
    let conclusive = found !== null;
    let ambiguous = false;
    if (!found) {
      if (budget <= 0) continue;
      try {
        const r = await port.findSent({ messageId: p.messageId!, gmailThreadId: gmailThreadFor(p) ?? null,
          subject: finalReplyOf(p).subject, sentAfter: p.sendingAt!, maxCalls: Math.min(2, budget) });
        budget -= r.calls;
        found = r.match; conclusive = r.conclusive; ambiguous = r.ambiguous;
      } catch (err) {
        const deadline = rateLimitDeadline(err, now());
        if (deadline) return rateLimited(err, deadline, { during: "recovery", proposalId: p.id });
        errors.push({ proposalId: p.id, message: short(err) });
        budget = 0; // a failing search is not retried on the next row this tick
        continue;
      }
    }
    if (found) {
      if (await tryFinish(p, found, p.sendingAt!)) result.recovered++;
      continue;
    }
    if (ambiguous) {
      await db.update(schema.proposals)
        .set({ error: "meerdere berichten in Verzonden passen; niet automatisch gekozen", updatedAt: now() })
        .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "sending")));
    }
    if (conclusive && p.sendingAt! < new Date(now().getTime() - NOT_FOUND_FAIL_MS)) {
      // The copy never claims the mail did not go: Gmail accepted nothing we
      // can PROVE, which is not the same as proving it sent nothing.
      await markFailed(p, ambiguous ? "meerdere kandidaten in Verzonden" : "niet gevonden in Verzonden",
        `Versturen onzeker: ${askOf(p)}`,
        "De mail is MOGELIJK verstuurd. Kijk eerst in Gmail › Verzonden voordat je opnieuw goedkeurt.",
        `send-uncertain:${p.id}`);
    }
  }

  // 2–6. Claim, build, send, finish — each approved proposal once.
  const approved = await db.select({ id: schema.proposals.id }).from(schema.proposals)
    .where(eq(schema.proposals.status, "approved"))
    .orderBy(asc(schema.proposals.decidedAt), asc(schema.proposals.createdAt));
  if (approved.length > 0 && port.ready) {
    const reason = await port.ready();
    if (reason) {
      // Nothing is claimed: the approvals wait, and the row says why.
      await record("error", { ...result, waiting: approved.length, message: `not configured: ${reason}`, errors });
      return result;
    }
  }
  for (const { id } of approved) {
    const claimedAt = now();
    const [p] = await db.update(schema.proposals).set({
      status: "sending", messageId: newMessageId(), sendingAt: claimedAt, updatedAt: claimedAt,
    }).where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, "approved"))).returning();
    if (!p) continue; // another tick has it

    let raw: Buffer;
    try {
      const built = await build(db, deps.vaultDir, p, claimedAt);
      if ("refused" in built) { await notSent(p, built.refused); continue; }
      raw = built.raw;
    } catch (err) {
      // Nothing has been sent yet, so any failure here proves non-delivery.
      await notSent(p, `kon het bericht niet opbouwen: ${short(err)}`);
      continue;
    }

    let sent: SentMatch;
    try {
      sent = await port.send(raw, gmailThreadFor(p));
    } catch (err) {
      const deadline = rateLimitDeadline(err, now());
      if (deadline) {
        // A 429 proves non-delivery but is NOT a failure: undo the claim (the
        // one move back the state machine allows, because nothing left), and
        // the first tick after the deadline sends it with a fresh Message-ID.
        await db.update(schema.proposals)
          .set({ status: "approved", messageId: null, sendingAt: null, updatedAt: now() })
          .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "sending")));
        return rateLimited(err, deadline, { during: "send", proposalId: p.id });
      }
      const status = httpStatus(err);
      if (err instanceof NotSentError || (status !== null && status >= 400 && status < 500)) {
        await notSent(p, `Gmail weigerde het bericht${status ? ` (${status})` : ""}: ${short(err)}`);
      } else {
        // Timeout, socket reset, 5xx: the result is UNKNOWN. Recovery asks.
        errors.push({ proposalId: p.id, message: short(err) });
      }
      continue;
    }
    if (await tryFinish(p, sent, now())) result.sent++;
  }

  await record(errors.length ? "error" : "ok", { ...result, ...(errors.length ? { errors } : {}) });
  return result;
}
