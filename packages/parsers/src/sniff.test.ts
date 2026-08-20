import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  effectiveMime, isSpreadsheetMime, sniffContainer, UNINFORMATIVE_MIMES, XLS_MIME, XLSX_MIME,
} from "./sniff";

/** OLE2 magic with nothing behind it — the container .doc, .ppt and .msg share. */
const ole2 = (streamName?: string) => Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(256),
  streamName ? Buffer.from(streamName, "utf16le") : Buffer.alloc(0),
  Buffer.alloc(256),
]);

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe("sniffContainer", () => {
  it("recognizes a legacy BIFF8 .xls by its OLE2 magic", () => {
    expect(sniffContainer(fixture("abn.xls"))).toBe(XLS_MIME);
  });

  it("recognizes an OOXML .xlsx by ZIP magic plus an xl/ entry", () => {
    expect(sniffContainer(fixture("abn.xlsx"))).toBe(XLSX_MIME);
  });

  it("does NOT claim every legacy Office file is a spreadsheet", () => {
    // OLE2 is also .doc, .ppt and .msg. Only the Workbook stream makes it Excel.
    // Without this, a Beschikking.doc mailed as octet-stream would be recorded
    // and served as application/vnd.ms-excel — permanently, on an evidence row.
    expect(sniffContainer(ole2())).toBeNull();
    expect(sniffContainer(ole2("WordDocument"))).toBeNull();
    expect(sniffContainer(ole2("Workbook"))).toBe(XLS_MIME);
    expect(sniffContainer(ole2("Book"))).toBe(XLS_MIME); // BIFF5 names it this way
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

  it("is spelled the way browsers and Excel spell it", () => {
    // Written out rather than compared to the constants: a typo in the constant
    // would satisfy every assertion above and still be wrong everywhere else.
    expect(XLS_MIME).toBe("application/vnd.ms-excel");
    expect(XLSX_MIME)
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});

describe("effectiveMime", () => {
  it("lets the bytes decide only when the recorded mime says nothing", () => {
    const xls = readFileSync(new URL("../fixtures/abn.xls", import.meta.url));
    expect(effectiveMime("application/octet-stream", xls)).toBe(XLS_MIME);
    expect(effectiveMime("", xls)).toBe(XLS_MIME);
    // An informative mime is trusted, even when the bytes disagree.
    expect(effectiveMime("application/pdf", xls)).toBe("application/pdf");
    // Nothing to learn from the bytes either: the recorded mime stands.
    expect(effectiveMime("application/octet-stream", Buffer.from("hello")))
      .toBe("application/octet-stream");
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
