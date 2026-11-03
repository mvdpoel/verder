import { and, asc, eq, lt, or } from "drizzle-orm";
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
 * are all kept on the row — a refused answer too. NOT EVIDENCE: nothing here
 * appends a ledger event. Every store call writes one `party-brief` run row.
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
    // never overwrites anything; the next run drafts the newer state.
    if (row.status !== "drafting") return { outcome: "not-drafting", reason: row.status };
    const v = tooLong
      ? { ok: false as const, reason: `the answer is longer than ${MAX_BRIEF_ANSWER_CHARS} characters` }
      : validateBrief(answer, row.context as BriefContext);
    if (!v.ok) {
      await tx.update(schema.partyBriefs).set({
        status: "failed", error: v.reason, modelOutput: answer, model: input.model, updatedAt: now,
      }).where(eq(schema.partyBriefs.partyId, row.partyId));
      return { outcome: "failed", reason: v.reason };
    }
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
  const updated = await db.update(schema.partyBriefs).set({
    status: "failed", error: `drafter: ${input.reason}`, model: input.model ?? null, updatedAt: now,
  }).where(and(eq(schema.partyBriefs.partyId, input.partyId), eq(schema.partyBriefs.status, "drafting")))
    .returning({ partyId: schema.partyBriefs.partyId });
  const result: BriefStoreResult = updated.length
    ? { outcome: "failed", reason: `drafter: ${input.reason}` }
    : { outcome: "not-drafting" };
  await recordRun(db, PARTY_BRIEF_WORKER_NAME, "error", { partyId: input.partyId, outcome: result.outcome, reason: input.reason });
  return result;
}
