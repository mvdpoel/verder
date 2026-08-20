import { setTimeout as sleep } from "node:timers/promises";

/**
 * Ollama embedding client (nomic-embed-text, 768 dims): the vector half of the
 * hybrid index. Mirrors LlmPort in apps/worker/src/ollama.ts — an injectable
 * port with one real implementation reading env — so the indexer, the drain and
 * the search router are all testable without a GPU.
 *
 * It lives in @verder/api rather than the worker because three consumers need
 * it: the indexer (packages/api/src/search/index-entity.ts), the query pipeline
 * (packages/api/src/search/retrieve.ts) and the drain job in apps/worker.
 *
 * Ollama on the homelab is shared with qwen3.5:9b (suggest.entry, registry.mine
 * and three evals), so this client is deliberately polite: batches of 16, at
 * most 2 requests in flight, an explicit timeout, and three attempts with
 * exponential backoff. A permanently failing batch yields nulls rather than an
 * exception — a chunk without an embedding is still findable by full text, and
 * that is the spec's documented degraded mode. A THROWN error from this port is
 * therefore a genuine fault (a crashed client, a bug), never "Ollama is down".
 */

export const EMBED_DIMENSIONS = 768;
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };

export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 16;
const CONCURRENCY = 2;
const ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

/** nomic is asymmetric: indexed text carries this prefix. */
export function asDocument(text: string): string {
  return `search_document: ${text}`;
}

/** …and query text carries this one. Used by the query pipeline. */
export function asQuery(text: string): string {
  return `search_query: ${text}`;
}

async function embedBatch(
  url: string, model: string, timeoutMs: number, texts: string[],
): Promise<number[][]> {
  const res = await fetch(`${url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const vectors = data.embeddings ?? [];
  if (vectors.length !== texts.length) {
    throw new Error(`ollama embed returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const v of vectors) {
    // A wrong-width vector cannot go into vector(768) and must never be
    // half-written: fail the whole batch instead.
    if (v.length !== EMBED_DIMENSIONS) {
      throw new Error(`ollama embed dims ${v.length} != ${EMBED_DIMENSIONS}`);
    }
  }
  return vectors;
}

export function realEmbedPort(
  opts: { url?: string; model?: string; timeoutMs?: number } = {},
): EmbedPort {
  const url = opts.url ?? process.env.OLLAMA_URL ?? DEFAULT_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async embed(texts) {
      const model = opts.model ?? process.env[EMBED_MODEL_ENV] ?? DEFAULT_MODEL;
      const out: (number[] | null)[] = new Array<number[] | null>(texts.length).fill(null);
      const starts: number[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) starts.push(i);
      let next = 0;
      const runner = async (): Promise<void> => {
        for (;;) {
          const slot = next++;
          if (slot >= starts.length) return;
          const start = starts[slot]!;
          const batch = texts.slice(start, start + BATCH_SIZE);
          for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            try {
              const vectors = await embedBatch(url, model, timeoutMs, batch);
              vectors.forEach((v, i) => { out[start + i] = v; });
              break;
            } catch {
              // Last attempt: those slots stay null and the caller keeps the
              // chunk lexically searchable.
              if (attempt < ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, starts.length) }, () => runner()));
      return out;
    },
  };
}
