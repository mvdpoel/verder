import { describe, expect, it } from "vitest";
import {
  noOpenTracksLine, stopHref, stopMark, stopWhenLabel, trackTerminus,
} from "@/lib/track-marks";

const stop = (over: Partial<Parameters<typeof stopMark>[0]> = {}) => ({
  state: "done" as const, isStation: false, isJunction: false,
  datesOutOfOrder: false, ...over,
});

describe("stopMark", () => {
  it("fills a stop that happened and outlines one that has not", () => {
    expect(stopMark(stop({ state: "done" })).fill).toBe("solid");
    expect(stopMark(stop({ state: "open" })).fill).toBe("hollow");
    expect(stopMark(stop({ state: "expected" })).fill).toBe("dashed");
  });

  it("never renders an expected stop as if it had happened", () => {
    // The whole reason the map is laid out structurally is that an expected
    // stop has no date. It must not look like a fact.
    const mark = stopMark(stop({ state: "expected" }));
    expect(mark.fill).not.toBe("solid");
  });

  it("draws a staged stop large and a plain one small", () => {
    expect(stopMark(stop({ isStation: true })).size).toBe("station");
    expect(stopMark(stop({ isStation: false })).size).toBe("stop");
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
    expect(stopWhenLabel({ state: "open", happenedAt: null, expectedAt: null }))
      .toBe("loopt nog");
    expect(stopWhenLabel({ state: "done", happenedAt: null, expectedAt: null }))
      .toBe("gebeurd");
    expect(stopWhenLabel({ state: "expected", happenedAt: null, expectedAt: null }))
      .toBe("verwacht");
  });

  it("adds the date when there is one, without changing the wording", () => {
    const d = new Date("2026-08-12T10:00:00Z");
    const stamp = d.toLocaleDateString("nl-NL");
    expect(stopWhenLabel({ state: "open", happenedAt: d })).toBe(`loopt nog · ${stamp}`);
    expect(stopWhenLabel({ state: "done", happenedAt: d })).toBe(`gebeurd · ${stamp}`);
    expect(stopWhenLabel({ state: "expected", happenedAt: null, expectedAt: d }))
      .toBe(`verwacht · ${stamp}`);
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
