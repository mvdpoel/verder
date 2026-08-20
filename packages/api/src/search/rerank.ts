import { z } from "zod";

/**
 * Deep-mode reranking. Only the agent surfaces and the "do we already have this?"
 * panel pay this latency; ⌘K and /search stay on the fused order.
 *
 * The port owns the prompt, the JSON parsing and the ref→id mapping, and returns
 * plain scores so retrieve() only has to sort. It throws on any failure — timeout,
 * HTTP error, non-JSON reply — because retrieve() is the place that decides a
 * degradation is not an error.
 */

export const RERANK_PROMPT_VERSION = "rerank-v1";
/** 20 s, not the 120 s used for mining: a person is waiting on this one. */
export const RERANK_TIMEOUT_MS = 20_000;

const SNIPPET_CHARS = 400;

export type RerankPort = {
  rerank(query: string, candidates: { id: string; text: string }[]):
    Promise<{ id: string; score: number }[]>;
};

export function buildRerankPrompt(
  query: string, candidates: { ref: number; text: string }[],
): string {
  return [
    "You are ranking search results from a Dutch debt-restructuring (WSNP/bewindvoering) dossier.",
    "Order the numbered candidates below from most to least relevant to the search query.",
    "Reply with strict JSON only, one key:",
    "order (array of the candidate numbers, most relevant first, each number exactly once).",
    "Never invent a number that is not listed and never drop a listed number.",
    "",
    `Query: ${query}`,
    "",
    ...candidates.map((c) => `[${c.ref}] ${c.text}`),
  ].join("\n");
}

const orderSchema = z.object({ order: z.array(z.number().int()).default([]) });

export function realRerankPort(
  opts?: { url?: string; model?: string; timeoutMs?: number },
): RerankPort {
  return {
    async rerank(query, candidates) {
      const url = opts?.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
      const model = opts?.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
      const prompt = buildRerankPrompt(query, candidates.map((c, i) => ({
        ref: i + 1, text: c.text.slice(0, SNIPPET_CHARS),
      })));
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, messages: [{ role: "user", content: prompt }], format: "json", stream: false,
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? RERANK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message: { content: string } };
      const parsed = orderSchema.parse(JSON.parse(data.message.content));

      // A model that repeats, invents or drops a number must not corrupt the page:
      // unusable refs are skipped here, and retrieve() keeps whatever the model never
      // scored in its fused position behind the scored ones.
      const scored: { id: string; score: number }[] = [];
      const used = new Set<number>();
      for (const ref of parsed.order) {
        const idx = ref - 1;
        if (idx < 0 || idx >= candidates.length || used.has(idx)) continue;
        used.add(idx);
        scored.push({ id: candidates[idx].id, score: candidates.length - scored.length });
      }
      return scored;
    },
  };
}
