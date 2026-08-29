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

const on = (iso: string) => new Date(`${iso}T12:00:00+02:00`);
const rowOf = (map: ReturnType<typeof buildTrackMap>, id: string) =>
  map.stops.find((s) => s.id === id)!.row;

/** A spine of four dated stops and one spoor that ran alongside it in August. */
function caseFixture() {
  const tracks = [
    track({ id: "spine", title: "Bewindvoering" }),
    track({ id: "ontruiming", title: "Ontruiming Woonhave",
      status: "ended", parentTrackId: "spine" }),
  ];
  const stops = [
    stop({ id: "s1", trackId: "spine", orderIndex: 100, happenedAt: on("2026-04-16") }),
    stop({ id: "s2", trackId: "spine", orderIndex: 200, happenedAt: on("2026-07-20") }),
    stop({ id: "s3", trackId: "spine", orderIndex: 300, happenedAt: on("2026-08-12") }),
    stop({ id: "s4", trackId: "spine", orderIndex: 400, happenedAt: on("2026-08-28") }),
    stop({ id: "o1", trackId: "ontruiming", orderIndex: 100, happenedAt: on("2026-07-29") }),
    stop({ id: "o2", trackId: "ontruiming", orderIndex: 200, happenedAt: on("2026-08-06") }),
  ];
  return { tracks, stops };
}

describe("buildTrackMap order", () => {
  it("puts the newest stop at the top and the oldest at the bottom", () => {
    const map = buildTrackMap(caseFixture());
    expect(rowOf(map, "s4")).toBe(0);
    expect(rowOf(map, "s1")).toBe(map.rowCount - 1);
  });

  it("interleaves a spoor's stops with the spine by date", () => {
    const map = buildTrackMap(caseFixture());
    // 06-08 is newer than 20-07 and older than 12-08, wherever it sits.
    expect(rowOf(map, "o2")).toBeGreaterThan(rowOf(map, "s3"));
    expect(rowOf(map, "o2")).toBeLessThan(rowOf(map, "s2"));
  });

  it("reads the spine first when two stops share a day", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "o3", trackId: "ontruiming", orderIndex: 300,
      happenedAt: on("2026-08-28") }));
    const map = buildTrackMap(f);
    expect(rowOf(map, "s4")).toBeLessThan(rowOf(map, "o3"));
  });

  it("never renders an expected stop, even if one is in the data", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "future", trackId: "spine", orderIndex: 500,
      state: "expected" }));
    const map = buildTrackMap(f);
    expect(map.stops.map((s) => s.id)).not.toContain("future");
  });
});

describe("buildTrackMap bands", () => {
  it("gives every month in the span a band, newest first", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.bands.map((b) => b.key))
      .toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
    expect(map.bands[0].label).toBe("augustus 2026");
  });

  it("marks a month with nothing in it as empty and gives it no rows", () => {
    const map = buildTrackMap(caseFixture());
    const mei = map.bands.find((b) => b.key === "2026-05")!;
    expect(mei.empty).toBe(true);
    expect(mei.toRow).toBe(mei.fromRow);
  });

  it("covers every row exactly once, in order", () => {
    const map = buildTrackMap(caseFixture());
    let next = 0;
    for (const b of map.bands) {
      expect(b.fromRow).toBe(next);
      next = b.toRow;
    }
    expect(next).toBe(map.rowCount);
  });

  it("puts an undated open stop in a `nu` band above all history", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "live", trackId: "ontruiming", orderIndex: 300,
      state: "open" }));
    const map = buildTrackMap(f);
    expect(map.bands[0].key).toBe("nu");
    expect(rowOf(map, "live")).toBe(0);
  });

  it("omits the `nu` band when nothing is running undated", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.bands.map((b) => b.key)).not.toContain("nu");
  });

  it("gives an undated done stop the position of the one before it on its track", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "s2b", trackId: "spine", orderIndex: 250 }));
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "s2b")!.bandKey).toBe("2026-07");
  });

  it("drops an entirely undated track into a `zonder datum` band at the bottom", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "leeg", title: "Zonder datum", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "u1", trackId: "leeg", orderIndex: 100 }));
    const map = buildTrackMap(f);
    expect(map.bands.at(-1)!.key).toBe("onbekend");
    expect(rowOf(map, "u1")).toBe(map.rowCount - 1);
  });
});

describe("buildTrackMap lanes", () => {
  it("keeps the spine on lane 0", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.tracks.find((t) => t.id === "spine")!.lane).toBe(0);
    expect(map.stops.find((s) => s.id === "s1")!.lane).toBe(0);
  });

  it("lets two sporen that never overlap in time share a lane", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "oud", title: "Oud spoor", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "x1", trackId: "oud", orderIndex: 100,
      happenedAt: on("2026-04-20") }));
    const map = buildTrackMap(f);
    expect(map.tracks.find((t) => t.id === "oud")!.lane)
      .toBe(map.tracks.find((t) => t.id === "ontruiming")!.lane);
    expect(map.laneCount).toBe(2);
  });

  it("gives two sporen that overlap in time different lanes", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "gelijk", title: "Gelijktijdig", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "g1", trackId: "gelijk", orderIndex: 100,
      happenedAt: on("2026-08-01") }));
    const map = buildTrackMap(f);
    expect(map.tracks.find((t) => t.id === "gelijk")!.lane)
      .not.toBe(map.tracks.find((t) => t.id === "ontruiming")!.lane);
  });
});

describe("buildTrackMap edges", () => {
  it("branches from the spine at the spoor's own oldest stop when no origin is recorded", () => {
    const map = buildTrackMap(caseFixture());
    const branch = map.edges.find((e) => e.kind === "branch")!;
    expect(branch.trackId).toBe("ontruiming");
    expect(branch.atStopId).toBeNull();
    expect(branch.fromLane).toBe(0);
    expect(branch.fromRow).toBe(rowOf(map, "o1"));
    expect(branch.toRow).toBe(rowOf(map, "o1"));
  });

  it("branches at the recorded origin stop when there is one", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], branchesAtStopId: "s2" };
    const map = buildTrackMap(f);
    const branch = map.edges.find((e) => e.kind === "branch")!;
    expect(branch.atStopId).toBe("s2");
    expect(branch.fromRow).toBe(rowOf(map, "s2"));
  });

  it("draws a merge back into the spine above the spoor's newest stop", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], mergesAtStopId: "s4" };
    const map = buildTrackMap(f);
    const merge = map.edges.find((e) => e.kind === "merge")!;
    expect(merge.fromRow).toBe(rowOf(map, "o2"));
    expect(merge.toRow).toBe(rowOf(map, "s4"));
    expect(map.tracks.find((t) => t.id === "ontruiming")!.mergesBack).toBe(true);
  });

  it("refuses a merge into a stop older than the spoor itself, and reports it", () => {
    const f = caseFixture();
    // s2 is 20-07; the spoor's newest stop o2 is 06-08. Rejoining before it
    // left is not a track, it is a loop.
    f.tracks[1] = { ...f.tracks[1], mergesAtStopId: "s2" };
    const map = buildTrackMap(f);
    expect(map.edges.filter((e) => e.kind === "merge")).toHaveLength(0);
    expect(map.problems.map((p) => p.kind)).toContain("backwards-merge");
    const t = map.tracks.find((t) => t.id === "ontruiming")!;
    expect(t.droppedMerge).toBe(true);
    expect(t.mergesBack).toBe(false);
  });

  it("rings a stop another track leaves from or lands on", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], branchesAtStopId: "s2" };
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "s2")!.isJunction).toBe(true);
    expect(map.stops.find((s) => s.id === "s3")!.isJunction).toBe(false);
  });
});

describe("buildTrackMap current stop", () => {
  it("answers with the newest open stop", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "open1", trackId: "ontruiming", orderIndex: 300,
      state: "open", happenedAt: on("2026-08-20") }));
    const map = buildTrackMap(f);
    expect(map.currentStopId).toBe("open1");
  });

  it("prefers an undated open stop, because it is what is running now", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "dated", trackId: "ontruiming", orderIndex: 300,
      state: "open", happenedAt: on("2026-08-20") }));
    f.stops.push(stop({ id: "live", trackId: "ontruiming", orderIndex: 400,
      state: "open" }));
    const map = buildTrackMap(f);
    expect(map.currentStopId).toBe("live");
  });

  it("reports no current stop when nothing is open", () => {
    expect(buildTrackMap(caseFixture()).currentStopId).toBeNull();
  });
});

describe("buildTrackMap problems", () => {
  it("reports a map with no hoofdlijn and draws nothing", () => {
    const map = buildTrackMap({
      tracks: [track({ id: "a", title: "A", parentTrackId: "b" })], stops: [],
    });
    expect(map.problems.map((p) => p.kind)).toEqual(["no-root"]);
    expect(map.stops).toHaveLength(0);
    expect(map.rowCount).toBe(0);
  });

  it("reports a stop belonging to no track at all", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "weg", trackId: "bestaat-niet" }));
    const map = buildTrackMap(f);
    expect(map.problems.map((p) => p.kind)).toContain("orphan-stop");
    expect(map.stops.map((s) => s.id)).not.toContain("weg");
  });

  it("leaves a track whose parents cycle off the map, and says so", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "p", title: "P", parentTrackId: "q" }));
    f.tracks.push(track({ id: "q", title: "Q", parentTrackId: "p" }));
    f.stops.push(stop({ id: "p1", trackId: "p", happenedAt: on("2026-08-01") }));
    const map = buildTrackMap(f);
    expect(map.problems.map((p) => p.kind)).toContain("ancestry-cycle");
    expect(map.stops.map((s) => s.id)).not.toContain("p1");
    // Totality: the rest of the map still drew.
    expect(rowOf(map, "s4")).toBe(0);
  });

  it("flags a date that contradicts its position on its own track", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "typo", trackId: "spine", orderIndex: 350,
      happenedAt: on("2026-05-01") }));
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "typo")!.datesOutOfOrder).toBe(true);
    // Shown, never corrected: the healthy stop after it stays clean.
    expect(map.stops.find((s) => s.id === "s4")!.datesOutOfOrder).toBe(false);
  });

  it("renders an empty map without throwing", () => {
    const map = buildTrackMap({ tracks: [], stops: [] });
    expect(map.problems.map((p) => p.kind)).toEqual(["no-root"]);
    expect(map.bands).toEqual([]);
  });
});
