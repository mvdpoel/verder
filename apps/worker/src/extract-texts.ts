import { isNull, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { readFile } from "node:fs/promises";
import { storeDocumentText } from "./document-text";

export interface ExtractBackfillResult {
  scanned: number; extracted: number; reused: number; failed: number;
}

/**
 * Extract text for vault documents that have none.
 *
 * `storeDocumentText` only ever runs from the suggest.docmeta job, so every
 * document ingested before this sub-project existed — the entire vault at
 * deploy time — has no document_texts row and is therefore indexed on its
 * filename and metadata alone. That is precisely the case this feature exists
 * to fix, so it needs its own backfill rather than waiting for each document to
 * be touched again.
 *
 * Safe to interrupt and rerun: storeDocumentText short-circuits when the stored
 * sha256 still matches, so a second pass re-reads nothing and re-OCRs nothing.
 * A file that fails (missing from the vault, unreadable, an extractor crash) is
 * counted and skipped — one bad scan must never strand the rest of the corpus.
 *
 * Writing document_texts fires the trigger from migration 0019, so each
 * extracted document re-enters search_outbox and the drain re-indexes it with
 * its text. No explicit reindex call is needed here.
 */
export async function extractMissingTexts(
  deps: { db: Db; vaultDir: string; onProgress?: (done: number, total: number) => void },
  opts: { limit?: number } = {},
): Promise<ExtractBackfillResult> {
  // Two populations: documents with no text row at all, AND documents whose row
  // says extractor 'none' on a mime we CAN read. The second exists because a
  // failed extraction is stored as 'none' with empty text, and storeDocumentText
  // short-circuits on a matching sha256 — so a fixed extractor would never get a
  // second chance at them. That is not hypothetical: an ESM/CJS interop bug left
  // nine production scans stored as 'none' with zero characters. Retrying an
  // unsupported mime (octet-stream) costs nothing; it returns 'none' immediately.
  const rows = await deps.db.select({
    id: schema.documents.id, sha256: schema.documents.sha256, mime: schema.documents.mime,
    staleTextId: schema.documentTexts.documentId,
  })
    .from(schema.documents)
    .leftJoin(schema.documentTexts, eq(schema.documentTexts.documentId, schema.documents.id))
    .where(sql`${schema.documentTexts.documentId} IS NULL OR (
      ${schema.documentTexts.extractor} = 'none'
      AND (${schema.documents.mime} LIKE 'image/%' OR ${schema.documents.mime} = 'application/pdf'))`)
    .orderBy(sql`${schema.documents.receivedAt} ASC`)
    .limit(opts.limit ?? 100_000);

  const out: ExtractBackfillResult = { scanned: rows.length, extracted: 0, reused: 0, failed: 0 };
  for (const [i, doc] of rows.entries()) {
    try {
      const buf = await readFile(readFilePath(deps.vaultDir, doc.sha256));
      if (doc.staleTextId) {
        // Clear the 'none' row so storeDocumentText cannot short-circuit on the
        // unchanged sha256. Derived data — deleting it loses nothing.
        await deps.db.delete(schema.documentTexts)
          .where(eq(schema.documentTexts.documentId, doc.id));
      }
      const stored = await storeDocumentText({ db: deps.db }, doc, buf);
      if (stored.reused) out.reused++; else out.extracted++;
    } catch {
      out.failed++;
    }
    deps.onProgress?.(i + 1, rows.length);
  }
  return out;
}
