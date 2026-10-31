import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { SUPERSEDABLE_STATUSES, type ProposalKind } from "@verder/api/src/proposal-state";
import { isOwnOutbound, mailPriority, prioritySets, type MailPriority } from "../mail/priority";
import { normaliseMessageId } from "../mail/message-id";
import { gatherContext, type ContextDeps, type ProposalContext, type ProposalTrigger } from "./context";

/**
 * CREATING A PROPOSAL (spec §6.5), ONE PER TRIGGER, AND MAKING STALE ONES STALE.
 *
 * One function for every trigger — mail, letter, task, the mail agent's
 * external message, a follow-up. It assembles the context (`gatherContext`),
 * builds the prompt, and inserts a `drafting` row; the host drafter (Task 14)
 * takes it from there. Nothing here is evidence: no ledger event, ever.
 *
 * AT-LEAST-ONCE. `suggest.entry` may run twice for one raw email, so the insert
 * is `ON CONFLICT DO NOTHING` against the trigger unique indexes (0038) and a
 * second call returns the first row with `created: false`. Those indexes are
 * keyed on the trigger ALONE, so a row the drafter turned into a `question`
 * still blocks a second `reply`. Follow-ups are exempt by design: a thread may
 * be chased more than once (Task 17 dedups those on its notification key).
 *
 * STALENESS, in the same transaction as the insert:
 *   - a newer inbound mail in the thread supersedes every older `drafting` or
 *     `pending` proposal there — the draft answers a message that is no longer
 *     the last word;
 *   - and the mirror image, which at-least-once delivery makes real: an OLDER
 *     mail whose job runs after a newer one's is born `superseded`, or the
 *     stale draft would sit `pending` beside the current one.
 * "Older" compares when the trigger was SENT, never when its row was made: a
 * proposal's trigger time is its raw email's `sent_at`, else its parent
 * proposal's `sent_at` (a follow-up), else its own `created_at`.
 * `approved`, `sending` and everything final are never touched — approving is
 * Martin's decision, and the state machine never goes backwards.
 */

export interface CreateDeps extends ContextDeps {
  /** Task 14's `buildProposalPrompt`. Without it the prompt is NULL and
   *  `proposals-pending` builds it from the stored `context` (and stores it). */
  buildPrompt?: (ctx: ProposalContext, kind: ProposalKind) => string;
}

type RawRow = typeof schema.rawEmails.$inferSelect;
const SUPERSEDABLE = [...SUPERSEDABLE_STATUSES];

/** A proposal's trigger time, for "older than" (see the module comment). */
const triggerTimeSql = sql`COALESCE(
  (SELECT r.sent_at FROM raw_emails r WHERE r.id = ${schema.proposals.triggerRawEmailId}),
  (SELECT pp.sent_at FROM proposals pp WHERE pp.id = ${schema.proposals.parentProposalId}),
  ${schema.proposals.createdAt})`;

const threadKeyOf = (row: RawRow): string | null =>
  row.source === "gmail" ? `gmail:${row.gmailThreadId}` : null;

/**
 * The proposal whose sent mail this raw email IS — `sending` included, because
 * the re-ingest can overtake a slow or crashed `finishSent` (Task 16). Matched
 * on the RFC 5322 Message-ID verder generated (stored with or without its
 * brackets; normalised on both sides) or on the Gmail id the send returned.
 */
export async function proposalForOwnSentMail(
  db: Db, row: Pick<RawRow, "messageId" | "gmailMessageId">,
): Promise<string | null> {
  const mid = row.messageId ? normaliseMessageId(row.messageId) : null;
  const match = [
    eq(schema.proposals.gmailMessageId, row.gmailMessageId),
    ...(mid ? [inArray(schema.proposals.messageId, [mid, `<${mid}>`])] : []),
  ];
  const [p] = await db.select({ id: schema.proposals.id }).from(schema.proposals)
    .where(and(inArray(schema.proposals.status, ["sending", "sent"]), or(...match)))
    .limit(1);
  return p?.id ?? null;
}

/** Mark `drafting`/`pending` proposals on a thread superseded when their
 *  trigger is older than `before`. Returns how many. */
async function supersedeOlder(
  db: Db, threadKey: string, before: Date, reason: string, exceptId?: string,
): Promise<number> {
  const rows = await db.update(schema.proposals)
    .set({ status: "superseded", error: reason, updatedAt: new Date() })
    .where(and(
      eq(schema.proposals.threadKey, threadKey),
      inArray(schema.proposals.status, SUPERSEDABLE),
      ...(exceptId ? [ne(schema.proposals.id, exceptId)] : []),
      sql`${triggerTimeSql} < ${before}`,
    ))
    .returning({ id: schema.proposals.id });
  return rows.length;
}

function triggerColumns(trigger: ProposalTrigger) {
  if ("rawEmailId" in trigger) return { triggerRawEmailId: trigger.rawEmailId };
  if ("documentId" in trigger) return { triggerDocumentId: trigger.documentId, senderGuess: trigger.senderGuess };
  if ("taskId" in trigger) return { triggerTaskId: trigger.taskId };
  if ("external" in trigger) return { triggerExternal: trigger.external };
  return { parentProposalId: trigger.parentProposalId };
}

/** The row an earlier delivery of the same trigger already made. */
async function existingFor(db: Db, trigger: ProposalTrigger): Promise<string | null> {
  const where = "rawEmailId" in trigger
    ? and(eq(schema.proposals.triggerRawEmailId, trigger.rawEmailId), ne(schema.proposals.kind, "follow-up"))
    : "documentId" in trigger ? eq(schema.proposals.triggerDocumentId, trigger.documentId) : undefined;
  if (!where) return null;
  const [p] = await db.select({ id: schema.proposals.id }).from(schema.proposals).where(where).limit(1);
  return p?.id ?? null;
}

/** Why a just-created proposal for `row` is already stale, or null: a later
 *  message in its thread that is Martin's own reply or priority mail. */
async function laterWord(db: Db, row: RawRow): Promise<string | null> {
  const later = await db.select().from(schema.rawEmails)
    .where(and(eq(schema.rawEmails.gmailThreadId, row.gmailThreadId),
      eq(schema.rawEmails.source, row.source), gt(schema.rawEmails.sentAt, row.sentAt)))
    .orderBy(asc(schema.rawEmails.sentAt), asc(schema.rawEmails.id));
  if (later.length === 0) return null;
  const sets = await prioritySets(db);
  for (const r of later) {
    if (isOwnOutbound(sets, { from: r.fromAddr })) {
      if (await proposalForOwnSentMail(db, r)) continue;
      return `superseded: Martin replied himself ${r.id}`;
    }
    if (mailPriority(sets, { from: r.fromAddr }) !== "other") return `superseded: newer inbound ${r.id}`;
  }
  return null;
}

export async function createProposal(
  deps: CreateDeps, trigger: ProposalTrigger,
  priority: MailPriority, kind: "reply" | "follow-up" = "reply",
): Promise<{ id: string; created: boolean }> {
  // Reads (and the kb lookup) happen before the transaction opens.
  const ctx = await gatherContext(deps, trigger);
  const prompt = deps.buildPrompt ? deps.buildPrompt(ctx, kind) : null;

  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [inserted] = await tx.insert(schema.proposals).values({
      kind, status: "drafting", priority, ...triggerColumns(trigger),
      threadKey: ctx.threadKey, partyId: ctx.party?.id ?? null,
      context: ctx, prompt,
    }).onConflictDoNothing().returning({ id: schema.proposals.id });

    if (!inserted) {
      const id = await existingFor(tx, trigger);
      if (!id) throw new Error("proposal insert conflicted but no existing row was found");
      return { id, created: false };
    }

    // Supersession is about inbound mail answering in a thread; a follow-up
    // is a chase of Martin's own word and neither supersedes nor is stale.
    if ("rawEmailId" in trigger && kind !== "follow-up") {
      const [row] = await tx.select().from(schema.rawEmails)
        .where(eq(schema.rawEmails.id, trigger.rawEmailId));
      const threadKey = row ? threadKeyOf(row) : null;
      if (row && threadKey) {
        await supersedeOlder(tx, threadKey, row.sentAt, `superseded: newer inbound ${row.id}`, inserted.id);
        const stale = await laterWord(tx, row);
        if (stale) {
          await tx.update(schema.proposals)
            .set({ status: "superseded", error: stale, updatedAt: new Date() })
            .where(eq(schema.proposals.id, inserted.id));
        }
      }
    }
    return { id: inserted.id, created: true };
  });
}

/**
 * MARTIN ANSWERED IT HIMSELF. For his own outbound mail in a Gmail thread,
 * every `drafting`/`pending` proposal there whose trigger is older than his
 * message becomes `superseded`. That also cancels its reminder (Task 17 reminds
 * only `pending` rows): without it the stale draft keeps nagging, and approving
 * it later sends a second, contradictory reply.
 *
 * A proposal's OWN sent mail coming back through the poll is not Martin
 * replying himself — it is the reply — and supersedes nothing.
 */
export async function supersedeOnOwnReply(db: Db, rawEmailId: string): Promise<number> {
  const [row] = await db.select().from(schema.rawEmails).where(eq(schema.rawEmails.id, rawEmailId));
  if (!row) return 0;
  const threadKey = threadKeyOf(row);
  if (!threadKey) return 0;
  const sets = await prioritySets(db);
  if (!isOwnOutbound(sets, { from: row.fromAddr })) return 0;
  if (await proposalForOwnSentMail(db, row)) return 0;
  return supersedeOlder(db, threadKey, row.sentAt, `superseded: Martin replied himself ${row.id}`);
}

export interface MailProposalResult {
  priority: MailPriority;
  created: boolean;
  proposalId?: string;
  superseded: number;
}

/**
 * The `suggest.entry` step: Verder and creditor mail get a proposal, Martin's
 * own mail supersedes what it answered, everything else does nothing.
 */
export async function proposalsForMail(deps: CreateDeps, rawEmailId: string): Promise<MailProposalResult> {
  const [row] = await deps.db.select().from(schema.rawEmails).where(eq(schema.rawEmails.id, rawEmailId));
  if (!row) return { priority: "other", created: false, superseded: 0 };
  const sets = await prioritySets(deps.db);
  if (isOwnOutbound(sets, { from: row.fromAddr })) {
    return { priority: "other", created: false, superseded: await supersedeOnOwnReply(deps.db, rawEmailId) };
  }
  const priority = mailPriority(sets, { from: row.fromAddr });
  if (priority === "other") return { priority, created: false, superseded: 0 };
  const { id, created } = await createProposal(deps, { rawEmailId }, priority);
  return { priority, created, proposalId: id, superseded: 0 };
}
