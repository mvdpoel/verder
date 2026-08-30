-- Redo 0032's sender backfill against the headers the dossier actually holds.
--
-- 0032 joined `lower(p.email) = lower(r.from_addr)` and filled almost nothing.
-- Measured in production before this file was written: 107 of 130 raw_emails
-- rows hold a WHOLE header (`Demi Willemse <demi@verdergroep.nl>`) and only 23
-- hold a bare address, because ingestRawEmail stores `msg.from` verbatim and
-- the Gmail port passes the header through untouched. So the sender column
-- would have read "Onbekend" for nearly every document — a feature that looks
-- unused rather than a query that is broken.
--
-- THE ASCII GUARD IS NOT DECORATION. Postgres `lower()` performs full Unicode
-- case mapping, so U+212A KELVIN SIGN folds to ASCII `k` and a sender-chosen
-- header could fold into an address the dossier watches — the exact hazard
-- apps/worker/src/mail/relevance.ts:26-39 documents and the reason the worker
-- folds with `asciiLower` instead. Restricting BOTH sides to pure ASCII makes
-- `lower()` safe here, because within ASCII it is the identity fold.
--
-- THE EXTRACTION RULE (ported from apps/worker/src/gmail.ts's `senderAddress`,
-- controller Ruling 12 — four review rounds on the worker side found that
-- picking the first address loses to a quoted display name, picking the last
-- loses to a trailing RFC 5322 comment, and a hand-written comment-stripper
-- loses to a legal `quoted-pair` escape, e.g.
-- `<a@evil.tld> ( \) <spoofed@watched.nl> \( )` is a fully VALID header whose
-- comment a stripper mis-terminates). `from_addr` is sender-controlled text,
-- so this migration inherits the same threat model and the same fail-closed
-- answer: refuse to parse anything ambiguous.
--
--   - Refuse a value containing a parenthesis anywhere (`(` or `)`): RFC 5322
--     comments nest and take quoted-pair escapes, and no SQL expression here
--     attempts to parse them.
--   - Refuse a value with more than one `<`: a second mailbox, or a `<`
--     hidden inside a quoted display name — either way the header names more
--     than one candidate and there is no rule for picking among them.
--   - Otherwise, with exactly one `<`, accept the content of its `<...>` pair
--     ONLY if the WHOLE value matches `^[^<>]*<[^<>]*>[[:space:]]*$` AND the
--     captured content is address-shaped end to end. Both halves of that
--     anchor are load-bearing, and a first version of this migration shipped
--     without either, which a review caught with two attacks:
--       (1) a quoted-string LOCAL PART is legal RFC 5322 `addr-spec`, and `<`
--           `>` are legal `qtext` inside a quoted string, so
--           `"<demi@verdergroep.nl>"@evil.tld` has exactly one `<`, no
--           parenthesis, is pure ASCII, and its `<...>` content
--           (`demi@verdergroep.nl`) is address-shaped — every earlier guard
--           passed it and it resolved the WATCHED address while the real
--           mailbox was `@evil.tld`. The `^[^<>]*` prefix requirement fixes
--           this: whatever precedes the `<` must contain no `<`/`>` at all,
--           which a quoted `<addr>` used as a local part never satisfies
--           once the domain after it is accounted for by the suffix anchor
--           below (the `@evil.tld` after the closing `"` is not whitespace,
--           so the whole-value anchor fails and the value resolves to NULL,
--           exactly like `apps/worker/src/gmail.ts`'s `senderAddress`).
--       (2) `apps/worker/src/gmail.ts:151`'s comment says it precisely:
--           "angle-addr allows only CFWS after the `>` ... anything but
--           whitespace here is unaccounted-for text", and `:134` refuses a
--           second `>`. A first version of this file dropped both rules and
--           accepted `<D> attacker@evil.tld`, `<D>x`, `<D>>`,
--           `<D>; attacker@evil.tld` and worse — MORE permissive than the
--           function it ports, not a conservative simplification. The
--           `[[:space:]]*$` suffix requirement fixes this: nothing but
--           whitespace may follow the `>`, all the way to the end of the
--           value.
--   - With no `<` at all, accept the whole trimmed value only if it is
--     address-shaped end to end (a bare address, e.g. from the JMAP port).
--   - Everything else — unterminated `<`, a `<...>` pair whose content is not
--     a clean address, text before or after the pair, a second `>`, a
--     comma-separated list, anything — resolves to NULL.
--
-- This is deliberately weaker than `senderAddress` in the ways that remain
-- (no quoted-string awareness beyond what the anchor above buys, no top-level
-- comma/colon/semicolon refusal): SQL cannot express a stateful character-by-
-- character scan as a single expression. What it keeps is the property that
-- matters — it is checked in packages/db/src/sender-backfill.test.ts against
-- the exact shapes that defeated three prior attempts on the worker side, the
-- nine decoy shapes a review found this migration's first version missed, and
-- every attacker/spoofed fixture `from_addr` already sitting in this dev
-- database from the worker's own review rounds: every one of those resolves
-- to the true addr-spec or to nothing, never to the decoy.
--
-- KNOWN, ACCEPTED COST of the anchor fix above: a quoted display name that
-- itself contains a bare `>` (legal `qtext`, RFC 5322 never requires it
-- escaped — e.g. `"weird > name" <demi@verdergroep.nl>`) now resolves to
-- NULL here even though `senderAddress` correctly resolves it, because this
-- expression cannot tell a `>` inside quotes from one that closes the real
-- angle-addr. This is the same fail-closed trade-off as the "more than one
-- `<`" rule already accepts for a `<` hidden inside a quoted string: refusing
-- costs an "Onbekend" a human corrects; the alternative is guessing inside a
-- quoted string SQL cannot parse. Pinned as a test so it reads as an accepted
-- trade-off, not an unnoticed regression.
--
-- The markers below let the test import this exact expression by reading this
-- file, rather than keeping a hand-copied twin that could drift from it.
--
-- Idempotent: only rows whose party_id is still NULL are touched (0032's
-- backfill already ran, so this re-tries only what it left NULL), so this is
-- safe to run whether or not it matches anything, and safe to run twice.
UPDATE "documents" d SET "party_id" = p."id"
FROM "raw_emails" r
JOIN "parties" p
  ON p."email" IS NOT NULL
 AND p."email" ~ '^[[:ascii:]]+$'
 AND lower(p."email") = lower(
-- SENDER-EXTRACT-BEGIN
       CASE
         WHEN r."from_addr" ~ '[()]' THEN NULL
         WHEN length(r."from_addr") - length(replace(r."from_addr", '<', '')) > 1 THEN NULL
         WHEN r."from_addr" ~ '^[^<>]*<[^<>]*>[[:space:]]*$' THEN
           CASE
             WHEN btrim(substring(r."from_addr" from '<([^<>]*)>'))
                  ~* '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
               THEN btrim(substring(r."from_addr" from '<([^<>]*)>'))
             ELSE NULL
           END
         WHEN btrim(r."from_addr")
                ~* '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
           THEN btrim(r."from_addr")
         ELSE NULL
       END
-- SENDER-EXTRACT-END
     )
WHERE d."source" = 'email-attachment'
  AND d."source_ref" = r."gmail_message_id"
  AND d."party_id" IS NULL
  AND r."from_addr" ~ '^[[:ascii:]]*$';
