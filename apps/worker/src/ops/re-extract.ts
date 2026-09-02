/**
 * Re-run extraction for documents whose stored text is not language.
 *
 * storeDocumentText deliberately extracts once per vault file, because OCR is
 * expensive and content-addressed bytes never change. That rule is about COST:
 * when the EXTRACTOR improves, the stored text is stale rather than final, and
 * orientation detection made 25 upside-down scans on the Workspace share
 * readable that had been stored — and indexed, and searched — as gibberish.
 *
 * Selects on the score rather than on a list, so it is safe to re-run: a
 * document that reads as prose is never touched.
 *
 *   pnpm --filter worker re-extract [--dry-run] [--limit N]
 *
 * Afterwards the search index still holds the OLD text:
 *   pnpm --filter worker reindex --entity=document
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { storeDocumentText } from "../document-text";
import { looksLikeProse, stopwordShare, wordCount, MIN_WORDS } from "../text-quality";

export async function reExtractGarbled(deps: {
  db: ReturnType<typeof createDb>["db"];
  vaultDir: string;
  limit?: number;
  dryRun?: boolean;
  log?: (s: string) => void;
}): Promise<{ scanned: number; candidates: number; improved: number; unchanged: number }> {
  const log = deps.log ?? (() => {});
  const rows = await deps.db.select({
    id: schema.documents.id, sha256: schema.documents.sha256,
    mime: schema.documents.mime, title: schema.documents.title,
    text: schema.documentTexts.text,
  }).from(schema.documents)
    .innerJoin(schema.documentTexts, eq(schema.documentTexts.documentId, schema.documents.id));

  let candidates = 0, improved = 0, unchanged = 0;
  for (const row of rows) {
    // Only text long enough to score, and only text that fails. A short or
    // empty extraction is not evidence of a rotation problem — the blank
    // pages on this share produced 0 and 3 characters — and re-running OCR on
    // it costs the same as on a real page for nothing.
    if (wordCount(row.text) < MIN_WORDS || looksLikeProse(row.text)) continue;
    candidates++;
    if (deps.limit && candidates > deps.limit) break;
    const before = stopwordShare(row.text);
    if (deps.dryRun) {
      log(`  would re-extract ${row.title} (${(before * 100).toFixed(1)}%)`);
      continue;
    }
    let buf: Buffer;
    try { buf = await readFile(readFilePath(deps.vaultDir, row.sha256)); }
    catch (err) { log(`  ! ${row.title}: ${String(err)}`); continue; }
    const out = await storeDocumentText({ db: deps.db }, row, buf, { force: true });
    const after = stopwordShare(out.text);
    if (after > before) {
      improved++;
      log(`  ${row.title}: ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}%`
        + `${looksLikeProse(out.text) ? "  READABLE" : ""}`);
    } else {
      unchanged++;
      log(`  = ${row.title}: still ${(after * 100).toFixed(1)}%`);
    }
  }
  return { scanned: rows.length, candidates, improved, unchanged };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--limit");
  try {
    const res = await reExtractGarbled({
      db, vaultDir: process.env.VAULT_DIR ?? "/vault",
      dryRun: argv.includes("--dry-run"),
      limit: i >= 0 ? Number(argv[i + 1]) : undefined,
      log: (l) => console.log(l),
    });
    console.log(`re-extract: scanned ${res.scanned}, candidates ${res.candidates}, `
      + `improved ${res.improved}, unchanged ${res.unchanged}`);
    if (res.improved > 0) console.log("now run: pnpm --filter worker reindex --entity=document");
  } finally { await pool.end(); }
}
