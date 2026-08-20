// Regenerates the workbook fixtures. Run from the repo root:
//   node packages/parsers/fixtures/make-sheet-fixtures.mjs
// The generated files are committed; this script exists so they are
// reproducible rather than mysterious binaries. Mirrors the convention in
// apps/worker/src/fixtures/make-fixtures.sh.
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEADER = ["Rekeningnummer", "Muntsoort", "Transactiedatum", "Rentedatum",
  "Beginsaldo", "Eindsaldo", "Transactiebedrag", "Omschrijving"];

const ROWS = [
  ["123456789", "EUR", "20260701", "20260701", "1000.00", "927.50", "-72.50",
    "/TRTP/SEPA Incasso/NAME/Ziggo Services BV/MARF/NL-MND-0012345/IBAN/NL66INGB0007654321/"],
  ["123456789", "EUR", "20260702", "20260702", "927.50", "769.05", "-158.45",
    "SEPA Incasso  Naam: Zilveren Kruis Achmea  IBAN: NL13INGB0000432100  Machtiging: ZK-99887766"],
  ["123456789", "EUR", "20260703", "20260703", "769.05", "911.85", "142.80",
    "SEPA Overboeking  Naam: Belastingdienst Toeslagen  IBAN: NL86INGB0002445588"],
  ["123456789", "EUR", "20260704", "20260704", "911.85", "903.25", "-8.60",
    "BEA, Apple Pay  Albert Heijn 1234, PAS123"],
  ["123456789", "EUR", "kapot"], // malformed: 3 columns, must land in errors
];

const dir = fileURLToPath(new URL(".", import.meta.url));
for (const [ext, bookType] of [["xls", "biff8"], ["xlsx", "xlsx"]]) {
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...ROWS]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
  writeFileSync(`${dir}abn.${ext}`, XLSX.write(wb, { type: "buffer", bookType }));
}
console.log("fixtures: abn.xls abn.xlsx");
