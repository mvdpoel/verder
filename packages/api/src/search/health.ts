import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";

/**
 * The `worker_runs.worker` value written by the search.drain job in
 * apps/worker/src/search-drain.ts, and read back by index health on /verify.
 * Defined once, here, and imported by both — a typo on either side would make
 * a stalled index look healthy.
 */
export const DRAIN_WORKER_NAME = "search-drain";

// The drain job runs on a short cycle. Ten minutes of silence is a stalled
// index, not a slow minute.
export const DRAIN_STALE_MS = 10 * 60 * 1000;

// Below this the queue is simply working; above it, it is behind.
export const OUTBOX_WARN_DEPTH = 500;

export type IndexHealth = {
  chunks: number;
  outboxDepth: number;
  embedFailures: number;
  lastDrainAt: string | null;
  degraded: boolean;
};

/**
 * Read-only stats over the derived search tables. Deliberately NOT part of
 * runFullVerification: the index appends no ledger events, so its health is
 * reported BESIDE the chain checks and the nightly verifier stays untouched.
 * count(*)::int because postgres returns bigint as a string.
 */
export async function readIndexHealth(db: Db): Promise<IndexHealth> {
  const [chunks] = (await db.execute(sql`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE embedding IS NULL AND embed_attempts > 0))::int AS failures
    FROM search_chunks`)).rows as { total: number; failures: number }[];

  const [outbox] = (await db.execute(sql`
    SELECT count(*)::int AS depth FROM search_outbox`)).rows as { depth: number }[];

  const [drain] = (await db.execute(sql`
    SELECT ran_at FROM worker_runs
    WHERE worker = ${DRAIN_WORKER_NAME}
    ORDER BY ran_at DESC LIMIT 1`)).rows as { ran_at: string | Date }[];

  const lastDrainAt = drain ? new Date(drain.ran_at).toISOString() : null;
  const stale = lastDrainAt === null
    || Date.now() - Date.parse(lastDrainAt) > DRAIN_STALE_MS;

  return {
    chunks: chunks.total,
    outboxDepth: outbox.depth,
    embedFailures: chunks.failures,
    lastDrainAt,
    // One boolean the whole app can trust. The last run's status column is
    // deliberately not part of it: a drain that errors and keeps retrying shows
    // up here as embedFailures or a growing outbox, which is the thing that
    // actually costs Martin a result.
    degraded: stale || chunks.failures > 0 || outbox.depth > OUTBOX_WARN_DEPTH,
  };
}
