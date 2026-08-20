export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "none";

export interface ExtractedText {
  text: string;
  /** Code points extracted BEFORE the cap: charCount > text length means truncated. */
  charCount: number;
  extractor: Extractor;
  truncated: boolean;
  error?: string;
}

// Counted in code points, not UTF-16 units, so a Dutch letter full of accents
// is never measured or cut mid-code-point.
function measure(raw: string): { text: string; charCount: number; truncated: boolean } {
  return { text: raw, charCount: Array.from(raw).length, truncated: false };
}

export async function extractDocumentText(mime: string, buf: Buffer): Promise<ExtractedText> {
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return { ...measure((await pdfParse(buf)).text), extractor: "pdf-parse" };
  }
  return { text: "", charCount: 0, extractor: "none", truncated: false };
}
