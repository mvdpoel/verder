// Pure WSNP timeline derivation (no DB access). Milestones are a display aid —
// NOT ledgered; the underlying facts live in the logbook and vault. This module
// turns milestone rows into the six-stage dashboard strip plus the 18-month
// settlement countdown. It is total: any input renders without throwing.

export const WSNP_STAGES = [
  "application", "accepted", "onboarding", "wsnp-start", "settlement", "clean-slate",
] as const;

export type WsnpStage = (typeof WSNP_STAGES)[number];

/** Minimal shape deriveTimeline needs; DB milestone rows satisfy it. */
export interface MilestoneRow {
  stage: string;
  done: boolean;
  happenedAt: Date | null;
}

export interface TimelineStage<M extends MilestoneRow = MilestoneRow> {
  stage: string;
  state: "done" | "current" | "future" | "empty";
  milestones: M[];
}

export interface TimelineCountdown {
  endsAt: Date;
  daysLeft: number;
}

const DAY_MS = 86_400_000;
/** 18 months of settlement, as fixed in the design spec. */
const SETTLEMENT_DAYS = 547;

/**
 * Derive per-stage states and the settlement countdown.
 *
 * - A stage with no rows is "empty": rendered, but skipped when deriving
 *   done/current — an unstarted paperwork stage should not block the strip.
 * - "done" = has rows and all are done.
 * - "current" = the FIRST non-empty stage (fixed order) that is not all-done;
 *   every stage after it is "future" (spec rule — even if its rows are done).
 * - Countdown = earliest happenedAt among DONE "wsnp-start" milestones
 *   + 547 days; null while no such milestone exists. daysLeft is ceiled so a
 *   partial day still counts as a day of the settlement left.
 *
 * Grouping uses a Map keyed by stage: rows can only carry pgEnum stages in
 * production, but the function stays total for any string (prototype keys like
 * "constructor" must never throw — registry-status.ts lesson).
 */
export function deriveTimeline<M extends MilestoneRow>(
  rows: M[], now: Date,
): { stages: TimelineStage<M>[]; countdown: TimelineCountdown | null } {
  const byStage = new Map<string, M[]>(WSNP_STAGES.map((s) => [s, []]));
  for (const r of rows) byStage.get(r.stage)?.push(r);

  const currentIdx = WSNP_STAGES.findIndex((stage) => {
    const group = byStage.get(stage)!;
    return group.length > 0 && !group.every((m) => m.done);
  });

  const stages: TimelineStage<M>[] = WSNP_STAGES.map((stage, idx) => {
    const milestones = byStage.get(stage)!;
    let state: TimelineStage["state"];
    if (milestones.length === 0) state = "empty";
    else if (idx === currentIdx) state = "current";
    else if (currentIdx !== -1 && idx > currentIdx) state = "future";
    else state = "done"; // before current, or no current at all → all-done
    return { stage, state, milestones };
  });

  return { stages, countdown: deriveCountdown(rows, now) };
}

function deriveCountdown(rows: MilestoneRow[], now: Date): TimelineCountdown | null {
  const starts = rows
    .filter((r) => r.stage === "wsnp-start" && r.done && r.happenedAt !== null)
    .map((r) => r.happenedAt!.getTime());
  if (starts.length === 0) return null;
  const endsAt = new Date(Math.min(...starts) + SETTLEMENT_DAYS * DAY_MS);
  return { endsAt, daysLeft: Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS) };
}
