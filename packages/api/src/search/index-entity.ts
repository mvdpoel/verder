import { eq } from "drizzle-orm";
import { chunkBody, sourceHash, type SearchEntityType } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { effectiveDocument } from "../routers/documents";
import { renderDocument, type Rendered } from "./render";

/**
 * The bridge between the evidence tables and the search index: one entity id in,
 * index-ready chunks out.
 *
 * The renderers in render.ts are pure — they take a row plus the values the
 * caller already resolved. This file is the caller: it loads the row, the
 * extracted text, the effective status and the related party names, hands them
 * to the right renderer, chunks the rendered body and hashes each chunk.
 *
 * Status is resolved with the SAME helpers the rest of the app uses
 * (effectiveDocument, effectiveTaskStatus, effectiveStatus) and then stamped on
 * every chunk. Query-time status filtering reads that one denormalized column
 * instead of four per-entity-type subqueries.
 */

export type RenderedChunk = {
  entityType: SearchEntityType;
  entityId: string;
  chunkIndex: number;
  title: string;
  body: string;
  occurredAt: Date | null;
  status: string | null;
  sourceHash: string;
};

/** null when the entity's row is gone — the caller turns that into []. */
async function renderRow(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<Rendered | null> {
  switch (entityType) {
    case "document": {
      // effectiveDocument throws "Document not found" when the row is gone, and
      // loadAndRender must return [] instead, so existence is checked first.
      const [row] = await db.select({ id: schema.documents.id }).from(schema.documents)
        .where(eq(schema.documents.id, entityId));
      if (!row) return null;
      // Title, doc type and status all move to document_status_changes the
      // moment a doc-meta suggestion is approved — the documents row itself is
      // never updated. effectiveDocument is the one helper that resolves that,
      // and re-deriving it here would drift from the rest of the app.
      const doc = await effectiveDocument(db, entityId);
      const [extracted] = await db.select({ text: schema.documentTexts.text })
        .from(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, entityId));
      return renderDocument(
        { title: doc.effectiveTitle, docType: doc.effectiveDocType,
          mime: doc.mime, receivedAt: doc.receivedAt },
        // No extracted text yet (extraction runs asynchronously, or the file is
        // not text at all): the document is still indexed on title and metadata.
        { status: doc.effectiveStatus, text: extracted?.text ?? "" });
    }
    default:
      throw new Error(`loadAndRender: unsupported entity type "${entityType}"`);
  }
}

/**
 * Loads one entity, renders it, chunks it and hashes each chunk.
 * Returns [] when the row no longer exists, which is how indexEntity learns to
 * drop every chunk it still holds for that entity.
 */
export async function loadAndRender(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<RenderedChunk[]> {
  const rendered = await renderRow(db, entityType, entityId);
  if (!rendered) return [];
  return chunkBody(rendered.body).map((body, chunkIndex) => ({
    entityType, entityId, chunkIndex,
    title: rendered.title, body,
    occurredAt: rendered.occurredAt, status: rendered.status,
    // Per chunk, not per entity: the drain re-embeds chunk by chunk, so a hash
    // covering the whole entity would hide which chunk actually changed.
    sourceHash: sourceHash(rendered.title, body),
  }));
}
