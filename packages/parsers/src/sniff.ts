/**
 * What the BYTES say a file is. One copy of the magic-byte checks, shared by
 * four consumers: detectSource (statement import), registry-import (the mime it
 * records), the worker's extractor, and the web files route.
 *
 * Takes the WHOLE buffer, not a head slice. A ZIP scatters its entry names
 * through the file — in a minimal generated workbook `xl/workbook.xml` already
 * sits at offset 11198 — so no fixed prefix is reliable. Every caller already
 * holds the complete file in memory, uploads are capped at 50 MB, and
 * Buffer.includes is a memmem scan.
 */

import { isSpreadsheetMime, UNINFORMATIVE_MIMES, XLS_MIME, XLSX_MIME } from "./sheet-mimes";

// The vocabulary itself lives in ./sheet-mimes so client bundles can ask "is
// this a spreadsheet?" without dragging Buffer and SheetJS along; sniffing —
// which needs both — re-exports it so server callers still have one import.
export { isSpreadsheetMime, UNINFORMATIVE_MIMES, XLS_MIME, XLSX_MIME };

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
// OLE2 directory entry names are UTF-16LE. BIFF8 stores the sheet data in a
// "Workbook" stream, BIFF5 in "Book"; .doc uses "WordDocument", .msg and .ppt
// use names of their own. "Book" cannot match inside "Workbook" — the case of
// the B differs — so the two checks stay independent.
const OLE2_WORKBOOK = Buffer.from("Workbook", "utf16le");
const OLE2_BOOK = Buffer.from("Book", "utf16le");
// The `xl/` part is what makes a ZIP a spreadsheet rather than a .docx or .jar.
const OOXML_WORKBOOK = "xl/workbook.xml";

/**
 * The container check readWorkbook and sniffContainer share, so "is this a
 * workbook?" has exactly one answer in the codebase. Both halves need a
 * SECOND marker beyond the magic bytes: OLE2 and ZIP each carry half of
 * Office, and a Word document routed into a statement parser — or recorded on
 * an append-only evidence row as application/vnd.ms-excel — is the failure
 * this prevents.
 */
export function workbookContainer(buf: Buffer): typeof XLS_MIME | typeof XLSX_MIME | null {
  if (buf.subarray(0, 8).equals(OLE2)) {
    return buf.includes(OLE2_WORKBOOK) || buf.includes(OLE2_BOOK) ? XLS_MIME : null;
  }
  if (buf.subarray(0, 4).equals(ZIP) && buf.includes(OOXML_WORKBOOK)) return XLSX_MIME;
  return null;
}

export function sniffContainer(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(PNG)) return "image/png";
  if (buf.subarray(0, 3).equals(JPEG)) return "image/jpeg";
  // ABN AMRO's "Excel" statement download is BIFF8 inside an OLE2 container,
  // regardless of the .xlsx name it arrives with.
  return workbookContainer(buf);
}

/**
 * What a document actually is: the recorded mime unless it says nothing, in
 * which case the bytes decide. Production held an ABN AMRO transaction export
 * recorded as `application/octet-stream` — invisible to extraction, to the
 * preview and to the file route, all for a content-type header.
 *
 * One definition, because the preview, the extractor and the download route
 * disagreeing about what a document is would be its own bug.
 */
export function effectiveMime(recordedMime: string, buf: Buffer): string {
  if (!UNINFORMATIVE_MIMES.has(recordedMime)) return recordedMime;
  return sniffContainer(buf) ?? recordedMime;
}
