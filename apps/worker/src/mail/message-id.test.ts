import { describe, expect, it, vi } from "vitest";
import { extractMessageId, normaliseMessageId } from "./message-id";

/**
 * This extractor decides whether a message is INGESTED or SKIPPED, so its two
 * failure directions are not symmetric and neither is cheap: a false positive
 * (reading someone else's id as this message's) silently drops mail from an
 * append-only dossier, and a false negative writes a permanent duplicate row
 * plus a redundant LLM job. The tests below are grouped by which of the two a
 * bug in that area would cause.
 */

const crlf = (...lines: string[]) => lines.join("\r\n");

describe("extractMessageId — finding the header", () => {
  it("matches the header name however it is spelled", () => {
    for (const name of ["Message-ID", "Message-Id", "message-id", "MESSAGE-ID"]) {
      expect(extractMessageId(crlf(
        "From: a@b.nl", `${name}: <abc123@mail.example>`, "", "body",
      ))).toBe("abc123@mail.example");
    }
  });

  it("reads bare-LF messages, which is what an mbox export gives", () => {
    // This whole slice exists because two export formats disagree about bytes:
    // Takeout's mbox uses bare LF, the wire format uses CRLF, and the same
    // message must come out with the same id from both or the dedup misses.
    const lf = "From: a@b.nl\nMessage-ID: <abc123@mail.example>\n\nbody\n";
    const wire = crlf("From: a@b.nl", "Message-ID: <abc123@mail.example>", "", "body", "");
    expect(extractMessageId(lf)).toBe(extractMessageId(wire));
    expect(extractMessageId(lf)).toBe("abc123@mail.example");
  });

  it("accepts a Buffer and a string alike", () => {
    const raw = crlf("Message-ID: <buf@mail.example>", "", "body");
    expect(extractMessageId(Buffer.from(raw, "utf8"))).toBe("buf@mail.example");
    expect(extractMessageId(raw)).toBe("buf@mail.example");
  });

  it("unfolds a continuation line (RFC 5322 §2.2.3), space or tab", () => {
    // A long Message-ID from a Java or Exchange sender is routinely folded onto
    // the next line. Not unfolding leaves the header value empty, which reads as
    // "this message has no id" — a duplicate on every future sync.
    expect(extractMessageId(crlf(
      "Message-ID:", " <folded.onto.the.next.line@mail.example>", "", "body",
    ))).toBe("folded.onto.the.next.line@mail.example");
    expect(extractMessageId(crlf(
      "Message-ID: <first.half", "\t.second.half@mail.example>", "", "body",
    ))).toBe("first.half.second.half@mail.example");
  });

  it("does not confuse a header whose name merely ends in message-id", () => {
    // Resent-Message-ID is the id of the RESENT copy's original, i.e. a
    // DIFFERENT message. Matching it by suffix would give two unrelated mails
    // the same identity and silently drop the second.
    expect(extractMessageId(crlf(
      "Resent-Message-ID: <resent@mail.example>", "From: a@b.nl", "", "body",
    ))).toBeNull();
  });

  it("uses only the FIRST Message-ID when a malformed message carries several", () => {
    expect(extractMessageId(crlf(
      "Message-ID: <first@mail.example>",
      "Message-ID: <second@mail.example>", "", "body",
    ))).toBe("first@mail.example");
  });

  it("returns null for an empty first header rather than falling through", () => {
    // "First" is not "first usable". Falling through to a second header would
    // be this module deciding which of two conflicting claims is the real
    // identity; every MTA and every other parser takes the first one, and a
    // null here costs one duplicate row while guessing wrong drops a mail.
    expect(extractMessageId(crlf(
      "Message-ID:", "Message-ID: <second@mail.example>", "", "body",
    ))).toBeNull();
  });
});

describe("extractMessageId — the header/body boundary", () => {
  it("does NOT read a Message-ID quoted in the body", () => {
    // THE FAILURE THIS TEST EXISTS FOR. A forwarded mail, a pasted header
    // block, a bug report — all put a literal "Message-ID: <...>" line at the
    // start of a body line. Reading it would give two unrelated messages the
    // same identity, and the dedup would then skip one of them forever.
    const raw = crlf(
      "From: verder@verdergroep.nl",
      "Subject: FW: uw dossier",
      "",
      "Doorgestuurd bericht:",
      "Message-ID: <evil@example>",
      "From: someone@else.nl",
    );
    expect(extractMessageId(raw)).toBeNull();
  });

  it("prefers the real header over one quoted below the boundary", () => {
    const raw = crlf(
      "Message-ID: <real@mail.example>",
      "",
      "Message-ID: <evil@example>",
    );
    expect(extractMessageId(raw)).toBe("real@mail.example");
  });

  it("stops at a bare LF LF boundary as well as CRLF CRLF", () => {
    expect(extractMessageId("From: a@b.nl\n\nMessage-ID: <evil@example>\n")).toBeNull();
  });

  it("treats a headers-only message and a leading blank line correctly", () => {
    // A headers-only message AS TRANSMITTED still ends its block: RFC 5322
    // §2.1 writes CRLF CRLF whether or not a body follows, and an IMAP/JMAP
    // headers-only fetch returns it too. So the realistic spelling has the
    // trailing empty line, and it reads normally.
    expect(extractMessageId(crlf("Message-ID: <only@mail.example>", "")))
      .toBe("only@mail.example");
    // WITHOUT that terminator it is a fragment, not a message, and it is
    // refused — see the boundary test below for why an unterminated block gets
    // no identity. This is the cheap direction: one duplicate row, repairable
    // by a later backfill, where the alternative direction is not repairable
    // at all.
    expect(extractMessageId(crlf("Message-ID: <only@mail.example>"))).toBeNull();
    // A message that opens with the boundary has no headers at all, so
    // everything after it is body.
    expect(extractMessageId(crlf("", "Message-ID: <evil@example>"))).toBeNull();
  });

  it("does not end the header block on a whitespace-only line", () => {
    // RFC 5322 ends the headers at CRLF CRLF exactly; a line holding a single
    // space is a continuation, not a boundary. Ending there would hide every
    // header below it, and Message-ID sits near the bottom in most mail.
    expect(extractMessageId(crlf(
      "From: a@b.nl", " ", "Message-ID: <below@mail.example>", "", "body",
    ))).toBe("below@mail.example");
  });

  it("stops at a column-0 line that is not `ftext \":\"`-shaped", () => {
    // MEASURED against this module before the fix: the first and the third of
    // these returned "evil@example". The walk broke out ONLY on `line === ""`,
    // so a body line that is not header-shaped did not stop it — it merely
    // became the next `pending`, and the scan carried on into the body. The
    // very next thing in a forwarded body IS a header block, which is exactly
    // the false positive this file exists to prevent.
    //
    // The realistic shape is a Takeout mbox entry with NO Message-ID of its own
    // (legal, and Gmail's mbox does contain such rows) whose body quotes a
    // forwarded header block, with the blank separator line re-wrapped to a
    // single space or mangled away altogether — which is what a re-wrapped or
    // mangled export produces.
    expect(extractMessageId(crlf(
      "From: a@b.nl", "Subject: fwd", " ",
      "Beste meneer Van der Poel", "Message-ID: <evil@example>", "",
    ))).toBeNull();
    // The same message with a PROPER empty separator line was always read
    // correctly; the bug only ever showed with a malformed or absent boundary.
    expect(extractMessageId(crlf(
      "From: a@b.nl", "Subject: fwd", "",
      "Beste meneer Van der Poel", "Message-ID: <evil@example>", "",
    ))).toBeNull();
    // No boundary at all: the quoted block runs straight on from the headers.
    expect(extractMessageId(crlf(
      "From: a@b.nl", "Subject: fwd", "Doorgestuurd bericht",
      "Message-ID: <evil@example>",
    ))).toBeNull();
  });

  it("refuses an id from a block that never closed, even one above the garbage", () => {
    // REVERSED DELIBERATELY, and the earlier assertion (that `real@` should
    // still be returned here) was the more attractive of the two answers: it
    // keeps an id the message plainly states, and refusing costs a duplicate.
    //
    // It cannot be kept, because the rule it needs is unimplementable. Telling
    // a real header from a quoted one by SHAPE does not work: `Betreft:` opens
    // half of Dutch business correspondence and `http://example.com/x` opens
    // countless bodies, and both are perfectly good `ftext ":"`. MEASURED on
    // the shape-only version of this module, both of these returned
    // evil@example. The only structural signal that a header block was real is
    // the empty line RFC 5322 §2.1 ends it with, so an unterminated block gets
    // no identity at all — including whatever was read before the garbage,
    // because in the measured cases the garbage is what let the walk reach an
    // id in the first place.
    //
    // Nothing real pays for this. Every production input carries the boundary:
    // the Gmail API returns a whole RFC822 message, the vault stores one, and
    // Takeout's mbox writes one. What loses its id here is a fragment, and a
    // fragment's identity is exactly what should not be guessed.
    expect(extractMessageId(crlf(
      "Message-ID: <real@mail.example>", "Doorgestuurd bericht",
      "Message-ID: <evil@example>",
    ))).toBeNull();
    // And the case that forced it: no id of its own, a header-SHAPED body line,
    // no boundary. Shape alone cannot refuse this one.
    expect(extractMessageId(crlf(
      "From: iemand@voorbeeld.nl", "Subject: Doorgestuurd",
      "Betreft: uw dossier", "Message-ID: <evil@example>",
    ))).toBeNull();
    // Close the block properly and the same headers read normally, which is
    // what keeps this a boundary rule rather than a ban on forwarded mail.
    expect(extractMessageId(crlf(
      "From: iemand@voorbeeld.nl", "Message-ID: <real@mail.example>", "",
      "Betreft: uw dossier", "Message-ID: <evil@example>", "",
    ))).toBe("real@mail.example");
  });

  it("reads a Takeout mbox entry whose first line is the From_ separator", () => {
    // RFC 4155's "From " line is not a header and can never be ftext-shaped —
    // and it opens EVERY entry in the Takeout mbox this slice was built for, so
    // a walk that stops at the first non-header line stops before it has read
    // anything at all unless this one line is allowed past.
    expect(extractMessageId([
      "From martin@vanderpoel.pro Thu Aug 27 09:14:02 2026",
      "From: a@b.nl", "Message-ID: <mbox@mail.example>", "", "body",
    ].join("\n"))).toBe("mbox@mail.example");
    // ...but only as the FIRST line. Further down it is a body line quoting a
    // forwarded mail, and the walk must stop there.
    expect(extractMessageId([
      "From: a@b.nl", "Subject: fwd",
      "From martin@vanderpoel.pro Thu Aug 27 09:14:02 2026",
      "Message-ID: <evil@example>",
    ].join("\n"))).toBeNull();
  });
});

describe("extractMessageId — bounded reads", () => {
  it("converts only a bounded head of a large message, not the whole body", () => {
    const head = Buffer.from(crlf(
      "From: a@b.nl", "Message-ID: <big@mail.example>", "", "",
    ), "utf8");
    // 8 MiB of body with a quoted id at the very end: a mailed loonstrook-with-
    // attachments is this size routinely, and the archive import walks 146k of
    // them, so scanning bodies is both a correctness risk and an O(bytes) cost.
    const body = Buffer.concat([
      Buffer.alloc(8 * 1024 * 1024, 0x61),
      Buffer.from("\r\nMessage-ID: <evil@example>\r\n", "utf8"),
    ]);
    const raw = Buffer.concat([head, body]);

    const original = Buffer.prototype.toString;
    let widest = 0;
    const spy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(
      function (this: Buffer, ...args: unknown[]) {
        widest = Math.max(widest, this.length);
        return original.apply(this, args as never);
      } as never);
    try {
      expect(extractMessageId(raw)).toBe("big@mail.example");
    } finally {
      spy.mockRestore();
    }
    expect(widest).toBeLessThan(raw.length);
    expect(widest).toBeLessThanOrEqual(1024 * 1024);
  });

  it("finds nothing in a huge message that has no header block at all", () => {
    const raw = Buffer.alloc(4 * 1024 * 1024, 0x61);
    expect(extractMessageId(raw)).toBeNull();
  });

  // A header block padded past the 1 MiB bound so that the slice cuts INSIDE
  // the Message-ID line, 30 characters in — i.e. exactly after
  // "Message-ID: <trunc.abcdefghijk", whatever follows in the full id.
  const CUT_AT = "Message-ID: <trunc.abcdefghijk".length;
  const cutInsideIdLine = (id: string, padBytes = 1024 * 1024) => {
    const prefix = "From: a@b.nl\r\n";
    const pad = "X-Pad: " + "a".repeat(padBytes - prefix.length - 2 - 7 - CUT_AT) + "\r\n";
    return `${prefix}${pad}Message-ID: <${id}@mail.example>\r\nSubject: below the cut\r\n\r\nbody`;
  };

  it("discards a Message-ID line the 1 MiB bound cut in half", () => {
    // MEASURED before the fix: this returned "<trunc.abcdefghijk" — a leading
    // "<", no "@", no closing ">" — and THAT is what was INSERTed as the row's
    // dedup key. The bound's own comment reasons carefully about why no body
    // line can be misread and then never considers the partial line the slice
    // itself creates.
    expect(extractMessageId(cutInsideIdLine("trunc.abcdefghijk"))).toBeNull();
    expect(extractMessageId(Buffer.from(cutInsideIdLine("trunc.abcdefghijk"), "utf8")))
      .toBeNull();
    // The control: the identical message with a header block that FITS is read
    // in full, so the rule really is "the bound cut it", not "long headers are
    // suspect". A Received/ARC/DKIM chain runs to tens of kilobytes and every
    // one of those messages must still yield its id.
    expect(extractMessageId(cutInsideIdLine("trunc.abcdefghijk", 4096)))
      .toBe("trunc.abcdefghijk@mail.example");
  });

  it("does not give two cut-off messages one identity", () => {
    // Why the truncated value is not merely ugly. One duplicate row is the
    // cheap direction; but two messages from one sender share a header layout
    // AND an id prefix, so they truncate to the SAME string — and the second is
    // then skipped as already-ingested and is permanently absent.
    const a = extractMessageId(cutInsideIdLine("trunc.abcdefghijk.AAAAAA"));
    const b = extractMessageId(cutInsideIdLine("trunc.abcdefghijk.BBBBBB"));
    expect(a).toBeNull();
    expect(b).toBeNull();
  });
});

describe("normaliseMessageId", () => {
  it("strips exactly one surrounding pair of angle brackets", () => {
    expect(normaliseMessageId("<abc@mail.example>")).toBe("abc@mail.example");
    expect(normaliseMessageId("<<abc@mail.example>>")).toBe("<abc@mail.example>");
  });

  it("makes a bracketed and a bare spelling of one id compare equal", () => {
    // Deliberate normalisation, not sloppiness: Gmail's API hands the value
    // back bracketed and some stores hand it back bare. Nothing is lost — the
    // brackets are RFC 5322 delimiters and are not part of the id.
    expect(normaliseMessageId("<abc@mail.example>"))
      .toBe(normaliseMessageId("abc@mail.example"));
  });

  it("preserves case", () => {
    // RFC 5322 makes id-left an opaque token, case-SENSITIVE, so two ids that
    // differ only in case are two different messages. relevance.ts folds ASCII
    // case for ADDRESSES because a mailbox name is case-insensitive in practice;
    // this is the opposite decision for the opposite reason.
    expect(normaliseMessageId("<AbC.Def@Mail.Example>")).toBe("AbC.Def@Mail.Example");
    expect(extractMessageId(crlf("Message-ID: <AbC@Mail.EXAMPLE>", "", "b")))
      .toBe("AbC@Mail.EXAMPLE");
  });

  it("returns null and never an empty string for nothing at all", () => {
    for (const value of ["", "   ", "\t", "<>", "< >", "<\t>"]) {
      expect(normaliseMessageId(value)).toBeNull();
    }
    expect(extractMessageId(crlf("Message-ID:   ", "", "body"))).toBeNull();
    expect(extractMessageId(crlf("From: a@b.nl", "", "body"))).toBeNull();
    expect(extractMessageId("")).toBeNull();
  });

  it("takes the bracketed id when a comment or a second value trails it", () => {
    expect(normaliseMessageId("<abc@mail.example> (added by relay)"))
      .toBe("abc@mail.example");
  });

  it("keeps an unbracketed value as it stands", () => {
    expect(normaliseMessageId("  abc@mail.example  ")).toBe("abc@mail.example");
  });

  it("keeps the WHOLE run between the outermost brackets when two are present", () => {
    // MEASURED, and pinned here because the comment above the regex used to
    // claim the opposite. `<id> <junk>` IS wrapped — the outer pair matches
    // from the first "<" to the last ">" — so the greedy branch keeps the
    // brackets in the middle rather than taking the first bracketed run.
    //
    // Deliberately left as it is; see the comment on the regex. The junk value
    // is deterministic and unique per input, so it costs at most one duplicate
    // row, while taking the first run would collapse every message from a
    // broken client that emits a templated first id onto ONE key.
    expect(normaliseMessageId("<a@b> <c@d>")).toBe("a@b><c@d");
    expect(normaliseMessageId("<a@b>, <c@d>")).toBe("a@b>,<c@d");
    // The other half of that comment IS true: a trailing CFWS comment is not
    // bracketed, so the value is not wrapped and the first run wins.
    expect(normaliseMessageId("<a@b> (added by relay)")).toBe("a@b");
  });
});

describe("extractMessageId — the latin1/utf8 asymmetry", () => {
  it("decodes Buffer bytes as latin1, so a non-ASCII id reads differently per path", () => {
    // MEASURED, and pinned so nobody "fixes" it. A non-ASCII Message-ID is
    // illegal but broken clients emit them, and the two ingest paths then
    // disagree: the Buffer path (Stalwart/mbox bytes) mojibakes it, the JMAP
    // path gets a server-decoded UTF-8 string. The cost is one duplicate row —
    // the cheap direction — and the reason not to trade it away is in the
    // comment on the decode.
    const raw = "Message-ID: <ünïqué@mail.example>\r\n\r\nbody";
    expect(extractMessageId(Buffer.from(raw, "utf8"))).toBe("Ã¼nÃ¯quÃ©@mail.example");
    expect(extractMessageId(raw)).toBe("ünïqué@mail.example");
  });
});

describe("extractMessageId — a realistic message", () => {
  // A Verder mail as Stalwart hands it over: mbox-style bare LF, a Received
  // chain and DKIM above the interesting headers, a folded Subject, a
  // multipart body, and the original headers quoted inside the forwarded part.
  const REAL = [
    "From martin@vanderpoel.pro Thu Aug 27 09:14:02 2026",
    "Return-Path: <bounces@verdergroep.nl>",
    "Received: from mail.verdergroep.nl (mail.verdergroep.nl [203.0.113.9])",
    "\tby mx.example.net with ESMTPS id 4c2f9a1b",
    "\tfor <martin@vanderpoel.pro>; Thu, 27 Aug 2026 09:14:01 +0200 (CEST)",
    "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=verdergroep.nl;",
    " s=selector1; h=from:to:subject:message-id; b=Zm9vYmFyYmF6",
    "From: Team Opstart <opstart@verdergroep.nl>",
    "To: Martin van der Poel <martin@vanderpoel.pro>",
    "Subject: Re: Aanleveren stukken dossier NLTZ2612548IVB",
    " - aanvullende gegevens",
    "Date: Thu, 27 Aug 2026 09:14:00 +0200",
    "Message-ID:",
    " <CAF9x8Qm2vK7pQ@mail.verdergroep.nl>",
    "In-Reply-To: <20260826.113000.42@vanderpoel.pro>",
    "References: <20260826.113000.42@vanderpoel.pro>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=\"----=_Part_9\"",
    "",
    "------=_Part_9",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Beste meneer Van der Poel,",
    "",
    "Hieronder het eerdere bericht:",
    "",
    "From: Martin van der Poel <martin@vanderpoel.pro>",
    "Message-ID: <20260826.113000.42@vanderpoel.pro>",
    "Subject: Aanleveren stukken",
    "",
    "------=_Part_9--",
    "",
  ].join("\n");

  it("returns the message's own id, unfolded, and not the quoted one", () => {
    expect(extractMessageId(REAL)).toBe("CAF9x8Qm2vK7pQ@mail.verdergroep.nl");
    expect(extractMessageId(Buffer.from(REAL, "utf8")))
      .toBe("CAF9x8Qm2vK7pQ@mail.verdergroep.nl");
  });

  it("is not fooled by In-Reply-To or References standing above the body", () => {
    // Both carry a well-formed <id> and both name a DIFFERENT message; picking
    // one would file this mail under its parent and skip it as a duplicate.
    expect(extractMessageId(REAL)).not.toBe("20260826.113000.42@vanderpoel.pro");
  });

  it("gives the same answer for the CRLF spelling of the same message", () => {
    expect(extractMessageId(REAL.split("\n").join("\r\n"))).toBe(extractMessageId(REAL));
  });
});
