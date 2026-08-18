import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAbnTsv } from "./abn-tsv";
import { detectSource } from "./types";

const fixture = readFileSync(new URL("../fixtures/abn.tsv", import.meta.url));

describe("parseAbnTsv", () => {
  const result = parseAbnTsv(fixture);

  it("parses all well-formed lines and reports the malformed one", () => {
    expect(result.rows).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
  });

  it("extracts counterparty from /TRTP/ slash-format descriptions", () => {
    const row = result.rows[0];
    expect(row.rowIndex).toBe(0);
    expect(row.amountCents).toBe(-7250);
    expect(row.bookedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(row.counterpartyName).toBe("Ziggo Services BV");
    expect(row.counterpartyIban).toBe("NL66INGB0007654321");
    expect(row.mandateId).toBe("NL-MND-0012345");
    expect(row.description).toContain("/TRTP/SEPA Incasso");
  });

  it("extracts Naam:/IBAN:/Machtiging: from label-format descriptions", () => {
    const row = result.rows[1];
    expect(row.amountCents).toBe(-15845);
    expect(row.counterpartyName).toBe("Zilveren Kruis Achmea");
    expect(row.counterpartyIban).toBe("NL13INGB0000432100");
    expect(row.mandateId).toBe("ZK-99887766");
  });

  it("keeps credits positive (refund) and mandate null when absent", () => {
    const row = result.rows[2];
    expect(row.amountCents).toBe(14280);
    expect(row.counterpartyName).toBe("Belastingdienst Toeslagen");
    expect(row.counterpartyIban).toBe("NL86INGB0002445588");
    expect(row.mandateId).toBeNull();
  });

  it("decodes latin-1, handles NL thousands amounts, nulls when nothing extractable", () => {
    const row = result.rows[3];
    expect(row.amountCents).toBe(-123456); // "-1.234,56"
    expect(row.counterpartyName).toBeNull();
    expect(row.counterpartyIban).toBeNull();
    expect(row.mandateId).toBeNull();
    expect(row.description).toContain("Café De Zon"); // é is byte 0xE9 in the fixture
  });

  it("routes impossible booking dates to errors instead of rolling them over", () => {
    // "20260231" would roll over to 2026-03-03 via Date parsing — must error.
    const line = (date: string) =>
      Buffer.from(
        `123456789\tEUR\t${date}\t1000,00\t990,00\t${date}\t-10,00\tSEPA Overboeking Naam: Test\n`,
        "latin1"
      );
    for (const bad of ["20260231", "20260431", "20260229", "20260200"]) {
      const result = parseAbnTsv(line(bad));
      expect(result.rows, bad).toHaveLength(0);
      expect(result.errors, bad).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/booking date/);
    }
    // sanity: real leap day still parses
    expect(parseAbnTsv(line("20280229")).rows[0].bookedAt.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
  });

  it("lists the malformed line with its raw text instead of throwing", () => {
    const err = result.errors[0];
    expect(err.rowIndex).toBe(4);
    expect(err.raw).toContain("kapot");
    expect(err.message).toBeTruthy();
  });
});

describe("detectSource (abn-tsv)", () => {
  it("detects by tab count in the first line even without extension", () => {
    expect(detectSource("mutations.dat", fixture.subarray(0, 256))).toBe("abn-tsv");
  });
  it("detects by .tsv extension", () => {
    expect(detectSource("TXT260801123456.tsv", Buffer.from("x"))).toBe("abn-tsv");
  });
});
