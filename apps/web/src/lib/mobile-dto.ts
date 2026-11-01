import type { WaitingItem } from "@verder/api/src/waiting";
import type { VerderActionDTO } from "@verder/api/src/routers/verder-actions";

/**
 * The phone's wire shapes for the read routes under /api/mobile/v1.
 *
 * Hand-shaped, never raw router output: a router row is whatever the table
 * holds today, and the phone would come to depend on columns nobody meant to
 * publish — `documents.status` above all, which reads "inbox" forever because
 * a discard is APPENDED to document_status_changes and never written back.
 * Every field is named here, and every date leaves as an ISO string.
 *
 * Pure: no DB, no Next, so it is tested without either.
 */

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
const isoOrNull = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : iso(d);

// --- inbox -------------------------------------------------------------------

/**
 * One thing verder did on its own, offered for undo: `verderActions.list`'s
 * row, which is already hand-shaped (dates as ISO strings, the effective
 * title, the reason an undo is refused) and is published as it stands.
 */
export type { VerderActionDTO };

export interface InboxDTO {
  count: number;
  items: WaitingItem[];
  /**
   * "Door verder gedaan". NOT part of `count`: what verder already did is
   * there to check, not waiting on Martin, so it never reaches the badge.
   */
  doneByVerder: VerderActionDTO[];
}

/** `count` is the list's own length, so the badge and the list cannot disagree. */
export function toInboxDTO(items: WaitingItem[], doneByVerder: VerderActionDTO[] = []): InboxDTO {
  return { count: items.length, items, doneByVerder };
}

// --- suggestion --------------------------------------------------------------

/** What `suggestions.get` returns, as far as the phone reads it. */
export interface SuggestionSource {
  id: string;
  kind: string;
  status: string;
  createdAt: Date | string;
  proposed: unknown;
  retrievedRefs: unknown;
  rawEmail: { fromAddr: string; subject: string; sentAt: Date | string } | null;
  /** `effectiveDocument`'s row: the raw `status` is there and must NOT be read. */
  document: {
    id: string;
    status?: string;
    effectiveStatus: string;
    effectiveTitle: string;
    effectiveDocType: string | null;
  } | null;
}

export interface SuggestionDTO {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  proposed: unknown;
  trigger: { from: string | null; subject: string | null; sentAt: string | null } | null;
  document: { id: string; title: string; docType: string | null; status: string } | null;
  retrievedRefs: unknown[];
}

export function toSuggestionDTO(s: SuggestionSource): SuggestionDTO {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    createdAt: iso(s.createdAt),
    proposed: s.proposed ?? null,
    trigger: s.rawEmail
      ? { from: s.rawEmail.fromAddr || null, subject: s.rawEmail.subject || null,
          sentAt: isoOrNull(s.rawEmail.sentAt) }
      : null,
    document: s.document
      ? { id: s.document.id, title: s.document.effectiveTitle,
          docType: s.document.effectiveDocType ?? null,
          // The EFFECTIVE status, never documents.status (see the file comment).
          status: s.document.effectiveStatus }
      : null,
    retrievedRefs: Array.isArray(s.retrievedRefs) ? s.retrievedRefs : [],
  };
}

// --- task --------------------------------------------------------------------

/** A `tasks.list` row, as far as the phone reads it. */
export interface TaskSource {
  id: string;
  title: string;
  details: string | null;
  dueAt: Date | string | null;
  /** The raw column; never read — `effectiveStatus` is the ledger's answer. */
  status?: string;
  effectiveStatus: string;
  assigneeName: string | null;
}

export interface TaskDTO {
  id: string;
  title: string;
  details: string | null;
  dueAt: string | null;
  status: string;
  assigneeName: string | null;
  validNext: string[];
}

export function toTaskDTO(t: TaskSource, validNext: readonly string[]): TaskDTO {
  return {
    id: t.id, title: t.title, details: t.details ?? null, dueAt: isoOrNull(t.dueAt),
    status: t.effectiveStatus, assigneeName: t.assigneeName ?? null,
    validNext: [...validNext],
  };
}

// --- dashboard summary -------------------------------------------------------

export interface DashboardSummarySource {
  /** The parts of `tracks.map().map` the headline needs. */
  map: {
    currentStopId: string | null;
    stops: { id: string; trackId: string; title: string; note: string | null;
      happenedAt: Date | string | null }[];
    tracks: { id: string; title: string }[];
  };
  stats: { openCount: number; overdueCount: number; waitingOnOthersCount: number };
  waitingCount: number;
}

export interface DashboardSummaryDTO {
  headline: { stopTitle: string; trackTitle: string | null; happenedAt: string | null;
    note: string | null } | null;
  waitingCount: number;
  tasks: { openCount: number; overdueCount: number; waitingOnOthersCount: number };
}

/**
 * The headline is the stop the map itself draws as current — the same lookup
 * the web dashboard does — so the phone and the web name the same stop.
 */
export function toDashboardSummaryDTO(src: DashboardSummarySource): DashboardSummaryDTO {
  const stop = src.map.currentStopId
    ? src.map.stops.find((s) => s.id === src.map.currentStopId) ?? null
    : null;
  const track = stop ? src.map.tracks.find((t) => t.id === stop.trackId) ?? null : null;
  return {
    headline: stop
      ? { stopTitle: stop.title, trackTitle: track?.title ?? null,
          happenedAt: isoOrNull(stop.happenedAt), note: stop.note ?? null }
      : null,
    waitingCount: src.waitingCount,
    tasks: {
      openCount: src.stats.openCount,
      overdueCount: src.stats.overdueCount,
      waitingOnOthersCount: src.stats.waitingOnOthersCount,
    },
  };
}
