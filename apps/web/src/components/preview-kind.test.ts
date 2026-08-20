import { describe, expect, it } from "vitest";
import { previewKind, rowCountLabel } from "./preview-kind";

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
    expect(rowCountLabel(12, 12, false)).toBeNull();
  });

  it("says how much was withheld when capped", () => {
    expect(rowCountLabel(200, 314, true)).toBe("Showing first 200 of 314 rows");
  });
});
