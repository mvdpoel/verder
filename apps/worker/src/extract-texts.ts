import { inArray, isNull, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { notPurgedSql } from "@verder/api/src/effective-status";
import { UNINFORMATIVE_MIMES, XLS_MIME, XLSX_MIME } from "@verder/parsers";
import { readFile } from "node:fs/promises";
import { storeDocumentText } from "./document-text";

/**
 * Non-image mimes worth a SECOND extraction attempt when the first stored
 * 'none'. Derived from the extractor's own vocabulary rather than spelled out,
 * so teaching extraction a new container cannot leave the backfill behind —
 * which is exactly how ABN's Excel export stayed invisible to search.
 */
const RETRYABLE_MIMES: string[] = [
  "application/pdf", XLS_MIME, XLSX_MIME, ...UNINFORMATIVE_MIMES,
];

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
  // says extractor 'none' on a mime we might now be able to read. The second
  // exists because a failed extraction is stored as 'none' with empty text, and
  // storeDocumentText short-circuits on a matching sha256 — so a fixed or newly
  // taught extractor would never get a second chance at them. That is not
  // hypothetical twice over: an ESM/CJS interop bug left nine production scans
  // stored as 'none' with zero characters, and ABN's "Excel" export sat at
  // 'none' because nothing could read a workbook yet.
  //
  // The uninformative mimes are in the list precisely BECAUSE they say nothing:
  // extraction sniffs the bytes now, so 'application/octet-stream' is no longer
  // a reason to give up — it is the mime the ABN export is recorded under. The
  // retry is cheap: unreadable bytes return 'none' again immediately.
  const rows = await deps.db.select({
    id: schema.documents.id, sha256: schema.documents.sha256, mime: schema.documents.mime,
    staleTextId: schema.documentTexts.documentId,
  })
    .from(schema.documents)
    .leftJoin(schema.documentTexts, eq(schema.documentTexts.documentId, schema.documents.id))
    // A purge deletes the document_texts row this query looks for, so without
    // notPurgedSql a purged document qualifies for the first population FOREVER:
    // every run counts it `failed` on a vault file that is gone on purpose, and
    // in the repairable state where the unlink did not land it is re-extracted
    // and the destroyed text is stored again. Same predicate, same reason, as
    // pendingDocMeta — the two queries are twins and must stay twins.
    // The fragment reads `documents.id` unaliased, which is what
    // `.from(schema.documents)` emits.
    .where(sql`(${schema.documentTexts.documentId} IS NULL OR (
      ${schema.documentTexts.extractor} = 'none'
      AND (${schema.documents.mime} LIKE 'image/%'
        OR ${inArray(schema.documents.mime, RETRYABLE_MIMES)})))
      AND ${notPurgedSql}`)
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
