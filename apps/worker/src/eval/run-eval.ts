import { readFile } from "node:fs/promises";
import { z } from "zod";
import { realLlmPort } from "../ollama";
import { buildEntryPrompt, PROMPT_VERSION } from "../prompts";

const sampleSchema = z.array(z.object({
  from: z.string(), subject: z.string(), bodyText: z.string(),
  expect: z.object({
    actionItemCount: z.number(),
    summaryContains: z.string(),
    clarity: z.string().optional(),
  }),
}));

const shape = z.object({ summary: z.string(), actionItems: z.array(z.object({ description: z.string(), clarity: z.string() })).default([]) });

const samples = sampleSchema.parse(
  JSON.parse(await readFile(new URL("./samples.json", import.meta.url), "utf8")));
const llm = realLlmPort();
let pass = 0;
for (const s of samples) {
  const out = shape.safeParse(await llm.chatJson(
    buildEntryPrompt({ from: s.from, subject: s.subject, sentAt: new Date(), bodyText: s.bodyText })));
  const ok = out.success
    && out.data.actionItems.length === s.expect.actionItemCount
    && out.data.summary.toLowerCase().includes(s.expect.summaryContains)
    && (!s.expect.clarity || out.data.actionItems.every((a) => a.clarity === s.expect.clarity));
  console.log(`${ok ? "PASS" : "FAIL"} — ${s.subject}${ok ? "" : ` → ${JSON.stringify(out.success ? out.data : out.error.issues)}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${samples.length} with model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"} prompt=${PROMPT_VERSION}`);
