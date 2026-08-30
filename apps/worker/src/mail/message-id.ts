/**
 * THE ONE IDENTITY THAT SPANS BOTH INGEST NAMESPACES.
 *
 * A Stalwart Email id is not a Gmail message id, and Google Takeout's mbox
 * bytes are not the bytes Gmail's API returned for the same message, so neither
 * `raw_emails.gmail_message_id` nor `raw_emails.raw_rfc822_sha256` recognises a
 * mail the dossier already holds: measured on the archive import at 130
 * relevant messages matching 0 of 107 existing rows, i.e. ~114 permanent
 * duplicate rows in an append-only table and ~114 redundant LLM jobs on the
 * shared GPU. The RFC 5322 Message-ID is assigned by the ORIGINATING server and
 * survives both export formats intact, which is what makes it the right answer
 * — see the note on `raw_emails.message_id` in packages/db/src/schema.ts.
 *
 * BECAUSE THIS DECIDES INGEST-OR-SKIP, ITS TWO FAILURE DIRECTIONS ARE NOT
 * SYMMETRIC and both are expensive. A FALSE POSITIVE — reading an id that
 * belongs to some other message, most plausibly one quoted in a forwarded body
 * — gives two unrelated mails the same identity and silently drops one from a
 * dossier that has no DELETE grant to repair it with. A FALSE NEGATIVE — not
 * finding an id that is there — writes the duplicate this module exists to
 * prevent. So: every rule below is narrow where a wrong match would be silent,
 * and forgiving where the only cost is one duplicate row.
 *
 * Pure, no I/O, no database: the poller and the backfill both call it, and it
 * is testable against fixture bytes without either.
 */

/**
 * Case-fold ASCII, and ASCII ONLY — the same helper, and the same reasoning, as
 * `asciiLower` in relevance.ts: `String.toLowerCase()` is Unicode-aware and
 * maps characters like U+212A KELVIN SIGN onto plain ASCII. A header NAME is
 * attacker-chosen text, so folding it Unicode-aware means a name nobody can
 * read as "Message-ID" can still be accepted as one. Every legal field name is
 * US-ASCII (RFC 5322 §3.6.4 ftext), so folding anything else is guessing.
 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * How much of a message may be read to find its headers.
 *
 * A real header block is a few kilobytes; a long Received chain with ARC and
 * DKIM on top runs to a few tens. 1 MiB is far past anything legitimate and
 * still bounds the work for the archive import, where the alternative is
 * decoding 146 270 message bodies — gigabytes — to read a line near the top of
 * each. Nothing correct is lost by the bound: if no blank line falls inside the
 * first megabyte then the header block itself is longer than that, so the body
 * cannot start inside the slice either and no body line can be mistaken for a
 * header. `subarray` is a view, so only the slice is ever copied into a string.
 *
 * WHAT THAT REASONING MISSED, and it cost a measured false positive: the slice
 * does not only DROP lines, it MANUFACTURES one. Cutting at a fixed offset
 * lands mid-line, so the final element of the split is a PARTIAL header, and
 * `normaliseMessageId` validates no shape whatsoever — a cut inside a
 * `Message-ID:` line yielded `"<trunc.abcdefghijk"` (leading `<`, no `@`, no
 * closing `>`) and that string went into `raw_emails.message_id` as the row's
 * dedup key. Usually that costs one duplicate, the cheap direction. But two
 * messages from one sender share a header LAYOUT and an id PREFIX, so they
 * truncate to the SAME string, and the second is then skipped as
 * already-ingested and is permanently absent. So the final element is DISCARDED
 * unread whenever the input overflowed the bound — a message whose headers run
 * past a megabyte has no readable identity, and admitting that costs one
 * duplicate row where judging the fragment can drop a mail for good.
 *
 * A well-formed value never keeps a bracket — exactly one surrounding pair is
 * stripped — so `WHERE message_id LIKE '%<%'` is the production triage query
 * for rows this bug already wrote. It over-collects by exactly one shape, the
 * inner pair `normaliseMessageId` deliberately preserves in a malformed
 * `<<x>>`, and those are recognisable on sight by their closing `>`.
 */
const HEADER_SCAN_BYTES = 1024 * 1024;

/**
 * Normalise a Message-ID for comparison and storage.
 *
 * ANGLE BRACKETS ARE STRIPPED ON PURPOSE, and this is normalisation rather than
 * sloppiness: RFC 5322 §3.6.4 makes `<`/`>` the DELIMITERS around msg-id, not
 * part of it, so no uniqueness whatsoever is lost by removing them — while
 * keeping them loses the dedup, because Gmail's API hands the value back
 * bracketed and other stores hand back what they please. Exactly one
 * surrounding pair comes off, so a malformed `<<x>>` keeps its inner pair and
 * stays distinguishable rather than being quietly rewritten into `<x>`.
 *
 * CASE IS PRESERVED, which is the OPPOSITE of what relevance.ts does to
 * addresses, and deliberately so. That module folds ASCII case because a
 * mailbox name is case-insensitive in practice, so two spellings name one
 * person. Here id-left is an opaque token the originating server chose and RFC
 * 5322 gives no case-insensitivity: two ids differing only in case are two
 * different messages, and folding them would merge them — one of which then
 * never enters the dossier.
 */
export function normaliseMessageId(value: string): string | null {
  // Any CR/LF still present is a fold artefact from a caller that unfolded
  // nothing; the value cannot legally contain either. Collapsed rather than
  // rejected: refusing costs a duplicate row, and the intent is unambiguous.
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();

  // The canonical shape first, so exactly one pair is stripped from whatever
  // sits between the OUTERMOST brackets — the wrapped test is greedy, and that
  // matters for what it does NOT catch. Only a value that is not wrapped falls
  // through to the search for a bracketed run inside it, which is the
  // `<id> (comment)` case: a trailing CFWS comment carries no brackets, so the
  // first run wins and that matches what every other parser does.
  //
  // `<id> <junk>` is NOT that case, and an earlier version of this comment
  // wrongly claimed it was: two bracketed runs ARE wrapped, from the first `<`
  // to the last `>`, so the greedy branch keeps the middle brackets.
  // MEASURED: `<a@b> <c@d>` → `a@b><c@d`, `<a@b>, <c@d>` → `a@b>,<c@d`. Left
  // exactly as it stands, on purpose. The value is junk but it is DETERMINISTIC
  // and unique per input, so both sides of a comparison compute it identically
  // and the worst case is one duplicate row. Making the regex non-greedy would
  // take the first run in both branches — tidier to read, and the expensive
  // direction: a broken client that emits a templated first id
  // (`<tmpl@host> <seq@host>`) would collapse EVERY one of its messages onto
  // one key, and each after the first would be skipped as a duplicate and never
  // enter the dossier. Junk that is unique beats a plausible id that is shared.
  const wrapped = /^<([\s\S]*)>$/.exec(trimmed);
  const inner = wrapped ? wrapped[1] : /<([^<>]*)>/.exec(trimmed)?.[1] ?? trimmed;

  // No legal msg-id contains whitespace — RFC 5322 permits CFWS only OUTSIDE
  // the angle brackets — so anything left inside is an unfolded line break and
  // removing it is lossless. Keeping it would make two spellings of one id
  // compare unequal, which is precisely a duplicate row.
  const id = inner.replace(/\s+/g, "");

  // Never "": an empty string in `raw_emails.message_id` would be a value that
  // compares EQUAL to the next message that also has none, i.e. a dedup key
  // that matches unrelated mail. NULL means unknown, which is the truth.
  return id === "" ? null : id;
}

/** The Message-ID of an RFC822 message, or null when it has none. */
export function extractMessageId(raw: Buffer | string): string | null {
  // Whether the bound actually cut anything, which is what decides below
  // whether the last line of the split is a real line or a fragment the slice
  // invented. Measured on the same units the slice uses in each branch: UTF-16
  // code units for `String.slice`, bytes for `Buffer.subarray`.
  const overflowed = raw.length > HEADER_SCAN_BYTES;

  const head = typeof raw === "string"
    ? raw.slice(0, HEADER_SCAN_BYTES)
    // latin1 is byte-exact and never throws on a slice that cuts a multi-byte
    // sequence in half, which utf8 would paper over with U+FFFD. Field names
    // and msg-id are US-ASCII, so the two decodings agree on everything this
    // function reads, and latin1 additionally cannot invent an ASCII character
    // out of the tail of some multi-byte one.
    //
    // THE ASYMMETRY THIS LEAVES IS DELIBERATE — do not "fix" it. The Buffer
    // path decodes bytes; the JMAP path is handed a string the server already
    // decoded as UTF-8. So an ILLEGAL but real non-ASCII id from a broken
    // client reads differently per path: MEASURED, `<ünïqué@mail.example>`
    // gives `Ã¼nÃ¯quÃ©@mail.example` from bytes and `ünïqué@mail.example` from
    // the string. That costs one duplicate row, the cheap direction. Decoding
    // utf8 here would buy agreement on those and pay for it in the expensive
    // direction: U+FFFD from a split multi-byte sequence at the 1 MiB cut is an
    // invented character in a value used as a dedup key.
    : raw.subarray(0, HEADER_SCAN_BYTES).toString("latin1");

  // Splitting on /\r?\n/ takes CRLF and bare LF in one pass, which is the whole
  // point: the wire format uses CRLF and Takeout's mbox uses bare LF, and the
  // same message must yield the same id from both or the dedup this slice
  // exists for misses exactly the mails it was built to catch.
  const lines = head.split(/\r?\n/);

  // The fragment the bound manufactured, dropped unread — see HEADER_SCAN_BYTES
  // for why judging it can file two messages under one identity. Unconditional
  // when the input overflowed, because the only case where the last element is
  // a WHOLE line is one that ends exactly on the cut, and there is no way to
  // tell that apart from a fragment. It can never cost a real message its id:
  // if the header/body boundary fell inside the slice at all, the walk stops
  // there and never reaches the last element.
  if (overflowed) lines.pop();

  // The header currently being accumulated, unfolded. Evaluated only once the
  // NEXT header (or the boundary) proves it complete, because a folded value is
  // not readable until its continuations have been appended.
  let pending: string | null = null;

  /**
   * THE ID IS ONLY TRUSTED IF THE HEADER BLOCK WAS PROPERLY CLOSED.
   *
   * The shape check below is necessary and NOT sufficient, and the gap between
   * those two is a false positive — the expensive, unrepairable direction.
   * Stopping at the first column-0 line that is not `ftext ":"`-shaped catches
   * a body opening with prose, but a body line is very often header-SHAPED all
   * by itself. MEASURED on the shipped module before this flag existed:
   * `"From: …\r\nSubject: Doorgestuurd\r\nBetreft: uw dossier\r\nMessage-ID:
   * <evil@example>"` returned evil@example, because `Betreft:` is a perfectly
   * good ftext header, and so did the same message whose body began
   * `http://example.com/x` — `http:` is ftext too. Dutch business mail opens
   * with `Betreft:` constantly, and a forwarded one carries a quoted header
   * block right behind it.
   *
   * There is no shape rule that separates a real header from a quoted one, so
   * this stops guessing and asks for the structure instead: RFC 5322 §2.1 ends
   * every header block with an empty line, so a message that never produced one
   * is malformed and this module declines to say who it is. Refusing costs a
   * duplicate row — the cheap direction, and one a later backfill can still
   * repair — where accepting files a mail under a stranger's identity and the
   * next sync silently drops one of the two, permanently, from tables with no
   * DELETE grant.
   *
   * Every production input has the boundary: the Gmail API returns a whole
   * RFC822 message, the vault stores one, and Takeout's mbox writes one. It is
   * only ever absent from a fragment or a mangled export, which is precisely
   * the input whose identity should not be guessed at.
   */
  let sawBoundary = false;
  /** First match wins, but it cannot be RETURNED until the boundary proves the
   *  block was real — so it is held here rather than returned from the loop. */
  let found: string | null = null;
  /** Whether a Message-ID header was seen at all, which is a different question
   *  from whether it yielded a value — see the first-match note below. */
  let seenMessageId = false;

  // The name is trimmed before comparison — `Message-ID : <x>` puts a space
  // before the colon, which RFC 5322 forbids and some legacy relays emit
  // anyway. Accepting it risks nothing, because the comparison is on the WHOLE
  // name: `Resent-Message-ID` (the id of a DIFFERENT message) and
  // `X-Google-Original-Message-ID` still fail it, where a `startsWith` or an
  // `endsWith` would match both. Refusing the stray space, by contrast, costs a
  // duplicate row for a message that plainly states its identity.
  const isMessageId = (header: string): boolean => {
    const colon = header.indexOf(":");
    return colon >= 0 && asciiLower(header.slice(0, colon).trim()) === "message-id";
  };
  const idOf = (header: string): string | null =>
    normaliseMessageId(header.slice(header.indexOf(":") + 1));

  // RFC 5322 §3.6.8: a header line is `ftext ":"` — one or more printable
  // US-ASCII characters, 33 to 126 and never the colon itself, followed by the
  // colon. Anything at column 0 that does not have that shape is not a header
  // and cannot be the start of one.
  //
  // The optional WSP before the colon is NOT laxity for its own sake — it is
  // this function agreeing with `isMessageId` above, which trims the name for
  // exactly the reason documented there (legacy relays emit `Message-ID : <x>`
  // and refusing it costs a duplicate row for a message that plainly states its
  // identity). Without it the two disagree, and the disagreement is far worse
  // than the case it was written for: `isHeaderShaped` runs FIRST and breaks
  // the walk, so `isMessageId`'s trim is never reached. MEASURED on the
  // shipped module before this: `"Message-ID : <x@y>"` returned null, and — the
  // expensive half — a stray-space header standing ABOVE a good one
  // (`"Received : from a\r\nMessage-ID: <real@y>"`) also returned null, so one
  // relay's stray space anywhere in the block cost the message its identity
  // and duplicated it on every future sync.
  const isHeaderShaped = (line: string): boolean => /^[\x21-\x39\x3b-\x7e]+[ \t]*:/.test(line);

  for (const [index, line] of lines.entries()) {
    // THE HEADER/BODY BOUNDARY, and the single most important line in this
    // file. Headers end at the first EMPTY line (RFC 5322 §2.1). Everything
    // after it is body, and a body routinely contains a literal
    // "Message-ID: <...>" at the start of a line — a forwarded mail, a pasted
    // header block, a bug report. Reading one of those is the false positive
    // that gives two unrelated messages one identity and drops a mail for good.
    //
    // EMPTY, not blank: a line holding a single space or tab is a FOLD
    // continuation, and treating it as the boundary would hide every header
    // below it — Message-ID sits near the bottom in most real mail, so that
    // reads as "no id" and duplicates the message instead.
    if (line === "") { sawBoundary = true; break; }

    if (/^[ \t]/.test(line)) {
      // A continuation with no header above it (a truncated head, an mbox
      // separator artefact) belongs to nothing and is dropped rather than
      // guessed at.
      if (pending !== null) pending += line;
      continue;
    }

    // THE OTHER END OF THE HEADER BLOCK, and it is not always an empty line.
    // Breaking only on `line === ""` meant a column-0 line that is not header
    // shaped did not stop the walk — it merely became the next `pending` — so
    // the scan ran straight on into the body, and the very next thing in a
    // forwarded body is a quoted header block. MEASURED before this check:
    // "From/Subject/<space>/Beste meneer Van der Poel/Message-ID: <evil@…>"
    // returned evil@example, as did the same message with no separator line at
    // all, while the properly separated spelling returned null. That is the
    // realistic shape of a Takeout mbox entry with no Message-ID of its own —
    // legal, and the mbox does contain such rows — whose body quotes a
    // forwarded header, in an export whose blank line was re-wrapped to a
    // single space or mangled away.
    //
    // Note this only tightens the boundary and never moves it earlier for
    // legitimate mail: a fold continuation is handled above and is not at
    // column 0, and every real header by definition has this shape. What was
    // already read stands — the loop falls through to the return below, so a
    // Message-ID above the garbage is still this message's id.
    if (!isHeaderShaped(line)) {
      // ...with exactly one exception, and it is not optional: RFC 4155's
      // "From " envelope line opens EVERY entry in the Takeout mbox this slice
      // was built to read, and it is not a header and cannot be made to look
      // like one. Without this the walk stops on line 0 of every archived
      // message and the whole import dedups against nothing. It is allowed
      // ONLY at index 0: further down, a "From " at column 0 is body — an mbox
      // separator quoted inside a forwarded mail — and that is precisely the
      // line that must stop the walk.
      if (index === 0 && line.startsWith("From ")) continue;
      break;
    }

    // A complete header, so the previous one can now be judged. Returning on
    // the FIRST match — not the first USABLE one — is deliberate: a message
    // carrying two Message-ID headers is malformed, and choosing between two
    // conflicting claims of identity is not this module's call. Every MTA and
    // every other parser takes the first. If that first one is empty the answer
    // is null, which costs one duplicate row; silently preferring the second
    // could file this mail under an identity it never claimed.
    // FIRST MATCH WINS, INCLUDING AN EMPTY ONE — `seenMessageId` and not
    // `found !== null`. A message carrying two Message-ID headers is malformed,
    // and choosing between two conflicting claims of identity is not this
    // module's call; every MTA takes the first. If that first one is empty the
    // answer is null (one duplicate row), where falling through to the second
    // would file the mail under an identity it never claimed.
    if (!seenMessageId && pending !== null && isMessageId(pending)) {
      seenMessageId = true;
      found = idOf(pending);
    }
    pending = line;
  }

  // The last header before the boundary. A message that is nothing but headers
  // reaches here too — and, having produced no boundary, is refused by the
  // guard below exactly like any other unterminated block. As transmitted it
  // would have one: RFC 5322 ends the block with CRLF CRLF whether or not a
  // body follows, so the only inputs that lose an id here are fragments.
  if (!seenMessageId && pending !== null && isMessageId(pending)) found = idOf(pending);

  return sawBoundary ? found : null;
}
