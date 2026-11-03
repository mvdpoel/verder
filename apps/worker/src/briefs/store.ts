import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { PARTY_BRIEF_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { gatherBriefContext, type BriefContext } from "./context";
import { BRIEF_PROMPT_VERSION, buildBriefPrompt } from "./prompt";
import { validateBrief } from "./validate";

/**
 * The brief's lifecycle, worker side (the host only carries text):
 *
 *   pending ──(promptForBrief: context gathered, prompt built, stored)──▶ drafting
 *   drafting ──(storeBrief: answer passes validateBrief)──────────────────▶ ready
 *   drafting ──(storeBrief: refused │ storeBriefFailure: claude failed)────▶ failed
 *   any ──(markBriefPending: a new mail from them)────────────────────────▶ pending
 *
 * A `drafting` row older than STALE_DRAFTING_MS is offered again: the drafter
 * died between the two calls, and nothing else would ever move it.
 *
 * Golden rule: the context, prompt, prompt version, model and RAW model output
 * are kept on the row — a refused answer too — AND, because the row is
 * overwritten by the next draft, every attempt is APPENDED to
 * `party_brief_drafts` (0043) in the same transaction as the row's update:
 * ready, refused, a drafter failure, and a late answer. NOT EVIDENCE: nothing
 * here appends a ledger event. Every store call writes one `party-brief` run row.
 */

export const BRIEF_BATCH = 5;
export const STALE_DRAFTING_MS = 30 * 60 * 1000;
export const MAX_BRIEF_ANSWER_CHARS = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BriefStoreOutcome = "ready" | "failed" | "not-drafting" | "not-found";
export interface BriefStoreResult { outcome: BriefStoreOutcome; reason?: string }

const draftable = (now: Date) => or(
  eq(schema.partyBriefs.status, "pending"),
  and(eq(schema.partyBriefs.status, "drafting"),
    lt(schema.partyBriefs.updatedAt, new Date(now.getTime() - STALE_DRAFTING_MS))),
);

/** Parties whose brief should be drafted next, oldest request first. */
export async function pendingBriefs(db: Db, now = new Date(), limit = BRIEF_BATCH): Promise<string[]> {
  const rows = await db.select({ partyId: schema.partyBriefs.partyId }).from(schema.partyBriefs)
    .where(draftable(now))
    .orderBy(asc(schema.partyBriefs.requestedAt), asc(schema.partyBriefs.partyId)).limit(limit);
  return rows.map((r) => r.partyId);
}

/**
 * Gathers the context, builds the prompt, stores BOTH on the row and moves it
 * to `drafting` — the prompt printed is exactly the prompt recorded. null when
 * the brief is not draftable (already drafted, or re-claimed) or there is
 * nothing to summarise, which is recorded as `failed` rather than left pending
 * to be retried every five minutes.
 */
export async function promptForBrief(db: Db, partyId: string, now = new Date()): Promise<string | null> {
  if (!UUID.test(partyId)) return null;
  const [row] = await db.select().from(schema.partyBriefs)
    .where(and(eq(schema.partyBriefs.partyId, partyId), draftable(now)));
  if (!row) return null;
  const ctx = await gatherBriefContext(db, partyId);
  if (!ctx) {
    await db.update(schema.partyBriefs).set({ status: "failed", error: "nothing to summarise", updatedAt: now })
      .where(and(eq(schema.partyBriefs.partyId, partyId), eq(schema.partyBriefs.status, row.status)));
    await recordRun(db, PARTY_BRIEF_WORKER_NAME, "ok", { partyId, outcome: "no-context" });
    return null;
  }
  const prompt = buildBriefPrompt(ctx);
  // Conditional on the status we read: a mail landing meanwhile re-marked it
  // pending, and the next run drafts that newer state instead.
  const claimed = await db.update(schema.partyBriefs).set({
    status: "drafting", context: ctx, prompt, promptVersion: BRIEF_PROMPT_VERSION, error: null, updatedAt: now,
  }).where(and(eq(schema.partyBriefs.partyId, partyId), eq(schema.partyBriefs.status, row.status)))
    .returning({ partyId: schema.partyBriefs.partyId });
  return claimed.length ? prompt : null;
}

export async function storeBrief(
  db: Db, input: { partyId: string; model: string; answer: string }, now = new Date(),
): Promise<BriefStoreResult> {
  const tooLong = input.answer.length > MAX_BRIEF_ANSWER_CHARS;
  const answer = tooLong ? input.answer.slice(0, MAX_BRIEF_ANSWER_CHARS) : input.answer;
  const result: BriefStoreResult = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(schema.partyBriefs)
      .where(eq(schema.partyBriefs.partyId, input.partyId)).for("update");
    if (!row) return { outcome: "not-found" };
    // A late answer (re-marked pending by a newer mail, a second drafter run)
    // never overwrites the row; the next run drafts the newer state. What the
    // model said is still kept — WITHOUT a context or prompt, because the
    // row's may already belong to a newer claim and would misattribute it.
    if (row.status !== "drafting") {
      await tx.insert(schema.partyBriefDrafts).values({
        partyId: row.partyId, verdict: "late", model: input.model, modelOutput: answer,
        error: `not-drafting: ${row.status}`, createdAt: now,
      });
      return { outcome: "not-drafting", reason: row.status };
    }
    const attempt = {
      partyId: row.partyId, context: row.context, prompt: row.prompt, promptVersion: row.promptVersion,
      model: input.model, modelOutput: answer, createdAt: now,
    };
    const v = tooLong
      ? { ok: false as const, reason: `the answer is longer than ${MAX_BRIEF_ANSWER_CHARS} characters` }
      : validateBrief(answer, row.context as BriefContext);
    if (!v.ok) {
      await tx.insert(schema.partyBriefDrafts).values({ ...attempt, verdict: "refused", error: v.reason });
      await tx.update(schema.partyBriefs).set({
        status: "failed", error: v.reason, modelOutput: answer, model: input.model, updatedAt: now,
      }).where(eq(schema.partyBriefs.partyId, row.partyId));
      return { outcome: "failed", reason: v.reason };
    }
    await tx.insert(schema.partyBriefDrafts).values({
      ...attempt, verdict: "ready", summary: v.summary, sourceRefs: v.sourceRefs });
    await tx.update(schema.partyBriefs).set({
      status: "ready", summary: v.summary, sourceRefs: v.sourceRefs, modelOutput: answer, model: input.model,
      generatedAt: now, error: null, updatedAt: now,
    }).where(eq(schema.partyBriefs.partyId, row.partyId));
    return { outcome: "ready" };
  });
  await recordRun(db, PARTY_BRIEF_WORKER_NAME, result.outcome === "ready" || result.outcome === "not-drafting" ? "ok" : "error",
    { partyId: input.partyId, outcome: result.outcome, ...(result.reason ? { reason: result.reason.slice(0, 200) } : {}) });
  return result;
}

/** The host got no answer at all (claude exited non-zero, timed out, or said nothing). */
export async function storeBriefFailure(
  db: Db, input: { partyId: string; model?: string; reason: string }, now = new Date(),
): Promise<BriefStoreResult> {
  const error = `drafter: ${input.reason}`;
  // One statement: the attempt is appended only when the row really was
  // drafting, with the context and prompt that draft was given.
  const updated = (await db.execute(sql`
    WITH failed AS (
      UPDATE party_briefs SET status = 'failed', error = ${error}, model = ${input.model ?? null}, updated_at = ${now}
      WHERE party_id = ${input.partyId}::uuid AND status = 'drafting'
      RETURNING party_id, context, prompt, prompt_version)
    INSERT INTO party_brief_drafts (party_id, verdict, context, prompt, prompt_version, model, error, created_at)
    SELECT party_id, 'failed', context, prompt, prompt_version, ${input.model ?? null}, ${error}, ${now} FROM failed
    RETURNING party_id`)).rows;
  const result: BriefStoreResult = updated.length
    ? { outcome: "failed", reason: `drafter: ${input.reason}` }
    : { outcome: "not-drafting" };
  await recordRun(db, PARTY_BRIEF_WORKER_NAME, "error", { partyId: input.partyId, outcome: result.outcome, reason: input.reason });
  return result;
}
