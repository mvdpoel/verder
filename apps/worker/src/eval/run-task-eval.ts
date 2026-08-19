import { readFile } from "node:fs/promises";
import { z } from "zod";
import { realLlmPort } from "../ollama";
import { buildTaskPrompt, TASK_PROMPT_VERSION } from "../prompts";

// Golden-rule eval for action-item mining (task suggestions). Mirrors
// run-registry-eval.ts: real Ollama, fixed samples, score printed with prompt
// version. Scored: isTask match, plus assigneeHint when the sample IS a task.
// expect.title is reference-only (free-form model output — never scored).
// The FYI-only negatives target entry-v1's known invented-action-item weakness.

const sampleSchema = z.array(z.object({
  subject: z.string(),
  bodyText: z.string(),
  expect: z.object({
    isTask: z.boolean(),
    title: z.string().optional(),
    assigneeHint: z.enum(["martin", "verdergroep", "other"]).optional(),
  }),
}));

// Same shape task-mine.ts validates (llmTaskSchema).
const shape = z.object({
  isTask: z.boolean(),
  title: z.string().default(""),
  details: z.string().default(""),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  assigneeHint: z.enum(["martin", "verdergroep", "other"]).catch("other"),
});

const samples = sampleSchema.parse(
  JSON.parse(await readFile(new URL("./samples-task.json", import.meta.url), "utf8")));
const llm = realLlmPort();
let pass = 0;
for (const s of samples) {
  const out = shape.safeParse(await llm.chatJson(buildTaskPrompt(s.subject, s.bodyText)));
  const ok = out.success
    && out.data.isTask === s.expect.isTask
    && (!s.expect.isTask || !s.expect.assigneeHint
      || out.data.assigneeHint === s.expect.assigneeHint);
  console.log(`${ok ? "PASS" : "FAIL"} — ${s.subject}${ok ? "" : ` → ${JSON.stringify(out.success ? out.data : out.error.issues)}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${samples.length} with model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"} prompt=${TASK_PROMPT_VERSION}`);
