import { describe, expect, it } from "vitest";
import { mailboxList, replyHeaders, replySubject, threadingHeaders } from "./threading";

const msg = (headers: string[], body = "Beste Martin,\r\n\r\nGroet."): Buffer =>
  Buffer.from([...headers, "", body].join("\r\n"), "latin1");

describe("threadingHeaders", () => {
  it("reads In-Reply-To and References", () => {
    const raw = msg([
      "From: Demi <demi@verdergroep.nl>",
      "Message-ID: <c@mail.verder.nl>",
      "In-Reply-To: <b@mail.example>",
      "References: <a@mail.example>",
      " <b@mail.example>",
      "Subject: Re: stukken",
    ]);
    expect(threadingHeaders(raw)).toEqual({
      messageId: "c@mail.verder.nl", inReplyTo: "b@mail.example",
      references: ["a@mail.example", "b@mail.example"],
    });
  });

  it("ignores a body that quotes headers", () => {
    const raw = msg(["From: Demi <demi@verdergroep.nl>", "Subject: Doorgestuurd"],
      "Message-ID: <evil@example>\r\nIn-Reply-To: <evil2@example>\r\nReferences: <evil3@example>");
    expect(threadingHeaders(raw)).toEqual({ messageId: null, inReplyTo: null, references: [] });
  });

  it("trusts nothing without the empty line that ends the header block", () => {
    const raw = Buffer.from("From: a@b.nl\r\nMessage-ID: <x@y>\r\nReferences: <r@y>", "latin1");
    expect(threadingHeaders(raw)).toEqual({ messageId: null, inReplyTo: null, references: [] });
  });

  it("reads bare-LF mail the same as CRLF", () => {
    const raw = Buffer.from("Message-ID: <c@x>\nReferences: <a@x> <b@x>\n\nbody", "latin1");
    expect(threadingHeaders(raw)).toMatchObject({ messageId: "c@x", references: ["a@x", "b@x"] });
  });
});

describe("replyHeaders", () => {
  it("answers the parent and appends it to References", () => {
    expect(replyHeaders({ messageId: "c@x", references: ["a@x", "b@x"] })).toEqual({
      inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>",
    });
  });

  it("References is capped at the last 10 ids", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `r${i}@x`);
    const out = replyHeaders({ messageId: "parent@x", references: refs });
    const ids = out.references!.split(" ");
    expect(ids).toHaveLength(10);
    expect(ids[9]).toBe("<parent@x>");
    expect(ids[0]).toBe("<r3@x>");
  });

  it("drops an id that could break the header it is written into", () => {
    const out = replyHeaders({ messageId: "ok@x", references: ["a b@x", "evil@x>\r\nBcc: c@d", "fine@x"] });
    expect(out).toEqual({ inReplyTo: "<ok@x>", references: "<fine@x> <ok@x>" });
  });

  it("a parent with no Message-ID gives no In-Reply-To", () => {
    expect(replyHeaders({ messageId: null, references: [] })).toEqual({});
  });
});

describe("replySubject", () => {
  it("replySubject keeps an existing Re:", () => {
    expect(replySubject("Re: stukken")).toBe("Re: stukken");
    expect(replySubject("RE:stukken")).toBe("RE:stukken");
    expect(replySubject("Antw: stukken")).toBe("Antw: stukken");
  });
  it("adds Re: otherwise", () => {
    expect(replySubject("Informatie over uw dossier")).toBe("Re: Informatie over uw dossier");
  });
  it("never carries a line break into the header", () => {
    expect(replySubject("a\r\nBcc: x@y")).toBe("Re: a Bcc: x@y");
  });
});

describe("mailboxList", () => {
  it("splits a list at top-level commas only", () => {
    expect(mailboxList('"Willemse, Demi" <demi@verdergroep.nl>, b@x.nl'))
      .toEqual(['"Willemse, Demi" <demi@verdergroep.nl>', "b@x.nl"]);
  });
  it("an empty header has no mailboxes", () => {
    expect(mailboxList("  ")).toEqual([]);
  });
});
