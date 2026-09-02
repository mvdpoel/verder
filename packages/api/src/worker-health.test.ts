import { describe, expect, it } from "vitest";
import { cadenceMs, declFor, workerState } from "./worker-health";
import { MAIL_BACKUP_WORKER_NAME, MAIL_DRILL_WORKER_NAME } from "./worker-names";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const agoMs = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The state of a real worker name as of `now`, exactly as the router reads it. */
const state = (worker: string, status: string, ranAt: Date) =>
  workerState(declFor(worker), status, ranAt, NOW);

describe("workerState — watchers", () => {
  it("is ok inside three ticks and down outside them", () => {
    // search.drain runs every 60 s. Two missed minutes is a slow GPU or a long
    // drain, not an outage; four is a dead watcher.
    expect(state("search-drain", "ok", agoMs(2 * MIN))).toBe("ok");
    expect(state("search-drain", "ok", agoMs(4 * MIN))).toBe("down");
  });

  it("scales the tolerance with the declared cadence, so heartbeat gets 15 minutes", () => {
    // THE BUG THIS PINS: one hand-picked 15-minute threshold judged every row.
    // The heartbeat's own cadence is 300 s, so 12 minutes of silence is two
    // missed ticks and healthy, while 20 minutes is four and genuinely dead —
    // and the same multiplier gives search-drain four minutes, not fifteen.
    expect(declFor("heartbeat").everyMs).toBe(5 * MIN);
    expect(state("heartbeat", "ok", agoMs(12 * MIN))).toBe("ok");
    expect(state("heartbeat", "ok", agoMs(20 * MIN))).toBe("down");
  });

  it("reads a recorded error as down however fresh the row is", () => {
    expect(state("mail", "error", agoMs(1_000))).toBe("down");
  });
});

describe("workerState — nightly jobs", () => {
  it("tolerates a full day of silence and fails a skipped night", () => {
    // 03:30 from the host crontab: stale ~21 h of every day BY DESIGN, which is
    // why the old 15-minute rule drew both of these amber every afternoon.
    expect(state("nightly-verify", "ok", agoMs(20 * HOUR))).toBe("ok");
    expect(state("model-check", "ok", agoMs(20 * HOUR))).toBe("ok");
    expect(state("nightly-verify", "ok", agoMs(30 * HOUR))).toBe("down");
  });

  it("still reports a failed verification as down", () => {
    expect(state("nightly-verify", "error", agoMs(HOUR))).toBe("down");
  });

  /*
   * THE MAIL BACKUP, and the hole it closes is the reason this declaration
   * exists at all. ops/mail-backup.sh wrote NO worker_runs row and had no entry
   * in the taxonomy, and it is the LAST step of ops/nightly.sh — so
   * nightly-verify and model-check have already written their green rows by the
   * time it starts. The monthly drill did not cover it either:
   * ops/mail-restore-drill.sh takes the newest archive by mtime and never asks
   * how old it is. A night where the 5.59 GB snapshot failed WOULD therefore have
   * left the panel entirely green, and stayed green for fourteen days until `find
   * -mtime +14 -delete` took the last archive and the drill failed with nothing
   * left to restore. The conditional is deliberate: the backup first ran from
   * cron on 2026-09-02, so no such fortnight was ever observed.
   */
  describe("the mail backup", () => {
    it("is nightly, like the two jobs it runs beside in the same cron entry", () => {
      // It IS the same 03:30 UTC run — the last step of ops/nightly.sh — so its
      // silence reads exactly as nightly-verify's does. A kind states HOW
      // SILENCE IS READ and nothing else, and this one already fits: no new kind
      // was invented for it.
      expect(declFor("mail-backup")).toEqual({ kind: "nightly" });
      // THE NAME is one constant, spelled in worker-names.ts, because its writer
      // (apps/worker/src/ops/mail-backup-run.ts) and its reader (this module)
      // are in different packages. A rename that missed one half would not
      // throw: the panel would find no rows and show no tile, which is
      // indistinguishable from a system that has no mail backup.
      expect(MAIL_BACKUP_WORKER_NAME).toBe("mail-backup");
      expect(declFor(MAIL_BACKUP_WORKER_NAME).kind).toBe("nightly");
    });

    it("tolerates a full day of silence and fails a skipped night", () => {
      // ~21 h stale for most of every day BY DESIGN, and a night that was
      // skipped is the failure that matters — a backup that did not run.
      expect(state("mail-backup", "ok", agoMs(20 * HOUR))).toBe("ok");
      expect(state("mail-backup", "ok", agoMs(30 * HOUR))).toBe("down");
    });

    it("reports a failed backup from this morning as down", () => {
      // The whole point: a tar that died at 03:35 is amber over coffee instead
      // of a line in a cron log nobody reads.
      expect(state("mail-backup", "error", agoMs(2 * HOUR))).toBe("down");
    });

    it("needs no error window of its own, because the two rules agree", () => {
      // The monthly drill needed errorActionableMs: its next run is a MONTH
      // away, so ageing its failure out at 26 h would report a healthy backup
      // for twenty-nine days. This one runs again tonight — past 26 h the
      // default drops it through to the `nightly` silence rule, which also says
      // down. There is no age at which a failed backup quietly turns green.
      expect(declFor("mail-backup").errorActionableMs).toBeUndefined();
      expect(state("mail-backup", "error", agoMs(27 * HOUR))).toBe("down");
      expect(state("mail-backup", "error", agoMs(9 * DAY))).toBe("down");
    });

    it("is NOT judged as a watcher, which is what an undeclared name would be", () => {
      // declFor defaults an unknown name to a watcher at 5 min × 3, so a nightly
      // job with no declaration is amber for roughly 23 hours out of every 24 —
      // the permanent-amber problem this module exists to remove, arriving
      // through its own front door. The counterfactual is asserted rather than
      // described: a name one typo away IS down at four hours, and would be
      // down forever.
      expect(declFor("mail-backup").everyMs).toBeUndefined();
      expect(state("mail-backup", "ok", agoMs(4 * HOUR))).toBe("ok");
      expect(state("mail-bakcup", "ok", agoMs(4 * HOUR))).toBe("down");
    });

    it("puts its line at exactly 26 hours, inclusive, like every nightly job", () => {
      // Spelled out and deliberately not imported: a boundary test that reads
      // the constant it pins proves only that arithmetic works. Move this number
      // down and the tile turns amber every night before the 03:30 run clears
      // it; move it past 27 h and a backup that skipped a whole night reports
      // healthy — a page claiming the mail store is backed up when it is not.
      expect(state("mail-backup", "ok", agoMs(26 * HOUR))).toBe("ok");
      expect(state("mail-backup", "ok", agoMs(26 * HOUR + 1))).toBe("down");
    });
  });
});

describe("workerState — silence that is not failure", () => {
  it("leaves an event-driven worker idle after two days of no mail", () => {
    // task-mine rides suggest.entry, which rides an arriving email. It has been
    // silent for two days because the MX still points at Gmail and gmail.poll
    // is unscheduled — phase 1's documented honest limit. It is quiet BECAUSE
    // the system is behaving as built, and an alarm here is a lie.
    expect(state("task-mine", "ok", agoMs(2 * DAY))).toBe("idle");
    expect(state("ollama", "ok", agoMs(2 * DAY))).toBe("idle");
    expect(state("extract", "ok", agoMs(2 * DAY))).toBe("idle");
  });

  it("leaves a hand-run ops script idle after eleven days", () => {
    expect(state("case-history", "ok", agoMs(11 * DAY))).toBe("idle");
    expect(state("reindex", "ok", agoMs(11 * DAY))).toBe("idle");
    expect(state("extract-texts", "ok", agoMs(11 * DAY))).toBe("idle");
  });

  it("still reports a hand-run script that failed THIS MORNING as down", () => {
    // A kind decides how SILENCE is read. It never suppresses a failure the
    // worker itself reported while that failure is still worth acting on: a
    // reindex that died two hours ago is a broken search index whether or not
    // anything was due to run it. What it no longer does is carry that verdict
    // forever — see "an error ages out" below, which is the same rule read from
    // the other end.
    expect(state("reindex", "error", agoMs(2 * HOUR))).toBe("down");
    expect(state("backfill-message-ids", "error", agoMs(HOUR))).toBe("down");
  });
});

describe("workerState — retired and incident", () => {
  /*
   * GMAIL IS A WATCHER AGAIN as of 2026-09-02, and this test guards the MOVE
   * rather than the cadence. It was `retired` while the poll was unscheduled —
   * silence was health, because nobody was going to restart it and a red dot no
   * action can clear is worse than no dot. The poll is scheduled again as a
   * bridge until the MX moves, so silence is failure again.
   *
   * Left declared retired, a Gmail poller that died — an expired refresh token,
   * a fresh rate limit, a crash loop — would render as a calm grey "off" for as
   * long as it took somebody to notice by hand that the dossier had stopped
   * growing. That is the blindness this whole module exists to remove, arriving
   * through the one kind whose purpose is to say nothing.
   */
  it("judges gmail as a scheduled watcher now that the poll is back", () => {
    expect(declFor("gmail").kind).toBe("watcher");
    expect(cadenceMs(declFor("gmail"))).toBe(15 * MIN);
    // Three missed quarter-hours is dead, not slow.
    expect(state("gmail", "ok", agoMs(30 * MIN))).toBe("ok");
    expect(state("gmail", "ok", agoMs(3 * DAY))).toBe("down");
    expect(state("gmail", "error", agoMs(3 * DAY))).toBe("down");
  });

  /*
   * NOTHING IS DECLARED `retired` TODAY — gmail was its only member — so the
   * kind is exercised through declFor's shape rather than through a live name.
   * It is kept because it is the right reading for a worker switched off on
   * purpose, and because removing a WorkerKind member reaches further than it
   * looks: worker-row-label.ts switches exhaustively over the union and only
   * `next build` typechecks it.
   */
  it("still reads a retired worker's silence as health, and a fresh failure as news", () => {
    const retired = { kind: "retired" } as const;
    expect(workerState(retired, "ok", new Date(NOW - 3 * DAY), NOW)).toBe("off");
    expect(workerState(retired, "error", new Date(NOW - 3 * DAY), NOW)).toBe("off");
    // A recent failure outranks the kind, retired included: somebody running it
    // by hand and watching it fail is the one reader this panel has.
    expect(workerState(retired, "error", new Date(NOW - 1_000), NOW)).toBe("down");
    expect(workerState(retired, "error", new Date(NOW - 2 * HOUR), NOW)).toBe("down");
  });

  it("classifies incident markers so the router can filter them", () => {
    expect(declFor("search-rerank").kind).toBe("incident");
    expect(declFor("pg-boss").kind).toBe("incident");
    expect(state("search-rerank", "error", agoMs(9 * DAY))).toBe("off");
  });
});

describe("declFor — unknown names", () => {
  it("treats an unknown worker as a watcher and lets it go down", () => {
    // LOUD BEATS QUIET. A name missing from the map costs one spurious amber
    // dot that a one-line edit fixes; defaulting to "idle" would let a newly
    // added watcher die completely unnoticed — the same failure direction the
    // incident denylist argues for.
    const decl = declFor("some-worker-added-next-week");
    expect(decl.kind).toBe("watcher");
    expect(decl.everyMs).toBeGreaterThan(0);
    expect(state("some-worker-added-next-week", "ok", agoMs(2 * MIN))).toBe("ok");
    expect(state("some-worker-added-next-week", "ok", agoMs(HOUR))).toBe("down");
  });
});

describe("declFor — the workers that exist today", () => {
  it("declares every cron watcher with the cadence index.ts schedules it at", () => {
    // The cadence is a FACT copied from boss.schedule; the 3× tolerance is a
    // policy. Mixing them is how one 15-minute threshold came to judge fifteen
    // unlike things. Queue name and worker_runs name differ — mail.poll records
    // as "mail", nas.scan as "nas" — so these are the recorded names.
    expect(declFor("mail")).toEqual({ kind: "watcher", everyMs: MIN });
    expect(declFor("docmeta-sweep")).toEqual({ kind: "watcher", everyMs: MIN });
    expect(declFor("search-drain")).toEqual({ kind: "watcher", everyMs: MIN });
    expect(declFor("nas")).toEqual({ kind: "watcher", everyMs: 2 * MIN });
    expect(declFor("registry-mine")).toEqual({ kind: "watcher", everyMs: 2 * MIN });
    expect(declFor("heartbeat")).toEqual({ kind: "watcher", everyMs: 5 * MIN });
  });

  it("declares receipts as event-driven — it runs only when registry.mine finds an aggregator", () => {
    // Not in the original inventory of this panel, and it is the one worker
    // that would otherwise sit amber for months: receipts.resolve is enqueued
    // by registry.mine and only for an APPLE.COM/BILL-shaped statement line.
    expect(declFor("receipts").kind).toBe("on-demand");
  });

  it("declares mail-drill monthly, with its own error window", () => {
    // Spelled out rather than imported, like every other number in this file:
    // the 35 days are the longest a calendar month can be (31) plus four days
    // of slack for a homelab that was off, and this assertion has to fail if
    // somebody moves it.
    expect(declFor("mail-drill")).toEqual({ kind: "monthly", errorActionableMs: 35 * DAY });
    // THE NAME, on the other hand, is ONE constant: its writer is
    // apps/worker/src/ops/mail-restore-drill.ts and its reader is this module,
    // in a different package, and a rename that missed one half would not throw
    // — the panel would simply find no rows and show no tile, which reads as a
    // system that has no restore drill at all.
    expect(MAIL_DRILL_WORKER_NAME).toBe("mail-drill");
    expect(declFor(MAIL_DRILL_WORKER_NAME).kind).toBe("monthly");
  });
});

describe("workerState — the monthly restore drill", () => {
  it("is ok mid-month and down once a whole run has been skipped", () => {
    // `30 5 1 * *` on the host crontab (CRON_TZ=UTC), restoring the 5.59 GB
    // native snapshot into a scratch Stalwart and counting 146 270 messages
    // back. Three weeks of silence is the middle of an ordinary month; six is a
    // drill that did not run on the 1st, and nothing else in the system would
    // say so.
    expect(state("mail-drill", "ok", agoMs(20 * DAY))).toBe("ok");
    expect(state("mail-drill", "ok", agoMs(40 * DAY))).toBe("down");
  });

  it("is NOT judged as a watcher, which is the bug this kind was added to stop", () => {
    // THE BUG THIS PINS, caught before it shipped. declFor defaults an
    // undeclared name to a watcher at 5 min × 3, so a monthly job with no
    // declaration is amber for roughly 29 days out of every 30 — the exact
    // permanent-amber problem this module exists to remove, arriving through its
    // own front door. The counterfactual is asserted on the next line rather
    // than described: a name one typo away from this one IS down at three days.
    expect(declFor("mail-drill").kind).toBe("monthly");
    expect(declFor("mail-drill").everyMs).toBeUndefined();
    expect(state("mail-drill", "ok", agoMs(3 * DAY))).toBe("ok");
    expect(state("mail-drills", "ok", agoMs(3 * DAY))).toBe("down");
  });

  it("keeps a FAILED drill down long past the 26 h every other kind ages out at", () => {
    // THE MIRROR-IMAGE BUG, and the reason WorkerDecl carries its own error
    // window. Ageing an error out is right when the failure becomes stale news:
    // ollama's 120 s timeout is a snapshot of a busy GPU, and a day later the
    // only honest thing left to say is when it happened — which is why the
    // hand-run reindex on the last line is `idle` at the same age. A drill that
    // failed is not that. It says the mail backup could not be restored; that
    // stays true until a human fixes it, the next run is a MONTH away, and no
    // other surface reports it (/verify renders the ledger panel and index
    // health only, and the dashboard router is the only reader of
    // worker_runs.status in the app). At 26 h + 1 the default would hand this
    // row back as a healthy `ok` for the next four weeks.
    expect(state("mail-drill", "error", agoMs(2 * HOUR))).toBe("down");
    expect(state("mail-drill", "error", agoMs(27 * HOUR))).toBe("down");
    expect(state("mail-drill", "error", agoMs(5 * DAY))).toBe("down");
    expect(state("reindex", "error", agoMs(5 * DAY))).toBe("idle");
  });

  it("falls through to the silence rule once even its own window has passed", () => {
    // Past 35 days the failed row is history like any other, and the kind's
    // ordinary rule takes over — which for `monthly` says down as well, because
    // a drill that has not reported in 40 days is overdue whatever its last word
    // was. THE TWO ANSWERS AGREEING IS THE POINT, not an accident: it is what
    // makes it safe to set the error window equal to the silence bound. There is
    // no age at which a failed drill quietly turns green, so nothing here needs
    // a reader to know which of the two branches produced the verdict.
    expect(state("mail-drill", "error", agoMs(40 * DAY))).toBe("down");
    expect(state("mail-drill", "error", agoMs(400 * DAY))).toBe("down");
  });
});

describe("workerState — an error ages out", () => {
  it("is down while a failure is recent and idle once it is history", () => {
    // THE BUG THIS PINS, and it is the very one this taxonomy was written to
    // remove. workerState judges the NEWEST worker_runs row, and nothing
    // replaces a row until the worker runs again — for a kind with no cadence,
    // that is never. `ollama` records status "error" on its 120 s timeout,
    // measured at 14 of 32 docmeta calls while the GPU is VRAM-starved, and
    // `extract` records "error" on a corrupt PDF, a Tesseract failure or a
    // workbook over readWorkbook's caps (this repo ships dimension- and
    // inflation-bomb fixtures for exactly those). Read "any error is down"
    // literally and the FIRST such failure pins an amber dot nothing can ever
    // clear — precisely the search-rerank shape: written only on failure, red
    // for a week, no code path to green. Trading nine meaningless ambers for
    // one permanent one would leave the panel worse than it started.
    expect(state("ollama", "error", agoMs(2 * HOUR))).toBe("down");
    expect(state("ollama", "error", agoMs(3 * DAY))).toBe("idle");
    expect(state("extract", "error", agoMs(11 * DAY))).toBe("idle");
    expect(state("reindex", "error", agoMs(11 * DAY))).toBe("idle");
  });

  it("changes nothing for a watcher, which a stale row already condemns", () => {
    // The rule is only interesting where there is no cadence. A watcher with a
    // recent error is down by this rule, and a watcher with an old one is down
    // by its cadence — the two answers agree, which is what makes it safe to
    // apply the ageing rule to every kind rather than to a special-cased few.
    expect(state("mail", "error", agoMs(1_000))).toBe("down");
    expect(state("mail", "error", agoMs(3 * DAY))).toBe("down");
  });

  it("leaves an incident marker off however fresh it is", () => {
    // The one kind the ageing rule must NOT reach. These rows are written only
    // on failure, so "recent error" is their normal state and reading it as
    // health inverts the panel: one Ollama timeout would paint the tile red
    // again, with going green needing a success row no code writes.
    expect(state("search-rerank", "error", agoMs(1_000))).toBe("off");
    expect(state("pg-boss", "error", agoMs(1_000))).toBe("off");
  });
});

describe("workerState — the boundaries themselves", () => {
  // MEASURED, on a copy of this module in a scratch directory: before these
  // existed, flipping BOTH age comparisons from `>` to `>=` left all thirteen
  // tests green, and so did moving NIGHTLY_MAX_AGE_MS from 26 h to 21 h. The
  // suite sampled 2 min / 4 min against a 3-minute bound and 20 h / 30 h
  // against 26 h — comfortably either side of each line, never on it. The 21 h
  // mutation is the one that bites: nightly-verify would turn amber every night
  // from 00:30 until the 03:30 run cleared it, three hours of false alarm every
  // night, with a green suite reporting all well.
  //
  // Every number below is SPELLED OUT and deliberately not imported from the
  // module. A boundary test that reads the constant it is pinning re-derives
  // the implementation and proves only that arithmetic works; these have to
  // fail when the constant moves, which is the whole reason they exist.

  it("puts a watcher's line at exactly three ticks, inclusive", () => {
    // search.drain is declared every 60 s, so the line is at 180 000 ms. AT the
    // line is still healthy: a drain that took its full third tick has not
    // missed anything yet, and rounding that to "down" is how a busy GPU
    // becomes an alarm.
    expect(state("search-drain", "ok", agoMs(3 * MIN))).toBe("ok");
    expect(state("search-drain", "ok", agoMs(3 * MIN + 1))).toBe("down");
    // The same line scaled by the declared cadence, so the multiplier is pinned
    // and not just one worker's arithmetic: heartbeat is every 5 min → 15 min.
    expect(state("heartbeat", "ok", agoMs(15 * MIN))).toBe("ok");
    expect(state("heartbeat", "ok", agoMs(15 * MIN + 1))).toBe("down");
  });

  it("puts the nightly line at exactly 26 hours, inclusive", () => {
    // 03:30 plus two hours of slack = healthy until 05:30 the next morning.
    // Move this number down and every night grows a window of false amber
    // between midnight and the run; move it up past 27 h and a job that skipped
    // a whole night — a backup that did not run, the failure that actually
    // matters — is reported healthy.
    expect(state("nightly-verify", "ok", agoMs(26 * HOUR))).toBe("ok");
    expect(state("nightly-verify", "ok", agoMs(26 * HOUR + 1))).toBe("down");
    expect(state("model-check", "ok", agoMs(26 * HOUR))).toBe("ok");
    expect(state("model-check", "ok", agoMs(26 * HOUR + 1))).toBe("down");
  });

  it("puts the actionable-error line at exactly 26 hours, inclusive", () => {
    // Same number as the nightly bound, on purpose and by coincidence rather
    // than by sharing a constant: this one means "a failure you could still act
    // on today". A hand-run script is the honest test of it, because nothing
    // else about a hand-run worker can produce "down" — at the line it is still
    // an alarm, one millisecond past it the panel goes back to reporting the
    // truth about a script nobody has run since.
    expect(state("reindex", "error", agoMs(26 * HOUR))).toBe("down");
    expect(state("reindex", "error", agoMs(26 * HOUR + 1))).toBe("idle");
    // And the retired case, which has a different resting state on the far side.
    // Built inline: gmail carried this until 2026-09-02 and is a watcher again,
    // and no declared worker is retired today.
    const retired = { kind: "retired" } as const;
    expect(workerState(retired, "error", new Date(NOW - 26 * HOUR), NOW)).toBe("down");
    expect(workerState(retired, "error", new Date(NOW - (26 * HOUR + 1)), NOW)).toBe("off");
  });

  it("puts the monthly line at exactly 35 days, inclusive", () => {
    // 31 days — the longest a calendar month can be — plus four days of slack
    // for a machine that was powered off, or a drill that started on the 1st and
    // was still restoring when the clock rolled over. Move this number down and
    // the panel calls an on-time drill overdue; move it past 62 and a drill that
    // skipped a whole month is reported healthy, which is a page claiming the
    // mail backup is restorable when the last thing anyone actually proved was
    // two months ago.
    expect(state("mail-drill", "ok", agoMs(35 * DAY))).toBe("ok");
    expect(state("mail-drill", "ok", agoMs(35 * DAY + 1))).toBe("down");
  });

  it("leaves the 26-hour error window in place for every kind that does not ask for its own", () => {
    // THE BLAST RADIUS OF THE PER-DECL WINDOW, pinned from both ends. No decl
    // written before mail-drill may carry one, so every kind is judged by the
    // same 26 h it was before the monthly kind existed.
    for (const name of ["mail", "heartbeat", "nightly-verify", "model-check", "mail-backup",
                        "ollama", "extract", "reindex", "case-history", "gmail"]) {
      expect(declFor(name).errorActionableMs).toBeUndefined();
    }
    // And the same line drawn through workerState, on the kinds where it is
    // OBSERVABLE. It is not observable on a watcher or a nightly job: past 26 h
    // their own cadence rule already says down, so both branches agree and no
    // assertion can tell them apart — which is exactly the argument the
    // "changes nothing for a watcher" test above makes. On-demand, hand-run and
    // retired are where the window decides the answer.
    expect(state("ollama", "error", agoMs(26 * HOUR))).toBe("down");
    expect(state("ollama", "error", agoMs(26 * HOUR + 1))).toBe("idle");
    expect(state("extract-texts", "error", agoMs(26 * HOUR))).toBe("down");
    expect(state("extract-texts", "error", agoMs(26 * HOUR + 1))).toBe("idle");
    // The retired arm, built inline: gmail carried it until 2026-09-02 and is a
    // scheduled watcher again, so no DECLARED worker is retired today.
    expect(workerState({ kind: "retired" }, "error", new Date(NOW - (26 * HOUR + 1)), NOW))
      .toBe("off");
    // The unknown-name default is a watcher and must not have acquired one
    // either, or a worker added next month would inherit a window nobody chose.
    expect(declFor("some-worker-added-next-week").errorActionableMs).toBeUndefined();
  });
});

describe("declFor — keys that are not workers", () => {
  it("does not mistake Object.prototype for a declaration", () => {
    // `DECLS[worker] ?? default` runs against an object literal, so
    // declFor("constructor") used to hand back Object.prototype.constructor —
    // truthy, so `??` never fired — and every downstream read came back
    // undefined: decl.kind matched no case, workerState fell off the end of its
    // switch and returned undefined, and the dashboard rendered a dot with no
    // state at all. worker_runs.worker is a free-text column written by
    // recordRun call sites, so this is one typo away rather than an attack.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const decl = declFor(name);
      expect(decl.kind).toBe("watcher");
      expect(decl.everyMs).toBe(5 * MIN);
      expect(state(name, "ok", agoMs(2 * MIN))).toBe("ok");
      expect(state(name, "ok", agoMs(HOUR))).toBe("down");
    }
  });
});
