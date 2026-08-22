import { describe, expect, it } from "vitest";
import { buildTrackMap, type StopRow, type TrackRow } from "./track-map";

const track = (over: Partial<TrackRow> & { id: string; title: string }): TrackRow => ({
  status: "open", parentTrackId: null, branchesAtStopId: null,
  mergesAtStopId: null, note: null, ...over,
});

const stop = (over: Partial<StopRow> & { id: string; trackId: string }): StopRow => ({
  orderIndex: 0, title: over.id, kind: "process", state: "done",
  happenedAt: null, expectedAt: null, stage: null,
  entryId: null, taskId: null, documentId: null, note: null, ...over,
});

/** Main line m0..m3, with a child branching at m1 and merging at m3. */
function branchingFixture() {
  const tracks = [
    track({ id: "main", title: "Einde bewindvoering" }),
    track({
      id: "aanvraag", title: "WSNP-aanvraag", parentTrackId: "main",
      branchesAtStopId: "m1", mergesAtStopId: "m3",
    }),
  ];
  const stops = [
    stop({ id: "m0", trackId: "main", orderIndex: 0 }),
    stop({ id: "m1", trackId: "main", orderIndex: 1 }),
    stop({ id: "m2", trackId: "main", orderIndex: 2 }),
    stop({ id: "m3", trackId: "main", orderIndex: 3 }),
    stop({ id: "a1", trackId: "aanvraag", orderIndex: 0 }),
    stop({ id: "a2", trackId: "aanvraag", orderIndex: 1 }),
    stop({ id: "a3", trackId: "aanvraag", orderIndex: 2 }),
  ];
  return { tracks, stops };
}

const columnOf = (map: ReturnType<typeof buildTrackMap>, id: string) =>
  map.stops.find((s) => s.id === id)!.column;

describe("buildTrackMap columns", () => {
  it("puts a branch's first stop after the stop it branches from", () => {
    const map = buildTrackMap(branchingFixture());
    expect(columnOf(map, "a1")).toBeGreaterThan(columnOf(map, "m1"));
  });

  it("puts a merge target after every stop that fed into it", () => {
    const map = buildTrackMap(branchingFixture());
    // m3 waits for the whole child track, so it must sit right of a3 — even
    // though on its own track it is only three stops along.
    expect(columnOf(map, "m3")).toBeGreaterThan(columnOf(map, "a3"));
    expect(columnOf(map, "m3")).toBeGreaterThan(columnOf(map, "m2"));
  });

  it("orders stops within a track by order_index", () => {
    const map = buildTrackMap(branchingFixture());
    expect(columnOf(map, "m0")).toBeLessThan(columnOf(map, "m1"));
    expect(columnOf(map, "a1")).toBeLessThan(columnOf(map, "a2"));
  });

  it("drops a merge that points backwards, and reports it", () => {
    // Branches at m2 but claims to merge at m1 — that is a loop, not a track.
    const { tracks, stops } = branchingFixture();
    tracks[1] = { ...tracks[1], branchesAtStopId: "m2", mergesAtStopId: "m1" };
    const map = buildTrackMap({ tracks, stops });
    expect(map.edges.some((e) => e.kind === "merge")).toBe(false);
    expect(map.problems.some((p) => p.kind === "backwards-merge")).toBe(true);
    // and it still draws: every stop got a column
    expect(map.stops).toHaveLength(7);
  });

  it("survives a track whose ancestry never reaches the root", () => {
    const tracks = [
      track({ id: "main", title: "hoofdlijn" }),
      track({ id: "x", title: "x", parentTrackId: "y", branchesAtStopId: "s" }),
      track({ id: "y", title: "y", parentTrackId: "x", branchesAtStopId: "s" }),
    ];
    const stops = [stop({ id: "m0", trackId: "main" }), stop({ id: "s", trackId: "x" })];
    const map = buildTrackMap({ tracks, stops });
    expect(map.problems.some((p) => p.kind === "ancestry-cycle")).toBe(true);
    expect(map.tracks.map((t) => t.id)).toEqual(["main"]);
  });

  it("returns an empty map, not an exception, when there is no root", () => {
    const map = buildTrackMap({ tracks: [], stops: [] });
    expect(map.stops).toEqual([]);
    expect(map.problems.some((p) => p.kind === "no-root")).toBe(true);
  });

  it("keeps a track with no stops as a labelled stub", () => {
    const { tracks, stops } = branchingFixture();
    tracks.push(track({
      id: "leeg", title: "Team Opstart", parentTrackId: "main", branchesAtStopId: "m2",
    }));
    const map = buildTrackMap({ tracks, stops });
    const leeg = map.tracks.find((t) => t.id === "leeg")!;
    // A track opens the moment something arrives, before anyone has written
    // down what happens next. It gets a lane and a position anyway.
    expect(leeg.firstColumn).toBeGreaterThan(columnOf(map, "m2") - 1);
  });

  it("counts a stopless track's stub inside columnCount, so it is not drawn clipped", () => {
    // The stub sits one column RIGHT of the last stop on the map, so a count
    // taken from stops alone leaves it outside the viewBox.
    const { tracks, stops } = branchingFixture();
    tracks.push(track({
      id: "leeg", title: "Team Opstart", parentTrackId: "main", branchesAtStopId: "m3",
    }));
    const map = buildTrackMap({ tracks, stops });
    const leeg = map.tracks.find((t) => t.id === "leeg")!;
    const widest = Math.max(...map.stops.map((s) => s.column));
    expect(leeg.lastColumn).toBeGreaterThan(widest);
    expect(map.columnCount).toBeGreaterThan(leeg.lastColumn);
  });
});

describe("buildTrackMap refuses a branch that would close a loop", () => {
  it("skips and reports a track branching from one of its own stops", () => {
    // Nothing in the schema forces branches_at_stop_id onto the PARENT track.
    // Pointed at the track's own first stop it is a1 → a1 … → a1: a cycle in
    // the layering, which is Kahn-based and would silently leave every stop in
    // it, and everything downstream of it, stacked at column 0.
    const { tracks, stops } = branchingFixture();
    tracks[1] = { ...tracks[1], branchesAtStopId: "a1" };
    const map = buildTrackMap({ tracks, stops });

    expect(map.problems.some(
      (p) => p.kind === "branch-into-own-subtree" && p.trackId === "aanvraag")).toBe(true);
    // Total: every stop still drawn, and the main line still laid out.
    expect(map.stops).toHaveLength(7);
    expect(columnOf(map, "m0")).toBe(0);
    expect(columnOf(map, "m1")).toBe(1);
    expect(columnOf(map, "m2")).toBe(2);
    expect(columnOf(map, "a1")).toBeLessThan(columnOf(map, "a2"));
    expect(columnOf(map, "a2")).toBeLessThan(columnOf(map, "a3"));
    // The merge is untouched by the refused branch and still holds.
    expect(columnOf(map, "m3")).toBeGreaterThan(columnOf(map, "a3"));
    // No branch edge was drawn, so no junction is claimed either.
    expect(map.edges.some((e) => e.kind === "branch")).toBe(false);
    expect(map.stops.find((s) => s.id === "a1")!.isJunction).toBe(false);
  });

  it("skips and reports a track branching from a stop on its own descendant", () => {
    // main ─ m0 m1 ; "ouder" hangs under main, "kind" hangs under "ouder" and
    // branches at ouder's p1. Pointing ouder's own branch at kind's k1 closes
    // p1 → k1 → p1, which flattened the entire map to column 0.
    const tracks = [
      track({ id: "main", title: "Einde bewindvoering" }),
      track({ id: "ouder", title: "WSNP-aanvraag", parentTrackId: "main",
        branchesAtStopId: "k1" }),
      track({ id: "kind", title: "Stukken rechtbank", parentTrackId: "ouder",
        branchesAtStopId: "p1" }),
    ];
    const stops = [
      stop({ id: "m0", trackId: "main", orderIndex: 0 }),
      stop({ id: "m1", trackId: "main", orderIndex: 1 }),
      stop({ id: "p1", trackId: "ouder", orderIndex: 0 }),
      stop({ id: "p2", trackId: "ouder", orderIndex: 1 }),
      stop({ id: "k1", trackId: "kind", orderIndex: 0 }),
    ];
    const map = buildTrackMap({ tracks, stops });

    expect(map.problems.some(
      (p) => p.kind === "branch-into-own-subtree" && p.trackId === "ouder")).toBe(true);
    expect(map.stops).toHaveLength(5);
    // The honest branch below it survives, and lands right of its branch point.
    expect(columnOf(map, "k1")).toBeGreaterThan(columnOf(map, "p1"));
    expect(columnOf(map, "p2")).toBeGreaterThan(columnOf(map, "p1"));
    expect(columnOf(map, "m1")).toBeGreaterThan(columnOf(map, "m0"));
    // The map is laid out, not collapsed: more than one column is in use.
    expect(new Set(map.stops.map((s) => s.column)).size).toBeGreaterThan(1);
  });
});

describe("buildTrackMap lanes and state", () => {
  it("keeps the main line in lane 0 and puts a branch beside it", () => {
    const map = buildTrackMap(branchingFixture());
    expect(map.tracks.find((t) => t.id === "main")!.lane).toBe(0);
    expect(map.tracks.find((t) => t.id === "aanvraag")!.lane).toBeGreaterThan(0);
  });

  it("reuses a lane for two tracks that do not overlap in time", () => {
    const tracks = [
      track({ id: "main", title: "hoofdlijn" }),
      track({ id: "vroeg", title: "Ontruiming", parentTrackId: "main",
        branchesAtStopId: "m0" }),
      track({ id: "laat", title: "Team Opstart", parentTrackId: "main",
        branchesAtStopId: "m3" }),
    ];
    const stops = [
      stop({ id: "m0", trackId: "main", orderIndex: 0 }),
      stop({ id: "m1", trackId: "main", orderIndex: 1 }),
      stop({ id: "m2", trackId: "main", orderIndex: 2 }),
      stop({ id: "m3", trackId: "main", orderIndex: 3 }),
      stop({ id: "v1", trackId: "vroeg", orderIndex: 0 }),
      stop({ id: "l1", trackId: "laat", orderIndex: 0 }),
    ];
    const map = buildTrackMap({ tracks, stops });
    const lane = (id: string) => map.tracks.find((t) => t.id === id)!.lane;
    // They never overlap, so the map does not grow a second row for them.
    expect(lane("vroeg")).toBe(lane("laat"));
    expect(map.laneCount).toBe(2);
  });

  it("gives overlapping tracks their own lanes", () => {
    const { tracks, stops } = branchingFixture();
    tracks.push(track({ id: "tweede", title: "Ontruiming", parentTrackId: "main",
      branchesAtStopId: "m1" }));
    stops.push(stop({ id: "t1", trackId: "tweede", orderIndex: 0 }));
    const map = buildTrackMap({ tracks, stops });
    const lane = (id: string) => map.tracks.find((t) => t.id === id)!.lane;
    expect(lane("aanvraag")).not.toBe(lane("tweede"));
  });

  it("marks a stop with a stage as a station, and a branch point as a junction", () => {
    const { tracks, stops } = branchingFixture();
    stops[2] = { ...stops[2], stage: "accepted" }; // m2
    const map = buildTrackMap({ tracks, stops });
    const at = (id: string) => map.stops.find((s) => s.id === id)!;
    expect(at("m2").isStation).toBe(true);
    expect(at("m0").isStation).toBe(false);
    expect(at("m1").isJunction).toBe(true);  // the child branches here
    expect(at("m3").isJunction).toBe(true);  // and merges here
    expect(at("m0").isJunction).toBe(false);
  });

  it("flags a dated stop that sits before the one ahead of it, and does not reorder", () => {
    const { tracks, stops } = branchingFixture();
    stops[0] = { ...stops[0], happenedAt: new Date("2026-06-01T00:00:00Z") };
    stops[1] = { ...stops[1], happenedAt: new Date("2026-05-01T00:00:00Z") };
    const map = buildTrackMap({ tracks, stops });
    const at = (id: string) => map.stops.find((s) => s.id === id)!;
    expect(at("m1").datesOutOfOrder).toBe(true);
    expect(at("m0").datesOutOfOrder).toBe(false);
    // Structure still wins: the map draws the order it was given.
    expect(at("m1").column).toBeGreaterThan(at("m0").column);
  });

  it("flags one stop for one typo, instead of cascading over every stop behind it", () => {
    // 2036 instead of 2026 on m1. The flag means "this date precedes the one on
    // the PREVIOUS dated stop", so the discontinuity is reported once — at m2,
    // the first stop that reads as going backwards. Carrying a running MAXIMUM
    // instead flags m2, m3 AND m4: three correct stops, and never the typo.
    const tracks = [track({ id: "main", title: "Einde bewindvoering" })];
    const stops = [
      stop({ id: "m0", trackId: "main", orderIndex: 0,
        happenedAt: new Date("2026-01-01T00:00:00Z") }),
      stop({ id: "m1", trackId: "main", orderIndex: 1,
        happenedAt: new Date("2036-02-01T00:00:00Z") }),
      stop({ id: "m2", trackId: "main", orderIndex: 2,
        happenedAt: new Date("2026-03-01T00:00:00Z") }),
      stop({ id: "m3", trackId: "main", orderIndex: 3,
        happenedAt: new Date("2026-04-01T00:00:00Z") }),
      stop({ id: "m4", trackId: "main", orderIndex: 4,
        happenedAt: new Date("2026-05-01T00:00:00Z") }),
    ];
    const map = buildTrackMap({ tracks, stops });
    expect(map.stops.filter((s) => s.datesOutOfOrder).map((s) => s.id)).toEqual(["m2"]);
  });

  it("flags the typo itself when the wrong date points backwards", () => {
    // 2016 instead of 2026 on m2: here the stop carrying the typo is the one
    // that reads as going backwards, and the stops behind it stay clean.
    const tracks = [track({ id: "main", title: "Einde bewindvoering" })];
    const stops = [
      stop({ id: "m0", trackId: "main", orderIndex: 0,
        happenedAt: new Date("2026-01-01T00:00:00Z") }),
      stop({ id: "m1", trackId: "main", orderIndex: 1,
        happenedAt: new Date("2026-02-01T00:00:00Z") }),
      stop({ id: "m2", trackId: "main", orderIndex: 2,
        happenedAt: new Date("2016-03-01T00:00:00Z") }),
      stop({ id: "m3", trackId: "main", orderIndex: 3,
        happenedAt: new Date("2026-04-01T00:00:00Z") }),
      stop({ id: "m4", trackId: "main", orderIndex: 4,
        happenedAt: new Date("2026-05-01T00:00:00Z") }),
    ];
    const map = buildTrackMap({ tracks, stops });
    expect(map.stops.filter((s) => s.datesOutOfOrder).map((s) => s.id)).toEqual(["m2"]);
  });

  it("points at the furthest open stop as the current one", () => {
    const { tracks, stops } = branchingFixture();
    stops[1] = { ...stops[1], state: "open" };  // m1, early
    stops[6] = { ...stops[6], state: "open" };  // a3, late
    const map = buildTrackMap({ tracks, stops });
    expect(map.currentStopId).toBe("a3");
  });

  it("has no current stop when nothing is open", () => {
    expect(buildTrackMap(branchingFixture()).currentStopId).toBeNull();
  });
});
