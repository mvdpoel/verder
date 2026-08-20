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

  it("does not route a legacy Word document into a statement parser", () => {
    const doc = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("WordDocument", "utf16le"), Buffer.alloc(256)]);
    expect(detectSource("Beschikking.doc", doc)).toBeNull();
  });
});

describe("detectSource (bounded text scan)", () => {
  it("reads only the head of a large file, never the whole upload", () => {
    // Uploads run to 50 MB. Decoding all of one to UTF-8 to look for an XML
    // token costs ~2 bytes of JS string per byte of file, on the request path —
    // and lets a token buried deep in a binary hijack the format decision.
    const big = Buffer.concat([
      Buffer.alloc(200_000, 0x41), Buffer.from("BkToCstmrStmt"), Buffer.alloc(200_000, 0x41)]);
    expect(detectSource("scan.dat", big)).toBeNull();
  });

  it("still detects the tokens that live in the head", () => {
    expect(detectSource("stmt.dat", Buffer.concat([
      Buffer.from("<Document><BkToCstmrStmt>"), Buffer.alloc(100_000, 0x41)])))
      .toBe("abn-camt053");
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
