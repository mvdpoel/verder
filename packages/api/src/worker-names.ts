/**
 * The `worker_runs.worker` strings that are written in one module and READ in
 * another. Nothing else lives here: no policy, no types, no imports — so any
 * module on either side of the wire can take a name without dragging a
 * dependency along with it.
 *
 * WHY A LEAF OF ITS OWN. Each of these names has a writer and a reader that
 * cannot see each other. `search-drain` is written by apps/worker's drain loop
 * and read back by index health on /verify AND by the dashboard taxonomy in
 * worker-health.ts; `search-rerank` is written by search/retrieve.ts on a
 * degraded rerank and read only by that same taxonomy, which classifies it as
 * an incident marker so one Ollama timeout cannot paint the tile red forever.
 * A name that must match in two files and is spelled twice is a rename waiting
 * to go silently wrong — and the failure is the worst kind, because a typo does
 * not throw: the reader simply finds no rows, and a stalled index or a dead
 * drain renders as calm.
 *
 * They cannot live in worker-health.ts, which is where the taxonomy would
 * naturally keep them, because search/health.ts now derives its own staleness
 * bound from `declFor(DRAIN_WORKER_NAME).everyMs` — so health.ts imports
 * worker-health.ts, and worker-health.ts importing the name back would be a
 * cycle that ACTUALLY BREAKS rather than one TypeScript merely dislikes: DECLS
 * uses the name as a computed key at module scope, so whichever module loads
 * second hits the temporal dead zone and throws at import time.
 */

/**
 * Written by apps/worker/src/search-drain.ts on every drain tick, and read by
 * BOTH readIndexHealth (search/health.ts, which judges index freshness) and the
 * dashboard taxonomy (worker-health.ts, which judges the watcher's pulse). Two
 * readers with two different tolerances over one row — see DRAIN_STALE_MS.
 */
export const DRAIN_WORKER_NAME = "search-drain";

/**
 * Written by search/retrieve.ts, and ONLY with status "error", when a deep
 * search's LLM rerank times out — the search itself still succeeds on the fused
 * order. No code path writes it "ok", which is exactly why worker-health.ts
 * declares it an incident marker rather than a worker with health.
 */
export const RERANK_WORKER_NAME = "search-rerank";

/**
 * Written by apps/worker/src/ops/mail-restore-drill.ts — the monthly restore
 * drill — and read back by the `monthly` declaration in worker-health.ts, which
 * is the ONLY durable surface a failed drill has: /verify renders the ledger
 * panel and index health and nothing else, and the push is one interruption that
 * is gone once it is dismissed.
 *
 * The name is spelled here rather than in either of them because they sit in
 * different packages and neither imports the other. A rename that missed the
 * other half would not throw — the dashboard would simply find no `mail-drill`
 * rows and show no tile, which is indistinguishable from a system that has no
 * restore drill at all. That is the silence the whole drill exists to end.
 */
export const MAIL_DRILL_WORKER_NAME = "mail-drill";
