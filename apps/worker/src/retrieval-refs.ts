import type { Db } from "@verder/db";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { retrieve, type SearchHit } from "@verder/api/src/search/retrieve";

/**
 * Retrieval citations for a suggestion: what the index put in front of the
 * model. Fast mode only — this runs inside the suggest.entry job, and the
 * rerank LLM call belongs to the queue-card path, not to every ingested email.
 *
 * Best-effort by construction: retrieval is context, not evidence. A dead
 * Ollama, an empty index or a slow query must never fail (and thereby retry)
 * the suggestion job, so every failure degrades to an empty citation list.
 */
export type RetrievedRef = {
  entityType: string; entityId: string; title: string; score: number; snippet: string;
};
export type RetrieveRefsFn = (query: string) => Promise<RetrievedRef[]>;

const SNIPPET_CHARS = 300;
const MAX_REFS = 5;

export function refsFromHits(hits: SearchHit[]): RetrievedRef[] {
  return hits.slice(0, MAX_REFS).map((h) => ({
    entityType: h.entityType,
    entityId: h.entityId,
    title: h.title,
    score: h.score,
    snippet: h.snippet.slice(0, SNIPPET_CHARS),
  }));
}

/** Injectable form: tests pass their own retrieve function. */
export function retrieveRefsWith(
  run: (query: string) => Promise<{ hits: SearchHit[] }>,
): RetrieveRefsFn {
  return async (query) => {
    try {
      const { hits } = await run(query);
      return refsFromHits(hits);
    } catch {
      return [];
    }
  };
}

export function realRetrieveRefs(db: Db): RetrieveRefsFn {
  const embed = realEmbedPort();
  return retrieveRefsWith((q) =>
    retrieve({ db, embed }, { q, mode: "fast", limit: MAX_REFS }));
}
