import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTrackMap, filterDebtEpisodes, type StopRow, type TrackRow,
} from "@verder/api/src/track-map";
import type { StopEvidence } from "@verder/api/src/track-evidence";
import { toCaseMapDTO } from "./mobile-case-map";

/**
 * The phone's `timeline` fixture IS this DTO over the synthetic case — the
 * section "Tijdlijn / de zaak" of
 * docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md, all invented —
 * so the JSON the simulator draws can never drift from what the route serves.
 *
 * Regenerate with `WRITE_FIXTURES=1 pnpm --filter web test mobile-case-map.fixture`.
 */

const FIXTURES = fileURLToPath(new URL("../../../ios/Verder/FixtureData/", import.meta.url));
const SHOWN = `${FIXTURES}_shared/case-map.json`;
const HIDDEN = `${FIXTURES}_shared/case-map~schuldeisers=verborgen.json`;
const EMPTY = `${FIXTURES}empty/case-map.json`;
const LAYOUT = fileURLToPath(new URL("../../../ios/VerderTests/Fixtures/", import.meta.url));

const id = (prefix: string, n: number) =>
  `00000000-f1c5-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const T = (n: number) => id("4", n);
const S = (n: number) => id("5", n);
const DOC = (n: number) => `00000000-f1c5-4000-8000-200000000${n}`;
const TASK_STUKKEN = "00000000-f1c5-4000-8000-300000000011";

const ROOT = T(1), AANVRAAG = T(2), OPSTART = T(3), KADE = T(4), HUUR = T(5);
const day = (d: string) => new Date(`${d}T09:00:00.000Z`);

const track = (o: Partial<TrackRow> & { id: string; title: string }): TrackRow => ({
  status: "open", parentTrackId: ROOT, branchesAtStopId: null, mergesAtStopId: null,
  note: null, ...o,
});
const stop = (o: Partial<StopRow> & { id: string; trackId: string; title: string; orderIndex: number }): StopRow => ({
  kind: "other", state: "done", happenedAt: null, expectedAt: null, stage: null,
  entryId: null, taskId: null, documentId: null, note: null, ...o,
});

const tracks: TrackRow[] = [
  track({ id: ROOT, title: "Bewindvoering", parentTrackId: null }),
  track({ id: AANVRAAG, title: "Aanvraag bewindvoering", status: "done",
    branchesAtStopId: S(1), mergesAtStopId: S(2) }),
  track({ id: OPSTART, title: "Opstart en stukken", branchesAtStopId: S(2) }),
  track({ id: KADE, title: "Vordering Kade & Partners", branchesAtStopId: S(4) }),
  track({ id: HUUR, title: "Huurachterstand Lindehof", status: "ended" }),
];

const stops: StopRow[] = [
  stop({ id: S(1), trackId: ROOT, orderIndex: 0, title: "Aanmelding bij Bewindkantoor Noordkust",
    happenedAt: day("2026-05-12"), documentId: DOC(310) }),
  stop({ id: S(2), trackId: ROOT, orderIndex: 1, title: "Beschikking: onder bewind gesteld",
    happenedAt: day("2026-06-03"), documentId: DOC(300) }),
  stop({ id: S(3), trackId: ROOT, orderIndex: 2, title: "Rekening overgenomen door Bewindkantoor Noordkust",
    happenedAt: day("2026-10-02"), entryId: "entry-rekening" }),
  stop({ id: S(4), trackId: ROOT, orderIndex: 3, title: "Sommatie Kade & Partners namens Stroomnet Energie",
    happenedAt: day("2026-10-14"), documentId: DOC(106) }),
  stop({ id: S(5), trackId: ROOT, orderIndex: 4, title: "Brief Gemeente Westerlaan over bijzondere bijstand",
    happenedAt: day("2026-10-30"), documentId: DOC(307) }),
  stop({ id: S(6), trackId: ROOT, orderIndex: 5, title: "Stukken aanleveren bij Team Startdossier",
    state: "open", taskId: TASK_STUKKEN, note: "Loonstroken en polissen nog sturen." }),
  stop({ id: S(11), trackId: AANVRAAG, orderIndex: 0, title: "Intake", happenedAt: day("2026-05-19"),
    entryId: "entry-intake" }),
  stop({ id: S(12), trackId: AANVRAAG, orderIndex: 1, title: "Verzoek naar de rechtbank",
    happenedAt: day("2026-05-26") }),
  stop({ id: S(21), trackId: OPSTART, orderIndex: 0, title: "Team Startdossier vraagt stukken",
    happenedAt: day("2026-06-05") }),
  stop({ id: S(22), trackId: OPSTART, orderIndex: 1, title: "Loonstroken gestuurd",
    happenedAt: day("2026-06-20"), entryId: "entry-loonstroken" }),
  stop({ id: S(31), trackId: KADE, orderIndex: 0, title: "Kade & Partners — verwerkt als vordering",
    happenedAt: day("2026-10-15") }),
  stop({ id: S(32), trackId: KADE, orderIndex: 1, title: "Kade & Partners — melden bij Noordkust",
    state: "open", note: "Nog doorgeven aan Ilse." }),
  stop({ id: S(41), trackId: HUUR, orderIndex: 0, title: "Betalingsregeling afgesproken",
    happenedAt: day("2026-09-08"), entryId: "entry-regeling" }),
  stop({ id: S(42), trackId: HUUR, orderIndex: 1, title: "Regeling loopt", happenedAt: day("2026-10-01") }),
];

const none: StopEvidence = { entry: null, task: null, documents: [], email: null };
const doc = (n: number, title: string) => ({ id: DOC(n), title, mime: "application/pdf" });
const entry = (summary: string, d: string, channel: string, direction: string) =>
  ({ id: "x", summary, occurredAt: day(d), channel, direction });

const evidence: Record<string, StopEvidence> = {
  [S(1)]: { ...none, documents: [doc(310, "Bevestiging aanmelding Noordkust")] },
  [S(2)]: { ...none, documents: [doc(300, "Beschikking Rechtbank Westerlaan")] },
  [S(3)]: { ...none, entry: entry("Noordkust beheert nu de rekening", "2026-10-02", "email", "inbound") },
  [S(4)]: { ...none, documents: [doc(106, "Sommatie Kade & Partners 14 okt")],
    email: { id: "x", subject: "Sommatie namens Stroomnet Energie", fromAddr: "incasso@kade.example",
      sentAt: day("2026-10-14"), gmailMessageId: "x" } },
  [S(5)]: { ...none, documents: [doc(307, "Brief Gemeente Westerlaan 30 okt")] },
  [S(6)]: { ...none, task: { id: TASK_STUKKEN, title: "Loonstroken en polissen sturen naar Team Startdossier",
    status: "open", dueAt: null } },
  [S(11)]: { ...none, entry: entry("Intakegesprek met Ilse", "2026-05-19", "meeting", "inbound") },
  [S(22)]: { ...none, entry: entry("Loonstroken gemaild aan Team Startdossier", "2026-06-20", "email", "outbound") },
  [S(41)]: { ...none, entry: entry("Telefoongesprek met Lindehof over een regeling", "2026-09-08", "call", "outbound") },
};

function dto(hide: boolean) {
  const filtered = filterDebtEpisodes({ tracks, stops }, hide);
  const map = buildTrackMap(filtered);
  return toCaseMapDTO({ map, evidence, hiddenDebtTrackCount: filtered.hiddenTrackCount,
    debtEpisodesHidden: hide });
}

const emptyDTO = () => toCaseMapDTO({
  map: buildTrackMap({ tracks: [], stops: [] }), evidence: {},
  hiddenDebtTrackCount: 0, debtEpisodesHidden: false,
});

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * LANE SHARING. `buildTrackMap` packs lanes on each spoor's STOP span alone,
 * never on the row it branches from or merges into, so two sporen that never
 * ran at the same time share a lane even when one's connector has to travel
 * past the other. These three maps are that shape from the real builder, for
 * the phone's layout tests (TimelineLayoutTests): a rail stretched to its
 * connector would run straight through the other spoor.
 */
const LA = T(10), LB = T(11);
const shared = (o: { aBranch?: string; aMerge?: string; root: StopRow[]; a: string[]; b: string[] }) => {
  const ts: TrackRow[] = [
    track({ id: ROOT, title: "Bewindvoering", parentTrackId: null }),
    track({ id: LA, title: "Spoor A", branchesAtStopId: o.aBranch ?? null, mergesAtStopId: o.aMerge ?? null }),
    track({ id: LB, title: "Spoor B", status: "ended" }),
  ];
  const ss: StopRow[] = [
    ...o.root,
    ...o.a.map((d, i) => stop({ id: S(60 + i), trackId: LA, orderIndex: i, title: `A ${d}`, happenedAt: day(d) })),
    ...o.b.map((d, i) => stop({ id: S(70 + i), trackId: LB, orderIndex: i, title: `B ${d}`, happenedAt: day(d) })),
  ];
  return toCaseMapDTO({ map: buildTrackMap({ tracks: ts, stops: ss }), evidence: {},
    hiddenDebtTrackCount: 0, debtEpisodesHidden: false });
};
const rootStop = (n: number, d: string) =>
  stop({ id: S(n), trackId: ROOT, orderIndex: n, title: `Hoofdlijn ${d}`, happenedAt: day(d) });
const laneShared = {
  // A branches at a trunk stop OLDER than B, which sits between them in lane 1.
  below: () => shared({ aBranch: S(50), root: [rootStop(50, "2026-10-01")],
    a: ["2026-10-10", "2026-10-12"], b: ["2026-10-03", "2026-10-04"] }),
  // A branches at a trunk stop NEWER than all of A, with B between them.
  above: () => shared({ aBranch: S(50), root: [rootStop(50, "2026-10-20")],
    a: ["2026-10-05", "2026-10-06"], b: ["2026-10-15", "2026-10-16"] }),
  // A merges into a trunk stop newer than B, which sits between them.
  merge: () => shared({ aBranch: S(51), aMerge: S(50),
    root: [rootStop(50, "2026-10-20"), rootStop(51, "2026-10-01")],
    a: ["2026-10-05", "2026-10-06"], b: ["2026-10-15", "2026-10-16"] }),
};
const layoutFile = (k: string) => `${LAYOUT}case-map-lane-shared-${k}.json`;

/**
 * MANY CONCURRENT SPOREN. Production has ten tracks with several open sporen
 * running side by side into the `nu` band (Opstart, Bankrekening,
 * Schuldregeling and the debt episodes), so `buildTrackMap` hands the phone
 * more lanes than the four the gutter was first drawn for. Six open sporen
 * branch off the trunk and are all still open: every one holds its own lane.
 */
const CONCURRENT_SPOREN = 6;
const concurrentTrack = (i: number) => T(20 + i);
const concurrent = () => {
  const ts: TrackRow[] = [track({ id: ROOT, title: "Bewindvoering", parentTrackId: null })];
  const ss: StopRow[] = [rootStop(80, "2026-09-01")];
  for (let i = 0; i < CONCURRENT_SPOREN; i++) {
    ts.push(track({ id: concurrentTrack(i), title: `Spoor ${i + 1}`, branchesAtStopId: S(80) }));
    ss.push(
      stop({ id: S(81 + 3 * i), trackId: concurrentTrack(i), orderIndex: 0, title: `Spoor ${i + 1} begint`,
        happenedAt: day(`2026-09-${String(2 + i).padStart(2, "0")}`) }),
      stop({ id: S(82 + 3 * i), trackId: concurrentTrack(i), orderIndex: 1, title: `Spoor ${i + 1} loopt`,
        happenedAt: day(`2026-10-${String(10 + i).padStart(2, "0")}`) }),
      stop({ id: S(83 + 3 * i), trackId: concurrentTrack(i), orderIndex: 2, title: `Spoor ${i + 1} wacht`,
        state: "open" }),
    );
  }
  return toCaseMapDTO({ map: buildTrackMap({ tracks: ts, stops: ss }), evidence: {},
    hiddenDebtTrackCount: 0, debtEpisodesHidden: false });
};
const CONCURRENT_FILE = `${LAYOUT}case-map-concurrent.json`;

describe("the phone's timeline fixture", () => {
  if (process.env.WRITE_FIXTURES === "1") {
    writeFileSync(SHOWN, text(dto(false)));
    writeFileSync(HIDDEN, text(dto(true)));
    writeFileSync(EMPTY, text(emptyDTO()));
    for (const [k, f] of Object.entries(laneShared)) writeFileSync(layoutFile(k), text(f()));
    writeFileSync(CONCURRENT_FILE, text(concurrent()));
  }

  it("is the DTO over the synthetic case", () => {
    expect(readFileSync(SHOWN, "utf8")).toBe(text(dto(false)));
    expect(readFileSync(HIDDEN, "utf8")).toBe(text(dto(true)));
    expect(readFileSync(EMPTY, "utf8")).toBe(text(emptyDTO()));
    for (const [k, f] of Object.entries(laneShared)) {
      expect(readFileSync(layoutFile(k), "utf8")).toBe(text(f()));
    }
    expect(readFileSync(CONCURRENT_FILE, "utf8")).toBe(text(concurrent()));
  });

  it("gives every concurrent open spoor its own lane, more than four of them", () => {
    const m = concurrent();
    expect(m.problems).toEqual([]);
    const lanes = new Set(
      m.tracks.filter((t) => !t.isRoot).map((t) => t.lane),
    );
    expect(lanes.size).toBe(CONCURRENT_SPOREN);
    expect(m.laneCount).toBeGreaterThanOrEqual(CONCURRENT_SPOREN + 1);
    // All six wait in the `nu` band at once.
    expect(m.stops.filter((s) => s.bandKey === "nu" && s.state === "open")).toHaveLength(CONCURRENT_SPOREN);
  });

  it("puts two sporen that never overlap on ONE lane, whatever their connectors span", () => {
    for (const f of Object.values(laneShared)) {
      const m = f();
      const a = m.tracks.find((t) => t.id === LA)!;
      const b = m.tracks.find((t) => t.id === LB)!;
      expect(a.lane).toBe(1);
      expect(b.lane).toBe(1);
    }
    const below = laneShared.below();
    const branch = below.edges.find((e) => e.kind === "branch" && e.trackId === LA)!;
    expect([branch.fromRow, branch.toRow]).toEqual([4, 1]);
  });

  it("draws the case the data doc describes", () => {
    const shown = dto(false);
    expect(shown.problems).toEqual([]);
    expect(shown.currentStopId).toBe(S(6));
    expect(shown.stops[0].id).toBe(S(6));
    expect(shown.tracks.find((t) => t.id === HUUR)?.terminus).toBe("ended");
    expect(shown.tracks.find((t) => t.id === AANVRAAG)?.terminus).toBe("merge");
    const hidden = dto(true);
    expect(hidden.stops.some((s) => s.id === S(4) || s.trackId === KADE)).toBe(false);
    expect(hidden.hiddenDebtTrackCount).toBe(1);
  });
});
