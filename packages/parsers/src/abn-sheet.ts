import { abnRowToParsed } from "./abn-rows";
import { MAX_SHEET_ROWS, readWorkbook } from "./sheet";
import type { ParseResult, ParsedRow } from "./types";

/** ABN's "Excel" export labels its first column this way. */
const HEADER_FIRST_CELL = "rekeningnummer";

export interface ParseAbnSheetOptions {
  /** Rows accepted, header included. Beyond it the import is refused, not cut. */
  maxRows?: number;
}

/**
 * ABN AMRO "Excel" statement export. Same eight columns as the TSV, plus a
 * header row the TSV does not have. The header is detected by CONTENT, not
 * position (and case-insensitively — nothing guarantees ABN keeps capitalising
 * it the same way), so an export without one still imports.
 *
 * rowIndex counts from the first DATA row. It is half of the import
 * idempotency key (statementSha256, rowIndex), so it must not drift with the
 * presence or absence of a header.
 *
 * A statement longer than the cap is REFUSED rather than truncated: importing
 * the first N rows of a statement looks exactly like a clean import, and the
 * missing transactions would never be noticed.
 */
export function parseAbnSheet(buf: Buffer, opts: ParseAbnSheetOptions = {}): ParseResult {
  const maxRows = opts.maxRows ?? MAX_SHEET_ROWS;
  const sheets = readWorkbook(buf, { maxRows: maxRows + 1 });
  if (sheets.length === 0) return { rows: [], errors: [] };
  const all = sheets[0].rows;
  if (all.length > maxRows) {
    throw new Error(`statement has more than ${maxRows} rows — split it and import in parts`);
  }
  const body = all[0]?.[0]?.trim().toLowerCase() === HEADER_FIRST_CELL ? all.slice(1) : all;

  const rows: ParsedRow[] = [];
  const errors: ParseResult["errors"] = [];

  body.forEach((cols, rowIndex) => {
    try {
      rows.push(abnRowToParsed(cols, rowIndex));
    } catch (err) {
      errors.push({
        rowIndex,
        raw: cols.join("\t"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { rows, errors };
}
