/**
 * The logbook's enum values, in Dutch.
 *
 * `channel`, `direction` and `clarity` are database enums, so they are English
 * identifiers by necessity — and they were being printed raw on four surfaces,
 * including the contact report that gets handed to VerderGroep. "inbound" is
 * not a word in that document.
 *
 * ONE map rather than a `switch` per screen, for the reason `track-marks.ts`
 * gives: the logbook list, the entry page, the entry form and the export all
 * name the same fact, and four spellings of it is how they come to disagree.
 *
 * Every lookup keeps a `?? value` fallback at the call site: a value added to
 * the enum and not yet to this file must still render as itself, never as
 * `undefined`.
 */

export const CHANNEL_LABEL: Record<string, string> = {
  call: "telefoon",
  meeting: "gesprek",
  email: "e-mail",
  whatsapp: "WhatsApp",
  voicemail: "voicemail",
  letter: "brief",
  other: "anders",
};

export const DIRECTION_LABEL: Record<string, string> = {
  inbound: "inkomend",
  outbound: "uitgaand",
  // Not "intern" alone: an entry Martin writes for himself has no counterparty,
  // and "eigen notitie" is what it actually is.
  internal: "eigen notitie",
};

export const CLARITY_LABEL: Record<string, string> = {
  clear: "duidelijk",
  ambiguous: "onduidelijk",
  "already-provided": "al aangeleverd",
};

/** Where an entry came from. `manual` is Martin typing it; the rest are watchers. */
export const ENTRY_SOURCE_LABEL: Record<string, string> = {
  manual: "handmatig",
  "gmail-watch": "e-mailwatcher",
  "nas-watch": "scanwatcher",
};

/** How a document reached the vault. */
export const DOC_SOURCE_LABEL: Record<string, string> = {
  upload: "geüpload",
  "nas-scan": "scanner",
  "email-attachment": "e-mailbijlage",
};
