// The mime vocabulary comes from the parsers package so the browser and the
// server agree on what counts as a spreadsheet; the subpath keeps SheetJS and
// Buffer out of this client bundle.
import { isSpreadsheetMime, UNINFORMATIVE_MIMES } from "@verder/parsers/sheet-mimes";

export type PreviewKind = "image" | "pdf" | "sheet" | "file";

/**
 * Which preview a document gets. Everything that is not explicitly renderable
 * lands on "file" — the old two-way branch sent it to an <iframe> instead,
 * which is why opening a spreadsheet downloaded it.
 */
export function previewKind(mime: string): PreviewKind {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (isSpreadsheetMime(mime)) return "sheet";
  return "file";
}

/**
 * Whether a document's mime says nothing, so the bytes have to be asked. ABN's
 * "Excel" export arrives as application/octet-stream, and `documents` is
 * append-only — that mime is on the evidence row forever.
 */
export function needsSniffing(mime: string): boolean {
  return UNINFORMATIVE_MIMES.has(mime);
}

/**
 * Whether /api/files may serve a document with `Content-Disposition: inline`.
 *
 * The stored mime is whatever the SENDER wrote on the mail attachment part —
 * nothing validates it at ingest. Served inline on our own origin, an
 * `image/svg+xml` or a `text/html` attachment executes script with Martin's
 * session, and the financial registry is one fetch away. So the allowlist is
 * exactly what the app renders itself, minus the image types that can carry
 * script; everything else downloads.
 */
const SCRIPTABLE_IMAGES = new Set(["image/svg+xml", "image/svg"]);

export function servesInline(mime: string): boolean {
  if (SCRIPTABLE_IMAGES.has(mime)) return false;
  return previewKind(mime) !== "file";
}

export function rowCountLabel(shown: number, truncated: boolean): string | null {
  if (!truncated) return null;
  // Deliberately not "of N". The reader stops at the cap, so nothing has
  // counted the rest — and counting would mean parsing the whole workbook.
  return `Showing the first ${shown} rows`;
}
