export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "none";

export interface ExtractedText {
  text: string;
  /** Code points extracted BEFORE the cap: charCount > text length means truncated. */
  charCount: number;
  extractor: Extractor;
  truncated: boolean;
  error?: string;
}

export interface OcrPort { ocrImage(png: Buffer): Promise<string> }

export function realOcrPort(): OcrPort {
  return {
    async ocrImage(png) {
      const { recognize } = await import("tesseract.js");
      return (await recognize(png, "nld+eng")).data.text;
    },
  };
}

// Counted in code points, not UTF-16 units, so a Dutch letter full of accents
// is never measured or cut mid-code-point.
function measure(raw: string): { text: string; charCount: number; truncated: boolean } {
  return { text: raw, charCount: Array.from(raw).length, truncated: false };
}

export async function extractDocumentText(
  mime: string, buf: Buffer,
  deps: { ocr?: OcrPort } = {},
): Promise<ExtractedText> {
  const ocr = deps.ocr ?? realOcrPort();
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return { ...measure((await pdfParse(buf)).text), extractor: "pdf-parse" };
  }
  if (mime.startsWith("image/")) {
    return { ...measure((await ocr.ocrImage(buf)).trim()), extractor: "ocr-image" };
  }
  return { text: "", charCount: 0, extractor: "none", truncated: false };
}
