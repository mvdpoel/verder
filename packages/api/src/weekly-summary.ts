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
 * Every count is an integer for ONE ISO week, Monday to Sunday in Amsterdam.
 */
export interface WeeklySummary {
  /** ISO week key, "2026-W44". */
  week: string;
  /** Amsterdam day keys, Monday and Sunday: "2026-10-26" … "2026-11-01". */
  from: string;
  to: string;
  /** Outbound log entries (current versions), plus sent non-question proposals with no entry yet. */
  sent: number;
  /** Mail in the dossier whose sender is not Martin's own address. */
  received: number;
  /** Documents that moved INTO filed this week, by who moved them. */
  filedByMartin: number;
  filedByVerder: number;
  /** Tasks that got a `done` status change this week. */
  tasksDone: number;
  /** `loadWaiting().length` when the summary was composed. */
  waiting: number;
  /** The first three of that same list, in its order. Never in the push. */
  topWaiting: WaitingItem[];
}

/** True when `v` has the WeeklySummary shape — a stored row is read back, never trusted blind. */
export function isWeeklySummary(v: unknown): v is WeeklySummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const ints = ["sent", "received", "filedByMartin", "filedByVerder", "tasksDone", "waiting"];
  return typeof o.week === "string" && /^\d{4}-W\d{2}$/.test(o.week)
    && typeof o.from === "string" && typeof o.to === "string"
    && ints.every((k) => Number.isInteger(o[k]) && (o[k] as number) >= 0)
    && Array.isArray(o.topWaiting);
}
