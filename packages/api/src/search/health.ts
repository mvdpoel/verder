import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { cadenceMs, declFor } from "../worker-health";
import { DRAIN_WORKER_NAME } from "../worker-names";

/**
 * Re-exported so the drain job and this reader still take the name from the
 * module they already import; it is DEFINED in ../worker-names.ts, which the
 * dashboard taxonomy reads too. See the note there for why it sits in a leaf.
 */
export { DRAIN_WORKER_NAME };

/**
 * How many drain cycles of silence mean the INDEX is stale. Ten, and this is a
 * POLICY that is deliberately looser than the dashboard's.
 *
 * THE BUG THIS SHAPE EXISTS TO FIX: this file used to hard-code 10 * 60 * 1000
 * while packages/api/src/worker-health.ts declared search.drain's cadence as
 * 60 s and judged it at three missed ticks. Two screens then disagreed about
 * one worker — a drain that died at 12:00 was "down" on the dashboard at 12:04
 * while /verify still printed its green "alles is doorzoekbaar" until 12:10 —
 * and neither number said which of them was the cadence and which the
 * tolerance, so a change to the schedule could only ever fix one of them.
 *
 * Unifying the NUMBERS would have been the wrong repair: the two pages want
 * different tolerances honestly. A dead watcher should be caught fast, because
 * the dashboard's job is to notice; index freshness can absorb a slow drain,
 * because /verify's job is to tell Martin whether what he searches is complete,
 * and a queue that is merely behind by a few minutes still answers his
 * question. So the FACT is stated once — the cadence, in worker-health.ts's
 * DECLS, copied from the boss.schedule call — and each page multiplies it by a
 * named tolerance of its own, in the open where a reader can see the choice.
 *
 * Ten ticks × 60 s reproduces the ten minutes this file has always used; if the
 * drain's schedule changes, both pages move with it and stay in proportion.
 */
const DRAIN_STALE_TICKS = 10;
export const DRAIN_STALE_MS = cadenceMs(declFor(DRAIN_WORKER_NAME)) * DRAIN_STALE_TICKS;

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
