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
 * retry, or a second run by hand, a duplicate `notify()` refuses.
 *
 * The summary is stored as `worker_runs.detail.summary` BEFORE the push, and
 * that row is what GET /api/mobile/v1/weekly serves — no new table, the same
 * data-in-detail precedent as `rateLimitedUntil`.
 *
 * WEEK MEMBERSHIP is an Amsterdam question (the `money.month` rule): the SQL
 * window is widened by two days on each side and every row is judged in JS
 * with `dayKey` against `weekBounds`, so a Monday 00:30 CET that is still
 * Sunday in UTC lands in the right week.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { addDays, dayKey, isoWeekKey, weekBounds } from "@verder/api/src/amsterdam";
import { loadWaiting, type WaitingItem } from "@verder/api/src/waiting";
import type { WeeklySummary } from "@verder/api/src/weekly-summary";
import { WEEKLY_SUMMARY_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "./heartbeat";
import { senderAddress } from "./gmail";
import { ownMailboxAddresses } from "./mail/relevance";
import type { NotifyFn } from "./notify/notify";

export interface Week { from: string; to: string; key: string }

/** The ISO week (Monday to Sunday, Amsterdam) that contains `now`. */
export function weekOf(now: Date): Week {
  const { from, to } = weekBounds(dayKey(now), 1);
  return { from, to, key: isoWeekKey(from) };
}

export interface StatusChangeRow {
  id: string; documentId: string; status: string; actor: string | null; createdAt: Date;
}

/** Everything `composeWeekly` decides on. Rows may lie outside the week: it judges. */
export interface WeeklyInput {
  week: { from: string; to: string };
  ownAddresses: string[];
  /** Outbound log entries that no other entry supersedes. */
  outboundEntries: { occurredAt: Date }[];
  /** Proposals with a `sent_at`. */
  sentProposals: { kind: string; sentAt: Date; resultEntryId: string | null }[];
  /** `raw_emails`: `fromAddr` is a whole RFC 5322 header for Gmail-era rows. */
  emails: { fromAddr: string; sentAt: Date }[];
  /** EVERY change row of each document that has a `filed` row near the week. */
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
  const { from, to } = input.week;
  const inWeek = (d: Date) => { const k = dayKey(d); return k >= from && k <= to; };

  // A sent proposal's entry is linked by result_entry_id and is already among
  // the outbound entries, so only one with no entry yet adds to the count. A
  // question closes as `sent` and nothing left the house.
  const sent = input.outboundEntries.filter((e) => inWeek(e.occurredAt)).length
    + input.sentProposals.filter((p) =>
      p.kind !== "question" && p.resultEntryId === null && inWeek(p.sentAt)).length;

  // PARSED, never substring-matched: a Gmail-era header that merely contains
  // Martin's address as text was sent by someone else. A header senderAddress
  // refuses (null) is not provably his, so it counts as received.
  const own = new Set(input.ownAddresses);
  const received = input.emails.filter((m) => {
    if (!inWeek(m.sentAt)) return false;
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
    week: isoWeekKey(from), from, to,
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

/** UTC midnight of a day key: only ever a WIDENED bound, never a decision. */
const utcMidnight = (day: string) => new Date(`${day}T00:00:00Z`);

export async function loadWeekly(db: Db, week: Week, deps: WeeklyLoadDeps = {}): Promise<WeeklyInput> {
  const lo = utcMidnight(addDays(week.from, -2));
  const hi = utcMidnight(addDays(week.to, 3));
  const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
  const date = (v: string | Date) => new Date(v);

  // SEQUENTIAL on purpose: once a week, five small reads, and a transaction
  // (every test) queues parallel queries on one client, which pg 8 deprecates.
  const entries = await db.execute(sql`
      SELECT e.occurred_at FROM log_entries e
      WHERE e.direction = 'outbound' AND e.occurred_at >= ${lo} AND e.occurred_at < ${hi}
        AND NOT EXISTS (SELECT 1 FROM log_entries s WHERE s.supersedes_id = e.id)`);
  const proposals = await db.execute(sql`
      SELECT kind, sent_at, result_entry_id FROM proposals
      WHERE sent_at >= ${lo} AND sent_at < ${hi}`);
  const emails = await db.execute(sql`
      SELECT from_addr, sent_at FROM raw_emails WHERE sent_at >= ${lo} AND sent_at < ${hi}`);
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
    week: { from: week.from, to: week.to },
    ownAddresses: (deps.ownAddresses ?? ownMailboxAddresses)(),
    outboundEntries: rows<{ occurred_at: string | Date }>(entries)
      .map((r) => ({ occurredAt: date(r.occurred_at) })),
    sentProposals: rows<{ kind: string; sent_at: string | Date; result_entry_id: string | null }>(proposals)
      .map((r) => ({ kind: r.kind, sentAt: date(r.sent_at), resultEntryId: r.result_entry_id })),
    emails: rows<{ from_addr: string; sent_at: string | Date }>(emails)
      .map((r) => ({ fromAddr: r.from_addr, sentAt: date(r.sent_at) })),
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
  const week = weekOf(now);
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
