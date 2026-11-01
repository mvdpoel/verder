import { describe, expect, it } from "vitest";
import { isWeeklySummary } from "./weekly-summary";

const good = {
  week: "2026-W44", from: "2026-10-26", to: "2026-11-01", sent: 3, received: 7,
  filedByMartin: 2, filedByVerder: 3, tasksDone: 2, waiting: 4, topWaiting: [],
};

describe("isWeeklySummary", () => {
  it("accepts the stored shape", () => {
    expect(isWeeklySummary(good)).toBe(true);
  });

  it("refuses a row that is not a summary, so /weekly answers 404 rather than junk", () => {
    expect(isWeeklySummary(null)).toBe(false);
    expect(isWeeklySummary({ message: "boom" })).toBe(false);
    expect(isWeeklySummary({ ...good, week: "2026-44" })).toBe(false);
    expect(isWeeklySummary({ ...good, sent: -1 })).toBe(false);
    expect(isWeeklySummary({ ...good, received: "7" })).toBe(false);
    expect(isWeeklySummary({ ...good, topWaiting: undefined })).toBe(false);
  });
});
