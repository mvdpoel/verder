import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { buildTrackMap, type StopRow } from "./track-map";
import { effectiveTaskStatuses } from "./task-decide";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "./effective-status";
import { loadTrackMapRows } from "./routers/tracks";

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

/** `request` (Vraag Grip): an ANSWERED request Martin has not opened yet. A
 *  queued or working one waits on Grip, not on him, and is not listed here. */
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
}

/** An answered request Martin has not opened (Vraag Grip). */
export interface RequestRow {
  id: string;
  text: string;
  answeredAt: Date;
}

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

const REQUEST_TITLE_MAX = 120;

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

  // 1 and 2: Verder-priority proposals, then the others and the questions.
  const proposals = byAt(input.proposals);
  const verderFirst = [
    ...proposals.filter((p) => p.priority === "verder"),
    ...proposals.filter((p) => p.priority !== "verder"),
  ].map(proposalItem);

  // 2: answered requests he has not opened — his own question, answered.
  const requests = [...(input.requests ?? [])]
    .sort((a, b) => newestFirst({ at: a.answeredAt, id: a.id }, { at: b.answeredAt, id: b.id }))
    .map((r): WaitingItem => {
      const t = r.text.trim().replace(/\s+/g, " ");
      return {
        kind: "request", id: r.id,
        title: t.length > REQUEST_TITLE_MAX ? `${t.slice(0, REQUEST_TITLE_MAX - 1)}…` : t,
        subtitle: "Grip heeft het uitgezocht", priority: 2,
        at: r.answeredAt.toISOString(), dueAt: null, verder: false, partyId: null,
      };
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

  return [...verderFirst, ...requests, ...suggestions, ...tasks, ...stopItems];
}

/**
 * The one loader. Every membership rule that needs the database lives here:
 *
 * - Requests (Vraag Grip): answered and not yet opened. Queued and working
 *   requests wait on Grip; a failed one is shown on the phone's request list
 *   ("Lukte niet · Opnieuw") but does not count, because nothing he can decide
 *   is in it.
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
      senderGuess: schema.proposals.senderGuess,
    }).from(schema.proposals)
      .leftJoin(schema.parties, eq(schema.parties.id, schema.proposals.partyId))
      .where(eq(schema.proposals.status, "pending")),
    db.select({ id: schema.requests.id, text: schema.requests.text, answeredAt: schema.requests.answeredAt })
      .from(schema.requests)
      .where(and(eq(schema.requests.status, "answered"), isNull(schema.requests.openedAt))),
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
    // answered_at is NOT NULL whenever status = 'answered' (requests_answered_ck).
    requests: requests.map((r) => ({ id: r.id, text: r.text, answeredAt: r.answeredAt ?? new Date(0) })),
    suggestions: (suggestions.rows as RawSuggestion[]).map((r) => ({
      id: r.id, kind: r.kind, createdAt: new Date(r.created_at), proposed: r.proposed,
      documentTitle: r.document_title, emailSubject: r.email_subject,
    })),
    tasks: taskRows.map((t) => ({ ...t, status: statuses.get(t.id) ?? "open" })),
    currentStop,
    now,
  });
}
