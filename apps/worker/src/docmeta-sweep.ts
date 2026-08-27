import { sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";

/**
 * Documents whose text has never been extracted.
 *
 * THE GAP THIS CLOSES: suggest.docmeta was enqueued by exactly one caller —
 * nas.scan. gmail.poll enqueued only suggest.entry, and documents.registerUpload
 * enqueued nothing, so every mailed attachment and every upload sat in the vault
 * findable by its filename alone. Migration 0019 recorded this lesson once
 * already ("18 documents indexed, 0 document_texts rows"); it was still true for
 * two of the three ingest paths.
 *
 * A SWEEP rather than an enqueue at each ingest site: the web app has no pg-boss
 * connection (the worker owns the queue), so registerUpload cannot enqueue
 * directly. A sweep covers all three paths with one mechanism, is idempotent,
 * and repairs the existing backlog on its own — the same outbox-repair shape
 * pollGmail already uses for suggestQueuedAt.
 *
 * CONVERGENCE: storeDocumentText writes a row for EVERY attempt, including
 * extractor "none". So a document that genuinely cannot be read gets a row and
 * is never selected again — this cannot loop.
 *
 * Discarded documents are excluded via the effective status (document_status_changes
 * wins over documents.status, which reads "inbox" forever). IS DISTINCT FROM, not
 * <>: NULL <> 'discarded' is NULL and would drop every document with no status row.
 */
export async function pendingDocMeta(db: Db, limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT d.id
    FROM ${schema.documents} d
    LEFT JOIN ${schema.documentTexts} t ON t.document_id = d.id
    LEFT JOIN LATERAL (
      SELECT status FROM ${schema.documentStatusChanges}
      WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE t.document_id IS NULL
      AND COALESCE(c.status::text, d.status::text) IS DISTINCT FROM 'discarded'
    ORDER BY d.created_at ASC
    LIMIT ${limit}
  `)).rows as { id: string }[];
  return rows.map((r) => r.id);
}
