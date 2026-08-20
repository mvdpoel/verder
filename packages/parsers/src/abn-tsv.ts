import { abnRowToParsed } from "./abn-rows";
import type { ParseResult, ParsedRow } from "./types";

/**
 * ABN AMRO TSV ("TXT" mutation export): latin-1, tab-separated, no header row.
 * The row mapping lives in abn-rows.ts because the "Excel" export carries the
 * same eight columns — see abn-sheet.ts.
 */
export function parseAbnTsv(buf: Buffer): ParseResult {
  const lines = buf
    .toString("latin1")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  const rows: ParsedRow[] = [];
  const errors: ParseResult["errors"] = [];

  lines.forEach((line, rowIndex) => {
    try {
      rows.push(abnRowToParsed(line.split("\t"), rowIndex));
    } catch (err) {
      errors.push({
        rowIndex,
        raw: line,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { rows, errors };
}
