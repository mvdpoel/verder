import { readFile } from "node:fs/promises";
import { z } from "zod";
import { realLlmPort } from "../ollama";
import { buildRegistryPrompt, REGISTRY_PROMPT_VERSION } from "../prompts";

// Golden-rule eval for payee classification (registry mining). Mirrors
// run-eval.ts: real Ollama, fixed samples, score printed with prompt version.

const sampleSchema = z.array(z.object({
  counterpartyName: z.string(),
  counterpartyIban: z.string().nullable(),
  mandateId: z.string().nullable(),
  cadence: z.string(),
  typicalAmountCents: z.number().int(),
  chargeCount: z.number().int(),
  expect: z.object({ category: z.string(), isDebtCollector: z.boolean() }),
}));

// Same shape registry-mine.ts validates (llmRegistrySchema).
const shape = z.object({
  name: z.string().min(1),
  category: z.enum(["energy", "insurance", "telecom", "streaming", "software", "housing", "other"]),
  isDebtCollector: z.boolean().default(false),
});

const samples = sampleSchema.parse(
  JSON.parse(await readFile(new URL("./samples-registry.json", import.meta.url), "utf8")));
const llm = realLlmPort();
let pass = 0;
for (const s of samples) {
  const out = shape.safeParse(await llm.chatJson(buildRegistryPrompt(s)));
  const ok = out.success
    && out.data.category === s.expect.category
    && out.data.isDebtCollector === s.expect.isDebtCollector;
  console.log(`${ok ? "PASS" : "FAIL"} — ${s.counterpartyName}${ok ? "" : ` → ${JSON.stringify(out.success ? out.data : out.error.issues)}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${samples.length} with model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"} prompt=${REGISTRY_PROMPT_VERSION}`);
