import { decimalToCents } from "./money";
import type { ParseResult, ParsedRow } from "./types";

/**
 * PayPal activity CSV parser. UTF-8 with BOM, quoted CSV with a header row.
 * Uses columns Date, Name, Type, Status, Currency, Gross, Transaction ID.
 * Only `Status = Completed` and `Currency = EUR` rows become transactions —
 * pending rows and currency-conversion legs are skipped (they still consume
 * their rowIndex so indices stay stable). Malformed rows land in errors[].
 */

/** Minimal RFC-4180 field splitter: quotes, embedded commas, "" escapes. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** DD-MM-YYYY, or with slashes MM/DD/YYYY unless the first segment is >12 (then DD/MM/YYYY). */
function parseDate(s: string): Date {
  const m = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`malformed date: ${s}`);
  const [, first, sep, second, year] = m;
  const firstNum = Number(first);
  const [day, month] =
    sep === "/" && firstNum <= 12 ? [second, first] : [first, second];
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00Z`;
  const date = new Date(iso);
  // Date parsing rolls out-of-range DAYS over ("2026-02-31" → 2026-03-03) and
  // only returns Invalid Date for out-of-range months, so compare the UTC
  // components back against what we parsed to catch impossible calendar dates.
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`invalid date: ${s}`);
  }
  return date;
}

const REQUIRED = ["Date", "Name", "Type", "Status", "Currency", "Gross", "Transaction ID"] as const;

export function parsePaypalCsv(buf: Buffer): ParseResult {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM

  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("parsePaypalCsv: empty file");

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col: Record<string, number> = {};
  for (const name of REQUIRED) {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`parsePaypalCsv: missing required column "${name}"`);
    col[name] = idx;
  }

  const rows: ParsedRow[] = [];
  const errors: ParseResult["errors"] = [];

  lines.slice(1).forEach((line, rowIndex) => {
    try {
      const fields = splitCsvLine(line);
      if (fields.length < header.length) {
        throw new Error(`expected ${header.length} fields, got ${fields.length}`);
      }
      const status = fields[col["Status"]].trim();
      const currency = fields[col["Currency"]].trim();
      if (status !== "Completed") return; // pending/denied etc. — skip, keep index
      if (currency !== "EUR") return; // conversion legs and foreign currency — skip

      const type = fields[col["Type"]].trim();
      const txId = fields[col["Transaction ID"]].trim();
      rows.push({
        rowIndex,
        bookedAt: parseDate(fields[col["Date"]]),
        amountCents: decimalToCents(fields[col["Gross"]]),
        counterpartyName: fields[col["Name"]].trim() || null,
        counterpartyIban: null,
        description: `paypal:${type} ${txId}`.trim(),
        mandateId: null,
        accountIban: null, // a PayPal activity export names no bank account
      });
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
