import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "./extract";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

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
});
