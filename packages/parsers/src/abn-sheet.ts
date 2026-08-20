import { abnRowToParsed } from "./abn-rows";
import { readWorkbook } from "./sheet";
import type { ParseResult, ParsedRow } from "./types";

/** ABN's "Excel" export labels its first column this way. */
const HEADER_FIRST_CELL = "Rekeningnummer";

/**
 * ABN AMRO "Excel" statement export. Same eight columns as the TSV, plus a
 * header row the TSV does not have. The header is detected by CONTENT, not
 * position, so an export without one still imports.
 *
 * rowIndex counts from the first DATA row. It is half of the import
 * idempotency key (statementSha256, rowIndex), so it must not drift with the
 * presence or absence of a header.
 */
export function parseAbnSheet(buf: Buffer): ParseResult {
  const sheets = readWorkbook(buf);
  if (sheets.length === 0) return { rows: [], errors: [] };
  const all = sheets[0].rows;
  const body = all[0]?.[0]?.trim() === HEADER_FIRST_CELL ? all.slice(1) : all;

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
