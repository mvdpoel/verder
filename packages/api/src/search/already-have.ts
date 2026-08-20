import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { realEmbedPort, type EmbedPort } from "./embed";
import { realRerankPort, type RerankPort } from "./rerank";
import { retrieve } from "./retrieve";
import { documentRequestText } from "./document-request";

/**
 * "Do we already have this?" — deep retrieval over the vault for the document
 * a suggestion asks for. Read-only: it links nothing, drafts nothing and sends
 * nothing. Martin picks on the card and the existing approve path does the
 * linking.
 *
 * Degrades, never errors: `retrieve` falls back to the fused order when the
 * rerank times out, and to lexical-only results when the embedder is down.
 */
export type AlreadyHaveDocument = {
  documentId: string; title: string; snippet: string; score: number;
  sha256: string; mime: string;
};
export type AlreadyHaveResult = {
  request: string | null; documents: AlreadyHaveDocument[]; reranked: boolean;
};

const MAX_DOCUMENTS = 3;
const RERANK_CANDIDATES = 20;

export async function alreadyHave(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort },
  suggestionId: string,
): Promise<AlreadyHaveResult> {
  const [s] = await deps.db.select().from(schema.suggestions)
    .where(eq(schema.suggestions.id, suggestionId));
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });

  const request = documentRequestText(s.kind, s.proposed);
  // No document request → no retrieval, no rerank, no GPU time. The card is
  // not rendered in this case either (suggestions.list reports
  // documentRequest: null), so this branch is belt-and-braces, not the gate.
  if (!request) return { request: null, documents: [], reranked: false };

  const { hits, reranked } = await retrieve(deps, {
    q: request, mode: "deep", limit: RERANK_CANDIDATES, entityTypes: ["document"],
  });

  // Top 3 distinct documents, hydrated in ONE batched lookup — never one query
  // per hit (same rule as timeline.ts withLinks).
  const top = hits.filter((h) => h.entityType === "document").slice(0, MAX_DOCUMENTS);
  if (top.length === 0) return { request, documents: [], reranked };
  const rows = await deps.db.select().from(schema.documents)
    .where(inArray(schema.documents.id, top.map((h) => h.entityId)));
  const byId = new Map(rows.map((d) => [d.id, d]));
  const documents = top.flatMap((h): AlreadyHaveDocument[] => {
    const doc = byId.get(h.entityId);
    if (!doc) return [];
    return [{ documentId: doc.id, title: h.title, snippet: h.snippet,
      score: h.score, sha256: doc.sha256, mime: doc.mime }];
  });
  return { request, documents, reranked };
}

/**
 * Real ports, constructed here rather than in the router so the router needs
 * exactly one new import line and the helper stays the only place that knows
 * which ports this feature uses.
 */
export function realAlreadyHaveDeps(db: Db) {
  return { db, embed: realEmbedPort(), rerank: realRerankPort() };
}
