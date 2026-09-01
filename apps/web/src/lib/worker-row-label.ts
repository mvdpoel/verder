import { dayKey } from "@verder/api/src/amsterdam";
import type { WorkerKind, WorkerState } from "@verder/api/src/worker-health";

/**
 * One served row of dashboard.stats().lastWorkerRuns, minus its name.
 *
 * The label reads FOUR fields and takes them as one object rather than as four
 * positional arguments, because three of them are strings — `kind`, `state` and
 * the raw `status` — and two of those are unions with overlapping members
 * ("ok" is a valid WorkerState AND the healthy status). Positionally, a
 * transposed pair type-checks and silently mislabels every row on the panel.
 */
export interface WorkerRow {
  kind: WorkerKind;
  state: WorkerState;
  /** The raw `worker_runs.status`. Anything that is not exactly "ok" failed. */
  status: string;
  ranAt: Date;
}

/**
 * The right-hand line of a "Systeem" row: what kind of thing this is, whether
 * it is currently broken, and when it last reported.
 *
 * THREE THINGS THIS FIXES, all measured on the panel it replaces.
 *
 * 1. A GREY DOT NEEDS A REASON. The taxonomy in worker-health.ts draws
 *    `idle` and `off` rows in neutral grey precisely because they have no
 *    cadence to be late against — but a grey dot with a bare timestamp beside
 *    it reads as "something is wrong here and nobody is saying what". The kind
 *    is the missing half of the sentence: `op aanvraag` says the silence is the
 *    absence of work, not the absence of a worker.
 *
 * 2. A DATE, NEVER A CLOCK, ONCE THE RUN IS NOT FROM TODAY. The old panel
 *    called `toLocaleTimeString`, so an eleven-day-old `case-history` run
 *    rendered as `laatst 21:03` — which every reader parses as minutes ago.
 *    That is a large part of what made the panel misleading even where its
 *    colour happened to be right.
 *
 * 3. AN AMBER DOT NEEDS A REASON TOO, and a dot carries one bit. When
 *    registry.mine hits an LLM failure it records `error` and turns amber
 *    beside a timestamp forty seconds old — and a reader who has just been
 *    taught that amber means "stale" reads a fresh time next to an amber dot as
 *    the panel glitching, and stops trusting it. That is the exact reader
 *    behaviour this whole slice exists to prevent, so `fout ·` is prefixed to
 *    say which of the two amber causes this is. The router already returned
 *    `status`; it was simply never drawn.
 *
 * Watchers and nightly jobs get NO kind word. Their cadence is the default
 * reading of this panel and the dot already carries the whole judgement; a
 * label on the two kinds that are actually being judged would be noise on
 * thirteen rows to explain three.
 *
 * Amsterdam, not the server's zone: the containers run UTC, so a 23:58 CEST run
 * read at 00:05 CEST is the same UTC day and a UTC "is it today?" would print a
 * clock time for a run that happened yesterday — the exact misreading above,
 * reintroduced for two hours every night.
 */
export function workerRowLabel(row: WorkerRow, now: number): string {
  const when = whenLabel(row.ranAt, now);
  /*
   * A REPORTED FAILURE OUTRANKS THE KIND WORD, AND ONLY WHILE IT IS STILL THE
   * REASON THE ROW IS AMBER.
   *
   * The gate is `state === "down"`, not `status !== "ok"`, and the difference
   * is the whole decision. A failed status ARRIVES HERE ON ROWS THE PANEL IS
   * NOT POINTING AT, because workerState ages an error out after
   * ERROR_ACTIONABLE_MS (26 h): an eleven-day-old reindex crash comes back as
   * `idle` with status "error" still sitting on the row, and the retired
   * `gmail` row — whose last act WAS the failure that got it unscheduled —
   * comes back as `off`. A status-only rule here would print `fout` on that
   * gmail row forever, reinstating exactly the permanent red the taxonomy was
   * written to remove: no action clears it, because restarting the poller is
   * precisely what nobody is going to do.
   *
   * Those read as their kind instead. The word "fout" belongs to the actionable
   * case ALONE: this label's job is to explain the dot beside it, and "fout"
   * next to a neutral grey dot is the same mismatch as a fresh timestamp next
   * to an amber one, only inverted — it teaches the same distrust. And the
   * panel answers "what needs me NOW"; an eleven-day-old failure needs nobody
   * today, and rows that claim attention they do not deserve are how nine amber
   * dots came to mean nothing. The mirror case is worth stating too: a retired
   * worker run BY HAND today and failing is `down` — deliberately, per
   * workerState — and it says `fout`, because the one reader this panel has is
   * the person watching that run.
   *
   * WHAT AGES OUT IS THE URGENCY, NOT THE FACT. The dot goes grey, because a
   * failure from last month needs nobody today and rows claiming attention they
   * do not deserve are how nine amber dots came to mean nothing. The WORD stays:
   * the date is prefixed `fout` instead of `laatst`, so an aged-out failure is
   * still legible as a failure while sitting quietly.
   *
   * An earlier version of this comment said the history was safe because
   * "/verify is the surface for old failures". IT IS NOT, and the claim was
   * checked rather than trusted: apps/web/src/app/(app)/verify/page.tsx renders
   * the ledger panel and the index-health card and nothing else, and a grep for
   * worker_runs across apps/web and packages/api finds the dashboard router as
   * the ONLY reader of `status` anywhere in the application. Dropping the word
   * would therefore have made an eleven-day-old extract failure visible in
   * precisely one place: a psql prompt. Hence the prefix.
   *
   * Reading `state` rather than re-deriving any of this also keeps the single
   * source of truth intact: the judgement is made once in worker-health.ts and
   * served as data, and a second copy of the rule in the web app is how the two
   * drift, invisibly, until a dead watcher renders green.
   */
  // `fout` REPLACES `laatst`, it is not a third segment. The column must not
  // wrap, and one word carrying both "when" and "how it went" keeps every row
  // to at most two segments whatever its kind. It is driven by `status` alone,
  // so a failure stays legible after its urgency has aged out — the dot, driven
  // by `state`, is what stops claiming your attention.
  const last = row.status !== "ok" ? `fout ${when}` : `laatst ${when}`;
  if (row.state === "down" && row.status !== "ok") {
    // Deliberately WITHOUT the kind word, even for a hand-run script. The kind
    // exists to explain a grey dot — silence on something nobody scheduled is
    // not news — and this row is amber for a stated reason. One reason per row,
    // and two segments instead of three in a column that must not wrap.
    return last;
  }
  switch (row.kind) {
    case "watcher":
    case "nightly":
      return last;
    case "on-demand":
      return `op aanvraag · ${last}`;
    case "hand-run":
      return `met de hand · ${last}`;
    case "retired":
      return `uit · ${last}`;
    // Filtered out of the list by dashboard.stats, because the newest row of a
    // failure-only marker is "the last time this ever broke" and not current
    // health. Labelled anyway so this function is total over WorkerKind: a
    // caller that forgets to filter must degrade to an honest sentence rather
    // than to a row that reads like a heartbeat.
    case "incident":
      return `laatste storing ${when}`;
  }
}

const TIME_FMT = new Intl.DateTimeFormat("nl-NL", {
  timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * `HH:MM` for a run from today, `dd-MM` for an older one, `dd-MM-yyyy` once the
 * year differs too. The year is spelled in full rather than abbreviated because
 * a row this old is rare enough that four characters cost nothing, and `30-12-25`
 * is ambiguous with a day-month-year read of `30-12` in a Dutch date format.
 *
 * Built from `dayKey`'s "YYYY-MM-DD" rather than a second Intl format, so the
 * string that is COMPARED and the string that is PRINTED come from one
 * Amsterdam rendering of the date and cannot disagree at a boundary.
 */
function whenLabel(ranAt: Date, now: number): string {
  const day = dayKey(ranAt);
  const today = dayKey(new Date(now));
  if (day === today) return TIME_FMT.format(ranAt);
  const [y, m, d] = day.split("-");
  return y === today.slice(0, 4) ? `${d}-${m}` : `${d}-${m}-${y}`;
}
