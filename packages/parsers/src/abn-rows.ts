import { decimalToCents } from "./money";
import type { ParsedRow } from "./types";

/**
 * The ABN AMRO statement row, independent of the container it arrived in.
 * Both the TSV export and the "Excel" export carry the same eight columns:
 *   [0] account [1] currency [2] booking date YYYYMMDD
 *   [3][4][5] the value date and the running balances, in whichever order the
 *             export writes them — nothing here reads them, and the two
 *             fixtures in this repo disagree, so do not trust this line if you
 *             come to use them: check a real export first
 *   [6] amount [7] description
 * The TSV writes amounts with a comma decimal and the sheet with a dot;
 * decimalToCents accepts both, and does string math for either.
 *
 * Counterparty details live inside the free-text description in two shapes:
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

/** Throws on a malformed row; callers collect the error, never drop the row. */
export function abnRowToParsed(cols: string[], rowIndex: number): ParsedRow {
  if (cols.length < 8) throw new Error(`expected 8 columns, got ${cols.length}`);
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
  return { rowIndex, bookedAt, amountCents, description, ...extract(description ?? "") };
}
