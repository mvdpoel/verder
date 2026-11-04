import type { WaitingItem } from "./waiting";

/**
 * The Sunday summary (Plan 3 Task 26, spec §7.9) — the SHAPE only.
 *
 * It is composed by the worker (apps/worker/src/weekly-summary.ts), because
 * "received" needs `ownMailboxAddresses()` and `senderAddress`, which live only
 * there; it is stored as `worker_runs.detail.summary` on the `weekly-summary`
 * row, and read back by `dashboard.weekly` for `GET /api/mobile/v1/weekly`.
 * Writer and reader sit in different packages, so the type lives in this leaf
 * that both already depend on — a second spelling of a JSON contract is one
 * that drifts.
 *
 * Every count is an integer for ONE window, `[from, to)`: from the previous
 * Sunday 18:00 Amsterdam to the Sunday 18:00 the job ran at. Windows abut on
 * the run instant, so Sunday-evening activity lands in the NEXT summary rather
 * than in none (a Monday-to-Sunday window closed after its push had gone out).
 */
export interface WeeklySummary {
  /** ISO week key of the week whose Sunday closes the window, "2026-W44". */
  week: string;
  /**
   * The window as ISO-8601 UTC instants, half-open: "2026-10-25T17:00:00.000Z"
   * (Sunday 25-10 18:00 Amsterdam) up to, NOT including, "2026-11-01T17:00:00.000Z".
   */
  from: string;
  to: string;
  /** Outbound log entries (current versions), plus sent non-question proposals with no entry yet. */
  sent: number;
  /** Mail in the dossier whose sender is not Martin's own address. */
  received: number;
  /** Documents that moved INTO filed this week, by who moved them. */
  filedByMartin: number;
  filedByGrip: number;
  /** Tasks that got a `done` status change this week. */
  tasksDone: number;
  /** `loadWaiting().length` when the summary was composed. */
  waiting: number;
  /** The first three of that same list, in its order. Never in the push. */
  topWaiting: WaitingItem[];
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isInstant = (v: unknown) => typeof v === "string" && INSTANT.test(v) && !Number.isNaN(Date.parse(v));

/** True when `v` has the WeeklySummary shape — a stored row is read back, never trusted blind. */
export function isWeeklySummary(v: unknown): v is WeeklySummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const ints = ["sent", "received", "filedByMartin", "filedByGrip", "tasksDone", "waiting"];
  return typeof o.week === "string" && /^\d{4}-W\d{2}$/.test(o.week)
    && isInstant(o.from) && isInstant(o.to)
    && ints.every((k) => Number.isInteger(o[k]) && (o[k] as number) >= 0)
    && Array.isArray(o.topWaiting);
}
