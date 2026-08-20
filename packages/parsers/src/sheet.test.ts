import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_SHEET_ROWS, MAX_WORKBOOK_BYTES, MAX_WORKBOOK_INFLATED_BYTES, readWorkbook,
  zipDeclaredInflatedBytes,
} from "./sheet";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

/**
 * A minimal STORED (uncompressed) zip, so a non-workbook zip can be built
 * inline. The two hostile workbooks are committed fixtures instead — see
 * fixtures/make-sheet-fixtures.mjs, which explains what makes each one nasty.
 */
function storedZip(files: [name: string, data: Buffer][]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

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

  it("throws on a zip that is not a workbook, exactly as the sniffer would", () => {
    // A .docx is a zip too. sniffContainer refuses it; readWorkbook must agree,
    // or the 'one container check' claim in the docblock is not true.
    const docx = storedZip([
      ["[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)],
      ["word/document.xml", Buffer.from("<document/>")],
    ]);
    expect(() => readWorkbook(docx)).toThrow(/not a workbook/);
  });

  it("throws on an OLE2 container that holds no workbook stream", () => {
    // OLE2 is also the container for .doc, .ppt and .msg.
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    expect(() => readWorkbook(ole2)).toThrow(/not a workbook/);
  });
});

describe("readWorkbook (bounded work — untrusted attachments)", () => {
  it("caps the rows it materializes, so a declared grid cannot hang the process", () => {
    // The declared dimension, not the data, is the weapon.
    const t0 = Date.now();
    const sheets = readWorkbook(fixture("dimension-bomb.xlsx"));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(sheets[0].rows.length).toBeLessThanOrEqual(MAX_SHEET_ROWS);
    expect(sheets[0].rows).toHaveLength(2); // only the rows that actually exist
  }, 20_000);

  it("honours a caller's lower row cap", () => {
    const sheets = readWorkbook(fixture("abn.xls"), { maxRows: 3 });
    expect(sheets[0].rows).toHaveLength(3);
  });

  it("refuses a file bigger than the byte cap before handing it to the parser", () => {
    const huge = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(MAX_WORKBOOK_BYTES + 1)]);
    expect(() => readWorkbook(huge)).toThrow(/too large/);
  });

  it("refuses a zip whose members declare more inflated bytes than the cap", () => {
    // A compression bomb announces its own size in the central directory, and
    // SheetJS inflates up to exactly that number — so reading the announcement
    // is a real bound, not a formality.
    const bomb = fixture("inflation-bomb.xlsx");
    expect(bomb.length).toBeLessThan(10_000); // tiny file, enormous claim
    expect(zipDeclaredInflatedBytes(bomb)).toBeGreaterThan(MAX_WORKBOOK_INFLATED_BYTES);
    expect(() => readWorkbook(bomb)).toThrow(/expands/);
  });

  it("reads the honest sizes of an honest workbook, and lets it through", () => {
    const declared = zipDeclaredInflatedBytes(fixture("abn.xlsx"));
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(MAX_WORKBOOK_INFLATED_BYTES);
    // Not a zip at all: nothing to learn, and no reason to refuse.
    expect(zipDeclaredInflatedBytes(fixture("abn.xls"))).toBeNull();
  });
});
