import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "@verder/db";
import { effectiveTaskStatuses } from "./task-decide";
import { effectiveDocStatusSql, effectivePartyIdSql, effectiveTitleSql, notDiscardedSql, notPurgedSql, purgedSql } from "./effective-status";
import {
  briefSummary, buildTalkingPoints, UNANSWERED_MAX_DAYS,
  type BriefSummary, type TalkingPoint, type TalkingPointsInput,
} from "./talking-points";

/**
 * The one loader for a party's talking points (talking-points.ts is the pure
 * half and holds the ranking; this file holds every rule that needs the
 * database). READ-ONLY: nothing here writes, and nothing appends a ledger
 * event — the talking points are a view of the dossier, not part of it.
 *
 * "The party" is the party AND its contact persons (`parent_party_id`): Ilse
 * writes for Bewindkantoor Noordkust, and her mail is the office's request.
 */

export interface PartyTalkingPoints {
  /** `phone` is what the call sheet's "Bel" dials; null when none is recorded. */
  party: { id: string; name: string; phone: string | null };
  tell: TalkingPoint[];
  ask: TalkingPoint[];
  summary: BriefSummary | null;
}

/** ASCII-only lower-casing: an address is never Unicode-folded (mail/relevance.ts). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

/** A header with its quoted display names and comments removed. */
const stripped = (h: string) => h.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\((?:[^()\\]|\\.)*\)/g, " ");

/**
 * Every address in a To/From header. Display names and comments are removed
 * FIRST, so `"ilse@noordkust.example" <someone@else.example>` is someone else —
 * the spoof `senderAddress` in apps/worker/src/gmail.ts was hardened against.
 * This is a display reading (a point on a screen), not a binding: nothing here
 * is written anywhere, so a header it cannot read costs a missing point.
 */
export function addressesIn(header: string): string[] {
  const out: string[] = [];
  for (const part of stripped(header).split(",")) {
    const angle = /<([^<>]*)>/.exec(part);
    const candidate = (angle ? angle[1] : part).trim();
    if (ADDRESS.test(candidate)) out.push(asciiLower(candidate));
  }
  return out;
}

interface MailRow {
  id: string; gmailMessageId: string; gmailThreadId: string; messageId: string | null;
  fromAddr: string; toAddr: string; subject: string; sentAt: Date;
}

const MAIL_CANDIDATES = 300;

/** An `IN (…)` list; an empty one matches nothing (`IN (NULL)`), never everything. */
const uuids = (ids: string[]) => (ids.length ? sql.join(ids.map((d) => sql`${d}::uuid`), sql`, `) : sql`NULL::uuid`);
const texts = (ids: string[]) => (ids.length ? sql.join(ids.map((d) => sql`${d}`), sql`, `) : sql`NULL`);

export async function loadTalkingPoints(db: Db, partyId: string, now = new Date()): Promise<PartyTalkingPoints> {
  const [party] = await db.select({
    id: schema.parties.id, name: schema.parties.name, email: schema.parties.email, phone: schema.parties.phone,
  })
    .from(schema.parties).where(eq(schema.parties.id, partyId));
  if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "Party not found" });
  const contacts = await db.select({ id: schema.parties.id, email: schema.parties.email })
    .from(schema.parties).where(eq(schema.parties.parentPartyId, partyId));
  const partyIds = [party.id, ...contacts.map((c) => c.id)];
  const emails = new Set([party.email, ...contacts.map((c) => c.email)]
    .filter((e): e is string => !!e && ADDRESS.test(e.trim())).map((e) => asciiLower(e.trim())));

  // ---- mail to and from them ----------------------------------------------
  // strpos(lower()) is only a CANDIDATE filter (it may over-match); membership
  // is decided below on parsed, ASCII-folded addresses.
  let mails: MailRow[] = [];
  if (emails.size > 0) {
    const r = schema.rawEmails;
    mails = await db.select({
      id: r.id, gmailMessageId: r.gmailMessageId, gmailThreadId: r.gmailThreadId, messageId: r.messageId,
      fromAddr: r.fromAddr, toAddr: r.toAddr, subject: r.subject, sentAt: r.sentAt,
    }).from(r)
      .where(or(...[...emails].map((e) =>
        sql`strpos(lower(${r.fromAddr}), ${e}) > 0 OR strpos(lower(${r.toAddr}), ${e}) > 0`)))
      .orderBy(desc(r.sentAt), desc(r.id)).limit(MAIL_CANDIDATES);
  }
  const isFromThem = (m: MailRow) => addressesIn(m.fromAddr).some((a) => emails.has(a));
  const inbound = mails.filter(isFromThem);
  const outbound = mails.filter((m) => !isFromThem(m) && addressesIn(m.toAddr).some((a) => emails.has(a)));
  const lastRequestAt = inbound.reduce<Date | null>((max, m) => (!max || m.sentAt > max ? m.sentAt : max), null);
  /** Their first mail in that thread after `after`: the follow-up clock's "reply". */
  const replyIn = (threadId: string | null, after: Date): Date | null => {
    if (!threadId) return null;
    const replies = inbound.filter((m) => m.gmailThreadId === threadId && m.sentAt > after);
    return replies.reduce<Date | null>((min, m) => (!min || m.sentAt < min ? m.sentAt : min), null);
  };

  // ---- proposals verder sent them, on Martin's approval ----------------------
  const since = new Date(now.getTime() - UNANSWERED_MAX_DAYS * 24 * 3600 * 1000);
  const sentProposals = await db.select({
    id: schema.proposals.id, sentAt: schema.proposals.sentAt, gmailThreadId: schema.proposals.gmailThreadId,
    gmailMessageId: schema.proposals.gmailMessageId, messageId: schema.proposals.messageId,
    payload: schema.proposals.payload, finalPayload: schema.proposals.finalPayload,
  }).from(schema.proposals)
    .where(and(eq(schema.proposals.status, "sent"), inArray(schema.proposals.partyId, partyIds)));
  const proposalCopies = new Set(sentProposals.flatMap((p) => [p.gmailMessageId, p.messageId].filter(Boolean) as string[]));
  const field = (o: unknown, k: string): unknown =>
    o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  const sent: TalkingPointsInput["sent"] = [];
  const sentDocs: { id: string; at: Date }[] = [];
  for (const p of sentProposals) {
    if (!p.sentAt) continue;
    sent.push({
      id: p.id, type: "proposal", sentAt: p.sentAt, repliedAt: replyIn(p.gmailThreadId, p.sentAt),
      subject: text(field(p.finalPayload, "subject")) ?? text(field(p.payload, "ask")) ?? "(geen onderwerp)",
    });
    const atts = field(p.finalPayload, "attachmentDocumentIds");
    if (Array.isArray(atts)) for (const id of atts) if (typeof id === "string") sentDocs.push({ id, at: p.sentAt });
  }
  // Martin's own outbound mail — unless it is a sent proposal's re-ingested
  // copy, which the proposal already stands for (as `proposalForOwnSentMail`).
  const ownMail = outbound.filter((m) => !proposalCopies.has(m.gmailMessageId) && !(m.messageId && proposalCopies.has(m.messageId)));
  for (const m of ownMail) {
    if (m.sentAt < since) continue;
    sent.push({ id: m.id, type: "mail", subject: m.subject.trim() || "(geen onderwerp)", sentAt: m.sentAt,
      repliedAt: replyIn(m.gmailThreadId, m.sentAt) });
  }

  // ---- debts they are on ---------------------------------------------------
  const debtRows = await db.selectDistinct({
    id: schema.debts.id, creditorName: schema.debts.creditorName,
    claimedCents: schema.debts.claimedCents, reference: schema.debts.references_,
  }).from(schema.debts)
    .leftJoin(schema.debtParties, eq(schema.debtParties.debtId, schema.debts.id))
    .where(or(inArray(schema.debts.creditorPartyId, partyIds), inArray(schema.debtParties.partyId, partyIds)));
  const debtIds = debtRows.map((d) => d.id);

  // ---- documents: sent to them, or filed from them / on their debts ---------
  const ownMailIds = ownMail.filter((m) => m.sentAt >= since).map((m) => m.gmailMessageId);
  const sentDocIds = [...new Set(sentDocs.map((d) => d.id))];
  // `documents` unaliased, because the shared expressions assume it.
  const docRows = (await db.execute(sql`
    SELECT documents.id, documents.source_ref, ${effectiveTitleSql} AS title,
      ${effectiveDocStatusSql} AS status, ${purgedSql} AS purged,
      ${effectivePartyIdSql} AS party_id,
      COALESCE((SELECT max(c.created_at) FROM document_status_changes c
        WHERE c.document_id = documents.id AND c.status = 'filed'), documents.received_at) AS filed_at,
      EXISTS (SELECT 1 FROM debt_documents dd WHERE dd.document_id = documents.id
        AND dd.debt_id IN (${uuids(debtIds)})) AS on_debt
    FROM documents
    WHERE ${notDiscardedSql} AND ${notPurgedSql} AND (
      documents.id IN (${uuids(sentDocIds)})
      OR (documents.source = 'email-attachment'
        AND documents.source_ref IN (${texts(ownMailIds)}))
      OR ${effectivePartyIdSql} IN (${uuids(partyIds)})
      OR EXISTS (SELECT 1 FROM debt_documents dd WHERE dd.document_id = documents.id
        AND dd.debt_id IN (${uuids(debtIds)}))
    )`)).rows as {
      id: string; source_ref: string | null; title: string; status: string; purged: boolean;
      party_id: string | null; filed_at: string | Date; on_debt: boolean }[];

  const mailSentAt = new Map(ownMail.map((m) => [m.gmailMessageId, m.sentAt]));
  const documents: TalkingPointsInput["documents"] = [];
  for (const d of docRows) {
    const base = { id: d.id, title: d.title, status: d.status, purged: d.purged === true };
    const sentAt = [
      ...sentDocs.filter((s) => s.id === d.id).map((s) => s.at),
      ...(d.source_ref && mailSentAt.has(d.source_ref) ? [mailSentAt.get(d.source_ref)!] : []),
    ].sort((a, b) => b.getTime() - a.getTime())[0];
    if (sentAt) documents.push({ ...base, how: "sent", at: sentAt });
    else if (d.status === "filed" && ((d.party_id && partyIds.includes(d.party_id)) || d.on_debt)) {
      documents.push({ ...base, how: "filed", at: new Date(d.filed_at) });
    }
  }

  // ---- tasks linked to them --------------------------------------------------
  const taskRows = await db.selectDistinct({
    id: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt, createdAt: schema.tasks.createdAt,
  }).from(schema.tasks)
    .leftJoin(schema.proposals, eq(schema.proposals.createdTaskId, schema.tasks.id))
    .where(or(
      inArray(schema.tasks.assigneePartyId, partyIds),
      debtIds.length ? inArray(schema.tasks.debtId, debtIds) : sql`false`,
      inArray(schema.proposals.partyId, partyIds),
    ));
  const taskIds = taskRows.map((t) => t.id);
  const statuses = await effectiveTaskStatuses(db, taskIds);
  // When the effective status was set: the same "latest" as effectiveTaskStatuses (ledger seq).
  const statusAt = new Map<string, Date>();
  if (taskIds.length) {
    const rows = await db.selectDistinctOn([schema.taskStatusChanges.taskId], {
      taskId: schema.taskStatusChanges.taskId, createdAt: schema.taskStatusChanges.createdAt,
    }).from(schema.taskStatusChanges)
      .innerJoin(schema.ledgerEvents, and(
        eq(schema.ledgerEvents.entityId, schema.taskStatusChanges.id),
        eq(schema.ledgerEvents.eventType, "task.status")))
      .where(inArray(schema.taskStatusChanges.taskId, taskIds))
      .orderBy(schema.taskStatusChanges.taskId, desc(schema.ledgerEvents.seq));
    for (const r of rows) statusAt.set(r.taskId, r.createdAt);
  }

  // ---- open stops on a spoor that concerns them --------------------------------
  // A spoor concerns them when one of its stops carries their task, their
  // document, or a log entry they took part in. Never by matching a title.
  const docIds = documents.map((d) => d.id);
  const stopRows = (await db.execute(sql`
    SELECT s.id, s.title, COALESCE(s.happened_at, s.expected_at) AS at
    FROM stops s
    WHERE s.state = 'open' AND s.track_id IN (
      SELECT o.track_id FROM stops o
      WHERE o.task_id IN (${uuids(taskIds)})
        OR o.document_id IN (${uuids(docIds)})
        OR o.entry_id IN (SELECT ep.entry_id FROM entry_participants ep
          WHERE ep.party_id IN (${uuids(partyIds)})))`)).rows as {
      id: string; title: string; at: string | Date | null }[];

  // ---- the AI line ---------------------------------------------------------------
  const [brief] = await db.select().from(schema.partyBriefs).where(eq(schema.partyBriefs.partyId, partyId));

  const points = buildTalkingPoints({
    now, lastRequestAt,
    tasks: taskRows.map((t) => ({ ...t, status: statuses.get(t.id) ?? "open", statusAt: statusAt.get(t.id) ?? null })),
    sent,
    debts: debtRows,
    documents,
    openStops: stopRows.map((s) => ({ id: s.id, title: s.title, at: s.at ? new Date(s.at) : null })),
  });
  return { party: { id: party.id, name: party.name, phone: party.phone }, ...points, summary: briefSummary(brief ?? null) };
}
