// The app icon's number, kept true between alerts (spec §7.3, Plan 3 Task 5).
//
// Every alert already carries the badge (notify.ts reads `loadWaiting` itself),
// but most changes to what waits on Martin raise no alert at all: he approves a
// suggestion on the web, a task is marked done, a docmeta suggestion appears.
// The web app holds no pg-boss connection, so the worker checks every five
// minutes and tells the phone when the count moved.
//
// TWO PUSHES, NEVER ONE, because Apple says a background push must not carry a
// badge, throttles background pushes, and never delivers them to a force-quit
// app — while an alert-type push with only `aps.badge` updates the icon even
// then:
//   1. the badge:   apns-push-type alert, priority 5, `{ aps: { badge: N } }` —
//      no alert, no sound, so nothing lights up or makes a noise;
//   2. the refresh: apns-push-type background, priority 5,
//      `{ aps: { "content-available": 1 } }` — refreshes the widget snapshot and
//      the inbox cache when iOS allows it. Nothing depends on it arriving.
//
// Neither is a notification: no `notifications` row, no ledger event. The run
// row carries the counts, one per tick whether or not anything was sent,
// because this is a watcher and its silence must mean failure.
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { BADGE_SYNC_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "./heartbeat";
import type { ApnsRaw } from "./notify/apns";
import { countWaiting, type PushCounts } from "./notify/notify";

export const BADGE_PUSH = (count: number): ApnsRaw =>
  ({ pushType: "alert", priority: 5, payload: { aps: { badge: count } } });

export const REFRESH_PUSH: ApnsRaw =
  { pushType: "background", priority: 5, payload: { aps: { "content-available": 1 } } };

export interface BadgeSyncDeps {
  push: (raw: ApnsRaw) => Promise<PushCounts>;
  /** Defaults to `countWaiting` — THE one definition (spec §12.9). */
  count?: (db: Db) => Promise<number>;
}

/**
 * The count the phone was last told. Read from the newest `ok` row only: a tick
 * whose badge push reached no device records `error`, so the next tick sees the
 * count as untold and tries again instead of leaving a stale icon until the
 * count happens to move.
 */
async function previousCount(db: Db): Promise<number | null> {
  const [row] = await db.select({ detail: schema.workerRuns.detail }).from(schema.workerRuns)
    .where(and(eq(schema.workerRuns.worker, BADGE_SYNC_WORKER_NAME), eq(schema.workerRuns.status, "ok")))
    .orderBy(desc(schema.workerRuns.ranAt), desc(schema.workerRuns.id)).limit(1);
  const c = (row?.detail as { count?: unknown } | null | undefined)?.count;
  return typeof c === "number" ? c : null;
}

export async function syncBadge(db: Db, deps: BadgeSyncDeps): Promise<{ count: number; sent: boolean }> {
  const count = await (deps.count ?? countWaiting)(db);
  const previous = await previousCount(db);
  if (previous === count) {
    await recordRun(db, BADGE_SYNC_WORKER_NAME, "ok", { count, sent: false, delivered: 0, failed: 0, skipped: 0 });
    return { count, sent: false };
  }

  const badge = await deps.push(BADGE_PUSH(count));
  const refresh = await deps.push(REFRESH_PUSH);
  // Only the badge push decides: the refresh is best-effort by design. A badge
  // that reached no device although there were devices to try is an error, so
  // it is retried next tick; no device at all is nothing to retry.
  const untold = badge.delivered === 0 && badge.failed + badge.skipped > 0;
  await recordRun(db, BADGE_SYNC_WORKER_NAME, untold ? "error" : "ok", {
    count, sent: true,
    delivered: badge.delivered + refresh.delivered,
    failed: badge.failed + refresh.failed,
    skipped: badge.skipped + refresh.skipped,
  });
  return { count, sent: true };
}
