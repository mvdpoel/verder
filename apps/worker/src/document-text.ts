import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { recordRun } from "./heartbeat";
import { extractDocumentText, type Extractor } from "./extract";

export interface StoredText { text: string; extractor: Extractor; reused: boolean }

/**
 * Extracted document text, stored once per vault file. Vault files are
 * content-addressed and never mutate, so a row whose sha256 still matches the
 * document is final — OCR is expensive and runs once, ever. Derived data: no
 * ledger event is appended here, and reindex can throw the whole table away.
 */
export async function storeDocumentText(
  deps: { db: Db; extract?: typeof extractDocumentText },
  doc: { id: string; sha256: string; mime: string },
  fileBuf: Buffer,
  // `force` re-runs extraction for bytes already extracted. The "once, ever"
  // rule above is about COST, not correctness: when the extractor itself gets
  // better -- orientation detection made 25 upside-down scans readable that
  // had been stored as gibberish -- the stored text is stale, not final.
  opts: { force?: boolean } = {},
): Promise<StoredText> {
  const extract = deps.extract ?? extractDocumentText;
  const [existing] = await deps.db.select().from(schema.documentTexts)
    .where(eq(schema.documentTexts.documentId, doc.id));
  if (!opts.force && existing && existing.sha256 === doc.sha256) {
    return { text: existing.text, extractor: existing.extractor as Extractor, reused: true };
  }
  const out = await extract(doc.mime, fileBuf);
  await deps.db.insert(schema.documentTexts).values({
    documentId: doc.id, sha256: doc.sha256, text: out.text,
    extractor: out.extractor, charCount: out.charCount, truncated: out.truncated,
  }).onConflictDoUpdate({
    target: schema.documentTexts.documentId,
    set: { sha256: doc.sha256, text: out.text, extractor: out.extractor,
      charCount: out.charCount, truncated: out.truncated, extractedAt: new Date() },
  });
  await recordRun(deps.db, "extract", out.error ? "error" : "ok", {
    documentId: doc.id, extractor: out.extractor, charCount: out.charCount,
    truncated: out.truncated, ...(out.error ? { message: out.error } : {}) });
  return { text: out.text, extractor: out.extractor, reused: false };
}
