import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectSource } from "./types";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe("detectSource (spreadsheets)", () => {
  it("detects a legacy .xls whatever the filename claims", () => {
    // The real file from ABN AMRO arrives named .xlsx but is BIFF8 inside.
    expect(detectSource("abn.amro.afschriften.xlsx", fixture("abn.xls"))).toBe("abn-xls");
  });

  it("detects a genuine .xlsx", () => {
    expect(detectSource("statement.xlsx", fixture("abn.xlsx"))).toBe("abn-xls");
  });

  it("lets bytes beat a misleading extension", () => {
    expect(detectSource("statement.csv", fixture("abn.xls"))).toBe("abn-xls");
  });

  it("does not route a plain zip into a statement parser", () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]);
    expect(detectSource("archive.zip", zip)).toBeNull();
  });
});

describe("detectSource (existing behaviour unchanged)", () => {
  it("still detects CAMT.053 XML", () => {
    expect(detectSource("stmt.xml", Buffer.from("<?xml version=\"1.0\"?><Doc/>"))).toBe("abn-camt053");
  });
  it("still detects PayPal CSV by extension", () => {
    expect(detectSource("activity.csv", Buffer.from("x"))).toBe("paypal-csv");
  });
  it("still returns null for an unrecognizable file", () => {
    expect(detectSource("notes.dat", Buffer.from("nothing useful"))).toBeNull();
  });
});
