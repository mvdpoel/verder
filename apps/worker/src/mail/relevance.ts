import { schema, type Db } from "@verder/db";

/**
 * WHO THE DOSSIER IS INTERESTED IN — one definition, both ports.
 *
 * This lived inside gmail.ts as a private helper plus an inline `hay.includes`
 * check. It moved here rather than being copied, because the two ports already
 * share `MailMessage` and `SkippedPart` for exactly this reason and a second
 * spelling of a filter is a filter that drifts. What the drift costs is on
 * record twice: testing `from` alone left 50 inbound emails ingested and ZERO
 * outbound, taking with it every attachment Martin SENT — the whole moratorium
 * package, paspoort, loonstroken, BKR — and having no filter at all is what
 * burned the Gmail quota into a permanent lockout.
 *
 * FINDING F. It also carried an `includes` on unvalidated data. `parties.email`
 * is free text nobody validates and RELEVANT_SENDERS is typed by hand into a
 * deploy command, so a single row holding " " matched `"<from> <to>"` — which
 * always contains a space — and every message in the mailbox became relevant.
 * That is the whole-mailbox ingest, and its unremovable `document.ingested`
 * event per attachment, straight back through the fix that was meant to stop
 * it. Two changes, and both are needed: the list is VALIDATED here, and the
 * predicate matches PARSED ADDRESSES instead of substrings, so junk that
 * somehow reaches it still cannot match anything.
 */

/**
 * Case-fold ASCII, and ASCII ONLY.
 *
 * `String.toLowerCase()` is Unicode-aware, and that is a hole here rather than
 * a feature: U+212A KELVIN SIGN lower-cases to plain ASCII "k", so
 * `incasso@<KELVIN>vk.nl` folded into `incasso@kvk.nl` on BOTH sides of this
 * module. On the list side a party row nobody can read as an address passed the
 * shape check below and then matched real KvK mail; on the message side a `from`
 * header — text the sender chooses — folded into an address the dossier watches
 * and let a stranger into an append-only ledger. Every address this filter can
 * legitimately name is ASCII (see the two patterns below), so folding anything
 * else is guessing, and this module's whole job is to refuse to guess.
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A domain entry: `@verdergroep.nl`, matching anybody at that exact domain. */
const DOMAIN_RE = /^@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** A whole address: `incasso@stam.nl`. */
const ADDRESS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** Addresses as they appear inside a header: `Demi <demi@verdergroep.nl>`,
 *  `a@b.nl, c@d.nl`, or bare. Deliberately the same shape as ADDRESS_RE. */
const IN_HEADER_RE = /[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;

/**
 * Every address a raw header names, ASCII-folded — never `toLowerCase`, see
 * `asciiLower` above. `From: Demi Willemse <demi@verdergroep.nl>` yields one
 * address; a `to` header can yield several. Shared by `isRelevantMessage`
 * below and by the sender-resolution lookup in `ingestRawEmail` (Task 3),
 * which is exactly the ONE-DEFINITION discipline this module already applies
 * to `MailMessage`/`SkippedPart`: a second, ad hoc regex over `msg.from` would
 * parse a Gmail header (which carries a display name) differently from how
 * this module already does, and silently match nothing.
 */
export function addressesInHeader(header: string): string[] {
  return [...(asciiLower(header).match(IN_HEADER_RE) ?? [])];
}

/**
 * WHO WROTE THE ENTRY — and therefore how far to trust it (FINDING 7).
 *
 * `"operator"` is RELEVANT_SENDERS: a human typing into a deploy command,
 * stating an intent. `"party"` is `parties.email`: a free-text column filled by
 * the seeds, by an LLM suggestion Martin approved, and by rows that predate any
 * validation at all. The two are different KINDS of thing, so the same string
 * means different things in them — see the domain rule in sanitizeAddresses.
 */
export type AddressSource = "operator" | "party";

export type RejectReason = "malformed" | "own-mailbox" | "party-domain";
export interface RejectedAddress { value: string; reason: RejectReason }
export interface AddressFilter {
  /** Addresses and @domains a message must touch to be worth ingesting. */
  addrs: string[];
  /** What was thrown out and why. Reported rather than dropped in silence: a
   *  filter that quietly narrowed — or nearly widened to the whole mailbox —
   *  is otherwise invisible until the vault looks wrong months later, and
   *  worker_runs is the one place mail health is visible at all. */
  rejected: RejectedAddress[];
}

/** The one mailbox this dossier has ever polled. */
const DEFAULT_OWN_ADDRESS = "martin@vanderpoel.pro";

/**
 * THE ADDRESSES THAT ARE ON EVERY MESSAGE ANYWAY, and therefore filter nothing.
 *
 * WHY THIS EXISTS, and please read it before deleting it. Relevance is a
 * question about the OTHER party. Martin's own address appears on every message
 * in his own mailbox by construction, so putting it in the list is not a wide
 * filter — it is no filter at all, and under JMAP this filter is the ONLY gate
 * there is. Gmail bounded the same mistake twice (server-side buildQueries AND
 * `newer_than:7d`); JMAP has neither, and behind it sits an 11.49 GB archive
 * import whose every attachment would append a ledger event on tables with no
 * DELETE grant.
 *
 * And it is not hypothetical: docs/deploy.md documents a backfill command that
 * deliberately puts `martin@vanderpoel.pro` into RELEVANT_SENDERS. That
 * procedure was a workaround for pollGmail testing `from` alone, which
 * isRelevantMessage has since fixed by reading BOTH sides — so his outbound
 * post is found by the COUNTERPARTY on the other side of it (`to:` Verder,
 * Stam, Hafkamp), never by his own address, and the widening is obsolete.
 * Anyone repeating it now gets the address rejected with a reason recorded in
 * the run detail rather than a silently swallowed mailbox.
 *
 * The default is spelled here for the same reason `case-history.ts` spells
 * CASE_HISTORY_USER's: a protection that only works once someone remembers to
 * set an env var is not a protection. Override with MAIL_OWN_ADDRESSES (a
 * comma-separated list) if the dossier ever moves to another person's mailbox.
 * JMAP_USER is folded in automatically when it is an address — it IS the polled
 * account, so the same argument applies to it word for word.
 */
export function ownMailboxAddresses(): string[] {
  // FINDING 8. `??` does not fire on "", and an env var is empty far more often
  // than it is absent: a bare `MAIL_OWN_ADDRESSES=` line in .env.prod, a
  // compose file interpolating an unset variable, a wrapper exporting the name
  // with no value. All three used to drop the default in silence and leave this
  // protection resting on JMAP_USER alone. An empty value is not a claim that
  // the mailbox has no owner — that reading has no legitimate use, while the
  // typo has an obvious one — so it is read as the mistake it is.
  const configured = process.env.MAIL_OWN_ADDRESSES?.trim()
    ? process.env.MAIL_OWN_ADDRESSES : DEFAULT_OWN_ADDRESS;
  const values = [...configured.split(","), process.env.JMAP_USER ?? ""]
    .map((s) => asciiLower(s.trim()))
    .filter((s) => ADDRESS_RE.test(s));
  return [...new Set(values)];
}

/**
 * Normalise a raw list into addresses that can only ever match what they name.
 *
 * An entry that is neither an address nor an @domain is REJECTED, not repaired:
 * there is no honest reading of " " or "@" as an address, and guessing at one
 * is how this defect got in. A truly empty value is passed over in silence —
 * most creditors have no email and a party without one is ordinary data, not a
 * mistake anybody made.
 *
 * FINDING 7 — WHY `source` EXISTS, and why one rule for both sources was wrong.
 * A bare `@domain` is enormously more powerful than an address: it admits
 * everybody at that domain, forever, with no window behind it. Whether that is
 * correct depends entirely on WHO WROTE IT.
 *
 *   - From the OPERATOR (RELEVANT_SENDERS) it is the documented, intended
 *     usage. `RELEVANT_SENDERS=@verdergroep.nl` is docs/deploy.md's own example
 *     and the production value: a human naming the organisation handling the
 *     case, in a variable only a deploy touches. Refusing it would break the
 *     filter's primary use.
 *   - From a PARTY ROW it is data, and this module exists to distrust data.
 *     `parties.email` is free text: the web UI cannot create a bare domain
 *     (packages/api/src/routers/parties.ts validates `z.string().email()`), but
 *     `case-history.ts` and `case-debts.ts` INSERT straight into the table and
 *     every row written before those validations existed was never checked at
 *     all. One row holding "@gmail.com" or "@ziggo.nl" would hand the entire
 *     provider to the ingest — years of commercial mail out of the 11.49 GB
 *     archive, one unremovable `document.ingested` per attachment, on tables
 *     with no DELETE grant. Nobody would ever see which row did it.
 *
 * So it is rejected with its own reason rather than quietly dropped: the row is
 * probably a real creditor whose mail is now invisible, and `party-domain` in
 * worker_runs says both what happened and how to fix it (write the address
 * out). Widening the gate is never the app's decision to make on a party's
 * behalf — an operator who genuinely wants the domain can put it in
 * RELEVANT_SENDERS, where saying so is the whole point of the variable.
 */
export function sanitizeAddresses(
  values: string[], own: string[], source: AddressSource,
): AddressFilter {
  const addrs: string[] = [];
  const rejected: RejectedAddress[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = asciiLower(raw.trim());
    if (!v) {
      // "" is a trailing comma or a party with no email — nothing to report.
      // " " is a human mistake in a field that gates the whole mailbox, so it
      // is reported: the ORIGINAL is what makes it non-empty, not the trim.
      if (raw.length > 0) rejected.push({ value: raw, reason: "malformed" });
      continue;
    }
    if (!DOMAIN_RE.test(v) && !ADDRESS_RE.test(v)) {
      rejected.push({ value: v, reason: "malformed" });
      continue;
    }
    if (source === "party" && v.startsWith("@")) {
      rejected.push({ value: v, reason: "party-domain" });
      continue;
    }
    // A domain entry the owner falls under matches every message just as surely
    // as the owner's own address does, so both spellings are refused.
    const isOwn = own.some((o) => (v.startsWith("@") ? o.endsWith(v) : o === v));
    if (isOwn) { rejected.push({ value: v, reason: "own-mailbox" }); continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    addrs.push(v);
  }
  return { addrs, rejected };
}

/** Two filters into one, keeping the first spelling of a duplicate and every
 *  rejection from both. Concatenating the two sources BEFORE sanitising is what
 *  made finding 7 possible: once the strings are in one array there is nothing
 *  left to say where each came from. */
function mergeFilters(...parts: AddressFilter[]): AddressFilter {
  const addrs: string[] = [];
  const rejected: RejectedAddress[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const a of part.addrs) if (!seen.has(a)) { seen.add(a); addrs.push(a); }
    rejected.push(...part.rejected);
  }
  return { addrs, rejected };
}

/** Everyone worth watching: the configured domains plus every party's address,
 *  with what the gate threw away, for the run detail.
 *
 *  Sanitised PER SOURCE (finding 7): the operator's intent and the parties
 *  table are held to different rules, so they cannot be poured into one list
 *  first. Note the asymmetry in the two defaults, and that it is the right way
 *  round — `RELEVANT_SENDERS=` empty yields `[""]`, which sanitises to nothing
 *  and leaves the parties alone to gate, i.e. it fails CLOSED, while an empty
 *  MAIL_OWN_ADDRESSES fails OPEN and is therefore the one that keeps its
 *  default (see ownMailboxAddresses). */
export async function relevanceFilter(db: Db): Promise<AddressFilter> {
  const own = ownMailboxAddresses();
  const senders = (process.env.RELEVANT_SENDERS ?? "@verdergroep.nl").split(",");
  const partyEmails = (await db.select().from(schema.parties)).map((p) => p.email ?? "");
  return mergeFilters(
    sanitizeAddresses(senders, own, "operator"),
    sanitizeAddresses(partyEmails, own, "party"),
  );
}

/** The same call with the report dropped — what pollGmail wants. One policy,
 *  one implementation, so the two ports cannot drift. */
export async function relevantAddresses(db: Db): Promise<string[]> {
  return (await relevanceFilter(db)).addrs;
}

/**
 * BOTH DIRECTIONS, always: `to` is what finds the mail Martin sent to a party.
 *
 * An EMPTY address list matches nothing, and that is deliberate — the same trap
 * buildQueries records. Read the other way ("nothing configured, so let it all
 * through") this becomes a whole-mailbox ingest, which after the Takeout import
 * means a `document.ingested` ledger event per attachment of years of
 * commercial mail. There is no DELETE grant on `documents` or `ledger_events`:
 * that is not a mistake anyone can undo.
 *
 * It matches PARSED ADDRESSES, never substrings of the header. Substring
 * matching accepted a whitespace entry as a match on every message (finding F),
 * and it also read `notincasso@stam.nl` as `incasso@stam.nl` and
 * `hello@stam.nl.evil.example` as `@stam.nl` — a lookalike domain walking
 * straight into the dossier. An entry has to be the WHOLE local part or the
 * WHOLE domain. Junk in the list is therefore inert here as well as filtered
 * upstream, which is the point: the list comes from a table anybody can type
 * into, and this predicate is the last gate before an ingest that cannot be
 * undone.
 *
 * A domain entry is that domain EXACTLY: `@stam.nl` does not cover
 * `x@mail.stam.nl`, because a subdomain is a different mail system and whoever
 * wants it can write it out. And the headers are folded by `asciiLower`, never
 * `toLowerCase` — see the note there; the `from` header is text the sender
 * chooses, so the one place a stranger could reach into this predicate is the
 * fold, and a Unicode-aware one hands him ASCII "k" for the asking.
 */
export function isRelevantMessage(
  addrs: string[], msg: { from: string; to: string },
): boolean {
  const inMsg = new Set([...addressesInHeader(msg.from), ...addressesInHeader(msg.to)]);
  if (inMsg.size === 0) return false;
  for (const raw of addrs) {
    const a = asciiLower(raw.trim());
    if (!a) continue;
    if (a.startsWith("@")) {
      for (const m of inMsg) if (m.endsWith(a)) return true;
    } else if (inMsg.has(a)) return true;
  }
  return false;
}
