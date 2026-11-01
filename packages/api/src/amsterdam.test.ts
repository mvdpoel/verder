import { describe, expect, it } from "vitest";
import {
  addDays, amsterdamAt, dayKey, isoWeekKey, monthIndex, monthKey, monthLabel, monthsBetween, weekBounds,
} from "./amsterdam";

describe("amsterdam calendar", () => {
  it("reads an instant as an Amsterdam calendar day", () => {
    // 22:30 UTC on 31 July is already 1 August in Amsterdam (CEST, +2).
    expect(dayKey(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08-01");
    expect(monthKey(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08");
  });

  it("names a month in Dutch", () => {
    expect(monthLabel("2026-08")).toBe("augustus 2026");
    expect(monthLabel("2026-01")).toBe("januari 2026");
  });

  it("lists every month from newest to oldest, gaps included", () => {
    expect(monthsBetween("2026-04", "2026-08"))
      .toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween("2025-11", "2026-02"))
      .toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });

  it("subtracts two months, across a year boundary and across centuries", () => {
    expect(monthIndex("2026-08") - monthIndex("2026-04")).toBe(4);
    expect(monthIndex("2026-02") - monthIndex("2025-11")).toBe(3);
    // The gap a mistyped year opens, which is what the map has to refuse.
    expect(monthIndex("2026-05") - monthIndex("1926-05")).toBe(1200);
  });
});

describe("amsterdam weeks", () => {
  it("week of a Sunday is the Monday before", () => {
    // 2026-11-01 is a Sunday.
    expect(weekBounds("2026-11-01")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    // A Monday is its own week's first day.
    expect(weekBounds("2026-10-26")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("week starting Thursday contains the Wednesday after", () => {
    // Thursday 2026-10-29 starts the week; Wednesday 2026-11-04 is its last day.
    expect(weekBounds("2026-11-04", 4)).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(weekBounds("2026-10-29", 4)).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(weekBounds("2026-11-05", 4)).toEqual({ from: "2026-11-05", to: "2026-11-11" });
    // A Sunday start (ISO 7).
    expect(weekBounds("2026-11-02", 7)).toEqual({ from: "2026-11-01", to: "2026-11-07" });
  });

  it("week across the DST change has seven days", () => {
    // 2026-10-25 is the Sunday the clocks go back: a 25-hour day. Day keys are
    // civil dates, so the week still spans exactly seven of them.
    const w = weekBounds("2026-10-25");
    expect(w).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    const days: string[] = [];
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) days.push(d);
    expect(days).toHaveLength(7);
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-03-29", -1)).toBe("2026-03-28");
  });

  it("isoWeekKey at year end", () => {
    expect(isoWeekKey("2026-12-31")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-03")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
    // 2024-12-30 is a Monday whose Thursday falls in 2025.
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2026-10-26")).toBe("2026-W44");
  });

  it("amsterdamAt is the instant of a whole hour on an Amsterdam day, either side of DST", () => {
    // Winter time (CET, +1): Sunday 18:00 is 17:00 UTC.
    expect(amsterdamAt("2026-11-01", 18).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    // Summer time (CEST, +2): 16:00 UTC.
    expect(amsterdamAt("2026-10-18", 18).toISOString()).toBe("2026-10-18T16:00:00.000Z");
    // The DST days themselves: 25-10 falls back at 03:00, 29-03 springs forward at 02:00.
    expect(amsterdamAt("2026-10-25", 18).toISOString()).toBe("2026-10-25T17:00:00.000Z");
    expect(amsterdamAt("2026-03-29", 18).toISOString()).toBe("2026-03-29T16:00:00.000Z");
    expect(amsterdamAt("2026-11-01", 0).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(() => amsterdamAt("2026-11-01", 24)).toThrow(RangeError);
  });
});
