import { z } from "zod";
import { ENTRY_SOURCES, type EntrySource } from "@verder/db/entry-sources";

/**
 * How a `log-entry` suggestion becomes the input of `suggestions.approveEntry`.
 *
 * ONE spelling, used by the web queue card AND the phone's approve route, so
 * the two cannot build different entries from the same suggestion. Until Plan 3
 * this mapping lived inline in `SuggestionCard`; the phone would otherwise have
 * needed a second copy, and two copies is how they come to disagree.
 *
 * Pure and client-safe on purpose (zod plus the `entry-sources` leaf, never the
 * `@verder/db` barrel, which reaches `pg`): `suggestion-card.tsx` is a client
 * component and imports this file.
 */

export const entryForApproval = z.object({
  occurredAt: z.coerce.date(),
  channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]),
  direction: z.enum(["inbound", "outbound", "internal"]),
  summary: z.string().min(1),
  details: z.string().optional(),
  source: z.enum(ENTRY_SOURCES),
  sourceRef: z.string().optional(),
  participantPartyIds: z.array(z.string().uuid()),
  documentIds: z.array(z.string().uuid()),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    ownerPartyId: z.string().uuid().optional(),
    dueAt: z.coerce.date().optional(),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })),
});

export type EntryForApproval = z.infer<typeof entryForApproval>;

/**
 * The fields Martin may change on an entry card, and nothing else. `.strict()`
 * is load-bearing: an unknown key is REFUSED, never silently dropped, and
 * `source` is deliberately absent — where an entry came from is a fact about
 * the suggestion, never something a client gets to claim.
 */
export const entryEdits = entryForApproval.pick({
  occurredAt: true, channel: true, direction: true, summary: true, details: true,
  participantPartyIds: true,
}).extend({ attachmentDocumentIds: entryForApproval.shape.documentIds }).partial().strict();

export type EntryEdits = z.input<typeof entryEdits>;

/** The prompt version of a phone voice note (Plan 3 Task 24). */
export const VOICE_PROMPT_VERSION = "voice-v1";

export interface EntrySuggestion {
  rawEmailId: string | null;
  promptVersion: string | null;
  proposed: unknown;
}

/**
 * Derived from the suggestion, never from the client. A voice note Martin
 * dictated is his own record (`manual`); everything else the miner proposes
 * today comes out of the mail watcher, which is what the card always sent —
 * including for a suggestion without a `raw_email_id`, so this extraction
 * changes no entry the web already writes.
 */
export function entrySource(s: Pick<EntrySuggestion, "promptVersion">): EntrySource {
  return s.promptVersion === VOICE_PROMPT_VERSION ? "manual" : "gmail-watch";
}

/**
 * `{ ...proposed, ...edits }`, shaped as `approveEntry` wants it. Throws a
 * ZodError on an unknown or wrongly typed edit, on a `source` edit, and on a
 * proposal that does not make a valid entry — the phone route answers each of
 * those with a 400.
 */
export function entryFromProposed(s: EntrySuggestion, edits: unknown = {}): EntryForApproval {
  const e = entryEdits.parse(edits);
  const p = (s.proposed !== null && typeof s.proposed === "object" && !Array.isArray(s.proposed)
    ? s.proposed : {}) as Record<string, unknown>;
  // An emptied Toelichting is "no details", as the card always sent it.
  const details = e.details ?? p.details;
  const docIds = e.attachmentDocumentIds ?? p.attachmentDocumentIds ?? [];
  return entryForApproval.parse({
    occurredAt: e.occurredAt ?? p.occurredAt,
    channel: e.channel ?? p.channel,
    direction: e.direction ?? p.direction,
    summary: e.summary ?? p.summary,
    details: typeof details === "string" && details !== "" ? details : undefined,
    source: entrySource(s),
    // The miner proposes participant NAMES, never ids; resolving one is an
    // edit. A voice note is the one exception: its party is not a model's
    // guess but the one Martin PICKED on the phone, so its ids are carried.
    participantPartyIds: e.participantPartyIds
      ?? (s.promptVersion === VOICE_PROMPT_VERSION ? p.participantPartyIds : undefined) ?? [],
    // Deduplicated: the card merges the proposed attachments with the ones
    // Martin picked from "do we already have this?", which can overlap.
    documentIds: Array.isArray(docIds) ? [...new Set(docIds)] : docIds,
    actionItems: p.actionItems ?? [],
  });
}
