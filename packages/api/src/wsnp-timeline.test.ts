import { describe, expect, it } from "vitest";
import { WSNP_STAGES, deriveTimeline, type MilestoneRow } from "./wsnp-timeline";

// Pure timeline derivation (design spec, sub-project 3):
// - stage with no rows → "empty" (rendered, skipped in done/current derivation)
// - "done" = has rows, all done
// - "current" = first non-empty stage (fixed order) not all-done
// - stages after current → "future" (empty stays "empty")
// - countdown = earliest happenedAt among DONE wsnp-start milestones + 547 days

const DAY_MS = 86_400_000;

const row = (over: Partial<MilestoneRow> & { stage: string }): MilestoneRow => ({
  done: false,
  happenedAt: null,
  ...over,
});

const stateOf = (result: ReturnType<typeof deriveTimeline>, stage: string) =>
  result.stages.find((s) => s.stage === stage)?.state;

describe("WSNP_STAGES", () => {
  it("is the fixed six-stage order", () => {
    expect([...WSNP_STAGES]).toEqual([
      "application", "accepted", "onboarding", "wsnp-start", "settlement", "clean-slate",
    ]);
  });
});

describe("deriveTimeline — stage states", () => {
  it("empty input: all six stages rendered as empty, countdown null", () => {
    const result = deriveTimeline([], new Date("2026-08-19T00:00:00Z"));
    expect(result.stages.map((s) => s.stage)).toEqual([...WSNP_STAGES]);
    expect(result.stages.map((s) => s.state)).toEqual(
      ["empty", "empty", "empty", "empty", "empty", "empty"]);
    expect(result.stages.every((s) => s.milestones.length === 0)).toBe(true);
    expect(result.countdown).toBeNull();
  });

  it("mixed done/pending picks the first non-empty not-all-done stage as current", () => {
    const rows = [
      row({ stage: "application", done: true }),
      row({ stage: "application", done: true }),
      row({ stage: "accepted", done: true }),
      row({ stage: "accepted", done: false }), // ← first not-all-done
      // onboarding: empty (skipped in derivation, rendered as empty)
      row({ stage: "wsnp-start", done: true }), // after current → future, even though done
    ];
    const result = deriveTimeline(rows, new Date("2026-08-19T00:00:00Z"));
    expect(stateOf(result, "application")).toBe("done");
    expect(stateOf(result, "accepted")).toBe("current");
    expect(stateOf(result, "onboarding")).toBe("empty");
    expect(stateOf(result, "wsnp-start")).toBe("future");
    expect(stateOf(result, "settlement")).toBe("empty");
    expect(stateOf(result, "clean-slate")).toBe("empty");
  });

  it("empty first stage is skipped: current lands on the first stage with rows", () => {
    const result = deriveTimeline([row({ stage: "accepted", done: false })],
      new Date("2026-08-19T00:00:00Z"));
    expect(stateOf(result, "application")).toBe("empty");
    expect(stateOf(result, "accepted")).toBe("current");
    expect(stateOf(result, "onboarding")).toBe("empty");
  });

  it("all stages done → every non-empty stage done, none current", () => {
    const rows = WSNP_STAGES.map((stage) => row({ stage, done: true }));
    const result = deriveTimeline(rows, new Date("2026-08-19T00:00:00Z"));
    expect(result.stages.map((s) => s.state)).toEqual(
      ["done", "done", "done", "done", "done", "done"]);
    expect(result.stages.some((s) => s.state === "current")).toBe(false);
  });

  it("groups each milestone under its own stage, preserving input order", () => {
    const a = row({ stage: "application", done: true });
    const b = row({ stage: "application", done: false });
    const c = row({ stage: "settlement", done: false });
    const result = deriveTimeline([a, c, b], new Date("2026-08-19T00:00:00Z"));
    expect(result.stages.find((s) => s.stage === "application")?.milestones).toEqual([a, b]);
    expect(result.stages.find((s) => s.stage === "settlement")?.milestones).toEqual([c]);
  });

  it("is total: unknown/prototype stage names never throw and never appear", () => {
    const rows = [
      row({ stage: "constructor", done: true }),
      row({ stage: "__proto__", done: false }),
      row({ stage: "toString", done: false }),
      row({ stage: "no-such-stage", done: true }),
    ];
    const result = deriveTimeline(rows, new Date("2026-08-19T00:00:00Z"));
    expect(result.stages.map((s) => s.stage)).toEqual([...WSNP_STAGES]);
    expect(result.stages.every((s) => s.milestones.length === 0)).toBe(true);
    expect(result.stages.every((s) => s.state === "empty")).toBe(true);
  });
});

describe("deriveTimeline — settlement countdown", () => {
  it("adds exactly 547 days to the done wsnp-start happenedAt and ceils daysLeft", () => {
    const happenedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-10T12:00:00Z"); // 9.5 days in
    const result = deriveTimeline(
      [row({ stage: "wsnp-start", done: true, happenedAt })], now);
    expect(result.countdown).not.toBeNull();
    expect(result.countdown!.endsAt.getTime()).toBe(happenedAt.getTime() + 547 * DAY_MS);
    // 547 - 9.5 = 537.5 → ceil → 538
    expect(result.countdown!.daysLeft).toBe(538);
  });

  it("uses the EARLIEST happenedAt among done wsnp-start milestones", () => {
    const early = new Date("2026-01-01T00:00:00Z");
    const late = new Date("2026-03-01T00:00:00Z");
    const result = deriveTimeline([
      row({ stage: "wsnp-start", done: true, happenedAt: late }),
      row({ stage: "wsnp-start", done: true, happenedAt: early }),
    ], new Date("2026-01-01T00:00:00Z"));
    expect(result.countdown!.endsAt.getTime()).toBe(early.getTime() + 547 * DAY_MS);
    expect(result.countdown!.daysLeft).toBe(547);
  });

  it("ignores non-done wsnp-start rows", () => {
    const result = deriveTimeline([
      row({ stage: "wsnp-start", done: false, happenedAt: new Date("2026-01-01T00:00:00Z") }),
    ], new Date("2026-08-19T00:00:00Z"));
    expect(result.countdown).toBeNull();
  });

  it("ignores done wsnp-start rows without a happenedAt", () => {
    const result = deriveTimeline([
      row({ stage: "wsnp-start", done: true, happenedAt: null }),
    ], new Date("2026-08-19T00:00:00Z"));
    expect(result.countdown).toBeNull();
  });

  it("ignores done milestones of other stages", () => {
    const result = deriveTimeline([
      row({ stage: "settlement", done: true, happenedAt: new Date("2026-01-01T00:00:00Z") }),
    ], new Date("2026-08-19T00:00:00Z"));
    expect(result.countdown).toBeNull();
  });
});
