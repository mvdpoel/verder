import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractDocumentText, rasterizePdf, type OcrPort } from "./extract";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

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

  // Opt-in: downloads nld+eng training data on first run. Run once by hand with
  //   OCR_TESTS=1 env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
  it.runIf(process.env.OCR_TESTS === "1")("really OCRs the scan fixture", async () => {
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"));
    expect(out.extractor).toBe("ocr-image");
    expect(out.text).toContain("Ziggo");
  }, 180_000);
});
