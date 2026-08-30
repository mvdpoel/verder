import { describe, expect, it } from "vitest";
import { nextSelection } from "@/lib/files-selection";

const IDS = ["a", "b", "c", "d"];

describe("nextSelection", () => {
  it("toggles a single row on", () => {
    const next = nextSelection(new Set(), IDS, 1, null, false);
    expect(next).toEqual(new Set(["b"]));
  });

  it("toggles a single row off", () => {
    const next = nextSelection(new Set(["b"]), IDS, 1, null, false);
    expect(next).toEqual(new Set());
  });

  it("selects a forward shift range", () => {
    // anchor at "b" (index 1), shift-click "d" (index 3): b, c, d select.
    const next = nextSelection(new Set(), IDS, 3, 1, true);
    expect(next).toEqual(new Set(["b", "c", "d"]));
  });

  it("selects a backward shift range identically to the forward one", () => {
    // anchor at "d" (index 3), shift-click "b" (index 1): same span, b..d.
    const next = nextSelection(new Set(), IDS, 1, 3, true);
    expect(next).toEqual(new Set(["b", "c", "d"]));
  });

  it("falls back to a single-row toggle when shift has no anchor yet", () => {
    // The very first click on a fresh table: `last` is still null, so a
    // shift-click cannot know a range and must not invent one.
    const next = nextSelection(new Set(), IDS, 2, null, true);
    expect(next).toEqual(new Set(["c"]));
  });

  it("deselects a shift range when the clicked row was already selected", () => {
    // The spreadsheet rule: whether a shift-click adds or removes the span
    // is decided by the row just clicked, not by a fixed direction. Row "a"
    // is outside the span and must survive untouched.
    const next = nextSelection(new Set(["a", "b", "c", "d"]), IDS, 3, 1, true);
    expect(next).toEqual(new Set(["a"]));
  });
});
