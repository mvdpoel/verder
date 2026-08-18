import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePaypalCsv } from "./paypal-csv";
import { detectSource } from "./types";

const fixture = readFileSync(new URL("../fixtures/paypal.csv", import.meta.url));

describe("parsePaypalCsv", () => {
  const result = parsePaypalCsv(fixture);

  it("keeps only Completed EUR rows; malformed rows go to errors", () => {
    // fixture: 6 data rows → 3 rows (Pending and USD skipped), 1 error
    expect(result.rows).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
  });

  it("strips the UTF-8 BOM and parses DD-MM-YYYY dates", () => {
    const row = result.rows[0];
    expect(row.rowIndex).toBe(0);
    expect(row.bookedAt.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(row.amountCents).toBe(-1399);
    expect(row.counterpartyName).toBe("Spotify AB");
    expect(row.counterpartyIban).toBeNull();
    expect(row.mandateId).toBeNull();
    expect(row.description).toBe("paypal:Subscription Payment 7AB12345CD6789012");
  });

  it("keeps rowIndex aligned with the physical data row (skipped rows consume an index)", () => {
    expect(result.rows.map((r) => r.rowIndex)).toEqual([0, 1, 3]);
  });

  it("keeps a refund as a positive credit", () => {
    const refund = result.rows[2];
    expect(refund.amountCents).toBe(2495);
    expect(refund.counterpartyName).toBe("Bol.com B.V.");
    expect(refund.description).toBe("paypal:Refund 2RF55667JK7788990");
  });

  it("reports the row with a garbage Gross as an error", () => {
    const err = result.errors[0];
    expect(err.rowIndex).toBe(4);
    expect(err.raw).toContain("not-a-number");
    expect(err.message).toBeTruthy();
  });

  it("handles MM/DD/YYYY dates, flipping to DD/MM when the first segment exceeds 12", () => {
    const csv = (date: string) =>
      Buffer.from(
        `"Date","Name","Type","Status","Currency","Gross","Transaction ID"\n` +
          `"${date}","X","Payment","Completed","EUR","-1.00","T1"\n`
      );
    expect(parsePaypalCsv(csv("07/03/2026")).rows[0].bookedAt.toISOString()).toBe(
      "2026-07-03T00:00:00.000Z" // slash + first segment ≤12 → MM/DD
    );
    expect(parsePaypalCsv(csv("13/07/2026")).rows[0].bookedAt.toISOString()).toBe(
      "2026-07-13T00:00:00.000Z" // first segment >12 must be the day
    );
  });

  it("handles quoted fields containing commas and escaped quotes", () => {
    const buf = Buffer.from(
      `"Date","Name","Type","Status","Currency","Gross","Transaction ID"\n` +
        `"01-07-2026","Foo, Bar ""Baz"" B.V.","Payment","Completed","EUR","-2,50","T2"\n`
    );
    const row = parsePaypalCsv(buf).rows[0];
    expect(row.counterpartyName).toBe('Foo, Bar "Baz" B.V.');
    expect(row.amountCents).toBe(-250);
  });

  it("routes impossible calendar dates to errors instead of rolling them over", () => {
    // V8 only yields Invalid Date for out-of-range months; out-of-range days
    // roll over ("31-02-2026" → 2026-03-03). Those must be errors, not rows.
    const csv = (date: string) =>
      Buffer.from(
        `"Date","Name","Type","Status","Currency","Gross","Transaction ID"\n` +
          `"${date}","X","Payment","Completed","EUR","-1.00","T1"\n`
      );
    for (const bad of ["31-02-2026", "31-04-2026", "29-02-2026"]) {
      const result = parsePaypalCsv(csv(bad));
      expect(result.rows, bad).toHaveLength(0);
      expect(result.errors, bad).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/invalid date/);
    }
    // sanity: real leap day still parses
    expect(parsePaypalCsv(csv("29-02-2028")).rows[0].bookedAt.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
  });

  it("throws loudly when required headers are missing", () => {
    expect(() => parsePaypalCsv(Buffer.from("garbage\nmore garbage\n"))).toThrow();
  });
});

describe("detectSource (paypal-csv)", () => {
  it("detects by header sniff regardless of filename", () => {
    expect(detectSource("Download.dat", fixture.subarray(0, 256))).toBe("paypal-csv");
  });
  it("falls back to .csv extension", () => {
    expect(detectSource("activity.csv", Buffer.from("x"))).toBe("paypal-csv");
  });
});
