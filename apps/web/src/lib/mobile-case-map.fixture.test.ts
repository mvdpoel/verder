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

describe("the phone's timeline fixture", () => {
  if (process.env.WRITE_FIXTURES === "1") {
    writeFileSync(SHOWN, text(dto(false)));
    writeFileSync(HIDDEN, text(dto(true)));
    writeFileSync(EMPTY, text(emptyDTO()));
  }

  it("is the DTO over the synthetic case", () => {
    expect(readFileSync(SHOWN, "utf8")).toBe(text(dto(false)));
    expect(readFileSync(HIDDEN, "utf8")).toBe(text(dto(true)));
    expect(readFileSync(EMPTY, "utf8")).toBe(text(emptyDTO()));
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
