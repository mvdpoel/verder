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
  const rows = await deps.db.select({
    id: schema.documents.id, sha256: schema.documents.sha256, mime: schema.documents.mime,
  })
    .from(schema.documents)
    .leftJoin(schema.documentTexts, eq(schema.documentTexts.documentId, schema.documents.id))
    .where(isNull(schema.documentTexts.documentId))
    .orderBy(sql`${schema.documents.receivedAt} ASC`)
    .limit(opts.limit ?? 100_000);

  const out: ExtractBackfillResult = { scanned: rows.length, extracted: 0, reused: 0, failed: 0 };
  for (const [i, doc] of rows.entries()) {
    try {
      const buf = await readFile(readFilePath(deps.vaultDir, doc.sha256));
      const stored = await storeDocumentText({ db: deps.db }, doc, buf);
      if (stored.reused) out.reused++; else out.extracted++;
    } catch {
      out.failed++;
    }
    deps.onProgress?.(i + 1, rows.length);
  }
  return out;
}
