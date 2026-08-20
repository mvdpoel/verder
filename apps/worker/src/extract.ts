import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "none";

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

export interface OcrPort { ocrImage(png: Buffer): Promise<string> }

type Recognize = (img: Buffer, langs: string) => Promise<{ data: { text: string } }>;

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
  return {
    async ocrImage(png) {
      const mod = await import("tesseract.js") as unknown as
        { recognize?: Recognize; default?: { recognize?: Recognize } };
      const recognize = mod.recognize ?? mod.default?.recognize;
      if (typeof recognize !== "function") {
        throw new Error("tesseract.js: no recognize export (ESM/CJS interop)");
      }
      return (await recognize(png, "nld+eng")).data.text;
    },
  };
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
  mime: string, buf: Buffer,
  deps: { ocr?: OcrPort; rasterize?: typeof rasterizePdf } = {},
): Promise<ExtractedText> {
  const ocr = deps.ocr ?? realOcrPort();
  const rasterize = deps.rasterize ?? rasterizePdf;
  try {
    if (mime === "application/pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = (await pdfParse(buf)).text;
      if (Array.from(parsed).length >= MIN_PDF_TEXT_CHARS) {
        return { ...cap(parsed), extractor: "pdf-parse" };
      }
      const pages = await rasterize(buf);
      const texts: string[] = [];
      for (const page of pages) texts.push(await ocr.ocrImage(page));
      return { ...cap(texts.join("\n\n").trim()), extractor: "ocr-pdf" };
    }
    if (mime.startsWith("image/")) {
      return { ...cap((await ocr.ocrImage(buf)).trim()), extractor: "ocr-image" };
    }
    return { text: "", charCount: 0, extractor: "none", truncated: false };
  } catch (err) {
    // Never throws: a document that cannot be read stays findable by its title
    // and metadata, and the caller records the reason in worker_runs.
    return { text: "", charCount: 0, extractor: "none", truncated: false, error: String(err) };
  }
}
