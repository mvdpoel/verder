import { decimalToCents } from "./money";
import type { ParseResult, ParsedRow } from "./types";

/**
 * ABN AMRO TSV ("TXT" mutation export) parser. Latin-1, tab-separated, no
 * header row. Columns: [0] account, [1] currency, [2] booking date YYYYMMDD,
 * [3] balance before, [4] balance after, [5] value date, [6] amount (comma
 * decimal, leading sign), [7] description. Counterparty details live inside
 * the free-text description in two shapes:
 *   - label format:  "Naam: X  IBAN: NLxx...  Machtiging: Y"
 *   - slash format:  "/TRTP/SEPA .../NAME/X/MARF/Y/IBAN/NLxx.../..."
 */

const NAME_LABEL = /(?:Naam|Name):\s*(.+?)(?:\s{2,}|$)/;
const IBAN_LABEL = /IBAN:\s*([A-Z]{2}\d{2}[A-Z0-9]+)/;
const MANDATE_LABEL = /(?:Machtiging|Mandate):\s*(\S+)/;
const NAME_SLASH = /\/NAME\/([^/]+)/;
const IBAN_SLASH = /\/IBAN\/([A-Z]{2}\d{2}[A-Z0-9]+)/;
const MANDATE_SLASH = /\/MARF\/([^/]+)/;

function extract(description: string): {
  counterpartyName: string | null;
  counterpartyIban: string | null;
  mandateId: string | null;
} {
  const name = NAME_LABEL.exec(description)?.[1] ?? NAME_SLASH.exec(description)?.[1] ?? null;
  const iban = IBAN_LABEL.exec(description)?.[1] ?? IBAN_SLASH.exec(description)?.[1] ?? null;
  const mandate =
    MANDATE_LABEL.exec(description)?.[1] ?? MANDATE_SLASH.exec(description)?.[1] ?? null;
  return {
    counterpartyName: name?.trim() || null,
    counterpartyIban: iban,
    mandateId: mandate?.trim() || null,
  };
}

export function parseAbnTsv(buf: Buffer): ParseResult {
  const lines = buf
    .toString("latin1")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  const rows: ParsedRow[] = [];
  const errors: ParseResult["errors"] = [];

  lines.forEach((line, rowIndex) => {
    try {
      const cols = line.split("\t");
      if (cols.length < 8) throw new Error(`expected 8 tab-separated columns, got ${cols.length}`);
      if (cols[1] !== "EUR") throw new Error(`unsupported currency: ${cols[1]} (only EUR)`);
      const date = cols[2];
      if (!/^\d{8}$/.test(date)) throw new Error(`malformed booking date: ${date}`);
      const bookedAt = new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`
      );
      // Date parsing rolls out-of-range DAYS over ("20260231" → 2026-03-03) and
      // only returns Invalid Date for out-of-range months — compare the UTC
      // components back to catch impossible calendar dates.
      if (
        Number.isNaN(bookedAt.getTime()) ||
        bookedAt.getUTCFullYear() !== Number(date.slice(0, 4)) ||
        bookedAt.getUTCMonth() + 1 !== Number(date.slice(4, 6)) ||
        bookedAt.getUTCDate() !== Number(date.slice(6, 8))
      ) {
        throw new Error(`invalid booking date: ${date}`);
      }
      const amountCents = decimalToCents(cols[6]);
      const description = cols.slice(7).join("\t").trim() || null;

      rows.push({
        rowIndex,
        bookedAt,
        amountCents,
        description,
        ...extract(description ?? ""),
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
