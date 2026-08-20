/**
 * The spreadsheet mime vocabulary, on its own and free of Node.
 *
 * `sniff.ts` builds `Buffer`s at module scope and the barrel pulls in SheetJS,
 * so neither can be imported from a browser bundle. The queue card and the
 * vault preview are client components that need to know *which* mimes are
 * spreadsheets and nothing else, so that question lives here and is published
 * as its own subpath — the same split `@verder/core` makes for the ⌘K palette.
 */

export const XLS_MIME = "application/vnd.ms-excel";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isSpreadsheetMime(mime: string): boolean {
  return mime === XLS_MIME || mime === XLSX_MIME;
}
