import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractDocumentText, type OcrPort } from "./extract";

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
});
