// The mime vocabulary comes from the parsers package so the browser and the
// server agree on what counts as a spreadsheet; the subpath keeps SheetJS and
// Buffer out of this client bundle.
import { isSpreadsheetMime } from "@verder/parsers/sheet-mimes";

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

export function rowCountLabel(shown: number, total: number, truncated: boolean): string | null {
  if (!truncated) return null;
  return `Showing first ${shown} of ${total} rows`;
}
