import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSpreadsheetMime, sniffContainer, UNINFORMATIVE_MIMES, XLS_MIME, XLSX_MIME } from "./sniff";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe("sniffContainer", () => {
  it("recognizes a legacy BIFF8 .xls by its OLE2 magic", () => {
    expect(sniffContainer(fixture("abn.xls"))).toBe(XLS_MIME);
  });

  it("recognizes an OOXML .xlsx by ZIP magic plus an xl/ entry", () => {
    expect(sniffContainer(fixture("abn.xlsx"))).toBe(XLSX_MIME);
  });

  it("does NOT claim a plain zip is a spreadsheet", () => {
    // ZIP local file header for a single entry named "notes.txt"
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(22),
      Buffer.from("notes.txt"),
      Buffer.from("hello"),
    ]);
    expect(sniffContainer(zip)).toBeNull();
  });

  it("still recognizes the types extraction already handled", () => {
    expect(sniffContainer(Buffer.from("%PDF-1.4\n..."))).toBe("application/pdf");
    expect(sniffContainer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toBe("image/png");
    expect(sniffContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("returns null when the bytes say nothing", () => {
    expect(sniffContainer(Buffer.from("just some text"))).toBeNull();
    expect(sniffContainer(Buffer.alloc(0))).toBeNull();
  });
});

describe("isSpreadsheetMime", () => {
  it("covers both containers and rejects everything else", () => {
    expect(isSpreadsheetMime(XLS_MIME)).toBe(true);
    expect(isSpreadsheetMime(XLSX_MIME)).toBe(true);
    expect(isSpreadsheetMime("application/pdf")).toBe(false);
  });
});

describe("UNINFORMATIVE_MIMES", () => {
  it("is the set that means 'go look at the bytes'", () => {
    expect(UNINFORMATIVE_MIMES.has("application/octet-stream")).toBe(true);
    expect(UNINFORMATIVE_MIMES.has("binary/octet-stream")).toBe(true);
    expect(UNINFORMATIVE_MIMES.has("")).toBe(true);
    expect(UNINFORMATIVE_MIMES.has("application/pdf")).toBe(false);
  });
});
