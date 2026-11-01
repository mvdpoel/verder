import { readFile } from "node:fs/promises";
import { z } from "zod";
import { llmDocSchema, realLlmPort } from "../ollama";
import { buildDocMetaPrompt, DOCMETA_PROMPT_VERSION } from "../prompts";
import {
  AUTO_APPLY_RULE, passesAutoApplyRule, scoreDocMeta, summarizeDocMetaRun, type DocMetaOutcome,
} from "./docmeta-score";

// Golden-rule eval for document metadata (docmeta-v2), over Martin's REAL
// verdicts rather than fixtures: the samples come from
// ops/export-docmeta-samples.ts and hold real document text, so they are read
// from $DOCMETA_EVAL_SAMPLES and never committed.
//
// RUN FROM THE HOMELAB HOST (plan 3, Task 13): Ollama at localhost:11434, and
// the samples file is not mounted into the worker. One invocation is ONE run;
// the decision needs three completed runs, and a crashed run is rerun, never
// trusted.
//
// THE GATE IS THE SOORT ONLY (docmeta-score.ts): it is all auto-apply writes.
// The title rate is printed for information and decides nothing.

const sampleSchema = z.array(z.object({
  documentId: z.string(),
  verdict: z.string(),
  text: z.string(),
  promptTitle: z.string(),
  expected: z.object({ title: z.string(), docType: z.string().nullable() }),
}));

const path = process.env.DOCMETA_EVAL_SAMPLES;
if (!path) {
  console.error("docmeta-eval: set DOCMETA_EVAL_SAMPLES (written by export-docmeta-samples)");
  process.exit(1);
}
const samples = sampleSchema.parse(JSON.parse(await readFile(path, "utf8")));
const llm = realLlmPort();
const outcomes: DocMetaOutcome[] = [];
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

for (const [i, s] of samples.entries()) {
  // Soorten and ids only on the terminal: titles and text are Martin's.
  const label = `${String(i + 1).padStart(3)} ${s.documentId.slice(0, 8)} ${s.verdict}`;
  try {
    const out = llmDocSchema.parse(await llm.chatJson(buildDocMetaPrompt(s.promptTitle, s.text)));
    const score = scoreDocMeta(out, s.expected);
    outcomes.push({ kind: "answered", confident: out.confident, score });
    console.log(`${score.gate ? "PASS" : "FAIL"} ${label} — soort ${JSON.stringify(out.docType)}`
      + ` vs ${JSON.stringify(s.expected.docType)}${out.confident ? " (confident)" : ""}`);
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError.
    const timeout = err instanceof Error && err.name === "TimeoutError";
    outcomes.push({ kind: timeout ? "timeout" : "error" });
    console.log(`${timeout ? "TIME" : "ERR "} ${label}${timeout ? "" : ` — ${String(err).slice(0, 120)}`}`);
  }
}

const sum = summarizeDocMetaRun(outcomes);
console.log([
  "",
  `model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"} prompt=${DOCMETA_PROMPT_VERSION}`,
  `n=${sum.n} answered=${sum.answered} n_confident=${sum.nConfident} timeouts=${sum.timeouts} errors=${sum.errors}`,
  `gate (soort) precision among confident: ${pct(sum.gatePrecisionConfident)}`,
  `gate (soort) precision among all answered: ${pct(sum.gatePrecisionAll)}`,
  `title exact-match rate (information only): ${pct(sum.titleExactRate)}`,
  `this run ${passesAutoApplyRule(sum) ? "MEETS" : "does NOT meet"} the rule`
    + ` (n_confident >= ${AUTO_APPLY_RULE.minConfident}, precision >= ${AUTO_APPLY_RULE.minPrecision});`
    + " auto-apply needs all three completed runs to meet it",
].join("\n"));
