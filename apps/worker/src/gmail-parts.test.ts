import { describe, expect, it } from "vitest";
import { isInlineBodyImage } from "./gmail-parts";

const h = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

describe("isInlineBodyImage", () => {
  it("skips an inline part that the HTML body references by cid", () => {
    // This is the LinkedIn badge: 56% of what the watcher has filed.
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'inline; filename="image.png"',
      "Content-ID": "<ii_abc123>",
      "Content-Type": "image/png",
    }))).toBe(true);
  });

  it("keeps a real attachment", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'attachment; filename="Beschikking.pdf"',
      "Content-Type": "application/pdf",
    }))).toBe(false);
  });

  it("keeps an inline part with NO Content-ID — it is not a cid reference", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'inline; filename="scan.pdf"',
    }))).toBe(false);
  });

  it("keeps a part with a Content-ID but no inline disposition", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'attachment; filename="logo.png"',
      "Content-ID": "<ii_xyz>",
    }))).toBe(false);
  });

  it("matches header names case-insensitively, as they occur in the wild", () => {
    expect(isInlineBodyImage(h({
      "content-disposition": "INLINE",
      "content-id": "<ii_abc>",
    }))).toBe(true);
  });

  it("KEEPS a part with absent or malformed headers", () => {
    // Over-ingesting is noise; over-skipping loses evidence. Only one of
    // those is recoverable, so uncertainty always keeps the part.
    expect(isInlineBodyImage(undefined)).toBe(false);
    expect(isInlineBodyImage(null)).toBe(false);
    expect(isInlineBodyImage([])).toBe(false);
    expect(isInlineBodyImage([{ name: null, value: null }])).toBe(false);
  });
});
