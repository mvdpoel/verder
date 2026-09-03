import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { notPurgedSql } from "@verder/api/src/effective-status";

/**
 * Leave every document a test ingested under `sourceRef` the `document_texts`
 * row a real extraction would have left behind: extractor "none", empty text —
 * exactly what storeDocumentText writes for a file it cannot read.
 *
 * WHY A TEST NEEDS THIS. The dev database is shared and never truncated, and
 * `pendingDocMeta` is `ORDER BY created_at ASC LIMIT 50`. Every fixture ingest
 * that never writes a text row is therefore a permanent squatter at the FRONT
 * of that page: seven pollGmail tests × one checklist.pdf each, run after run,
 * had put 128 documents in the backlog and pushed docmeta-sweep.test.ts's own
 * freshly created document off the page — a suite gone red for reasons with
 * nothing to do with the sweep. CLAUDE.md records the rule from the last time
 * this happened ("a DB test that ingests fixture documents must also write each
 * one a document_texts row with extractor `none`"); this is the one place that
 * spells it, so the next ingest test cannot get it subtly different.
 *
 * Deliberately NOT a delete: `documents` is append-only evidence and no test is
 * allowed a DELETE grant on it. Writing the row a successful extraction would
 * have written is the append-only way to settle the debt.
 *
 * Runs on whatever connection the caller hands it, which must be the WORKER
 * role: 0016 grants verder_app SELECT only on document_texts, deliberately, and
 * the sweep meets the same grants in production.
 *
 * Returns the number of rows written, so a caller can assert it actually had
 * something to settle rather than silently settling nothing.
 */
export async function settleDocumentTexts(db: Db, sourceRef: string): Promise<number> {
  const pending = await db.select({ id: schema.documents.id, sha256: schema.documents.sha256 })
    .from(schema.documents)
    .leftJoin(schema.documentTexts,
      eq(schema.documentTexts.documentId, schema.documents.id))
    // A purged document owes the sweep nothing — pendingDocMeta already
    // excludes it — and writing it the row this helper writes would put back a
    // (empty, but real) document_texts row the purge deleted on purpose. Same
    // law as the guard in storeDocumentText, spelled where the shortcut is.
    .where(and(eq(schema.documents.sourceRef, sourceRef),
      isNull(schema.documentTexts.documentId), notPurgedSql));
  if (pending.length === 0) return 0;
  await db.insert(schema.documentTexts).values(pending.map((d) => ({
    documentId: d.id, sha256: d.sha256, text: "", charCount: 0,
    extractor: "none", truncated: false,
  }))).onConflictDoNothing();
  return pending.length;
}
