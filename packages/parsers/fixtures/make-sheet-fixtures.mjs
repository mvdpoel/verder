// Regenerates the workbook fixtures. Run from the repo root:
//   node packages/parsers/fixtures/make-sheet-fixtures.mjs
// The generated files are committed; this script exists so they are
// reproducible rather than mysterious binaries. Mirrors the convention in
// apps/worker/src/fixtures/make-fixtures.sh.
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

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

// A workbook that is a spreadsheet but NOT a statement — a household budget.
// Every row fails the ABN row contract, which is the point: "is a spreadsheet"
// must not be read as "is an ABN statement".
const BUDGET = [
  ["Maand", "Boodschappen", "Huur", "Verzekeringen", "Sparen"],
  ["januari", "412,80", "875,00", "168,45", "50,00"],
  ["februari", "398,15", "875,00", "168,45", "75,00"],
  ["maart", "455,20", "875,00", "171,10", "0,00"],
];

const dir = fileURLToPath(new URL(".", import.meta.url));
for (const [ext, bookType] of [["xls", "biff8"], ["xlsx", "xlsx"]]) {
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...ROWS]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
  writeFileSync(`${dir}abn.${ext}`, XLSX.write(wb, { type: "buffer", bookType }));
}
{
  const ws = XLSX.utils.aoa_to_sheet(BUDGET);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Huishoudboekje");
  writeFileSync(`${dir}huishoudboekje.xlsx`, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
/**
 * The two hostile workbooks, built by hand because SheetJS will not write
 * them: a writer that could emit these would be the bug.
 *
 * A STORED (uncompressed) zip keeps them readable in a hex dump — nothing is
 * hidden in a deflate stream. `declaredSize` lies about a member's
 * uncompressed length in both headers; that is the number a bomb has to
 * announce to detonate, because SheetJS inflates up to exactly it.
 */
function storedZip(files) {
  const locals = []; const central = [];
  let offset = 0;
  for (const [name, data, declaredSize] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const size = declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(size, 24);
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

const B = (s) => Buffer.from(s);
const CONTENT_TYPES = B(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
const ROOT_RELS = B(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
const WORKBOOK = B(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Bomb" sheetId="1" r:id="rId1"/></sheets></workbook>`);
const WORKBOOK_RELS = B(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
const ooxml = (sheet, declaredSize) => storedZip([
  ["[Content_Types].xml", CONTENT_TYPES], ["_rels/.rels", ROOT_RELS],
  ["xl/workbook.xml", WORKBOOK], ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
  ["xl/worksheets/sheet1.xml", sheet, declaredSize],
]);
const cell = (ref) => `<c r="${ref}" t="inlineStr"><is><t>x</t></is></c>`;

// 1. Two real cells, a declared dimension far bigger than the data. A reader
//    that believes the declaration materializes the whole grid: the real
//    thing (A1:XFD1048576) ran for over 120 s here and never finished, and
//    nothing can interrupt it because XLSX.read is synchronous. The committed
//    file declares a modest grid on purpose, so an unguarded reader FAILS the
//    test in a second rather than hanging the suite.
writeFileSync(`${dir}dimension-bomb.xlsx`, ooxml(B(
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:CV20000"/><sheetData><row r="1">${cell("A1")}${cell("B1")}</row><row r="2">${cell("A2")}${cell("B2")}</row></sheetData></worksheet>`)));

// 2. A few hundred bytes claiming to inflate to 3 GB — a compression bomb's
//    announcement, without the payload. Deliberately far above any plausible
//    cap so the fixture does not have to be regenerated when the cap moves.
writeFileSync(`${dir}inflation-bomb.xlsx`,
  ooxml(B("<worksheet/>"), 3_000_000_000));

console.log("fixtures: abn.xls abn.xlsx huishoudboekje.xlsx",
  "dimension-bomb.xlsx inflation-bomb.xlsx");
