import { describe, expect, it } from "vitest";
import {
  caseTopRows, noOpenTracksLine, stopHref, stopMark, stopWhenLabel, trackTerminus,
} from "@/lib/track-marks";

const stop = (over: Partial<Parameters<typeof stopMark>[0]> = {}) => ({
  state: "done" as const, isJunction: false,
  datesOutOfOrder: false, ...over,
});

describe("stopMark", () => {
  it("draws only two marks — filled if it happened, outlined if it is open", () => {
    // These are ALL the marks the map can reach: migration 0026 removed every
    // expected stop, so there is no third state left to draw and no dashed mark
    // on the page.
    expect(stopMark(stop({ state: "done" })).fill).toBe("solid");
    expect(stopMark(stop({ state: "open" })).fill).toBe("hollow");
  });

  it("still draws something for a state it can no longer be given", () => {
    // Migration 0026 removed every expected stop and buildTrackMap filters the
    // state out a second time, so this arm is unreachable by design. stopMark
    // stays TOTAL over the state anyway: a row that somehow reaches it must
    // draw as something, and dashed is the one thing it may not draw as a fact.
    expect(stopMark(stop({ state: "expected" })).fill).toBe("dashed");
    expect(stopMark(stop({ state: "expected" })).fill).not.toBe("solid");
  });

  it("rings a junction, so a branch point is visible without following the line", () => {
    expect(stopMark(stop({ isJunction: true })).ring).toBe(true);
    expect(stopMark(stop({ isJunction: false })).ring).toBe(false);
  });

  it("flags an out-of-order date instead of hiding it", () => {
    expect(stopMark(stop({ datesOutOfOrder: true })).flagged).toBe(true);
  });
});

describe("trackTerminus", () => {
  it("tells a track that rejoined apart from one that ended", () => {
    expect(trackTerminus({ mergesBack: true, status: "done", droppedMerge: false }))
      .toBe("merge");
    expect(trackTerminus({ mergesBack: false, status: "ended", droppedMerge: false }))
      .toBe("ended");
    expect(trackTerminus({ mergesBack: false, status: "open", droppedMerge: false }))
      .toBe("open");
  });

  it("keeps afgerond and geëindigd apart — the editor asks Martin to choose", () => {
    // Two different facts. Collapsing them drew one cap for both and made the
    // choice in the spoor editor meaningless.
    const done = trackTerminus({ mergesBack: false, status: "done", droppedMerge: false });
    const ended = trackTerminus({ mergesBack: false, status: "ended", droppedMerge: false });
    expect(done).toBe("done");
    expect(ended).toBe("ended");
    expect(done).not.toBe(ended);
  });

  it("renders a refused merge as not rejoining, and does not call it an outcome", () => {
    // buildTrackMap dropped the edge; the terminus must agree with the drawing.
    // But a spoor that is still `open` was neither afgerond nor geëindigd, so
    // it gets no outcome cap — map.problems is what reports the contradiction.
    const t = trackTerminus({ mergesBack: false, status: "open", droppedMerge: true });
    expect(t).not.toBe("merge");
    expect(t).toBe("open");
  });

  it("a dropped merge on a closed spoor still carries that spoor's own status", () => {
    // buildTrackMap already clears mergesBack when it drops the edge, so this
    // is the shape that reaches the drawing.
    expect(trackTerminus({ mergesBack: false, status: "ended", droppedMerge: true }))
      .toBe("ended");
    expect(trackTerminus({ mergesBack: false, status: "done", droppedMerge: true }))
      .toBe("done");
  });
});

describe("stopWhenLabel", () => {
  it("labels from the state, not from whether there is a date", () => {
    // The bug: any undated stop was called "verwacht", so the screen-reader
    // label of the current (open) stop contradicted the card beside it.
    expect(stopWhenLabel({ state: "open", happenedAt: null })).toBe("loopt nog");
    expect(stopWhenLabel({ state: "done", happenedAt: null })).toBe("gebeurd");
  });

  it("prints no date for a stop that only ever had an expected one", () => {
    // The label may not disagree with the axis. `buildTrackMap` files a stop
    // with no `happenedAt` under "Nu" or "Zonder datum", so a label built from
    // an expected date would stamp a day on a row that has none. The editor no
    // longer offers `verwacht op`, but rows written before it was removed still
    // carry the column — and they must read as undated here too.
    const stale = { state: "done", happenedAt: null, expectedAt: new Date("2026-09-12") };
    expect(stopWhenLabel(stale)).toBe("gebeurd");
  });

  it("adds the date when there is one, without changing the wording", () => {
    const d = new Date("2026-08-12T10:00:00Z");
    const stamp = d.toLocaleDateString("nl-NL");
    expect(stopWhenLabel({ state: "open", happenedAt: d })).toBe(`loopt nog · ${stamp}`);
    expect(stopWhenLabel({ state: "done", happenedAt: d })).toBe(`gebeurd · ${stamp}`);
  });

  it("never announces an open or done stop as verwacht", () => {
    for (const state of ["open", "done"]) {
      expect(stopWhenLabel({ state, happenedAt: null })).not.toContain("verwacht");
    }
  });
});

describe("noOpenTracksLine", () => {
  it("does not claim afgerond over a spoor that ended", () => {
    expect(noOpenTracksLine(["ended"])).toContain("geëindigd");
    expect(noOpenTracksLine(["ended"])).not.toContain("afgerond");
  });

  it("says afgerond when that is what happened", () => {
    expect(noOpenTracksLine(["done"])).toContain("afgerond");
    expect(noOpenTracksLine(["done"])).not.toContain("geëindigd");
  });

  it("names both when both happened", () => {
    const line = noOpenTracksLine(["done", "ended"]);
    expect(line).toContain("afgerond");
    expect(line).toContain("geëindigd");
  });

  it("claims no outcome at all when there is no zijspoor yet", () => {
    const line = noOpenTracksLine([]);
    expect(line).not.toContain("afgerond");
    expect(line).not.toContain("geëindigd");
  });
});

describe("stopHref", () => {
  it("round-trips selection: selecting a stop links to it, re-selecting clears it", () => {
    expect(stopHref("abc", null)).toBe("/timeline?stop=abc");
    expect(stopHref("abc", "other")).toBe("/timeline?stop=abc");
    expect(stopHref("abc", "abc")).toBe("/timeline");
  });

  it("encodes an id that would otherwise break the query string", () => {
    expect(stopHref("a b&c", null)).toBe("/timeline?stop=a%20b%26c");
  });
});

describe("caseTopRows", () => {
  // The shape `buildTrackMap` hands the dashboard, cut down to the fields this
  // decision reads. Rows are already newest-first: row 0 is the top of /timeline.
  const tracks = [
    { id: "root", title: "Bewindvoering", parentTrackId: null },
    { id: "sr", title: "Schuldregeling", parentTrackId: "root" },
  ];
  const s = (over: Record<string, unknown>) => ({
    id: "x", trackId: "root", title: "halte", row: 0,
    bandKey: "2026-08", happenedAt: new Date("2026-08-20T10:00:00Z"), ...over,
  }) as Parameters<typeof caseTopRows>[0]["stops"][number];

  it("puts what is running now above the history, and never dates it", () => {
    const rows = caseTopRows({ tracks, stops: [
      s({ id: "now", trackId: "sr", title: "Stukken aanleveren",
        row: 0, bandKey: "nu", happenedAt: null }),
      s({ id: "a", title: "Beschikking", row: 1 }),
    ] });
    expect(rows.map((r) => r.id)).toEqual(["now", "a"]);
    expect(rows[0].running).toBe(true);
    // "loopt nu", not a date: an undated open halte has none, and a dashboard
    // that printed one would be inventing a fact about Martin's case.
    expect(rows[0].when).toBe("loopt nu");
    expect(rows[0].spoor).toBe("Schuldregeling");
    expect(rows[1].running).toBe(false);
    expect(rows[1].when).toBe(new Date("2026-08-20T10:00:00Z").toLocaleDateString("nl-NL"));
    // A halte on the hoofdlijn is named as such: the root track's title is the
    // case, not a spoor.
    expect(rows[1].spoor).toBe("hoofdlijn");
  });

  it("shows only the newest few dated rows — the dashboard is not the map", () => {
    const stops = [0, 1, 2, 3, 4, 5].map((n) => s({ id: `s${n}`, row: n }));
    expect(caseTopRows({ tracks, stops }).map((r) => r.id))
      .toEqual(["s0", "s1", "s2"]);
    expect(caseTopRows({ tracks, stops, datedLimit: 4 })).toHaveLength(4);
  });

  it("keeps every running row, however many there are", () => {
    // The limit bounds HISTORY. "Wat loopt er nu" is the question the block is
    // opened to answer, so silently dropping one of those answers is worse than
    // a slightly longer list.
    const stops = [0, 1, 2, 3].map((n) =>
      s({ id: `n${n}`, row: n, bandKey: "nu", happenedAt: null }));
    expect(caseTopRows({ tracks, stops })).toHaveLength(4);
  });

  it("leaves out a row the axis could not place", () => {
    // A stop dated 1926 keeps its happenedAt and still lands in "onbekend".
    // Printing it would put a date on the landing page that the map itself
    // refused to file — and a stop with no date at all has nothing to show in a
    // list whose shape is datum · wat · spoor.
    const rows = caseTopRows({ tracks, stops: [
      s({ id: "typo", row: 0, bandKey: "onbekend",
        happenedAt: new Date("1926-08-20T10:00:00Z") }),
      s({ id: "undated", row: 1, bandKey: "onbekend", happenedAt: null }),
      s({ id: "real", row: 2 }),
    ] });
    expect(rows.map((r) => r.id)).toEqual(["real"]);
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(caseTopRows({ tracks, stops: [] })).toEqual([]);
  });
});
