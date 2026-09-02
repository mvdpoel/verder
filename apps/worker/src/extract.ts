import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { effectiveMime, isSpreadsheetMime, readWorkbook } from "@verder/parsers";
import { looksLikeProse, stopwordShare, worthRotating } from "./text-quality";

const run = promisify(execFile);

export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "sheet" | "none";

export interface ExtractedText {
  text: string;
  /** Code points extracted BEFORE the cap: charCount > text length means truncated. */
  charCount: number;
  extractor: Extractor;
  truncated: boolean;
  error?: string;
}

// A PDF that parses to less than this is a scan in a PDF wrapper: the NAS
// scanner produces image-only PDFs and pdf-parse returns a couple of newlines.
export const MIN_PDF_TEXT_CHARS = 200;
export const RASTER_DPI = 200;
export const MAX_OCR_PAGES = 20;
// The cap is on characters (code points), not bytes, so a Dutch letter full of
// accents is never cut mid-code-point.
export const MAX_TEXT_CHARS = 1_000_000;

export interface OcrRect { left: number; top: number; width: number; height: number }

export interface OcrPort {
  /** `rotateRadians` rotates the image before recognition; omitted means as-is. */
  ocrImage(png: Buffer, rotateRadians?: number, rectangle?: OcrRect): Promise<string>;
  /** Releases the tesseract worker, when the port owns one. */
  close?(): Promise<void>;
}

/**
 * Orientations tried when a page does not come out as language, in the order
 * they are worth trying: 180 first, because a sheet fed the wrong way round is
 * far commoner than one fed sideways, and every misread page found on the
 * Workspace share was 180.
 */
export const RETRY_ANGLES = [Math.PI, Math.PI / 2, -Math.PI / 2];

type Recognize = (img: Buffer, langs: string) => Promise<{ data: { text: string } }>;
type CreateWorker = (langs: string) => Promise<{
  recognize: (img: Buffer, opts?: { rotateRadians?: number; rectangle?: OcrRect })
    => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
}>;

/**
 * tesseract.js ships both an ESM and a CJS build, and which one a `import()`
 * resolves to differs between the Mac dev environment and the node:22-slim
 * container. Under the CJS shape the named exports live on `.default`, so
 * destructuring `recognize` straight off the namespace yields undefined and the
 * call dies with "recognize is not a function".
 *
 * That failure is invisible in normal running: extractDocumentText catches it
 * and returns extractor "none", so the document is still indexed — on its
 * filename alone. It shipped to production exactly that way, and nine scanned
 * letters came back with zero characters while the backfill reported 0 failures.
 * Hence the interop fallback, and the explicit throw: an OCR path that cannot
 * find its OCR must say so, not quietly return nothing.
 */
export function realOcrPort(): OcrPort {
  // ONE worker per extraction, created on first use and terminated by close().
  // The module-level recognize() spins a worker up and tears it down per call,
  // which was already wasteful per page and becomes four times so once a bad
  // page is retried at other orientations.
  let worker: Awaited<ReturnType<CreateWorker>> | null = null;
  async function get() {
    if (worker) return worker;
    const mod = await import("tesseract.js") as unknown as
      { createWorker?: CreateWorker; default?: { createWorker?: CreateWorker } };
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (typeof createWorker !== "function") {
      throw new Error("tesseract.js: no createWorker export (ESM/CJS interop)");
    }
    worker = await createWorker("nld+eng");
    return worker;
  }
  return {
    async ocrImage(png, rotateRadians, rectangle) {
      const w = await get();
      const opts: { rotateRadians?: number; rectangle?: OcrRect } = {};
      if (rotateRadians !== undefined) opts.rotateRadians = rotateRadians;
      if (rectangle !== undefined) opts.rectangle = rectangle;
      const res = await w.recognize(png, Object.keys(opts).length ? opts : undefined);
      return res.data.text;
    },
    async close() {
      const w = worker;
      worker = null;
      // A failure to terminate must not fail an extraction that already
      // produced its text.
      if (w) { try { await w.terminate(); } catch { /* best effort */ } }
    },
  };
}

/**
 * OCR one page, and if the result is not language, try it the other way up.
 *
 * A scanner fed a sheet the wrong way round produces a page tesseract reads as
 * mirrored gibberish rather than as nothing, so the failure is silent: 25 of
 * the 138 documents on the Workspace share were in that state, indexed and
 * searchable on 3000 characters of noise. The first orientation that reads as
 * prose wins; if none does, the highest-scoring one is kept, because a bad
 * page still beats an empty one for a filename or a search hit.
 */
export async function ocrPageUpright(
  ocr: OcrPort, png: Buffer,
): Promise<{ text: string; rotatedRadians: number }> {
  const first = await ocr.ocrImage(png);
  // worthRotating decides the short-text case, which is the hard one: a blank
  // page cannot be helped, a short page of whole words is a real short
  // document, and a short page of fragments is one the scanner fed sideways.
  // An earlier version refused on word count alone and thereby never rotated
  // page 1 of the ASML Code of Conduct, which is 23 fragments at 0 degrees and
  // reads correctly at -90.
  if (!worthRotating(first)) return { text: first, rotatedRadians: 0 };
  let best = { text: first, rotatedRadians: 0, score: stopwordShare(first) };
  for (const angle of RETRY_ANGLES) {
    const text = await ocr.ocrImage(png, angle);
    const score = stopwordShare(text);
    if (score > best.score) best = { text, rotatedRadians: angle, score };
    if (looksLikeProse(text)) break;
  }
  return { text: best.text, rotatedRadians: best.rotatedRadians };
}

/** Rasterizes the first MAX_OCR_PAGES pages to PNG with poppler's pdftoppm. */
export async function rasterizePdf(
  pdf: Buffer, opts: { dpi?: number; maxPages?: number } = {},
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "verder-raster-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf);
    await run("pdftoppm", ["-png", "-r", String(opts.dpi ?? RASTER_DPI),
      "-f", "1", "-l", String(opts.maxPages ?? MAX_OCR_PAGES), input, join(dir, "page")],
      { timeout: 120_000 });
    // pdftoppm zero-pads page numbers from ten pages on (page-01.png), so the
    // file list is read back and sorted, never constructed by hand.
    const names = (await readdir(dir)).filter((n) => n.endsWith(".png")).sort();
    return await Promise.all(names.map((n) => readFile(join(dir, n))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cap(raw: string): { text: string; charCount: number; truncated: boolean } {
  const cps = Array.from(raw);
  if (cps.length <= MAX_TEXT_CHARS) return { text: raw, charCount: cps.length, truncated: false };
  return { text: cps.slice(0, MAX_TEXT_CHARS).join(""), charCount: cps.length, truncated: true };
}

export async function extractDocumentText(
  recordedMime: string, buf: Buffer,
  deps: { ocr?: OcrPort; rasterize?: typeof rasterizePdf } = {},
): Promise<ExtractedText> {
  // Only a port this function created may be closed by it: an injected port
  // belongs to the caller, and terminating it would break the next document.
  const ownedOcr = deps.ocr ? null : realOcrPort();
  const ocr = deps.ocr ?? ownedOcr!;
  const rasterize = deps.rasterize ?? rasterizePdf;
  // Documents arrive from mail attachments and NAS scans, and the mime that
  // gets recorded is whatever the source claimed. Production held an ABN AMRO
  // transaction export recorded as `application/octet-stream`, which extraction
  // therefore refused to read — a bank statement invisible to search because of
  // a content-type header. So: the bytes get consulted, but ONLY when the
  // recorded mime says nothing. A recorded `application/pdf` is still trusted.
  const mime = effectiveMime(recordedMime, buf);
  try {
    if (mime === "application/pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = (await pdfParse(buf)).text;
      if (Array.from(parsed).length >= MIN_PDF_TEXT_CHARS) {
        return { ...cap(parsed), extractor: "pdf-parse" };
      }
      const pages = await rasterize(buf);
      const texts: string[] = [];
      // Orientation is decided per PAGE, not per document: a scanner fed a
      // stack the wrong way round rarely gets every sheet wrong the same way.
      for (const page of pages) texts.push((await ocrPageUpright(ocr, page)).text);
      return { ...cap(texts.join("\n\n").trim()), extractor: "ocr-pdf" };
    }
    if (mime.startsWith("image/")) {
      return { ...cap((await ocrPageUpright(ocr, buf)).text.trim()), extractor: "ocr-image" };
    }
    if (isSpreadsheetMime(mime)) {
      // Tab-separated so the extracted text reads like the statement it is, and
      // one heading per sheet so a multi-sheet workbook is legible in a search hit.
      const text = readWorkbook(buf)
        .map((s) => `## ${s.name}\n${s.rows.map((r) => r.join("\t")).join("\n")}`)
        .join("\n\n")
        .trim();
      return { ...cap(text), extractor: "sheet" };
    }
    return { text: "", charCount: 0, extractor: "none", truncated: false };
  } catch (err) {
    // Never throws: a document that cannot be read stays findable by its title
    // and metadata, and the caller records the reason in worker_runs.
    return { text: "", charCount: 0, extractor: "none", truncated: false, error: String(err) };
  } finally {
    await ownedOcr?.close?.();
  }
}


/**
 * Width and height straight out of a PNG's IHDR, which is always the first
 * chunk: 8 bytes of signature, 4 of length, 4 of type, then the two lengths.
 * Needed because a tesseract rectangle is in pixels and the footer band is a
 * fraction of the page.
 */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The strip of a page a printed page number lives in. */
export const FOOTER_BAND = 0.14;

/**
 * OCR only the bottom of a page. Reading the footer of a six-page letter is
 * cheap this way and a full recognition of every page is not — and the page
 * number is the only thing being looked for.
 */
export async function ocrFooter(ocr: OcrPort, png: Buffer): Promise<string> {
  const size = pngSize(png);
  if (!size) return await ocr.ocrImage(png);
  const height = Math.max(1, Math.round(size.height * FOOTER_BAND));
  return await ocr.ocrImage(png, undefined, {
    left: 0, top: size.height - height, width: size.width, height });
}
