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

/** One hour: generously past a slow OCR plus a 120 s LLM call, and past pg-boss's
 *  own 15-minute job expiry, so a document is only ever re-offered once the job
 *  that owned it can no longer be running. */
export const DOCMETA_ENQUEUE_TTL_MS = 60 * 60 * 1000;

/**
 * A per-process memory of what the sweep has already enqueued.
 *
 * WHY THIS EXISTS: pendingDocMeta stops returning a document only once
 * suggest.docmeta has written its document_texts row, and that job costs an OCR
 * pass plus a 120 s LLM call. Without this guard a sweep ticking every minute
 * re-enqueues the same five documents on every tick while the first is still
 * running: the queue grows by five jobs a minute and drains at roughly one
 * every two, so the eighteen-document backlog becomes hundreds of redundant
 * OCR+LLM passes on a GPU that is already shared with the evals — which is the
 * contention that aborts eval runs today. Enqueue rate is not drain rate, and
 * only the second one is bounded by the batch size.
 *
 * In-process and not a table: a document that is genuinely stuck becomes
 * eligible again after the TTL, and a worker restart costs at most one repeated
 * round. Neither is worth a migration in a slice that deliberately ships
 * without one. `now` is a parameter so the cool-down is testable without clocks.
 */
export function makeEnqueueGuard(ttlMs: number = DOCMETA_ENQUEUE_TTL_MS) {
  const seen = new Map<string, number>();
  return function admit(ids: string[], now: number): string[] {
    for (const [id, at] of seen) if (now - at >= ttlMs) seen.delete(id);
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.set(id, now);
    return fresh;
  };
}
