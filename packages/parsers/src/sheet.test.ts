import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkbook } from "./sheet";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe.each([["legacy BIFF8 .xls", "abn.xls"], ["OOXML .xlsx", "abn.xlsx"]])(
  "readWorkbook (%s)", (_label, file) => {
    const sheets = readWorkbook(fixture(file));

    it("returns one sheet with its name", () => {
      expect(sheets).toHaveLength(1);
      expect(sheets[0].name).toBe("Sheet0");
    });

    it("returns the header row plus every data row", () => {
      expect(sheets[0].rows).toHaveLength(6); // 1 header + 5 data
      expect(sheets[0].rows[0][0]).toBe("Rekeningnummer");
      expect(sheets[0].rows[0][7]).toBe("Omschrijving");
    });

    it("reads FORMATTED TEXT, never JS numbers — money.ts does string math", () => {
      const amount = sheets[0].rows[1][6];
      expect(typeof amount).toBe("string");
      expect(amount).toBe("-72.50"); // not -72.5, and not the number -72.5
      expect(sheets[0].rows[1][2]).toBe("20260701"); // date stays an 8-digit string
    });

    it("pads short rows so column indices never shift", () => {
      // the malformed fixture row has 3 values in an 8-column sheet
      expect(sheets[0].rows[5]).toHaveLength(8);
      expect(sheets[0].rows[5][2]).toBe("kapot");
      expect(sheets[0].rows[5][7]).toBe("");
      expect(sheets[0].rows.every((r) => r.every((c) => typeof c === "string"))).toBe(true);
    });
  });

describe("readWorkbook (bad input)", () => {
  it("throws on bytes that are not a workbook", () => {
    expect(() => readWorkbook(Buffer.from("not a spreadsheet at all"))).toThrow();
  });
});
