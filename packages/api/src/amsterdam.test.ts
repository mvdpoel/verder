import { describe, expect, it } from "vitest";
import { dayKey, monthIndex, monthKey, monthLabel, monthsBetween } from "./amsterdam";

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
