import { describe, expect, it } from "vitest";
import { buildMime, encodeWords, newMessageId, type MimeInput } from "./mime";

const base = (o: Partial<MimeInput> = {}): MimeInput => ({
  from: "Martin van der Poel <martin@vanderpoel.pro>",
  to: ["opstart@verdergroep.nl"], cc: [],
  subject: "Re: Informatie over uw dossier",
  body: "Beste Team Opstart,\n\nHierbij de loonstroken.\n\nMet vriendelijke groet,\nMartin",
  messageId: "<11111111-2222-3333-4444-555555555555@verder.vanderpoel.pro>",
  date: new Date("2026-10-31T10:00:00Z"),
  attachments: [],
  ...o,
});

/** The header block, unfolded, as name → value. */
function headers(raw: Buffer): Map<string, string> {
  const text = raw.toString("utf8");
  const block = text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
  const out = new Map<string, string>();
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    out.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

const decodeWords = (v: string) => v.split(/\s+/).map((w) => {
  const m = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(w);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : w;
}).join("");

describe("buildMime", () => {
  it("CRLF throughout", () => {
    const raw = buildMime(base({ attachments: [
      { fileName: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 x") }] }))
      .toString("utf8");
    expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(raw).toContain("\r\n\r\n");
  });

  it("non-ASCII subject is RFC 2047", () => {
    const subject = "Re: Afspraak over de éénmalige bijdrage — vóór 7 november, graag met overzicht van alle maanden";
    const raw = buildMime(base({ subject }));
    const h = headers(raw);
    expect(h.get("subject")).toMatch(/^=\?UTF-8\?B\?/);
    for (const w of h.get("subject")!.split(" ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeWords(h.get("subject")!)).toBe(subject);
    // No raw non-ASCII byte anywhere in the header block.
    const block = raw.toString("latin1").slice(0, raw.toString("latin1").indexOf("\r\n\r\n"));
    expect(block).toMatch(/^[\x00-\x7f]*$/);
  });

  it("encoded words never split a UTF-8 sequence", () => {
    const s = "é".repeat(40) + "😀".repeat(20);
    expect(encodeWords(s).map((w) => decodeWords(w)).join("")).toBe(s);
  });

  it("In-Reply-To and References present when replying", () => {
    const h = headers(buildMime(base({ inReplyTo: "<a@x.nl>", references: "<z@x.nl> <a@x.nl>" })));
    expect(h.get("in-reply-to")).toBe("<a@x.nl>");
    expect(h.get("references")).toBe("<z@x.nl> <a@x.nl>");
    const plain = headers(buildMime(base()));
    expect(plain.has("in-reply-to")).toBe(false);
    expect(plain.has("references")).toBe(false);
  });

  it("Message-ID is the generated one", () => {
    const mid = newMessageId();
    expect(mid).toMatch(/^<[0-9a-f-]{36}@verder\.vanderpoel\.pro>$/);
    expect(headers(buildMime(base({ messageId: mid }))).get("message-id")).toBe(mid);
  });

  it("attachment round-trips", () => {
    const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    const raw = buildMime(base({ attachments: [
      { fileName: "Loonstrook september.pdf", mime: "application/pdf", bytes }] })).toString("utf8");
    const boundary = /boundary="([^"]+)"/.exec(raw)![1];
    const parts = raw.split(`--${boundary}`);
    // preamble, text, attachment, closing "--"
    expect(parts).toHaveLength(4);
    const att = parts[2];
    expect(att).toContain('filename="Loonstrook september.pdf"');
    const content = att.slice(att.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, "");
    expect(Buffer.from(content, "base64").equals(bytes)).toBe(true);
    const text = parts[1];
    const body = Buffer.from(text.slice(text.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64")
      .toString("utf8");
    expect(body).toBe(base().body.replace(/\n/g, "\r\n"));
  });

  it("a non-ASCII filename is RFC 2047", () => {
    const raw = buildMime(base({ attachments: [
      { fileName: "Overzicht schuldeisers — oktober.pdf", mime: "application/pdf", bytes: Buffer.from("x") }] }))
      .toString("utf8");
    const m = /filename="([^"]+)"/.exec(raw)!;
    expect(decodeWords(m[1])).toBe("Overzicht schuldeisers — oktober.pdf");
  });

  it("no X-Unsent header", () => {
    const h = headers(buildMime(base({ cc: ["demi@verdergroep.nl"] })));
    expect(h.has("x-unsent")).toBe(false);
    expect(h.has("bcc")).toBe(false);
    expect(h.get("cc")).toBe("demi@verdergroep.nl");
  });

  it("refuses a header value with a line break", () => {
    expect(() => buildMime(base({ subject: "Hallo\r\nBcc: attacker@evil.tld" }))).toThrow(/line break/);
    expect(() => buildMime(base({ to: ["a@x.nl\nBcc: b@evil.tld"] }))).toThrow(/line break/);
  });
});
