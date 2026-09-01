import { describe, expect, it } from "vitest";
import type { WorkerKind, WorkerState } from "@verder/api/src/worker-health";
import { workerRowLabel, type WorkerRow } from "./worker-row-label";

// A fixed instant, late enough in the Amsterdam evening that the UTC day and
// the Amsterdam day differ: 2026-09-01T22:40Z is already 2026-09-02 in
// Amsterdam. Every "is this today?" assertion below would pass by accident on a
// UTC-based implementation at noon and fail here, which is the point.
const now = new Date("2026-09-01T22:40:00Z").getTime();
const at = (iso: string) => new Date(iso);

/**
 * A served row, spelled out. `status` defaults to the healthy "ok" because that
 * is the ordinary case, but `kind` and `state` are always written out: the
 * label reads BOTH — the kind explains a grey dot, the state decides whether
 * the row is allowed to say "fout" — and a helper that guessed one of them from
 * the other would be a second copy of worker-health's rule living in the test.
 */
const row = (
  fields: { kind: WorkerKind; state: WorkerState; ranAt: Date; status?: string },
): WorkerRow => ({ status: "ok", ...fields });

describe("workerRowLabel", () => {
  it("shows a bare clock time for a watcher that ran today", () => {
    expect(workerRowLabel(
      row({ kind: "watcher", state: "ok", ranAt: at("2026-09-01T22:39:00Z") }), now,
    )).toBe("laatst 00:39");
  });

  it("shows a bare clock time for a nightly job that ran this Amsterdam day", () => {
    // 03:30 CEST is 01:30Z, on the same Amsterdam day as `now`.
    expect(workerRowLabel(
      row({ kind: "nightly", state: "ok", ranAt: at("2026-09-02T01:30:00Z") }), now,
    )).toBe("laatst 03:30");
  });

  // THE BUG IN THE OLD PANEL. toLocaleTimeString rendered an eleven-day-old run
  // as a bare clock time, which reads as minutes ago.
  it("shows a date, never a clock time, once the run is not from today", () => {
    expect(workerRowLabel(
      row({ kind: "nightly", state: "down", ranAt: at("2026-08-21T01:30:00Z") }), now,
    )).toBe("laatst 21-08");
  });

  it("carries the year when the run is from another year", () => {
    expect(workerRowLabel(
      row({ kind: "watcher", state: "down", ranAt: at("2025-12-30T10:00:00Z") }), now,
    )).toBe("laatst 30-12-2025");
  });

  it("names the kind so a grey dot is legible: on-demand", () => {
    expect(workerRowLabel(
      row({ kind: "on-demand", state: "idle", ranAt: at("2026-08-30T10:31:00Z") }), now,
    )).toBe("op aanvraag · laatst 30-08");
  });

  it("names the kind so a grey dot is legible: hand-run", () => {
    expect(workerRowLabel(
      row({ kind: "hand-run", state: "idle", ranAt: at("2026-08-21T09:00:00Z") }), now,
    )).toBe("met de hand · laatst 21-08");
  });

  it("names the kind so a grey dot is legible: retired", () => {
    expect(workerRowLabel(
      row({ kind: "retired", state: "off", ranAt: at("2026-08-29T09:00:00Z") }), now,
    )).toBe("uit · laatst 29-08");
  });

  /*
   * THE ROW THAT LOOKS BROKEN AND IS NOT. The restore drill runs on the 1st, so
   * for twenty-nine days in thirty its newest row is weeks old beside a GREEN
   * dot. Without the kind word that reads as a stalled worker — the same
   * mismatch, inverted, that `fout ·` exists to prevent — and a reader who
   * decides this panel glitches stops reading it, which is the failure the
   * whole taxonomy was written to undo.
   */
  it("names the kind so a healthy month-old run is legible: monthly", () => {
    expect(workerRowLabel(
      row({ kind: "monthly", state: "ok", ranAt: at("2026-08-01T05:30:00Z") }), now,
    )).toBe("maandelijks · laatst 01-08");
  });

  /*
   * A FAILED DRILL DROPS THE KIND WORD, exactly as a failed hand-run script
   * does: the row is amber for a stated reason and the reason wins. This one
   * matters more than the others, because worker-health.ts gives `monthly` an
   * error window of its own (35 days rather than 26 hours) precisely so a
   * failed restore drill keeps saying so all month — so this is the label that
   * has to stay legible longest.
   */
  it("says a failed drill failed, without the kind word", () => {
    expect(workerRowLabel(
      row({ kind: "monthly", state: "down", status: "error", ranAt: at("2026-08-01T05:30:00Z") }), now,
    )).toBe("fout 01-08");
  });

  // The router filters incident markers out of the list, so this never renders
  // today. It is asserted anyway because the function must be total over
  // WorkerKind — a caller that forgets to filter has to degrade to an honest
  // label, not to a crash or to a row claiming health.
  it("calls an incident marker what it is", () => {
    expect(workerRowLabel(
      row({ kind: "incident", state: "off", ranAt: at("2026-08-23T09:00:00Z") }), now,
    )).toBe("laatste storing 23-08");
  });

  // A dossier read at 00:05 CEST must not report last night's 23:58 run as
  // "today". Both instants fall on 2026-09-02 in UTC, so a UTC comparison
  // prints a clock time for a run that happened yesterday — the misreading this
  // whole helper exists to remove, back for two hours every night. In Amsterdam
  // they are 01-09 and 02-09, so it is a date.
  it("crosses the Amsterdam midnight, not the UTC one", () => {
    const justAfterMidnight = new Date("2026-09-01T22:05:00Z").getTime();
    expect(workerRowLabel(
      row({ kind: "watcher", state: "ok", ranAt: at("2026-09-01T21:58:00Z") }),
      justAfterMidnight,
    )).toBe("laatst 01-09");
  });

  /*
   * THE SECOND HALF OF THE PANEL'S HONESTY. A dot has one bit; a row that turns
   * amber forty seconds after its last successful-looking timestamp has to say
   * WHY in words, or the reader — freshly taught that amber means "stale" —
   * reads a fresh time beside an amber dot as a glitch and stops trusting the
   * panel. That is the exact reader behaviour this whole slice exists to
   * prevent, so it must not be reintroduced by the fix for it.
   */
  it("says an errored watcher failed, beside a timestamp minutes old", () => {
    // registry.mine hits an LLM failure and records `error` at 20:14 CEST.
    // Without the word, this row is an amber dot next to `laatst 20:14`.
    expect(workerRowLabel(
      row({ kind: "watcher", state: "down", status: "error",
        ranAt: at("2026-09-01T22:39:20Z") }), now,
    )).toBe("fout 00:39");
  });

  it("says an errored hand-run script failed, and drops its kind word", () => {
    // `met de hand` exists to explain a GREY dot: silence on a script nobody
    // typed is not news. This row is amber and the news is the failure, so the
    // kind word would be the second reason on a row that has one — and three
    // segments is what starts wrapping the non-wrapping right-hand column.
    expect(workerRowLabel(
      row({ kind: "hand-run", state: "down", status: "error",
        ranAt: at("2026-09-01T22:00:00Z") }), now,
    )).toBe("fout 00:00");
  });

  /*
   * AN OLD FAILURE READS AS ITS KIND, NOT AS AN ALARM.
   *
   * workerState ages errors out: a failure older than ERROR_ACTIONABLE_MS
   * (26 h) stops being "down". So a row arrives here with status "error" and
   * state "idle", and the label has to choose which of the two it believes.
   *
   * It chooses the STATE, and the word "fout" is spent only on a row the panel
   * is actually pointing at. Two reasons, and the second is the load-bearing
   * one. First, the label's whole job is to explain the dot: "fout" beside a
   * neutral grey dot is the same mismatch as a fresh timestamp beside an amber
   * one, only inverted, and it teaches the same distrust. Second, this panel
   * answers "what needs me NOW" — an eleven-day-old reindex failure needs
   * nobody today, and every row that claims attention it does not deserve is
   * how nine amber dots came to mean nothing.
   *
   * WHAT IS LOST, argued and accepted: the row no longer shows that the last
   * thing this worker did was fail, so somebody reading only the dashboard
   * cannot tell an aged-out failure from an aged-out success. That history is
   * not gone — worker_runs keeps every row, /verify is the surface for old
   * failures, and the run itself is queryable. A dashboard is a triage list,
   * not an archive, and this is the trade that keeps it worth reading.
   */
  it("keeps the word once an old failure has aged out of being down", () => {
    // REVERSED DELIBERATELY. The urgency ages out — the dot is grey and claims
    // nothing — but the FACT does not. This row is the case that decided it: a
    // hand-run backfill that failed eleven days ago is a thing you would want to
    // know before assuming it completed, and nobody is watching a hand-run
    // script otherwise. The earlier version dropped the word on the grounds that
    // "/verify is the surface for old failures", and that was checked and found
    // false — verify/page.tsx renders the ledger panel and the index-health card
    // and nothing else, and the dashboard router is the only reader of
    // worker_runs.status in the whole application. Dropping it left one surface:
    // a psql prompt.
    expect(workerRowLabel(
      row({ kind: "hand-run", state: "idle", status: "error",
        ranAt: at("2026-08-21T09:00:00Z") }), now,
    )).toBe("met de hand · fout 21-08");
  });

  /*
   * The retired row is the case that proves the STATE is the right gate.
   * gmail's LAST ACT WAS THE FAILURE that got it unscheduled — worker-health.ts
   * says so — and that failure is months old, so a status-only rule would print
   * `fout` on it forever: precisely the permanent red that taxonomy was written
   * to remove, unclearable because restarting the poller is exactly what nobody
   * is going to do. workerState has already made that call (`off` once the
   * error is past ERROR_ACTIONABLE_MS), and reading the state inherits the
   * decision instead of spelling a second copy of the rule in the web app.
   */
  it("still records a retired worker's long-dead failure, quietly", () => {
    // ALSO REVERSED, and the comment above is the argument it has to answer:
    // that a status-only word would be "the permanent red the taxonomy was
    // written to remove". It would not, and the difference is what the permanent
    // red actually cost. Amber on this page means WORK WAITING ON MARTIN, and an
    // unclearable amber is a false claim on his attention. Grey claims nothing.
    // `uit · fout 29-08` reads as "switched off; the last thing it did failed" —
    // true, unalarming, and the dot is still grey. The state gate survives where
    // it matters: it decides the DOT, which is the part that shouts.
    expect(workerRowLabel(
      row({ kind: "retired", state: "off", status: "error",
        ranAt: at("2026-08-29T09:00:00Z") }), now,
    )).toBe("uit · fout 29-08");
  });

  /*
   * And the mirror, which is why the gate is the state and not the KIND either.
   * A retired worker can still be run by hand — `boss.send("gmail.poll")`, or
   * ops/backfill-gmail.ts — and workerState deliberately calls a fresh failure
   * on one `down`, because the person typing that command is the one reader
   * this panel has. Reading the state means this label follows that decision
   * for free; a rule that special-cased `retired` here would show them a calm
   * `uit` for the run they are watching fail.
   */
  it("does call a retired worker's fresh hand-run failure a fault", () => {
    expect(workerRowLabel(
      row({ kind: "retired", state: "down", status: "error",
        ranAt: at("2026-09-01T22:30:00Z") }), now,
    )).toBe("fout 00:30");
  });
});
