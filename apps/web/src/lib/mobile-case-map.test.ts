import { describe, expect, it } from "vitest";
import {
  buildTrackMap, filterDebtEpisodes, type StopRow, type TrackRow,
} from "@grip/api/src/track-map";
import type { StopEvidence } from "@grip/api/src/track-evidence";
import { toCaseMapDTO, type CaseMapSource } from "./mobile-case-map";

/**
 * The phone's case map. Built here from REAL `buildTrackMap` output over a
 * small invented case, so the DTO is tested against the shape the router
 * really returns and not against a hand-written guess of it.
 */

const ROOT = "00000000-0000-4000-8000-0000000000a0";
const AANVRAAG = "00000000-0000-4000-8000-0000000000a1";
const VORDERING = "00000000-0000-4000-8000-0000000000a2";
const HUUR = "00000000-0000-4000-8000-0000000000a3";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const TASK = "00000000-0000-4000-8000-0000000000e1";
const ENTRY = "00000000-0000-4000-8000-0000000000f1";

const track = (over: Partial<TrackRow> & { id: string; title: string }): TrackRow => ({
  status: "open", parentTrackId: ROOT, branchesAtStopId: null, mergesAtStopId: null,
  note: null, ...over,
});

let n = 0;
const stop = (over: Partial<StopRow> & { id: string; trackId: string; title: string }): StopRow => ({
  orderIndex: n++, kind: "other", state: "done", happenedAt: null, expectedAt: null,
  stage: null, entryId: null, taskId: null, documentId: null, note: null, ...over,
});

const at = (iso: string) => new Date(`${iso}T10:00:00.000Z`);

const tracks: TrackRow[] = [
  track({ id: ROOT, title: "Bewindvoering", parentTrackId: null }),
  track({ id: AANVRAAG, title: "Aanvraag bewindvoering", status: "done",
    branchesAtStopId: "s-aanmelding", mergesAtStopId: "s-beschikking" }),
  track({ id: VORDERING, title: "Vordering Kade & Partners", branchesAtStopId: "s-sommatie" }),
  track({ id: HUUR, title: "Huurachterstand Lindehof", status: "ended" }),
];

const stops: StopRow[] = [
  stop({ id: "s-aanmelding", trackId: ROOT, title: "Aanmelding", happenedAt: at("2026-05-12") }),
  stop({ id: "s-beschikking", trackId: ROOT, title: "Beschikking", happenedAt: at("2026-06-03"),
    documentId: DOC }),
  stop({ id: "s-sommatie", trackId: ROOT, title: "Sommatie Kade & Partners",
    happenedAt: at("2026-10-14") }),
  stop({ id: "s-stukken", trackId: ROOT, title: "Stukken aanleveren", state: "open",
    taskId: TASK, note: "Loonstroken nog sturen." }),
  stop({ id: "s-intake", trackId: AANVRAAG, title: "Intake", happenedAt: at("2026-05-19"),
    entryId: ENTRY }),
  stop({ id: "s-verwerkt", trackId: VORDERING, title: "Kade & Partners — verwerkt als vordering",
    happenedAt: at("2026-10-15") }),
  stop({ id: "s-melden", trackId: VORDERING, title: "Kade & Partners — melden bij Noordkust",
    state: "open" }),
  stop({ id: "s-regeling", trackId: HUUR, title: "Betalingsregeling afgesproken",
    happenedAt: at("2026-09-08") }),
];

const EMPTY_EVIDENCE: StopEvidence = { entry: null, task: null, documents: [], email: null };

function source(hide: boolean): CaseMapSource {
  const filtered = filterDebtEpisodes({ tracks, stops }, hide);
  const map = buildTrackMap(filtered);
  const evidence: Record<string, StopEvidence> = Object.fromEntries(
    map.stops.map((s) => [s.id, { ...EMPTY_EVIDENCE }]));
  evidence["s-beschikking"] = { ...EMPTY_EVIDENCE,
    documents: [{ id: DOC, title: "Beschikking rechtbank", mime: "application/pdf" }],
    email: { id: "raw-1", subject: "Uw beschikking", fromAddr: "post@noordkust.example",
      sentAt: at("2026-06-03"), gmailMessageId: "gm-secret-1" } };
  evidence["s-stukken"] = { ...EMPTY_EVIDENCE,
    task: { id: TASK, title: "Loonstroken sturen", status: "open", dueAt: at("2026-11-05") } };
  evidence["s-intake"] = { ...EMPTY_EVIDENCE,
    entry: { id: ENTRY, summary: "Intakegesprek", occurredAt: at("2026-05-19"),
      channel: "call", direction: "inbound" } };
  return { map, evidence, hiddenDebtTrackCount: filtered.hiddenTrackCount, debtEpisodesHidden: hide };
}

describe("toCaseMapDTO", () => {
  it("keeps the map's own order, bands and current stop", () => {
    const dto = toCaseMapDTO(source(false));
    expect(dto.currentStopId).toBe("s-stukken");
    expect(dto.stops.map((s) => s.row)).toEqual(dto.stops.map((_, i) => i));
    expect(dto.bands[0]).toMatchObject({ key: "nu", label: "Nu" });
    expect(dto.bands.map((b) => b.key)).toContain("2026-07");
    expect(dto.bands.find((b) => b.key === "2026-07")?.empty).toBe(true);
    expect(dto.rowCount).toBe(dto.stops.length);
  });

  it("dates leave as ISO strings and an undated stop stays null", () => {
    const dto = toCaseMapDTO(source(false));
    const beschikking = dto.stops.find((s) => s.id === "s-beschikking")!;
    expect(beschikking.happenedAt).toBe("2026-06-03T10:00:00.000Z");
    expect(dto.stops.find((s) => s.id === "s-stukken")!.happenedAt).toBeNull();
  });

  it("names how every spoor finishes — ended is its own clean outcome", () => {
    const dto = toCaseMapDTO(source(false));
    const byId = new Map(dto.tracks.map((t) => [t.id, t]));
    expect(byId.get(ROOT)!.isRoot).toBe(true);
    expect(byId.get(AANVRAAG)!.terminus).toBe("merge");
    expect(byId.get(HUUR)!.terminus).toBe("ended");
    expect(byId.get(HUUR)!.status).toBe("ended");
    expect(byId.get(VORDERING)!.terminus).toBe("open");
    expect(dto.edges.some((e) => e.kind === "merge" && e.trackId === AANVRAAG)).toBe(true);
  });

  it("maps evidence to app links and leaves the rest as text", () => {
    const dto = toCaseMapDTO(source(false));
    const beschikking = dto.stops.find((s) => s.id === "s-beschikking")!;
    expect(beschikking.evidence.documents).toEqual([
      { id: DOC, title: "Beschikking rechtbank", mime: "application/pdf",
        link: `grip://document/${DOC}` },
    ]);
    expect(beschikking.evidence.email).toEqual({
      subject: "Uw beschikking", fromAddr: "post@noordkust.example",
      sentAt: "2026-06-03T10:00:00.000Z" });
    const stukken = dto.stops.find((s) => s.id === "s-stukken")!;
    expect(stukken.evidence.task).toEqual({ id: TASK, title: "Loonstroken sturen", status: "open",
      dueAt: "2026-11-05T10:00:00.000Z", link: `grip://task/${TASK}` });
    const intake = dto.stops.find((s) => s.id === "s-intake")!;
    expect(intake.evidence.entry).toEqual({ summary: "Intakegesprek",
      occurredAt: "2026-05-19T10:00:00.000Z", channel: "call", direction: "inbound" });
  });

  it("publishes no raw router output", () => {
    const dto = toCaseMapDTO(source(false));
    const json = JSON.stringify(dto);
    // Never the Gmail id, never the raw-email row id, never a column nobody
    // meant to publish.
    expect(json).not.toContain("gm-secret-1");
    expect(json).not.toContain("raw-1");
    for (const key of ["gmailMessageId", "expectedAt", "stage", "orderIndex", "entryId",
      "documentId", "branchesAtStopId", "mergesAtStopId", "droppedMerge"]) {
      expect(json).not.toContain(`"${key}"`);
    }
    expect(Object.keys(dto).sort()).toEqual([
      "bands", "currentStopId", "debtEpisodesHidden", "edges", "hiddenDebtTrackCount",
      "laneCount", "problems", "rowCount", "stops", "tracks",
    ]);
    expect(Object.keys(dto.stops[0]).sort()).toEqual([
      "bandKey", "datesOutOfOrder", "evidence", "happenedAt", "id", "isJunction", "kind",
      "lane", "note", "row", "state", "title", "trackId",
    ]);
  });

  it("hiding schuldeisers drops the debt spoor AND its trigger, structurally", () => {
    const shown = toCaseMapDTO(source(false));
    const hidden = toCaseMapDTO(source(true));
    expect(shown.stops.some((s) => s.id === "s-sommatie")).toBe(true);
    expect(hidden.stops.some((s) => s.id === "s-sommatie")).toBe(false);
    expect(hidden.stops.some((s) => s.trackId === VORDERING)).toBe(false);
    expect(hidden.tracks.some((t) => t.id === VORDERING)).toBe(false);
    expect(hidden.hiddenDebtTrackCount).toBe(1);
    expect(hidden.debtEpisodesHidden).toBe(true);
    // The map was rebuilt, not post-filtered: rows stay dense.
    expect(hidden.stops.map((s) => s.row)).toEqual(hidden.stops.map((_, i) => i));
    expect(hidden.rowCount).toBe(hidden.stops.length);
  });
});
