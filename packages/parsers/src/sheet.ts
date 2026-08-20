import * as XLSX from "xlsx";

/**
 * Workbook container reader — the ONLY module in the monorepo that imports
 * SheetJS. Keeping the dependency behind one function means a library swap
 * touches one file, and means parsing untrusted workbooks (they arrive as mail
 * attachments) has exactly one entry point.
 *
 * `raw: false` is not a preference. Spreadsheet cells hold binary floats, and
 * `money.ts` exists specifically to keep floats out of euro arithmetic — a
 * cell read as the number -8.6 would launder a float straight through it.
 * Reading the FORMATTED TEXT keeps "-8.60" a string all the way to
 * decimalToCents.
 *
 * `defval: ""` pads every row to the sheet's full width, so a short row never
 * shifts the column a value is read from.
 */
export interface SheetData {
  name: string;
  rows: string[][];
}

// The two containers this feature accepts, mirroring isSpreadsheetMime's set:
// OLE2 (BIFF8 .xls) and ZIP (OOXML .xlsx).
// TODO(task 2): fold these into sniff.ts so there is one copy of the magic
// bytes — sheet.ts should call sniffContainer once that module exists.
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function readWorkbook(buf: Buffer): SheetData[] {
  // SheetJS's reader falls back to parsing ANY unrecognized bytes as plain
  // text, so a stray letter comes back as a one-cell "spreadsheet" instead of
  // an error. Untrusted attachments come through here; the container is
  // checked before the bytes are handed over.
  if (!buf.subarray(0, 8).equals(OLE2_MAGIC) && !buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new Error("not a workbook: expected an OLE2 (.xls) or OOXML (.xlsx) container");
  }
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1, raw: false, defval: "", blankrows: false,
    }),
  }));
}
