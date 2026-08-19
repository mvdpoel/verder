import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { normalizeName } from "@verder/parsers";
import { recordRun } from "./heartbeat";
import { buildTaskPrompt, TASK_PROMPT_VERSION } from "./prompts";
import type { LlmPort } from "./ollama";

/**
 * Action-item mining (runs inside the suggest.entry job, after suggestEntry):
 * ask the model whether the email contains a concrete action item and, if so,
 * queue a `kind: "task"` suggestion for Martin's review. Suggestion-only —
 * nothing becomes a task without approval.
 *
 * Convergence is per-EMAIL, not per-title: one mining attempt per email, ever.
 * If ANY task suggestion for this email exists (any status — rejected
 * included), we skip before touching the LLM, so a rejected suggestion can
 * never resurrect under a reworded title.
 *
 * On LLM failure nothing is inserted and the failure is recorded in
 * worker_runs — the email's entry suggestion already surfaces it to Martin,
 * and there is no deterministic task candidate to degrade to needs-manual.
 * This function never throws: a task-mine failure must never fail (and
 * thereby retry) the surrounding suggest.entry job.
 */

const llmTaskSchema = z.object({
  isTask: z.boolean(),
  title: z.string().default(""),
  details: z.string().default(""),
  // Non-essential fields degrade instead of dropping the whole task:
  // a garbage date or hint becomes null / "other".
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  assigneeHint: z.enum(["martin", "verdergroep", "other"]).catch("other"),
});

export async function suggestTask(
  deps: { db: Db; llm: LlmPort }, rawEmailId: string,
): Promise<void> {
  const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  try {
    const [email] = await deps.db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, rawEmailId));
    if (!email) return;

    // Pre-LLM guard: one mining attempt per email (see doc comment above).
    const prior = await deps.db.select({ id: schema.suggestions.id })
      .from(schema.suggestions)
      .where(and(eq(schema.suggestions.kind, "task"),
        sql`${schema.suggestions.proposed} ->> 'rawEmailId' = ${rawEmailId}`))
      .limit(1);
    if (prior.length > 0) {
      await recordRun(deps.db, "task-mine", "ok", { rawEmailId, skipped: true });
      return;
    }

    const parsed = llmTaskSchema.parse(
      await deps.llm.chatJson(buildTaskPrompt(email.subject, email.bodyText)));
    if (!parsed.isTask) {
      await recordRun(deps.db, "task-mine", "ok", { rawEmailId, isTask: false });
      return;
    }
    const title = parsed.title.trim();
    // isTask without a usable title is an unparseable reply, not a task.
    if (!title) throw new Error("isTask true but title empty");

    await deps.db.insert(schema.suggestions).values({
      kind: "task", rawEmailId, model, promptVersion: TASK_PROMPT_VERSION,
      proposed: {
        key: `task:${rawEmailId}:${normalizeName(title)}`,
        title,
        details: parsed.details,
        dueAt: parsed.dueAt,
        assigneeHint: parsed.assigneeHint,
        rawEmailId,
      } });
    await recordRun(deps.db, "task-mine", "ok", { rawEmailId, suggested: true });
  } catch (err) {
    try { await recordRun(deps.db, "task-mine", "error", { rawEmailId, message: String(err) }); }
    catch { /* recording must not turn a swallowed failure into a thrown one */ }
  }
}
