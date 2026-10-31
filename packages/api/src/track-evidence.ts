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

import { and, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveTitleSql, notDiscardedSql } from "./effective-status";
import { effectiveTaskStatuses } from "./task-decide";

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

// effectiveTaskStatuses moved to task-decide.ts, beside the single-task
// version it must stay in lockstep with, once the proposal context became its
// second caller. Re-exported so the map's imports do not move.
export { effectiveTaskStatuses };

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
        // effectiveTitleSql, not a fourth hand-written COALESCE: a document's
        // status and title are APPENDED to document_status_changes and never
        // written back, and the shared expression is the only one that reads
        // the newest row that NAMES the title rather than simply the newest
        // row. Resolving it per id with effectiveDocument would be the N+1
        // this module exists to avoid, so it runs in SQL.
        title: effectiveTitleSql,
        mime: schema.documents.mime, source: schema.documents.source,
        sourceRef: schema.documents.sourceRef,
      }).from(schema.documents).where(and(
        inArray(schema.documents.id, allDocIds),
        // IS DISTINCT FROM, not <>: the subquery is NULL for a document nobody
        // ever touched, and NULL <> 'discarded' is NULL — which would drop
        // every document Martin has not filed or discarded.
        notDiscardedSql))
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
