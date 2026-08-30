/** A message the port refused to promote to a document — see isInlineBodyImage. */
export interface SkippedPart { filename: string; mime: string; contentId: string | null }

export interface MailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
  skippedParts?: SkippedPart[];
  /**
   * The RFC 5322 Message-ID, normalised, or null when the message carries none.
   *
   * The SAME value `headers()` returned for this id, carried through so the
   * ingest stores what the skip decision was made on. A port that read it once
   * cheaply and then again out of the raw bytes has two sources for one
   * identity, and they disagree exactly where it matters — a header the store
   * rewrote, a Takeout export that refolded the line — leaving a row deduped
   * against a value nothing will ever compute again.
   *
   * Required, not optional, and nullable rather than absent: null is "this
   * message has no Message-ID", which is unusual but ingestable, while a
   * missing field is a port that forgot. Only the first is a fact about the
   * mail.
   */
  messageId: string | null;
}

export interface MailChanges {
  ids: string[];
  cursor: string;
  /**
   * The server had more to give than one poll drained.
   *
   * Not an error and not a loss: the cursor returned beside it is the
   * intermediate state the server issued, so the next poll continues from
   * exactly here. It exists so a run row can say "500 ingested, thousands
   * queued" instead of looking finished — the first sync after an 11 GB
   * mailbox import is the case that reads {ingested: 500} and lies.
   *
   * Optional so an existing fake port stays a valid MailPort.
   */
  hasMore?: boolean;
}

/**
 * Just enough of a message to decide whether the dossier wants it.
 *
 * `from` and `to` are spelled EXACTLY as getMessage would return them (first
 * `from` address, every `to` joined): the relevance filter must test the same
 * strings the ingest will store, or a message is judged on an address its
 * raw_emails row does not record.
 *
 * `messageId` is the same rule applied to identity, and it is here rather than
 * on MailMessage alone because it is what lets a KNOWN message be skipped
 * BEFORE its blob is fetched. Neither the store's own id nor the raw sha256
 * recognises a mail the dossier already holds across two ingest paths — a
 * Stalwart Email id is a different namespace from a Gmail message id, and
 * Takeout's mbox bytes are not the bytes Gmail's API returned for the same
 * message (measured on the archive at 130 relevant messages matching 0 of 107
 * existing rows). The RFC 5322 Message-ID is assigned by the ORIGINATING server
 * and survives both formats, so it is the identity that spans them; it must be
 * normalised the SAME way on both sides of the comparison, or the dedup misses
 * on a pair of angle brackets and writes the duplicate anyway.
 *
 * Null means the message carries no Message-ID at all. That is unusual and
 * still ingestable — it simply cannot be deduped by one — so no port may throw
 * over it.
 */
export interface MailHeaders {
  id: string; from: string; to: string; messageId: string | null;
}

/**
 * Discovery is CURSOR-based, not query-based.
 *
 * Gmail forced a time window (`newer_than:7d`) because its list API has no
 * delta. JMAP's `Email/changes` returns exactly what changed since a state
 * string, which is why the whole class of bug fixed on 2026-08-29 — re-fetching
 * the same unchanged messages forever — cannot be written here.
 *
 * A null cursor is a FIRST SYNC and is a different question, not the same
 * question with a missing argument: there is no "changes since nothing".
 */
export interface MailPort {
  changedSince(cursor: string | null): Promise<MailChanges>;
  /**
   * The addresses of many messages in as few round trips as possible, and
   * WITHOUT downloading a single blob.
   *
   * Discovery returns ids only, so relevance can only be decided from the
   * headers — and deciding it with `getMessage` would pull the RFC822 original
   * and every attachment of a message the case has no interest in. After the
   * 11.49 GB Takeout import that is years of commercial mail dragged through
   * the wire before being discarded. It is a separate method rather than a
   * flag on getMessage because the two return genuinely different things: this
   * one can never produce a document.
   *
   * An id the store no longer holds is simply absent from the result.
   */
  headers(ids: string[]): Promise<MailHeaders[]>;
  getMessage(id: string): Promise<MailMessage>;
}

/**
 * The server refused the cursor: it can no longer say what changed since that
 * state (JMAP's `cannotCalculateChanges`).
 *
 * An EXPECTED condition, not a fault — a store rebuild, an outage longer than
 * the server's change log, the Vandelay import. The port raises it as its own
 * type rather than swallowing it, because the recovery (drop the cursor and
 * resync from scratch) is the poll layer's policy to own, and it must be able
 * to tell this apart from a socket failure: resyncing on every transport blip
 * would re-walk the whole mailbox, and wedging on this one stops ingestion
 * dead.
 */
export class MailCursorRejectedError extends Error {
  constructor(readonly cursor: string, options?: { cause?: unknown }) {
    super(`the mail server can no longer resolve cursor ${cursor}; a full resync is needed`,
      options);
    this.name = "MailCursorRejectedError";
  }
}

/**
 * A caller that is not permitted to enumerate the whole mailbox was asked to.
 *
 * Raised by pollMail for `allowFirstSync: false` — the scheduled cron — on both
 * doors into a full walk: no cursor at all, and a cursor the server rejected.
 *
 * WHY REFUSING IS THE CORRECT ANSWER, and not merely the cautious one. A first
 * sync over the imported archive is IRREVERSIBLE: every relevant message writes
 * a raw_emails row, vault bytes and one `document.ingested` LEDGER EVENT per
 * attachment, on tables with no DELETE grant. It is also hours long on a shared
 * box, and it is the one operation in this system whose blast radius has to be
 * READ BEFORE it is authorised, which is exactly what ops/mail-first-sync.ts's
 * preview exists to make possible. A cron tick is never the right context for
 * a decision of that shape: nobody is watching it, it cannot be previewed, and
 * "it happened to be too big to finish" was the only thing stopping it before.
 *
 * The alternative — letting the poll resync and relying on the port's
 * DEFAULT_LIMITS to overflow first — is a guard made of arithmetic about how
 * much mail is in the store today (100 pages x 500 = 50 000 against 146 270).
 * Restore a subset, rebuild the mailbox, or import half the archive and the
 * same code quietly does the whole ingest instead of refusing it.
 */
export class MailFirstSyncRefusedError extends Error {
  constructor(readonly reason: "no-cursor" | "cursor-rejected", options?: { cause?: unknown }) {
    // The message carries the CURE, because worker_runs is the only place mail
    // failure is visible (docs/deploy.md) and this error is designed to repeat
    // every minute until a human acts: a red row that names no recovery is a
    // wedge, not a signal.
    super(`a first sync over the whole mailbox was refused (${reason}): this caller may only `
      + `poll deltas. Ingestion is irreversible, so a full sync is a hand-run, previewed `
      + `operation — run \`pnpm --filter worker mail-first-sync\` to authorise it.`, options);
    this.name = "MailFirstSyncRefusedError";
  }
}

/**
 * An ordinary delta came back far too large to be one minute of mail.
 *
 * THE DOOR MailFirstSyncRefusedError DOES NOT COVER. That guard closes the two
 * ways into a FIRST sync — no cursor, and a cursor the server rejected — and a
 * bulk import into the store is neither. The first sync writes cursor C, and
 * anything imported afterwards (a re-import, a restored subset, a second
 * Vandelay pass, phase 2 starting to deliver real mail) is `created` after C:
 * a perfectly legitimate delta, with a valid cursor and no
 * `cannotCalculateChanges` anywhere. The port will happily drain
 * changesPages x maxChanges = 20 x 500 = 10 000 ids in one poll, and every one
 * of them goes to the ingest loop of a cron that runs every minute.
 *
 * WHY REFUSING BEATS DRAINING AT A BOUNDED RATE, which is the obvious
 * alternative and the wrong one. A rate limit — take 200 a tick and let the
 * cursor crawl — still ingests every message, unattended, just more slowly: it
 * converts an irreversible bulk append into a slower irreversible bulk append,
 * and it does so while looking healthy, because each individual tick is small.
 * Refusing HOLDS the cursor instead. Nothing is lost (the same delta is
 * re-listed next tick), nothing is written (`documents` and `ledger_events`
 * have no DELETE grant, so anything appended here is permanent), and the poll
 * goes red once a minute naming the recovery until a human decides — which is
 * the whole point, because the decision "yes, ingest these ten thousand" is one
 * that has to be READ BEFORE it is authorised, and ops/mail-first-sync.ts's
 * preview is where it is read.
 *
 * A TRIPWIRE, NOT A THROUGHPUT KNOB. Raising the ceiling to make a red poll go
 * green is the one response that is always wrong: it authorises the ingest
 * without previewing it, from the side of the system that cannot preview.
 */
export class MailDeltaTooLargeError extends Error {
  /**
   * `truncated` is `changed.hasMore` — the server had more to give than this
   * poll drained. It is a SEPARATE trigger from the count, because the count
   * alone can be under the ceiling while the backlog is enormous: a server
   * returning small pages sets hasMoreChanges instead of a big `ids`, and the
   * bulk import then walks in under the tripwire one bounded batch at a time.
   * Reported so the run row says WHICH of the two fired, since the operator's
   * question ("is this a big minute or a bulk import?") is answered by that
   * and not by the number.
   */
  constructor(
    readonly delta: number, readonly ceiling: number, readonly truncated = false,
  ) {
    // Same shape as the first-sync refusal's message and for the same reason:
    // worker_runs is the only place mail failure is visible (docs/deploy.md),
    // this error repeats every minute by design, and a red row that names no
    // cure is a wedge rather than a signal.
    super(`a delta of ${delta} message(s)`
      + (truncated ? ` — and the server had MORE queued behind it —` : "")
      + ` exceeds the ${ceiling} this caller may accept in `
      + `one poll: that is a bulk import, not a minute of mail. Ingestion is irreversible, so `
      + `it is a hand-run, previewed operation — run \`pnpm --filter worker mail-first-sync\` `
      + `to read what it would append and authorise it. The cursor is HELD meanwhile: nothing `
      + `is lost and nothing is ingested.`);
    this.name = "MailDeltaTooLargeError";
  }
}

/**
 * A first sync found more messages than it is willing to enumerate in one pass.
 *
 * This THROWS where an over-long `Email/changes` merely sets `hasMore`, and the
 * asymmetry is the whole point. A truncated delta is safe: its cursor is an
 * intermediate state and the next poll resumes there. A truncated FIRST SYNC is
 * not: the cursor means "everything up to this state is accounted for", so
 * every message the enumeration never reached is stranded the moment that
 * cursor is written — silently, and forever. Refusing to return a cursor keeps
 * the next poll asking the same question, which is the recoverable failure.
 */
export class MailFirstSyncOverflowError extends Error {
  constructor(readonly enumerated: number, readonly pages: number) {
    super(`first sync enumerated ${enumerated} messages in ${pages} pages and the mailbox `
      + `still had more; raise the firstSyncPages limit rather than accepting a partial cursor`);
    this.name = "MailFirstSyncOverflowError";
  }
}
