/**
 * What is really behind a stop: the logbook entry, the task and its effective
 * status, the documents, and the e-mail those documents came off.
 *
 * DERIVED, NEVER STORED. This is the map's third level — the mail and its files
 * hanging off a stop — and it is resolved on read precisely so it cannot go
 * stale. A stop points; this module follows the pointer.
 *
 * Every lookup is BATCHED: one query per link type for the whole map, never one
 * per stop. Fifty stops on a map is normal and fifty round trips is not.
 *
 * Defensive throughout: a source_ref matching no e-mail yields NO e-mail link,
 * never an error. A stop can legitimately point at something that has been
 * discarded or was never there.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";

export interface EvidenceInput {
  id: string;
  entryId: string | null;
  taskId: string | null;
  documentId: string | null;
}

export interface StopEvidence {
  entry: {
    id: string; summary: string; occurredAt: Date; channel: string; direction: string;
  } | null;
  task: { id: string; title: string; status: string; dueAt: Date | null } | null;
  documents: { id: string; title: string; mime: string }[];
  email: {
    id: string; subject: string; fromAddr: string; sentAt: Date; gmailMessageId: string;
  } | null;
}

const EMPTY: StopEvidence = { entry: null, task: null, documents: [], email: null };

const idsOf = <T>(rows: T[], pick: (r: T) => string | null) =>
  [...new Set(rows.map(pick).filter((v): v is string => v !== null))];

/**
 * A document's status and title are APPENDED to document_status_changes and
 * never written back to the documents row, so a raw read calls a discarded
 * signature image "inbox" forever. effectiveDocument resolves that per id —
 * which here would be one extra query per document, the N+1 this module exists
 * to avoid — so the same resolution runs in SQL, exactly as documents.list
 * does it: latest change row wins, falling back to the document's own column.
 */
export const latestDocumentChange = (column: "status" | "title") =>
  sql`(SELECT c.${sql.raw(column)} FROM document_status_changes c
    WHERE c.document_id = documents.id ORDER BY c.created_at DESC LIMIT 1)`;

/**
 * effectiveTaskStatus for many tasks in ONE query.
 *
 * MUST STAY IN LOCKSTEP WITH effectiveTaskStatus (task-decide.ts): same join,
 * same definition of "latest" — the ledger seq of the task.status event, never
 * createdAt, because createdAt is the transaction timestamp and two changes
 * made in one transaction tie exactly — and the same "open" default for a task
 * nobody has decided on. This is the exact shape effectiveStatuses in
 * registry-decide.ts already uses for financial items, deliberately: DISTINCT
 * ON keeps one row per task, and Postgres requires the ORDER BY to lead with
 * the DISTINCT ON expression, so the seq ordering sits behind it as the
 * tiebreaker — which is precisely the LIMIT 1 the single-task version does.
 *
 * It lives here rather than beside effectiveTaskStatus only because the map is
 * its one caller today; move it to task-decide.ts the moment a second surface
 * needs it, and keep the three in lockstep.
 *
 * The returned Map has an entry for EVERY id asked about, so a caller never has
 * to re-apply the default and the two functions cannot drift on it.
 */
export async function effectiveTaskStatuses(
  db: Db, taskIds: string[]
): Promise<Map<string, string>> {
  const statuses = new Map(taskIds.map((id) => [id, "open"]));
  if (taskIds.length === 0) return statuses;
  const rows = await db
    .selectDistinctOn([schema.taskStatusChanges.taskId], {
      taskId: schema.taskStatusChanges.taskId,
      status: schema.taskStatusChanges.status,
    })
    .from(schema.taskStatusChanges)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.taskStatusChanges.id),
      eq(schema.ledgerEvents.eventType, "task.status"),
    ))
    .where(inArray(schema.taskStatusChanges.taskId, taskIds))
    .orderBy(schema.taskStatusChanges.taskId, desc(schema.ledgerEvents.seq));
  for (const r of rows) statuses.set(r.taskId, r.status);
  return statuses;
}

export async function resolveStopEvidence(
  db: Db, stops: EvidenceInput[]
): Promise<Map<string, StopEvidence>> {
  const out = new Map<string, StopEvidence>(stops.map((s) => [s.id, { ...EMPTY }]));
  if (stops.length === 0) return out;

  const entryIds = idsOf(stops, (s) => s.entryId);
  const taskIds = idsOf(stops, (s) => s.taskId);
  const directDocIds = idsOf(stops, (s) => s.documentId);

  const [entries, tasks, entryDocs] = await Promise.all([
    entryIds.length
      ? db.select({
          id: schema.logEntries.id, summary: schema.logEntries.summary,
          occurredAt: schema.logEntries.occurredAt, channel: schema.logEntries.channel,
          direction: schema.logEntries.direction,
        }).from(schema.logEntries).where(inArray(schema.logEntries.id, entryIds))
      : [],
    taskIds.length
      ? db.select({
          id: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt,
        }).from(schema.tasks).where(inArray(schema.tasks.id, taskIds))
      : [],
    entryIds.length
      ? db.select().from(schema.entryDocuments)
          .where(inArray(schema.entryDocuments.entryId, entryIds))
      : [],
  ]);

  const allDocIds = [...new Set([...directDocIds, ...entryDocs.map((d) => d.documentId)])];
  const documents = allDocIds.length
    ? await db.select({
        id: schema.documents.id,
        title: sql<string>`COALESCE(${latestDocumentChange("title")}, documents.title)`,
        mime: schema.documents.mime, source: schema.documents.source,
        sourceRef: schema.documents.sourceRef,
      }).from(schema.documents).where(and(
        inArray(schema.documents.id, allDocIds),
        // IS DISTINCT FROM, not <>: the subquery is NULL for a document nobody
        // ever touched, and NULL <> 'discarded' is NULL — which would drop
        // every document Martin has not filed or discarded.
        sql`COALESCE(${latestDocumentChange("status")}, documents.status)
          IS DISTINCT FROM 'discarded'`))
    : [];

  // The e-mail: an attachment carries its Gmail message id in source_ref, which
  // is the same value raw_emails.gmail_message_id holds.
  const messageIds = idsOf(
    documents.filter((d) => d.source === "email-attachment"), (d) => d.sourceRef);
  const emails = messageIds.length
    ? await db.select({
        id: schema.rawEmails.id, subject: schema.rawEmails.subject,
        fromAddr: schema.rawEmails.fromAddr, sentAt: schema.rawEmails.sentAt,
        gmailMessageId: schema.rawEmails.gmailMessageId,
      }).from(schema.rawEmails)
        .where(inArray(schema.rawEmails.gmailMessageId, messageIds))
    : [];

  // Task status lives in task_status_changes ordered by ledger seq, never on the
  // task row. ONE query for every linked task — calling effectiveTaskStatus per
  // task looked batched next to the fifty stops and was not: fifty stops on
  // fifty tasks cost fifty round trips.
  const statuses = await effectiveTaskStatuses(db, taskIds);

  const docById = new Map(documents.map((d) => [d.id, d]));
  const emailByMessageId = new Map(emails.map((e) => [e.gmailMessageId, e]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const docsByEntry = new Map<string, string[]>();
  for (const link of entryDocs) {
    const list = docsByEntry.get(link.entryId);
    if (list) list.push(link.documentId);
    else docsByEntry.set(link.entryId, [link.documentId]);
  }

  for (const s of stops) {
    const docIds = [
      ...(s.documentId ? [s.documentId] : []),
      ...(s.entryId ? docsByEntry.get(s.entryId) ?? [] : []),
    ];
    // A pointer that resolves to nothing — a discarded attachment, a document
    // that is simply not there — yields no link, never an error.
    const docs = [...new Set(docIds)]
      .map((id) => docById.get(id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    const task = s.taskId ? taskById.get(s.taskId) : undefined;
    const messageId = docs.find(
      (d) => d.source === "email-attachment" && d.sourceRef)?.sourceRef ?? null;

    out.set(s.id, {
      entry: (s.entryId && entryById.get(s.entryId)) || null,
      task: task
        ? { id: task.id, title: task.title, dueAt: task.dueAt,
            status: statuses.get(task.id) ?? "open" }
        : null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, mime: d.mime })),
      email: (messageId && emailByMessageId.get(messageId)) || null,
    });
  }
  return out;
}
