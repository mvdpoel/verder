import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { and, eq, or } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { effectiveTitleSql } from "@verder/api/src/effective-status";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";
import { detectPageOrder } from "./page-order";
import { pdfPageCount, reorderPdf, MAX_REORDER_PAGES } from "./reorder-pdf";
import { ocrFooter, rasterizePdf, realOcrPort, type OcrPort } from "./extract";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tiff": "image/tiff" };

// Anything larger is not a scan. The cap is a MEMORY bound, not a policy:
// ingest reads the whole file to hash it, and the share this now points at
// holds a 21.8 GB Downloads.zip — past Node's ~2 GiB Buffer ceiling, where
// readFile throws ERR_FS_FILE_TOO_LARGE and takes the whole sweep down with
// it. 100 MB is ~8x the largest real document on the share.
const MAX_BYTES = 100 * 1024 * 1024;

// Polling via cron, not fs-events: inotify is unreliable on a NAS mount, so a
// periodic non-recursive scan is the boring correct choice. The NAS original is
// never deleted or moved — the vault gets its own content-addressed copy.
/**
 * Put a multi-page scan back in the order its own pages claim, BEFORE it is
 * ingested — so the vault holds the document as written rather than as fed.
 *
 * Only the footer band of each page is OCRed, because the page number is the
 * only thing being read and a full recognition of every page of every new
 * scan would cost more than the whole sweep. detectPageOrder refuses unless
 * every page carries a marker and the numbers form an exact permutation, so
 * the common case — an ordinary scan — costs one cheap OCR pass per page and
 * changes nothing.
 *
 * Returns the corrected bytes, or null to leave the file exactly as it is.
 */
export async function reorderIfShuffled(
  buf: Buffer, mime: string, ocr: OcrPort,
  rasterize: typeof rasterizePdf = rasterizePdf,
): Promise<{ bytes: Buffer; order: number[] } | null> {
  if (mime !== "application/pdf") return null;
  const pages = await rasterize(buf, { dpi: 100, maxPages: MAX_REORDER_PAGES });
  if (pages.length < 2) return null;
  const texts: string[] = [];
  for (const page of pages) texts.push(await ocrFooter(ocr, page));
  const order = detectPageOrder(texts);
  if (!order) return null;
  return { bytes: await reorderPdf(buf, order), order };
}

export async function scanNasFolder(deps: {
  db: Db; scanDir: string; vaultDir: string;
  maxBytes?: number;
  /** Injected in tests; production creates and closes its own. */
  ocr?: OcrPort;
  enqueueDocMeta: (documentId: string) => Promise<void>;
}): Promise<{ ingested: number; skipped: number; read: number; reordered: number }> {
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  let ingested = 0, skipped = 0, read = 0, reordered = 0;
  const ownedOcr = deps.ocr ? null : realOcrPort();
  const ocr = deps.ocr ?? ownedOcr!;
  try {
    for (const name of await readdir(deps.scanDir)) {
      const abs = join(deps.scanDir, name);
      const st = await stat(abs);
      // Skip files modified <10s ago — the scanner may still be writing them.
      if (!st.isFile() || Date.now() - st.mtimeMs < 10_000) continue;
      // Extension allowlist, checked BEFORE any read. The old code mapped an
      // unknown extension to application/octet-stream and ingested it anyway,
      // which was harmless for a folder holding only scans and is not for a
      // 22 GB general archive of zips and disk images.
      const mime = MIME[extname(name).toLowerCase()];
      if (!mime || st.size > maxBytes) { skipped++; continue; }
      // Recognise an already-ingested file from its stat alone. The dedup that
      // matters is still sha256 below, but reaching it costs a full read, and
      // this sweep runs every 2 minutes over NFS against a folder measured in
      // gigabytes: hashing every byte of every file on every tick never
      // finishes. name+size+mtime is exact enough to skip the read, and a miss
      // only falls through to the hash, which is the authority.
      // source_ref is the name at INGEST and never changes -- documents has no
      // UPDATE grant -- so after auto-name renames a file on the share the two
      // no longer agree and this check misses every renamed file forever. It
      // therefore also accepts the EFFECTIVE title, which auto-name sets to
      // exactly the new filename. Measured: without this, 117 of 121 files
      // were fully re-read from the NAS on every single tick.
      const [known] = await deps.db.select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(
          eq(schema.documents.source, "nas-scan"),
          or(eq(schema.documents.sourceRef, name), eq(effectiveTitleSql, name)),
          eq(schema.documents.sizeBytes, st.size),
          eq(schema.documents.receivedAt, st.mtime),
        ));
      if (known) continue;
      let buf: Buffer = await readFile(abs);
      read++;
      let receivedAt = st.mtime;
      // Hash the file AS IT IS first. Reordering costs a rasterize plus a
      // footer OCR per page, and doing it before this check spent that on
      // every already-ingested file on every tick: the sweep's cadence fell
      // from 2 minutes to 12. Only a file that is genuinely new is worth
      // correcting, and one already in the dossier is fixed with
      // `fix-page-order` instead.
      const shaAsFound = sha256Hex(buf);
      const [alreadyHeld] = await deps.db.select({ id: schema.documents.id })
        .from(schema.documents).where(eq(schema.documents.sha256, shaAsFound));
      if (alreadyHeld) continue;
      // A PDF that does not parse is a file still being written, not a
      // document. Skipping leaves it for the next tick; ingesting it is
      // permanent, because documents is append-only and the bytes are already
      // in the ledger by the time anyone opens it.
      if (mime === "application/pdf" && (await pdfPageCount(buf)) === null) {
        await recordRun(deps.db, "page-order", "ok", { name, skipped: "unreadable-pdf" });
        skipped++;
        continue;
      }
      // The file on the share is corrected too, so the two never disagree.
      let reordered0 = false;
      try {
        const fixed = await reorderIfShuffled(buf, mime, ocr);
        if (fixed) {
          reordered0 = true;
          await writeFile(abs, fixed.bytes);
          buf = fixed.bytes;
          // Rewriting the file changes its mtime, and the stat pre-check above
          // matches on name+size+mtime. Recording the mtime read BEFORE the
          // rewrite would make this file miss that check on every future tick
          // and be fully re-read forever.
          receivedAt = (await stat(abs)).mtime;
          reordered++;
        }
      } catch (err) {
        // A document that cannot be reordered is still a document.
        await recordRun(deps.db, "page-order", "error", { name, message: String(err) });
      }
      // Re-hash: reordering changed the bytes, and the sha256 that reaches the
      // ledger must be the bytes the vault holds.
      const sha = reordered0 ? sha256Hex(buf) : shaAsFound;
      if (reordered0) {
        const [seen] = await deps.db.select({ id: schema.documents.id })
          .from(schema.documents).where(eq(schema.documents.sha256, sha));
        if (seen) continue;
      }
      await storeFile(deps.vaultDir, buf);
      const doc = await deps.db.transaction((tx) => ingestDocument(tx, {
        sha256: sha, sizeBytes: buf.length, mime,
        title: name, source: "nas-scan", sourceRef: name, receivedAt }));
      await deps.enqueueDocMeta(doc.id);
      ingested++;
    }
    await recordRun(deps.db, "nas", "ok", { ingested, skipped, read, reordered });
  } catch (err) {
    await recordRun(deps.db, "nas", "error", { message: String(err) });
    throw err;
  } finally {
    await ownedOcr?.close?.();
  }
  return { ingested, skipped, read, reordered };
}
