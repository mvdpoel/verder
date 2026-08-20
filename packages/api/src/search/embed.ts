/**
 * The embedding seam for the hybrid index.
 *
 * This file holds the CONTRACT: the port type, the vector width the
 * search_chunks.embedding column is declared with, the env var that selects the
 * model, and nomic's two task prefixes. The real Ollama client behind the port
 * (realEmbedPort) lands here in the search.drain task; the entity loader only
 * needs the contract, and tests substitute a fake port so indexing is testable
 * without a GPU.
 */

/** One vector per input text, in order. null = embedding failed for that text. */
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };

/** nomic-embed-text is 768-dimensional; search_chunks.embedding is vector(768). */
export const EMBED_DIMENSIONS = 768;

/** Env var read by the real client; default model is nomic-embed-text. */
export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";

/** Prefix for text that is STORED in the index. */
export function asDocument(text: string): string {
  return `search_document: ${text}`;
}

/** Prefix for text that is SEARCHED WITH. Used by the query pipeline. */
export function asQuery(text: string): string {
  return `search_query: ${text}`;
}
