import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAbnSheet } from "./abn-sheet";
import { parseAbnTsv } from "./abn-tsv";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe.each([["legacy .xls", "abn.xls"], ["modern .xlsx", "abn.xlsx"]])(
  "parseAbnSheet (%s)", (_label, file) => {
    const result = parseAbnSheet(fixture(file));

    it("skips the header row and parses the data rows", () => {
      expect(result.rows).toHaveLength(4);
      expect(result.errors).toHaveLength(1);
    });

    it("never imports the header row as a transaction", () => {
      expect(result.rows.some((r) => r.description?.includes("Omschrijving"))).toBe(false);
      expect(result.errors.some((e) => e.raw.includes("Rekeningnummer"))).toBe(false);
    });

    it("reads dot decimals into exact cents", () => {
      expect(result.rows[0].amountCents).toBe(-7250); // "-72.50"
      expect(result.rows[3].amountCents).toBe(-860); // "-8.60", not -859.99…
    });

    it("mines counterparties from slash- and label-format descriptions", () => {
      expect(result.rows[0].counterpartyName).toBe("Ziggo Services BV");
      expect(result.rows[0].counterpartyIban).toBe("NL66INGB0007654321");
      expect(result.rows[0].mandateId).toBe("NL-MND-0012345");
      expect(result.rows[1].counterpartyName).toBe("Zilveren Kruis Achmea");
      expect(result.rows[2].mandateId).toBeNull();
    });

    it("keeps credits positive", () => {
      expect(result.rows[2].amountCents).toBe(14280);
    });

    it("numbers rows from the first DATA row, so rowIndex is a stable import key", () => {
      expect(result.rows.map((r) => r.rowIndex)).toEqual([0, 1, 2, 3]);
      expect(result.errors[0].rowIndex).toBe(4);
    });

    it("collects the malformed row instead of throwing, with its raw text", () => {
      expect(result.errors[0].raw).toContain("kapot");
      expect(result.errors[0].message).toBeTruthy();
    });
  });

describe("parseAbnSheet vs parseAbnTsv", () => {
  it("produces identical rows from the same eight columns in either container", () => {
    // The whole point of the refactor: one row mapping, two containers.
    const fromSheet = parseAbnSheet(fixture("abn.xls"));
    // The same four well-formed rows, written as the TSV export writes them.
    const tsv = Buffer.from([
      "123456789\tEUR\t20260701\t20260701\t1000.00\t927.50\t-72.50\t/TRTP/SEPA Incasso/NAME/Ziggo Services BV/MARF/NL-MND-0012345/IBAN/NL66INGB0007654321/",
      "123456789\tEUR\t20260702\t20260702\t927.50\t769.05\t-158.45\tSEPA Incasso  Naam: Zilveren Kruis Achmea  IBAN: NL13INGB0000432100  Machtiging: ZK-99887766",
      "123456789\tEUR\t20260703\t20260703\t769.05\t911.85\t142.80\tSEPA Overboeking  Naam: Belastingdienst Toeslagen  IBAN: NL86INGB0002445588",
      "123456789\tEUR\t20260704\t20260704\t911.85\t903.25\t-8.60\tBEA, Apple Pay  Albert Heijn 1234, PAS123",
    ].join("\n"), "latin1");
    const fromTsv = parseAbnTsv(tsv);
    expect(fromSheet.rows).toEqual(fromTsv.rows);
  });
});

describe("parseAbnSheet (header absent)", () => {
  it("imports the first row when it is data, not a header", async () => {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([
      ["123456789", "EUR", "20260701", "20260701", "1000.00", "927.50", "-72.50",
        "SEPA Overboeking  Naam: Test BV  IBAN: NL66INGB0007654321"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
    const result = parseAbnSheet(Buffer.from(buf));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].counterpartyName).toBe("Test BV");
  });
});
