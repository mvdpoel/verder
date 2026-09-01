/**
 * What a `worker_runs` row MEANS — the taxonomy the dashboard's "Systeem" panel
 * judges against, as a pure module with no database and no React.
 *
 * THE BUG THIS EXISTS TO FIX, measured on the homelab 2026-09-01: the panel
 * showed one row per worker and judged all fifteen with one rule —
 * `down = (now - ranAt > 15 min) || status !== "ok"`. All fifteen reported
 * status ok and NINE were drawn amber, purely on the age half. On that page
 * amber means "work waiting on Martin", so nine dots claimed attention while
 * nothing at all was wrong; it had been six two days earlier and drifted to
 * nine on its own. A wall of meaningless amber is what teaches a reader to stop
 * reading the panel — the same argument mail/poll.ts makes when it records a
 * rate-limit skip as `ok` rather than burying the failure that needs a human
 * under noise.
 *
 * The list holds five different kinds of thing and that rule fit only the
 * first. A KIND says HOW SILENCE IS READ, and nothing else:
 *
 *  - watcher    a scheduled cron. Silence IS failure.
 *  - nightly    the 03:30 host crontab. Stale ~21 h of every day BY DESIGN.
 *  - on-demand  runs when a job arrives. No cadence to be late against.
 *  - hand-run   an ops script somebody types. Silent for weeks by design.
 *  - retired    deliberately unscheduled, but can still be run by hand.
 *  - incident   written ONLY on failure; silence is health.
 *
 * A kind NEVER suppresses a failure the worker itself reported while that
 * failure is still ACTIONABLE — see workerState and ERROR_ACTIONABLE_MS. It
 * decides what to make of a worker that said nothing, and what to make of one
 * whose last word was a failure long enough ago to be history.
 */

import { DRAIN_WORKER_NAME, RERANK_WORKER_NAME } from "./worker-names";

export type WorkerKind =
  | "watcher"
  | "nightly"
  | "on-demand"
  | "hand-run"
  | "retired"
  | "incident";

/**
 * `ok` healthy · `down` needs a human · `idle` last ran then, no judgement ·
 * `off` not judged at all (retired, or an incident marker).
 *
 * `idle` and `off` are separate on purpose. `idle` still shows a last-run time
 * that means something ("the last email we mined was two days ago"); `off` says
 * the row is history and the worker is not part of current health.
 */
export type WorkerState = "ok" | "down" | "idle" | "off";

export interface WorkerDecl {
  kind: WorkerKind;
  /** The declared cron cadence, for watchers only. THE FACT, not the policy —
   *  copied from the `boss.schedule` call in apps/worker/src/index.ts. The
   *  tolerance is derived from it below rather than hand-picked per worker,
   *  because a table of hand-picked timeouts is precisely how one 15-minute
   *  threshold came to judge fifteen unlike things. */
  everyMs?: number;
}

const MINUTE = 60_000;

/**
 * How many ticks a watcher may miss before it is down. Three, so a single slow
 * minute — a GPU busy with an eval, a long drain, a poll that ran over its
 * minute — is never an alarm, while a genuinely dead watcher is caught within a
 * few minutes rather than the fifteen the old flat threshold gave the fast ones
 * and never gave the slow ones at all.
 */
const WATCHER_MISSED_TICKS = 3;

/**
 * A nightly job runs at 03:30 from the host crontab, so it is legitimately
 * ~21 h stale for most of the day. 26 h keeps it healthy until 05:30 the next
 * morning: two hours of slack absorb a slow night (nightly-verify walks the
 * whole ledger and every vault file) without ever hiding a job that skipped a
 * whole day, which is the failure that matters — a backup that did not run.
 */
const NIGHTLY_MAX_AGE_MS = 26 * 60 * MINUTE;

/**
 * How long a recorded failure stays ACTIONABLE. Past this the row is history,
 * and the worker's kind decides what its silence means as if the row had said
 * "ok" — which for a watcher still means down, and for a worker with no cadence
 * means idle.
 *
 * THE BUG THIS EXISTS TO PREVENT is the one this whole module was written to
 * remove, arriving from the other side. workerState judges the NEWEST
 * `worker_runs` row, and nothing replaces a row until the worker runs again —
 * for on-demand and hand-run, that is never. `ollama` records status "error" on
 * its 120 s timeout, measured at 14 of 32 docmeta calls while Ollama gets only
 * 7.53 of qwen3.5:9b's 10.01 GB into VRAM; `extract` records "error" on a
 * corrupt PDF, a Tesseract failure, or a workbook over readWorkbook's caps
 * (this repo ships committed dimension- and inflation-bomb fixtures for exactly
 * those). Treat any error as down forever and the FIRST such failure pins an
 * amber dot that NOTHING can clear — the precise shape of search-rerank, which
 * is written only on failure and sat red for a week. Replacing nine meaningless
 * ambers with one permanent one would leave the panel worse than it was.
 *
 * 26 h is the SAME NUMBER as NIGHTLY_MAX_AGE_MS and deliberately NOT the same
 * constant. They coincide; they are not one fact. NIGHTLY_MAX_AGE_MS is 03:30
 * plus two hours of slack, and moves if the host crontab moves. This one is "a
 * failure you could still do something about today": you open the dashboard
 * over coffee and last night's error is still standing there, whatever hour it
 * happened. Sharing a constant would retune this window silently the day
 * somebody reschedules the backup, which is the kind of coupling that makes a
 * threshold impossible to reason about later.
 */
const ERROR_ACTIONABLE_MS = 26 * 60 * MINUTE;

/**
 * The cadence assumed for a name this module has never heard of. Five minutes
 * × 3 = the 15-minute bound the panel used to apply to everything, so an
 * unclassified worker is judged exactly as it was before — no worker gets
 * QUIETER by this change without somebody writing down why.
 */
const DEFAULT_WATCHER_EVERY_MS = 5 * MINUTE;

/**
 * Every `worker_runs.worker` value written today, keyed by the RECORDED name —
 * which is not always the queue name: `mail.poll` records as `mail`, `nas.scan`
 * as `nas`, `docmeta.sweep` as `docmeta-sweep`, `registry.mine` as
 * `registry-mine`, `search.drain` as `search-drain`. Cadences come from the
 * matching `boss.schedule` line; the names come from the `recordRun` call
 * sites.
 */
const DECLS: Record<string, WorkerDecl> = {
  // ---- cron watchers. Silence IS failure. --------------------------------
  // `boss.schedule("mail.poll", "* * * * *")`. Note the poll writes NOTHING on
  // a single-flight skip, deliberately, so that a hung poll goes stale here
  // instead of emitting a healthy-looking row every minute — staleness is the
  // designed signal for "a poll is stuck" and this is the rule that reads it.
  mail: { kind: "watcher", everyMs: MINUTE },
  "docmeta-sweep": { kind: "watcher", everyMs: MINUTE },
  [DRAIN_WORKER_NAME]: { kind: "watcher", everyMs: MINUTE },
  nas: { kind: "watcher", everyMs: 2 * MINUTE },
  "registry-mine": { kind: "watcher", everyMs: 2 * MINUTE },
  heartbeat: { kind: "watcher", everyMs: 5 * MINUTE },

  // ---- nightly, from the HOST crontab at 03:30, not from pg-boss ---------
  "nightly-verify": { kind: "nightly" },
  "model-check": { kind: "nightly" },

  // ---- event-driven. Runs only when a job arrives. -----------------------
  // task-mine rides suggest.entry, which rides an arriving email; ollama is
  // written by suggestEntry/suggestDocMeta; extract by storeDocumentText.
  // task-mine has been silent for two days because no new mail reaches the
  // dossier — the MX still points at Gmail and gmail.poll is unscheduled, which
  // is phase 1's documented honest limit. It was amber BECAUSE the system works
  // as built, which is the clearest possible statement of what was wrong here.
  "task-mine": { kind: "on-demand" },
  ollama: { kind: "on-demand" },
  extract: { kind: "on-demand" },
  // NOT in the inventory this change started from, and the one that would have
  // sat amber longest: receipts.resolve is enqueued by registry.mine and only
  // for an aggregator line (APPLE.COM/BILL, PayPal), so on a quiet registry it
  // can legitimately go months without a row.
  receipts: { kind: "on-demand" },

  // ---- hand-run ops scripts. Silent for weeks by design. -----------------
  // `pnpm --filter worker <script>`, typed by a human during a deploy or a
  // repair. There is no schedule to be late against, so the panel shows when
  // each last ran and passes no judgement on the gap.
  "extract-texts": { kind: "hand-run" },
  reindex: { kind: "hand-run" },
  "case-history": { kind: "hand-run" },
  "backfill-message-ids": { kind: "hand-run" },
  "discard-signature-images": { kind: "hand-run" },

  // ---- retired ------------------------------------------------------------
  // Gmail polling is deliberately unscheduled (see index.ts): the account sat
  // in a rate limit that every attempt re-armed for another fifteen minutes,
  // and the ingest path moved to JMAP. The rate-limit row it left behind must
  // not be a standing alarm, because no action can clear it — restarting the
  // poller is exactly what nobody is going to do.
  //
  // Retired means UNSCHEDULED, not gone: `pnpm --filter worker backfill` calls
  // pollGmail and records under this same name, and boss.send("gmail.poll")
  // still runs one poll by hand. So the kind decides only what its SILENCE
  // means; a failure from a hand-run backfill is still shown while it is recent
  // (see workerState, and ERROR_ACTIONABLE_MS above).
  gmail: { kind: "retired" },

  // ---- incident markers ---------------------------------------------------
  /*
   * Rows written ONLY when something went wrong on an on-demand path. The
   * newest one is not "current health", it is "the last time this ever broke",
   * so reading it as health inverts the meaning of the whole panel.
   *
   * MEASURED, and it is why this classification exists: `search-rerank` is
   * written only by search/retrieve.ts, only with status "error", when a DEEP
   * search's LLM rerank times out (the search still succeeds — it falls back to
   * the fused order). No code path anywhere writes it "ok", and nothing in
   * apps/web ever requests `mode: "deep"`. So one transient Ollama timeout on
   * 2026-08-23 painted the tile red and NOTHING COULD EVER CLEAR IT: going
   * green needs a success row that no code writes, from a mode no surface
   * requests. It sat red for a week over an optional feature CLAUDE.md already
   * records as unproven ("Deep did NOT beat fast").
   *
   * `pg-boss` is the same shape and was missing from the old ad-hoc list:
   * `boss.on("error", …)` in index.ts is its only writer, always "error".
   *
   * The rows are still WRITTEN and still queryable — this is a display
   * decision, not a decision to stop recording. When a surface actually uses
   * deep search, the degradation belongs in that search's own result, where the
   * person who ran it will see it, not as a dot on a page they may not open for
   * days.
   */
  [RERANK_WORKER_NAME]: { kind: "incident" },
  "pg-boss": { kind: "incident" },
};

/**
 * How to read a worker's silence. An unknown name is a WATCHER, and THE FAILURE
 * DIRECTION IS THE WHOLE POINT: a name missing from the map costs one spurious
 * amber dot that a one-line declaration fixes, while defaulting to "idle" or
 * "off" would let a watcher added next month die completely unnoticed — the
 * panel would look perfect while ingestion was dead. Loud beats quiet, exactly
 * as the incident classification above is a DENYLIST of known markers and never
 * an allowlist of known watchers.
 */
export function declFor(worker: string): WorkerDecl {
  // Object.hasOwn, not `DECLS[worker] ?? default`. DECLS is an object literal,
  // so a `worker` of "constructor" or "toString" reaches Object.prototype and
  // comes back truthy — the `??` never fires, the caller gets a Function where
  // it expected a WorkerDecl, `decl.kind` is undefined, workerState falls off
  // the end of its switch and the dashboard draws a dot with no state at all.
  // `worker_runs.worker` is a free-text column filled in by recordRun call
  // sites, so this is one unlucky worker name away rather than an attack.
  return Object.hasOwn(DECLS, worker)
    ? DECLS[worker]
    : { kind: "watcher", everyMs: DEFAULT_WATCHER_EVERY_MS };
}

/**
 * The cadence a decl is judged against: what it declares, or the assumed
 * default for a name nobody has written down yet.
 *
 * Exported because search/health.ts needs the same FACT to build a different
 * POLICY on top of — see DRAIN_STALE_MS there. The cadence of search.drain is
 * stated once, in DECLS above, and the two pages that care about it each apply
 * their own multiplier in the open.
 */
export function cadenceMs(decl: WorkerDecl): number {
  return decl.everyMs ?? DEFAULT_WATCHER_EVERY_MS;
}

/**
 * The judgement, computed here and served as data so the web app never
 * recomputes it — a second copy of this rule in a React component is how the
 * two drift, and the drift is invisible until a dead watcher renders green.
 *
 * `status` is the raw `worker_runs.status` string rather than a union: it comes
 * straight off a query and anything that is not exactly "ok" is a failure.
 */
export function workerState(
  decl: WorkerDecl,
  status: string,
  ranAt: Date,
  now: number,
): WorkerState {
  const ageMs = now - ranAt.getTime();

  // An incident marker is decided before everything else, and it is now the
  // ONLY kind that is. Those rows are written exclusively on failure, so
  // "recent error" is their resting state and reading one as health inverts the
  // panel: search-rerank's single Ollama timeout on 2026-08-23 would be down
  // forever, because going green needs a success row that no code path writes.
  // Callers filter incident rows out of the list entirely — that is the
  // router's job, not this function's (see routers/dashboard.ts). A state is
  // returned anyway so this function is total and a caller that forgets to
  // filter degrades to "not judged" rather than to a false alarm.
  if (decl.kind === "incident") return "off";

  // A RECENT failure is down whatever the kind, retired included. A kind
  // decides how SILENCE is read; it never suppresses a failure the worker
  // actually reported while somebody could still act on it. Retired is inside
  // this rule and not before it because "will never run again" was never quite
  // true: `pnpm --filter worker backfill` (apps/worker/package.json →
  // ops/backfill-gmail.ts) calls pollGmail, which records under the name
  // `gmail` with status "error" on a per-message failure and on a 429, and
  // boss.send("gmail.poll") still runs a single poll by hand because the queue
  // and its worker stay registered. The person typing that backfill is the one
  // reader this panel has; showing them a calm grey "off" for the run they are
  // watching fail is the panel lying to the only person using it.
  if (status !== "ok" && ageMs <= ERROR_ACTIONABLE_MS) return "down";

  // Past the window the failure is history and the kind's ordinary rule takes
  // over. For retired that is "off" — the rate-limit wall that got gmail
  // unscheduled must never become a standing alarm, because the action that
  // would clear it is exactly the one nobody is going to take.
  if (decl.kind === "retired") return "off";

  // Everything below reads SILENCE, and an aged-out error is read as silence
  // too: the row is no longer news, and how long ago it was still is. A watcher
  // is down by cadence either way, so this changes nothing there; for the kinds
  // with no cadence it is the whole point — a failed extract from this morning
  // is amber and one from eleven days ago is honestly idle.
  switch (decl.kind) {
    case "watcher":
      return ageMs > cadenceMs(decl) * WATCHER_MISSED_TICKS ? "down" : "ok";
    case "nightly":
      return ageMs > NIGHTLY_MAX_AGE_MS ? "down" : "ok";
    // No cadence to be late against. The panel shows when these last ran and
    // says nothing more; there is no age at which their silence becomes news.
    case "on-demand":
    case "hand-run":
      return "idle";
  }
}
