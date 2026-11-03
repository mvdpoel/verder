import type { CaseMap } from "@verder/api/src/track-map";
import type { StopEvidence } from "@verder/api/src/track-evidence";
import { trackTerminus, type Terminus } from "./track-marks";

/**
 * The phone's case map (`GET /api/mobile/v1/case-map`): `tracks.map` as the
 * web's /timeline draws it, hand-shaped.
 *
 * NOTHING IS RE-DERIVED HERE. Rows, lanes, bands, edges and the current stop
 * are `buildTrackMap`'s, so the phone and the web can never disagree about
 * what is newest or what waits; the debt filter ran on the map's INPUT inside
 * the router, exactly as on the web. This file only names fields — never a
 * spread of a router row, because a row is whatever the table holds today —
 * and turns every date into an ISO string.
 *
 * Evidence links are APP routes (`verder://document/<id>`, `verder://task/<id>`,
 * the kinds `DeepLink.swift` parses). A logbook entry and an e-mail have no
 * phone screen, so they travel as text; the Gmail message id and the
 * raw-email row id never leave the server.
 *
 * Pure: no DB, no Next.
 */

export interface CaseMapSource {
  map: CaseMap;
  evidence: Record<string, StopEvidence>;
  hiddenDebtTrackCount: number;
  debtEpisodesHidden: boolean;
}

export interface CaseMapBandDTO {
  key: string; label: string; fromRow: number; toRow: number; empty: boolean;
}

export interface CaseMapTrackDTO {
  id: string;
  title: string;
  /** "open" | "done" | "ended" — ended is a CLEAN outcome, never a failure. */
  status: string;
  isRoot: boolean;
  parentTrackId: string | null;
  note: string | null;
  lane: number;
  firstRow: number;
  lastRow: number;
  mergesBack: boolean;
  /** How the spoor finishes, the web's own decision (`trackTerminus`). */
  terminus: Terminus;
}

export interface CaseMapEvidenceDTO {
  entry: { summary: string; occurredAt: string; channel: string; direction: string } | null;
  task: { id: string; title: string; status: string; dueAt: string | null; link: string } | null;
  documents: { id: string; title: string; mime: string; link: string }[];
  email: { subject: string; fromAddr: string; sentAt: string } | null;
}

export interface CaseMapStopDTO {
  id: string;
  trackId: string;
  title: string;
  note: string | null;
  /** "done" | "open". An open stop is work waiting on Martin. */
  state: string;
  kind: string;
  happenedAt: string | null;
  row: number;
  lane: number;
  bandKey: string;
  isJunction: boolean;
  datesOutOfOrder: boolean;
  evidence: CaseMapEvidenceDTO;
}

export interface CaseMapEdgeDTO {
  kind: "branch" | "merge";
  trackId: string;
  fromLane: number; fromRow: number;
  toLane: number; toRow: number;
}

export interface CaseMapDTO {
  bands: CaseMapBandDTO[];
  tracks: CaseMapTrackDTO[];
  stops: CaseMapStopDTO[];
  edges: CaseMapEdgeDTO[];
  rowCount: number;
  laneCount: number;
  currentStopId: string | null;
  /** The map's own "wat de kaart niet kon tekenen" lines, in Dutch. */
  problems: string[];
  hiddenDebtTrackCount: number;
  debtEpisodesHidden: boolean;
}

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
const isoOrNull = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : iso(d);

const NO_EVIDENCE: StopEvidence = { entry: null, task: null, documents: [], email: null };

function toEvidenceDTO(e: StopEvidence): CaseMapEvidenceDTO {
  return {
    entry: e.entry
      ? { summary: e.entry.summary, occurredAt: iso(e.entry.occurredAt),
          channel: e.entry.channel, direction: e.entry.direction }
      : null,
    task: e.task
      ? { id: e.task.id, title: e.task.title, status: e.task.status,
          dueAt: isoOrNull(e.task.dueAt), link: `verder://task/${e.task.id}` }
      : null,
    documents: e.documents.map((d) => ({
      id: d.id, title: d.title, mime: d.mime, link: `verder://document/${d.id}`,
    })),
    email: e.email
      ? { subject: e.email.subject, fromAddr: e.email.fromAddr, sentAt: iso(e.email.sentAt) }
      : null,
  };
}

export function toCaseMapDTO(src: CaseMapSource): CaseMapDTO {
  const { map } = src;
  return {
    bands: map.bands.map((b) => ({
      key: b.key, label: b.label, fromRow: b.fromRow, toRow: b.toRow, empty: b.empty,
    })),
    tracks: map.tracks.map((t) => ({
      id: t.id, title: t.title, status: t.status, isRoot: t.parentTrackId === null,
      parentTrackId: t.parentTrackId, note: t.note ?? null,
      lane: t.lane, firstRow: t.firstRow, lastRow: t.lastRow, mergesBack: t.mergesBack,
      terminus: trackTerminus(t),
    })),
    stops: map.stops.map((s) => ({
      id: s.id, trackId: s.trackId, title: s.title, note: s.note ?? null,
      state: s.state, kind: s.kind, happenedAt: isoOrNull(s.happenedAt),
      row: s.row, lane: s.lane, bandKey: s.bandKey,
      isJunction: s.isJunction, datesOutOfOrder: s.datesOutOfOrder,
      evidence: toEvidenceDTO(src.evidence[s.id] ?? NO_EVIDENCE),
    })),
    edges: map.edges.map((e) => ({
      kind: e.kind, trackId: e.trackId,
      fromLane: e.fromLane, fromRow: e.fromRow, toLane: e.toLane, toRow: e.toRow,
    })),
    rowCount: map.rowCount,
    laneCount: map.laneCount,
    currentStopId: map.currentStopId,
    problems: map.problems.map((p) => p.detail),
    hiddenDebtTrackCount: src.hiddenDebtTrackCount,
    debtEpisodesHidden: src.debtEpisodesHidden,
  };
}
