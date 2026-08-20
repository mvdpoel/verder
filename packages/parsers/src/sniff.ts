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

import { isSpreadsheetMime, XLS_MIME, XLSX_MIME } from "./sheet-mimes";

// The vocabulary itself lives in ./sheet-mimes so client bundles can ask "is
// this a spreadsheet?" without dragging Buffer and SheetJS along; sniffing —
// which needs both — re-exports it so server callers still have one import.
export { isSpreadsheetMime, XLS_MIME, XLSX_MIME };

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

/** Mimes that carry no information, so the bytes get the final word. */
export const UNINFORMATIVE_MIMES: ReadonlySet<string> =
  new Set(["application/octet-stream", "binary/octet-stream", ""]);

export function sniffContainer(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(PNG)) return "image/png";
  if (buf.subarray(0, 3).equals(JPEG)) return "image/jpeg";
  // OLE2 is the legacy Office container. ABN AMRO's "Excel" statement download
  // is BIFF8 inside one of these, regardless of the .xlsx name it arrives with.
  if (buf.subarray(0, 8).equals(OLE2)) return XLS_MIME;
  // ZIP magic alone matches .docx, .odt, .jar and any plain archive. The
  // `xl/` marker is what makes it a spreadsheet — without this second half,
  // a Word document would be routed into a statement parser.
  if (buf.subarray(0, 4).equals(ZIP) && buf.includes("xl/workbook.xml")) return XLSX_MIME;
  return null;
}
