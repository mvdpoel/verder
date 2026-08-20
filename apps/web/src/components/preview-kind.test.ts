import { describe, expect, it } from "vitest";
import { previewKind, rowCountLabel, servesInline } from "./preview-kind";

describe("previewKind", () => {
  it("renders images inline", () => {
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/jpeg")).toBe("image");
  });

  it("renders PDFs in a frame", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
  });

  it("renders both spreadsheet containers as a table", () => {
    expect(previewKind("application/vnd.ms-excel")).toBe("sheet");
    expect(previewKind(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
  });

  it("falls back to a download card for anything else", () => {
    // The bug this fixes: octet-stream used to land in an iframe and download.
    expect(previewKind("application/octet-stream")).toBe("file");
    expect(previewKind("application/zip")).toBe("file");
    expect(previewKind("")).toBe("file");
  });
});

describe("rowCountLabel", () => {
  it("says nothing when every row is shown", () => {
    expect(rowCountLabel(12, false)).toBeNull();
  });

  it("says how much is shown when capped", () => {
    // Not "of N": the reader stops at the cap, so nobody has counted the rest.
    // Printing a total would mean parsing the whole workbook — the work the
    // cap exists to refuse.
    expect(rowCountLabel(200, true)).toBe("Showing the first 200 rows");
  });
});

describe("servesInline", () => {
  it("serves the four things the app can actually render", () => {
    expect(servesInline("application/pdf")).toBe(true);
    expect(servesInline("image/png")).toBe(true);
    expect(servesInline("application/vnd.ms-excel")).toBe(true);
  });

  it("never serves an active type inline", () => {
    // The stored mime is whatever the SENDER's mail client wrote on the
    // attachment part. Served inline on our own origin, an SVG or an HTML file
    // runs script with Martin's session — the whole registry is one fetch away.
    expect(servesInline("image/svg+xml")).toBe(false);
    expect(servesInline("text/html")).toBe(false);
    expect(servesInline("application/xhtml+xml")).toBe(false);
    expect(servesInline("application/octet-stream")).toBe(false);
  });
});
