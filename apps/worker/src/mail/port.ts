/** A message the port refused to promote to a document — see isInlineBodyImage. */
export interface SkippedPart { filename: string; mime: string; contentId: string | null }

export interface MailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
  skippedParts?: SkippedPart[];
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
 */
export interface MailHeaders { id: string; from: string; to: string }

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
