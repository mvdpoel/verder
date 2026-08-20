import * as XLSX from "xlsx";
import { workbookContainer } from "./sniff";

/**
 * Workbook container reader — the ONLY runtime module in the monorepo that
 * imports SheetJS. Keeping the dependency behind one function means a library
 * swap touches one file, and means parsing untrusted workbooks (they arrive as
 * mail attachments) has exactly one entry point.
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

/**
 * Three limits, because a workbook is the only attacker-shaped input this app
 * parses in-process, and XLSX.read is synchronous — whatever it costs, it
 * costs the worker (mail ingest, mining, backups) or the single-threaded web
 * server, and no timeout can interrupt it.
 *
 * MEASURED on this machine, before these guards existed:
 *   - a 1.5 KB .xlsx whose `<dimension>` declares the full 16384 × 1048576
 *     grid, holding two real cells: still running after 120 s. `sheetRows`
 *     makes SheetJS ignore the declaration and use the cells that exist — the
 *     same file then reads in 10 ms.
 *   - a 5 MB .xlsx inflating to 162 MB of sheet XML: 11.3 s and 955 MB RSS
 *     uncapped, 2.2 s and 436 MB with a row cap.
 *   - the same file with its declared uncompressed size patched down: 0.6 s,
 *     64 MB, no rows. SheetJS inflates up to the size the ZIP declares and no
 *     further, which is why reading that declaration is a real bound and not
 *     a formality — a bomb must announce itself to detonate.
 */
export const MAX_WORKBOOK_BYTES = 25_000_000;
export const MAX_WORKBOOK_INFLATED_BYTES = 64_000_000;
/** Two orders of magnitude above a year of ABN transactions. */
export const MAX_SHEET_ROWS = 20_000;

export interface ReadWorkbookOptions {
  /** Rows read per sheet. Bounds the work; defaults to MAX_SHEET_ROWS. */
  maxRows?: number;
}

/**
 * Sum of the uncompressed sizes a ZIP declares for its members, read from the
 * central directory. Returns null when the file is not a ZIP or its directory
 * cannot be walked (nothing learned — the row cap still applies), and Infinity
 * for ZIP64, whose 64-bit sizes live in an extra field this does not parse.
 */
export function zipDeclaredInflatedBytes(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const start = Math.max(0, buf.length - 66_000); // 64 KB comment + 22 B record
  let eocd = -1;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  try {
    const entries = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (p === 0xffffffff || entries === 0xffff) return Infinity; // ZIP64
    let total = 0;
    for (let i = 0; i < entries; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) return null;
      const size = buf.readUInt32LE(p + 24);
      if (size === 0xffffffff) return Infinity; // ZIP64 member
      total += size;
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return total;
  } catch {
    return null; // truncated or malformed directory
  }
}

export function readWorkbook(buf: Buffer, opts: ReadWorkbookOptions = {}): SheetData[] {
  // SheetJS's reader falls back to parsing ANY unrecognized bytes as plain
  // text, so a stray letter comes back as a one-cell "spreadsheet" instead of
  // an error. Untrusted attachments come through here; the container is
  // checked — by the shared sniffer, so the reader and the sniffer can never
  // disagree about what a workbook is — before the bytes are handed over.
  // Size first: it is the one check that costs nothing, and the container scan
  // below reads the whole buffer looking for its marker.
  if (buf.length > MAX_WORKBOOK_BYTES) {
    throw new Error(
      `workbook is too large: ${buf.length} bytes (max ${MAX_WORKBOOK_BYTES})`);
  }
  if (!workbookContainer(buf)) {
    throw new Error("not a workbook: expected an OLE2 (.xls) or OOXML (.xlsx) container");
  }
  const inflated = zipDeclaredInflatedBytes(buf);
  if (inflated !== null && inflated > MAX_WORKBOOK_INFLATED_BYTES) {
    throw new Error(
      `workbook expands to too much data: ${inflated} bytes (max ${MAX_WORKBOOK_INFLATED_BYTES})`);
  }
  const wb = XLSX.read(buf, {
    type: "buffer", cellDates: false, sheetRows: opts.maxRows ?? MAX_SHEET_ROWS,
  });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1, raw: false, defval: "", blankrows: false,
    }),
  }));
}
