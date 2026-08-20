import { describe, expect, it } from "vitest";
import { isInlineBodyImage } from "./gmail-parts";

const h = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

/** A Gmail message part, narrowed to what the skip decision reads. */
const part = (headers: Record<string, string>, mimeType?: string | null) =>
  ({ mimeType, headers: h(headers) });

describe("isInlineBodyImage", () => {
  it("skips an inline part that the HTML body references by cid", () => {
    // This is the LinkedIn badge: 56% of what the watcher has filed.
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'inline; filename="image.png"',
      "Content-ID": "<ii_abc123>",
      "Content-Type": "image/png",
    }, "image/png"))).toBe(true);
  });

  it("keeps a real attachment", () => {
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'attachment; filename="Beschikking.pdf"',
      "Content-Type": "application/pdf",
    }, "application/pdf"))).toBe(false);
  });

  it("keeps an inline part with NO Content-ID — it is not a cid reference", () => {
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'inline; filename="scan.pdf"',
    }, "application/pdf"))).toBe(false);
  });

  it("keeps a part with a Content-ID but no inline disposition", () => {
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'attachment; filename="logo.png"',
      "Content-ID": "<ii_xyz>",
    }, "image/png"))).toBe(false);
  });

  it("KEEPS an inline PDF carrying a Content-ID — Apple Mail sends every attachment that way", () => {
    // macOS and iOS Mail mark attachments `Content-Disposition: inline` and give
    // them a Content-Id — that is why Mail.app attachments render embedded in
    // other clients. Scan-to-email MFPs and some webmail forwarders do the same.
    // Without the mime check this drops a court decision, and the loss is
    // unrecoverable in practice: pollGmail short-circuits on a seen message id,
    // so re-polling after a fix never fetches it again.
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'inline; filename="Beschikking.pdf"',
      "Content-ID": "<8A9F0C11-2B3D-4E5F-8899-AABBCCDDEEFF>",
      "Content-Type": 'application/pdf; name="Beschikking.pdf"',
    }, "application/pdf"))).toBe(false);
  });

  it("KEEPS an inline spreadsheet carrying a Content-ID", () => {
    expect(isInlineBodyImage(part({
      "Content-Disposition": 'inline; filename="afschrift.xls"',
      "Content-ID": "<ii_bank>",
    }, "application/vnd.ms-excel"))).toBe(false);
  });

  it("falls back to the Content-Type header when the part declares no mimeType", () => {
    expect(isInlineBodyImage(part({
      "Content-Disposition": "inline", "Content-ID": "<ii_a>",
      "Content-Type": "IMAGE/PNG",
    }))).toBe(true);
    // …and keeps the part when neither says image.
    expect(isInlineBodyImage(part({
      "Content-Disposition": "inline", "Content-ID": "<ii_a>",
    }))).toBe(false);
  });

  it("matches header names case-insensitively, as they occur in the wild", () => {
    expect(isInlineBodyImage(part({
      "content-disposition": "INLINE",
      "content-id": "<ii_abc>",
    }, "image/gif"))).toBe(true);
  });

  it("KEEPS a part whose Content-Disposition occurs twice and disagrees", () => {
    // A mail gateway that rewrites parts can leave two dispositions behind.
    // Taking the first match resolves toward SKIPPING, which is the wrong way
    // for an irreversible decision: skip only when every occurrence says inline.
    expect(isInlineBodyImage({ mimeType: "image/png", headers: [
      { name: "Content-Disposition", value: "inline" },
      { name: "Content-Disposition", value: 'attachment; filename="bewijs.png"' },
      { name: "Content-ID", value: "<ii_abc>" },
    ] })).toBe(false);
  });

  it("KEEPS a part with absent or malformed headers", () => {
    // Over-ingesting is noise; over-skipping loses evidence. Only one of
    // those is recoverable, so uncertainty always keeps the part.
    expect(isInlineBodyImage(undefined)).toBe(false);
    expect(isInlineBodyImage(null)).toBe(false);
    expect(isInlineBodyImage({ mimeType: "image/png" })).toBe(false);
    expect(isInlineBodyImage({ mimeType: "image/png", headers: [] })).toBe(false);
    expect(isInlineBodyImage({ mimeType: "image/png",
      headers: [{ name: null, value: null }] })).toBe(false);
  });
});
