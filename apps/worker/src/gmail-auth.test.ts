import { describe, expect, it } from "vitest";
import { collectAttachments, listAllMessageIds, type MessageListFn } from "./gmail-auth";

describe("listAllMessageIds", () => {
  it("follows nextPageToken until the listing is exhausted", async () => {
    const pages: Record<string, { messages: { id: string }[]; nextPageToken?: string }> = {
      start: { messages: [{ id: "a1" }, { id: "a2" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "b1" }], nextPageToken: "p3" },
      p3: { messages: [{ id: "c1" }, { id: "c2" }] },
    };
    const seenTokens: (string | undefined)[] = [];
    const list: MessageListFn = async (params) => {
      seenTokens.push(params.pageToken);
      expect(params.q).toBe("newer_than:7d");
      return { data: pages[params.pageToken ?? "start"] };
    };
    const ids = await listAllMessageIds(list, "newer_than:7d");
    expect(ids).toEqual(["a1", "a2", "b1", "c1", "c2"]);
    expect(seenTokens).toEqual([undefined, "p2", "p3"]);
  });

  it("handles an empty mailbox", async () => {
    const list: MessageListFn = async () => ({ data: {} });
    expect(await listAllMessageIds(list, "newer_than:7d")).toEqual([]);
  });
});

const header = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

// The real Gmail payload shape, trimmed to what the walk reads.
const logoPart = {
  filename: "image.png", mimeType: "image/png",
  body: { attachmentId: "att-logo" },
  headers: header({
    "Content-Disposition": 'inline; filename="image.png"',
    "Content-ID": "<ii_abc123>",
    "Content-Type": "image/png",
  }),
};
const pdfPart = {
  filename: "Beschikking.pdf", mimeType: "application/pdf",
  body: { attachmentId: "att-pdf" },
  headers: header({
    "Content-Disposition": 'attachment; filename="Beschikking.pdf"',
    "Content-Type": "application/pdf",
  }),
};

describe("collectAttachments", () => {
  const fetchBytes = async (id: string) => Buffer.from(`bytes-${id}`);

  it("promotes the real attachment and never the signature logo", async () => {
    const got = await collectAttachments(
      { parts: [{ mimeType: "text/html" }, logoPart, pdfPart] }, fetchBytes);
    expect(got.map((a) => a.filename)).toEqual(["Beschikking.pdf"]);
    expect(got[0].data.toString()).toBe("bytes-att-pdf");
  });

  it("still recurses into a skipped part's children", async () => {
    // A skipped part may itself carry nested parts; dropping the recursion
    // would lose whatever hangs beneath it.
    const nesting = { ...logoPart, parts: [pdfPart] };
    const got = await collectAttachments({ parts: [nesting] }, fetchBytes);
    expect(got.map((a) => a.filename)).toEqual(["Beschikking.pdf"]);
  });

  it("keeps a part whose headers are absent or malformed", async () => {
    const headerless = { filename: "scan.pdf", mimeType: "application/pdf",
      body: { attachmentId: "att-scan" } };
    const got = await collectAttachments({ parts: [headerless] }, fetchBytes);
    expect(got.map((a) => a.filename)).toEqual(["scan.pdf"]);
  });

  it("falls back to a generic mime when the part declares none", async () => {
    const got = await collectAttachments(
      { parts: [{ filename: "mystery", body: { attachmentId: "att-x" } }] }, fetchBytes);
    expect(got[0].mime).toBe("application/octet-stream");
  });
});
