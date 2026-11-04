import { asc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { buildTrackMap, type StopRow } from "./track-map";
import { effectiveTaskStatuses } from "./task-decide";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "./effective-status";
import { loadTrackMapRows } from "./routers/tracks";
import { requestThreads, requestTodoMeta, type RequestThreadRow } from "./request-threads";

/**
 * WHAT WAITS ON MARTIN — the one definition (spec §12.9).
 *
 * The phone's Voor jou list, its badge, the widget and the web dashboard all
 * read this and nothing else counts waiting items: four surfaces with four
 * counts is how a badge comes to say 3 over a list that shows 2, and a badge
 * that can never drain teaches him to ignore it.
 *
 * `waitingOnMartin` is pure and decides membership and order. `loadWaiting`
 * below is the one loader that feeds it.
 */

/**
 * `in-progress` counts: Martin is the one doing it (settled by him on
 * 2026-10-31, spec §12.9). `waiting` does not — it means waiting on someone
 * else.
 */
export const WAITING_TASK_STATUSES = ["open", "in-progress"] as const;

/** `request` (Vraag Grip): a question THREAD that waits on Martin — an unread
 *  answer, a step only he can do, the proposal it drafted (folded into this
 *  row, never listed apart), or a failure to retry or drop
 *  (`request-threads.ts`). A queued or working one waits on Grip and is not
 *  listed here. */
export type WaitingKind = "proposal" | "question" | "request" | "suggestion" | "task" | "stop";

export interface WaitingItem {
  kind: WaitingKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** 1 = urgent (a Verder proposal, a task due within 24 h), 2 = a proposal or question, 3 = the rest. */
  priority: 1 | 2 | 3;
  /** ISO. */
  at: string;
  dueAt: string | null;
  verder: boolean;
  /**
   * The party a proposal is about, so the phone can open "Gesprek
   * voorbereiden" from it; null for every other kind and for a proposal with
   * no party. Optional in the type so older hand-built items still check.
   */
  partyId?: string | null;
}

/** A pending proposal, as the loader reads it. `payload` is the stored JSON. */
export interface ProposalRow {
  id: string;
  kind: string;
  priority: string;
  createdAt: Date;
  payload: unknown;
  partyName: string | null;
  /** `proposals.party_id`; optional so a caller that never reads it need not select it. */
  partyId?: string | null;
  senderGuess: unknown;
  /** The request that drafted it (Vraag Grip); optional for older callers. */
  triggerRequestId?: string | null;
}

/** Every request row, for the thread rule (`request-threads.ts`). */
export type RequestRow = RequestThreadRow;

/** A pending or needs-manual suggestion on a live (or no) document. */
export interface SuggestionRow {
  id: string;
  kind: string;
  createdAt: Date;
  proposed: unknown;
  documentTitle: string | null;
  emailSubject: string | null;
}

/** A task with its EFFECTIVE status already resolved. */
export interface TaskRow {
  id: string;
  title: string;
  status: string;
  dueAt: Date | null;
  createdAt: Date;
}

const DAY_MS = 24 * 3600 * 1000;

const SUGGESTION_LABEL: Record<string, string> = {
  "log-entry": "Logboekregel",
  "document-meta": "Document",
  "registry-item": "Vaste last",
  debt: "Vordering",
  task: "Taak",
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const field = (o: unknown, key: string): unknown =>
  o !== null && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;

/** Newest first; equal instants break on id so the order never depends on row order. */
const newestFirst = (a: { at: Date; id: string }, b: { at: Date; id: string }) =>
  b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function proposalItem(p: ProposalRow): WaitingItem {
  const question = field(p.payload, "question");
  const isQuestion = p.kind === "question";
  const guess = field(p.senderGuess, "kind");
  const verder = p.priority === "verder";
  return {
    kind: isQuestion ? "question" : "proposal",
    id: p.id,
    title: (isQuestion ? str(field(question, "prompt")) : null)
      ?? str(field(p.payload, "ask"))
      ?? (isQuestion ? "Vraag van Grip" : "Voorstel van Grip"),
    subtitle: p.partyName ?? (guess === "verder" ? "Verder" : null),
    priority: verder ? 1 : 2,
    at: p.createdAt.toISOString(),
    dueAt: str(field(p.payload, "dueAt")),
    verder,
    partyId: p.partyId ?? null,
  };
}

function suggestionTitle(s: SuggestionRow): string {
  const p = s.proposed;
  const fromProposal =
    s.kind === "log-entry" ? str(field(p, "summary"))
    : s.kind === "registry-item" ? str(field(p, "name"))
    : s.kind === "debt" ? str(field(p, "creditorName"))
    : str(field(p, "title"));
  return fromProposal ?? s.documentTitle ?? s.emailSubject ?? SUGGESTION_LABEL[s.kind] ?? "Suggestie";
}

export function waitingOnMartin(input: {
  proposals: ProposalRow[];
  /** Optional so older hand-built inputs still check; absent means none. */
  requests?: RequestRow[];
  suggestions: SuggestionRow[];
  tasks: TaskRow[];
  currentStop: StopRow | null;
  now: Date;
}): WaitingItem[] {
  const byAt = <T extends { id: string; createdAt: Date }>(rows: T[]) =>
    [...rows].sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }));

  // Vraag Grip first: his own questions, newest first (the frames put the
  // answered question above every proposal). A thread's pending proposal is
  // FOLDED into its row; "Laat maar" releases it as a proposal of its own.
  const threads = requestThreads(input.requests ?? []);
  const folded = new Set<string>();
  const foldedRequests = new Set<string>();
  for (const t of threads) {
    if (t.head.dismissedAt) continue;
    for (const m of t.members) foldedRequests.add(m.id);
    if (t.carried) folded.add(t.carried.id);
  }
  const released = new Set(threads.flatMap((t) => (t.released ? [t.released.id] : [])));
  const requests = threads.filter((t) => t.phase === "todo").map((t): WaitingItem => ({
    kind: "request", id: t.head.id, title: t.title, subtitle: requestTodoMeta(t), priority: 2,
    at: t.at.toISOString(), dueAt: null, verder: t.carried?.priority === "verder", partyId: null,
  }));

  // 1 and 2: Verder-priority proposals, then the others and the questions.
  const proposals = byAt(input.proposals.filter((p) =>
    !folded.has(p.id) && !(p.triggerRequestId && foldedRequests.has(p.triggerRequestId))));
  const verderFirst = [
    ...proposals.filter((p) => p.priority === "verder"),
    ...proposals.filter((p) => p.priority !== "verder"),
  ].map((p) => {
    const item = proposalItem(p);
    // Released from a question he put away: it says where it came from.
    return released.has(p.id) ? { ...item, subtitle: "Uit je vraag" } : item;
  });

  // 3: suggestions.
  const suggestions = byAt(input.suggestions).map((s): WaitingItem => ({
    kind: "suggestion", id: s.id, title: suggestionTitle(s),
    subtitle: SUGGESTION_LABEL[s.kind] ?? null, priority: 3,
    at: s.createdAt.toISOString(), dueAt: null, verder: false, partyId: null,
  }));

  // 4: tasks Martin is to do, earliest deadline first, undated last.
  const waitingStatuses: readonly string[] = WAITING_TASK_STATUSES;
  const stop = input.currentStop?.state === "open" ? input.currentStop : null;
  const soon = input.now.getTime() + DAY_MS;
  const tasks = input.tasks
    .filter((t) => waitingStatuses.includes(t.status))
    .sort((a, b) =>
      (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)
      || a.createdAt.getTime() - b.createdAt.getTime()
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t): WaitingItem => ({
      kind: "task", id: t.id, title: t.title,
      // One piece of work counts once: the open stop that carries this task
      // names it here rather than as a second item.
      subtitle: stop?.taskId === t.id ? stop.title : null,
      priority: t.dueAt && t.dueAt.getTime() <= soon ? 1 : 3,
      at: t.createdAt.toISOString(), dueAt: t.dueAt?.toISOString() ?? null, verder: false, partyId: null,
    }));

  // 5: the map's current open stop, unless its task already stands for it.
  const stopItems: WaitingItem[] =
    stop && !tasks.some((t) => t.id === stop.taskId)
      ? [{ kind: "stop", id: stop.id, title: stop.title, subtitle: null, priority: 3,
          at: (stop.happenedAt ?? stop.expectedAt ?? input.now).toISOString(),
          dueAt: null, verder: false, partyId: null }]
      : [];

  return [...requests, ...verderFirst, ...suggestions, ...tasks, ...stopItems];
}

/**
 * `todo` is work only Martin can do: his own questions (Vraag Grip),
 * proposals, questions, tasks and the
 * current stop. `review` is the suggestion backlog, verder's reading of what
 * arrived, waiting for his verdict. The badge counts `todo` only (Martin,
 * 2026-11-04): a number that a backlog of 494 unread suggestions keeps at 500
 * stops meaning "this is yours to do". `count` stays the list's length.
 */
export type WaitingBucket = "todo" | "review";

export const waitingBucket = (item: WaitingItem): WaitingBucket =>
  item.kind === "suggestion" ? "review" : "todo";

export interface WaitingCounts { count: number; todo: number; review: number }

export function waitingCounts(items: WaitingItem[]): WaitingCounts {
  const todo = items.filter((i) => waitingBucket(i) === "todo").length;
  return { count: items.length, todo, review: items.length - todo };
}

/**
 * The one loader. Every membership rule that needs the database lives here:
 *
 * - Requests (Vraag Grip): one item per THREAD that waits on him
 *   (`request-threads.ts`): an unread answer, an unticked step, a pending
 *   proposal it drafted (folded in, never counted twice), or a FAILURE — his
 *   next step is "Opnieuw proberen" or "Laat maar", so it counts until he takes
 *   one. Queued and working threads wait on Grip. Every request row is read:
 *   they are Martin's own questions, a handful a day, and the thread rule
 *   needs every member.
 * - Proposals: `status = 'pending'` only. drafting, draft-failed, approved and
 *   sending wait on Grip, not on Martin; the verdict column is never read.
 * - Suggestions: pending or needs-manual, and NOT on a discarded or purged
 *   document. Purge is the `document_purges` ROW (`notPurgedSql`), the same
 *   definition `/files`, `suggestions.list` and `dashboard.stats` use; only
 *   /verify reads the ledger event instead, because there the question is
 *   whether a forged row can hide evidence, and here a forged row can only hide
 *   an item — the conservative direction.
 * - Tasks: the effective status by ledger seq, batched (`effectiveTaskStatuses`).
 * - The current stop: what the map itself draws as current.
 */
export async function loadWaiting(db: Db, now = new Date()): Promise<WaitingItem[]> {
  const [proposals, requests, suggestions, taskRows, mapRows] = await Promise.all([
    db.select({
      id: schema.proposals.id, kind: schema.proposals.kind, priority: schema.proposals.priority,
      createdAt: schema.proposals.createdAt, payload: schema.proposals.payload,
      partyName: schema.parties.name, partyId: schema.proposals.partyId,
      senderGuess: schema.proposals.senderGuess, triggerRequestId: schema.proposals.triggerRequestId,
    }).from(schema.proposals)
      .leftJoin(schema.parties, eq(schema.parties.id, schema.proposals.partyId))
      .where(eq(schema.proposals.status, "pending")),
    loadRequestThreadRows(db),
    // `documents` unaliased, because the shared expressions assume it.
    db.execute(sql`
      SELECT s.id, s.kind, s.created_at, s.proposed,
        CASE WHEN s.document_id IS NULL THEN NULL ELSE ${effectiveTitleSql} END AS document_title,
        r.subject AS email_subject
      FROM suggestions s
      LEFT JOIN documents ON documents.id = s.document_id
      LEFT JOIN raw_emails r ON r.id = s.raw_email_id
      WHERE s.status IN ('pending','needs-manual')
        AND (s.document_id IS NULL OR (${notDiscardedSql} AND ${notPurgedSql}))`),
    db.select({
      id: schema.tasks.id, title: schema.tasks.title,
      dueAt: schema.tasks.dueAt, createdAt: schema.tasks.createdAt,
    }).from(schema.tasks).orderBy(asc(schema.tasks.createdAt)),
    loadTrackMapRows(db),
  ]);

  const statuses = await effectiveTaskStatuses(db, taskRows.map((t) => t.id));
  const map = buildTrackMap(mapRows);
  const currentStop = map.currentStopId
    ? mapRows.stops.find((s) => s.id === map.currentStopId) ?? null
    : null;

  type RawSuggestion = { id: string; kind: string; created_at: string | Date; proposed: unknown;
    document_title: string | null; email_subject: string | null };
  return waitingOnMartin({
    proposals,
    requests,
    suggestions: (suggestions.rows as RawSuggestion[]).map((r) => ({
      id: r.id, kind: r.kind, createdAt: new Date(r.created_at), proposed: r.proposed,
      documentTitle: r.document_title, emailSubject: r.email_subject,
    })),
    tasks: taskRows.map((t) => ({ ...t, status: statuses.get(t.id) ?? "open" })),
    currentStop,
    now,
  });
}

/** Every request with the proposal it drafted, for `requestThreads`. */
export async function loadRequestThreadRows(db: Db): Promise<RequestThreadRow[]> {
  const rows = await db.select({
    id: schema.requests.id, parentRequestId: schema.requests.parentRequestId, text: schema.requests.text,
    title: schema.requests.title, status: schema.requests.status, createdAt: schema.requests.createdAt,
    answeredAt: schema.requests.answeredAt, openedAt: schema.requests.openedAt,
    dismissedAt: schema.requests.dismissedAt, updatedAt: schema.requests.updatedAt,
    martinSteps: schema.requests.martinSteps, stepsDone: schema.requests.stepsDone,
    proposalId: schema.proposals.id, proposalStatus: schema.proposals.status,
    proposalPriority: schema.proposals.priority,
  }).from(schema.requests)
    .leftJoin(schema.proposals, eq(schema.proposals.id, schema.requests.proposalId));
  return rows.map(({ proposalId, proposalStatus, proposalPriority, ...r }) => ({
    ...r, status: r.status as string,
    martinSteps: r.martinSteps ?? [], stepsDone: r.stepsDone ?? {},
    proposal: proposalId ? { id: proposalId, status: proposalStatus!, priority: proposalPriority! } : null,
  }));
}
