/**
 * The `worker_runs.worker` value written by the search.drain job in
 * apps/worker/src/search-drain.ts, and read back by index health on /verify.
 * Defined once, here, and imported by both — a typo on either side would make
 * a stalled index look healthy.
 */
export const DRAIN_WORKER_NAME = "search-drain";
