import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractDocumentText, rasterizePdf, realOcrPort, type OcrPort } from "./extract";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

const sheetFixture = (name: string) =>
  readFile(new URL(`../../../packages/parsers/fixtures/${name}`, import.meta.url));

// OCR is never run for real in this suite: tesseract.js downloads ~15 MB of
// nld+eng training data on first use. The port is injected instead, and the one
// real-OCR test at the bottom of this file is opt-in.
const stubOcr = (out: string, seen: Buffer[] = []): OcrPort =>
  ({ ocrImage: async (png) => { seen.push(png); return out; } });

describe("extractDocumentText", () => {
  it("reads a text PDF with pdf-parse", async () => {
    const out = await extractDocumentText("application/pdf", await fixture("text-letter.pdf"));
    expect(out.extractor).toBe("pdf-parse");
    expect(out.text).toContain("dossiernummer");
    expect(out.truncated).toBe(false);
    expect(out.charCount).toBe(Array.from(out.text).length);
  });

  it("returns extractor none for a mime it cannot read", async () => {
    const out = await extractDocumentText("application/octet-stream", Buffer.from("blob"));
    expect(out).toEqual({ text: "", charCount: 0, extractor: "none", truncated: false });
  });

  it("OCRs an image", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"),
      { ocr: stubOcr("Beste heer Van der Poel", seen) });
    expect(out.extractor).toBe("ocr-image");
    expect(out.text).toBe("Beste heer Van der Poel");
    expect(seen).toHaveLength(1);
    expect(seen[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  });

  it("never OCRs a PDF that has a real text layer", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("application/pdf", await fixture("text-letter.pdf"),
      { ocr: stubOcr("SHOULD NOT RUN", seen) });
    expect(out.extractor).toBe("pdf-parse");
    expect(seen).toHaveLength(0);
  });

  it("rasterizes and OCRs a scanned PDF whose text layer is empty", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("application/pdf", await fixture("scanned-letter.pdf"),
      { ocr: stubOcr("Uw dossiernummer is 2026-VG-00412", seen) });
    expect(out.extractor).toBe("ocr-pdf");
    expect(out.text).toBe("Uw dossiernummer is 2026-VG-00412");
    expect(seen).toHaveLength(1); // one page in, one page rasterized
    expect(seen[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("rasterizes with real poppler", async () => {
    const pages = await rasterizePdf(await fixture("scanned-letter.pdf"), { dpi: 100 });
    expect(pages).toHaveLength(1);
    expect(pages[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("caps oversized text at 1 MB and flags the truncation", async () => {
    const huge = "é".repeat(1_000_050);
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"),
      { ocr: stubOcr(huge) });
    expect(Array.from(out.text)).toHaveLength(1_000_000);
    expect(out.charCount).toBe(1_000_050); // the length BEFORE the cap
    expect(out.truncated).toBe(true);
  });

  it("never throws: a rasterizer failure comes back as extractor none with the error", async () => {
    const out = await extractDocumentText("application/pdf", await fixture("scanned-letter.pdf"), {
      ocr: stubOcr("SHOULD NOT RUN"),
      rasterize: async () => { throw new Error("pdftoppm ENOENT"); },
    });
    expect(out.extractor).toBe("none");
    expect(out.text).toBe("");
    expect(out.error).toContain("pdftoppm ENOENT");
  });

  it("reads a PDF recorded as application/octet-stream, by its bytes", async () => {
    // Production held `mutov566567741_01042026-30072026.pdf` — an ABN AMRO
    // transaction export — recorded as application/octet-stream, so extraction
    // refused it and a bank statement stayed invisible to search because of a
    // content-type header. The bytes always said %PDF-.
    const out = await extractDocumentText("application/octet-stream",
      await fixture("text-letter.pdf"), { ocr: stubOcr("SHOULD NOT RUN") });
    expect(out.extractor).toBe("pdf-parse");
    expect(out.text).toContain("dossiernummer");
  });

  it("still trusts a recorded mime that is informative", async () => {
    // Sniffing is a fallback, never an override: a declared image/png goes
    // straight to OCR without the bytes getting a vote.
    const seen: Buffer[] = [];
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"),
      { ocr: stubOcr("Ziggo", seen) });
    expect(out.extractor).toBe("ocr-image");
    expect(seen).toHaveLength(1);
  });

  it("resolves tesseract's recognize under both module shapes", async () => {
    // The real port resolves this out of tesseract.js. Whether the named export
    // sits on the namespace or on `.default` depends on which build the runtime
    // picks — the Mac and the node:22-slim container disagreed, which is how
    // nine scanned letters reached production with zero extracted characters.
    const port = realOcrPort();
    expect(typeof port.ocrImage).toBe("function");
    const mod = await import("tesseract.js") as unknown as
      { recognize?: unknown; default?: { recognize?: unknown } };
    const resolved = mod.recognize ?? mod.default?.recognize;
    expect(typeof resolved).toBe("function");
  });

  // Opt-in: downloads nld+eng training data on first run. Run once by hand with
  //   OCR_TESTS=1 env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
  it.runIf(process.env.OCR_TESTS === "1")("really OCRs the scan fixture", async () => {
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"));
    expect(out.extractor).toBe("ocr-image");
    expect(out.text).toContain("Ziggo");
  }, 180_000);
});

describe("extractDocumentText (spreadsheets)", () => {
  it("extracts a legacy .xls recorded as octet-stream, by sniffing the bytes", async () => {
    // Exactly the production case: ABN's export, mime recorded as octet-stream.
    const out = await extractDocumentText("application/octet-stream", await sheetFixture("abn.xls"));
    expect(out.extractor).toBe("sheet");
    expect(out.text).toContain("Ziggo Services BV");
    expect(out.text).toContain("Zilveren Kruis Achmea");
    expect(out.error).toBeUndefined();
  });

  it("extracts a modern .xlsx", async () => {
    const out = await extractDocumentText(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      await sheetFixture("abn.xlsx"));
    expect(out.extractor).toBe("sheet");
    expect(out.text).toContain("Belastingdienst Toeslagen");
  });

  it("names each sheet so multi-sheet workbooks stay legible in search results", async () => {
    const out = await extractDocumentText("application/vnd.ms-excel", await sheetFixture("abn.xls"));
    expect(out.text).toContain("## Sheet0");
  });

  it("counts characters and never OCRs a spreadsheet", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("application/vnd.ms-excel",
      await sheetFixture("abn.xls"), { ocr: stubOcr("SHOULD NOT RUN", seen) });
    expect(seen).toHaveLength(0);
    expect(out.charCount).toBe(Array.from(out.text).length);
    expect(out.truncated).toBe(false);
  });

  it("records the reason instead of throwing when the workbook will not open", async () => {
    const broken = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const out = await extractDocumentText("application/octet-stream", broken);
    expect(out.extractor).toBe("none");
    expect(out.error).toBeTruthy();
  });
});
