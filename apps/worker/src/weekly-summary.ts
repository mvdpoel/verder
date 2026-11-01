/**
 * The Sunday summary (Plan 3 Task 26, spec §7.9): at 18:00 Amsterdam, one
 * PASSIVE `weekly` push saying what moved this ISO week — sent, received,
 * filed, tasks done — and how much waits on Martin.
 *
 * COUNTS ONLY in the push. A title on the lock screen is the dossier read
 * aloud to whoever picks up the phone; `topWaiting` rides along in the stored
 * summary for the screen the tap opens, which is behind Face ID.
 *
 * ONE PUSH PER WEEK, EVER: the dedupKey `weekly:<ISO week>` makes a pg-boss
 * retry, or a second run by hand, a duplicate `notify()` refuses. The week is
 * `summaryWeek(now)` — the window closing on the newest Sunday 18:00 passed — so a
 * hand-run on Monday after a failed Sunday recovers THAT week, not the new one.
 *
 * The summary is stored as `worker_runs.detail.summary` BEFORE the push, and
 * that row is what GET /api/mobile/v1/weekly serves — no new table, the same
 * data-in-detail precedent as `rateLimitedUntil`.
 *
 * THE WINDOW IS NOT MONDAY TO SUNDAY. It runs from the previous Sunday 18:00
 * Amsterdam to this Sunday 18:00 — half-open, `[from, to)` — so consecutive
 * windows ABUT ON THE INSTANT THE JOB RUNS. A Monday-to-Sunday window closed
 * six hours after its push had gone out, and the next one opened on Monday:
 * mail sent, a document filed or a task closed on Sunday evening fell in a
 * week already summarised and outside the next, so no summary EVER counted
 * it — and a Monday recovery run counted the whole Sunday while the punctual
 * run did not. The window is a property of the WEEK, never of the clock the
 * run read, so a late run and a punctual one count the same rows. The ISO
 * week key names the week whose Sunday closes the window.
 *
 * Rows are judged in JS on instants (the SQL bound is widened, the `money.month`
 * discipline: widen the SQL, decide in JS). Two sources carry a date that is
 * NOT when verder learned of the row — `raw_emails.sent_at` (the 15-minute Gmail poll
 * fetches a 17:55 mail at 18:10) and `log_entries.occurred_at` (an entry typed
 * in after the fact) — and judged on that date alone, a row recorded after the
 * run but dated before it falls in a window already pushed. `arrivedAt` judges
 * them on the LATER of the two, unless the gap exceeds LATE_RECORD_MS: that is
 * a backfill of old mail, judged on its own date, never dumped into one week.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { addDays, amsterdamAt, dayKey, isoWeekKey, weekBounds } from "@verder/api/src/amsterdam";
import { loadWaiting, type WaitingItem } from "@verder/api/src/waiting";
import type { WeeklySummary } from "@verder/api/src/weekly-summary";
import { WEEKLY_SUMMARY_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "./heartbeat";
import { senderAddress } from "./gmail";
import { ownMailboxAddresses } from "./mail/relevance";
import type { NotifyFn } from "./notify/notify";

/** The span one summary counts: `[from, to)`, Sunday 18:00 to Sunday 18:00 Amsterdam. */
export interface SummaryWindow { key: string; from: Date; to: Date }

/** The Sunday-summary hour, Amsterdam: the schedule's `0 18 * * 0`. */
export const WEEKLY_SUMMARY_HOUR = 18;

/**
 * The window a run at `now` SUMMARISES: the one that closes on the newest
 * Sunday 18:00 Amsterdam at or before `now`. From Sunday 18:00 to midnight that
 * Sunday is today's; on Monday to Sunday afternoon it is LAST Sunday's.
 *
 * Never the week containing `now` outright: a hand-run on Monday after a failed
 * Sunday, or a pg-boss job that starts after midnight, would otherwise
 * summarise the new, nearly empty week AND take its `weekly:<key>` dedupKey —
 * so the failed week is never recovered and the real push six days later is
 * refused as a duplicate.
 */
export function summaryWeek(now: Date): SummaryWindow {
  let sunday = weekBounds(dayKey(now), 1).to;
  if (amsterdamAt(sunday, WEEKLY_SUMMARY_HOUR).getTime() > now.getTime()) sunday = addDays(sunday, -7);
  return {
    key: isoWeekKey(sunday),
    from: amsterdamAt(addDays(sunday, -7), WEEKLY_SUMMARY_HOUR),
    to: amsterdamAt(sunday, WEEKLY_SUMMARY_HOUR),
  };
}

/**
 * How late a row may be RECORDED after its own date and still count as news
 * when it is recorded: the Gmail poll's own `newer_than:7d` window. Anything
 * recorded later than that is a backfill and keeps its own date.
 */
export const LATE_RECORD_MS = 7 * 24 * 3600_000;

/** When verder learned of a row: the later of its date and its recording, unless that is a backfill. */
export function arrivedAt(dated: Date, recorded: Date): Date {
  const late = recorded.getTime() - dated.getTime();
  return late > 0 && late <= LATE_RECORD_MS ? recorded : dated;
}

export interface StatusChangeRow {
  id: string; documentId: string; status: string; actor: string | null; createdAt: Date;
}

/** Everything `composeWeekly` decides on. Rows may lie outside the week: it judges. */
export interface WeeklyInput {
  window: SummaryWindow;
  ownAddresses: string[];
  /** Outbound log entries that no other entry supersedes. */
  outboundEntries: { occurredAt: Date; recordedAt: Date }[];
  /** Proposals with a `sent_at`. */
  sentProposals: { kind: string; sentAt: Date; resultEntryId: string | null }[];
  /** `raw_emails`: `fromAddr` is a whole RFC 5322 header for Gmail-era rows. */
  emails: { fromAddr: string; sentAt: Date; fetchedAt: Date }[];
  /** EVERY change row of each document that has a `filed` row near the window. */
  statusChanges: StatusChangeRow[];
  /** `documents.status` (the ingest status) of those documents. */
  documentStatus: Record<string, string>;
  /** `task_status_changes` to `done`. */
  tasksDone: { taskId: string; createdAt: Date }[];
  waiting: WaitingItem[];
}

const TOP_WAITING = 3;

/** Pure: no database, no clock, no environment. */
export function composeWeekly(input: WeeklyInput): WeeklySummary {
  const { key, from, to } = input.window;
  const inWeek = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();

  // A sent proposal's entry is linked by result_entry_id and is already among
  // the outbound entries, so only one with no entry yet adds to the count. A
  // question closes as `sent` and nothing left the house.
  const sent = input.outboundEntries.filter((e) => inWeek(arrivedAt(e.occurredAt, e.recordedAt))).length
    + input.sentProposals.filter((p) =>
      p.kind !== "question" && p.resultEntryId === null && inWeek(p.sentAt)).length;

  // PARSED, never substring-matched: a Gmail-era header that merely contains
  // Martin's address as text was sent by someone else. A header senderAddress
  // refuses (null) is not provably his, so it counts as received.
  const own = new Set(input.ownAddresses);
  const received = input.emails.filter((m) => {
    if (!inWeek(arrivedAt(m.sentAt, m.fetchedAt))) return false;
    const addr = senderAddress(m.fromAddr);
    return addr === null || !own.has(addr);
  }).length;

  // Filed = a TRANSITION into filed: every change row restates the status, so
  // a rename of an already-filed document is not filed again. Once per
  // document, attributed to the actor of its first transition in the week.
  const byDoc = new Map<string, StatusChangeRow[]>();
  for (const c of input.statusChanges) {
    const list = byDoc.get(c.documentId) ?? [];
    list.push(c);
    byDoc.set(c.documentId, list);
  }
  let filedByMartin = 0;
  let filedByVerder = 0;
  for (const [docId, rows] of byDoc) {
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let previous = input.documentStatus[docId] ?? "inbox";
    for (const r of rows) {
      if (r.status === "filed" && previous !== "filed" && inWeek(r.createdAt)) {
        if (r.actor === "verder") filedByVerder++; else filedByMartin++;
        break;
      }
      previous = r.status;
    }
  }

  const tasksDone = new Set(input.tasksDone.filter((t) => inWeek(t.createdAt)).map((t) => t.taskId)).size;

  return {
    week: key, from: from.toISOString(), to: to.toISOString(),
    sent, received, filedByMartin, filedByVerder, tasksDone,
    waiting: input.waiting.length,
    topWaiting: input.waiting.slice(0, TOP_WAITING),
  };
}

/** "3 verstuurd · 7 binnen · 5 opgeborgen · 2 taken klaar — 4 wachten op jou". Counts only. */
export function weeklyBody(s: WeeklySummary): string {
  const filed = s.filedByMartin + s.filedByVerder;
  const tasks = `${s.tasksDone} ${s.tasksDone === 1 ? "taak" : "taken"} klaar`;
  const waiting = s.waiting === 0 ? "niets wacht op jou"
    : `${s.waiting} ${s.waiting === 1 ? "wacht" : "wachten"} op jou`;
  return `${s.sent} verstuurd · ${s.received} binnen · ${filed} opgeborgen · ${tasks} — ${waiting}`;
}

export interface WeeklyLoadDeps {
  waiting?: (db: Db) => Promise<WaitingItem[]>;
  ownAddresses?: () => string[];
}

/** The SQL bound is only ever WIDENED; every decision is `composeWeekly`'s, in JS. */
const SQL_MARGIN_MS = 2 * 24 * 3600_000;

export async function loadWeekly(db: Db, window: SummaryWindow, deps: WeeklyLoadDeps = {}): Promise<WeeklyInput> {
  const lo = new Date(window.from.getTime() - SQL_MARGIN_MS);
  const hi = new Date(window.to.getTime() + SQL_MARGIN_MS);
  const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
  const date = (v: string | Date) => new Date(v);

  // SEQUENTIAL on purpose: once a week, five small reads, and a transaction
  // (every test) queues parallel queries on one client, which pg 8 deprecates.
  const entries = await db.execute(sql`
      SELECT e.occurred_at, e.recorded_at FROM log_entries e
      WHERE e.direction = 'outbound'
        AND ((e.occurred_at >= ${lo} AND e.occurred_at < ${hi})
          OR (e.recorded_at >= ${lo} AND e.recorded_at < ${hi}))
        AND NOT EXISTS (SELECT 1 FROM log_entries s WHERE s.supersedes_id = e.id)`);
  const proposals = await db.execute(sql`
      SELECT kind, sent_at, result_entry_id FROM proposals
      WHERE sent_at >= ${lo} AND sent_at < ${hi}`);
  const emails = await db.execute(sql`
      SELECT from_addr, sent_at, fetched_at FROM raw_emails
      WHERE (sent_at >= ${lo} AND sent_at < ${hi}) OR (fetched_at >= ${lo} AND fetched_at < ${hi})`);
  const changes = await db.execute(sql`
      SELECT c.id, c.document_id, c.status, c.actor, c.created_at, d.status AS doc_status
      FROM document_status_changes c JOIN documents d ON d.id = c.document_id
      WHERE c.document_id IN (SELECT document_id FROM document_status_changes
        WHERE status = 'filed' AND created_at >= ${lo} AND created_at < ${hi})`);
  const tasks = await db.execute(sql`
      SELECT task_id, created_at FROM task_status_changes
      WHERE status = 'done' AND created_at >= ${lo} AND created_at < ${hi}`);
  const waiting = await (deps.waiting ?? loadWaiting)(db);

  type Change = { id: string; document_id: string; status: string; actor: string | null;
    created_at: string | Date; doc_status: string };
  const changeRows = rows<Change>(changes);
  const documentStatus: Record<string, string> = {};
  for (const c of changeRows) documentStatus[c.document_id] = c.doc_status;

  return {
    window,
    ownAddresses: (deps.ownAddresses ?? ownMailboxAddresses)(),
    outboundEntries: rows<{ occurred_at: string | Date; recorded_at: string | Date }>(entries)
      .map((r) => ({ occurredAt: date(r.occurred_at), recordedAt: date(r.recorded_at) })),
    sentProposals: rows<{ kind: string; sent_at: string | Date; result_entry_id: string | null }>(proposals)
      .map((r) => ({ kind: r.kind, sentAt: date(r.sent_at), resultEntryId: r.result_entry_id })),
    emails: rows<{ from_addr: string; sent_at: string | Date; fetched_at: string | Date }>(emails)
      .map((r) => ({ fromAddr: r.from_addr, sentAt: date(r.sent_at), fetchedAt: date(r.fetched_at) })),
    statusChanges: changeRows.map((c) => ({ id: c.id, documentId: c.document_id, status: c.status,
      actor: c.actor, createdAt: date(c.created_at) })),
    documentStatus,
    tasksDone: rows<{ task_id: string; created_at: string | Date }>(tasks)
      .map((r) => ({ taskId: r.task_id, createdAt: date(r.created_at) })),
    waiting,
  };
}

export interface WeeklySummaryDeps extends WeeklyLoadDeps {
  db: Db;
  notify: NotifyFn;
  now?: () => Date;
}

export interface WeeklySummaryResult { summary: WeeklySummary; body: string; sent: boolean }

/**
 * Compose, record, push — in that order, so the stored copy exists before the
 * push that points at it. `dry` (the hand-run `--dry`) composes only: no row,
 * no push.
 */
export async function runWeeklySummary(
  deps: WeeklySummaryDeps, opts: { dry?: boolean } = {},
): Promise<WeeklySummaryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const week = summaryWeek(now);
  const summary = composeWeekly(await loadWeekly(deps.db, week, deps));
  const body = weeklyBody(summary);
  if (opts.dry) return { summary, body, sent: false };

  await recordRun(deps.db, WEEKLY_SUMMARY_WORKER_NAME, "ok", { summary });
  const r = await deps.notify({
    kind: "weekly", level: "passive", title: "Je week", body,
    link: "verder://inbox", dedupKey: `weekly:${week.key}`,
  });
  return { summary, body, sent: !r.duplicate };
}
