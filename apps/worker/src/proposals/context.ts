import { readFile } from "node:fs/promises";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { dayKey } from "@verder/api/src/amsterdam";
import {
  effectivePartyIdSql, effectiveTitleSql, notDiscardedSql, notPurgedSql,
} from "@verder/api/src/effective-status";
import { readFilePath } from "@verder/api/src/storage";
import { effectiveTaskStatuses } from "@verder/api/src/task-decide";
import { resolveSenderPartyId, senderAddress } from "../gmail";
import { matchesList, type LetterSender } from "../mail/priority";
import { normaliseMessageId } from "../mail/message-id";
import { operatorAddresses, ownMailboxAddresses, sanitizeAddresses } from "../mail/relevance";
import {
  headerFields, mailboxList, replyHeaders, replySubject, threadAncestry, threadingHeaders,
} from "../mail/threading";
import type { RetrieveRefsFn } from "../retrieval-refs";

/**
 * WHAT THE DRAFTER IS ALLOWED TO KNOW, AND THEREFORE TO CITE (spec §6.5).
 *
 * Everything a proposal may rely on is assembled here, each item carrying the
 * id of the row it came from, so that the drafter can say what it relied on and
 * `validateDraft` (Task 14) can refuse anything it did not get from here. Three
 * of the lists are not merely context but the WHOLE of what a draft may use:
 *
 *   - `attachable` — the only documents a draft may attach. Effectively not
 *     discarded and not purged, resolved through the same predicates every
 *     other surface uses (`notDiscardedSql`/`notPurgedSql`), because a
 *     discard is never written back to `documents.status`.
 *   - `addresses` — the only recipients. Built from PARSED mailboxes with the
 *     strict `senderAddress`, never `addressesInHeader`, which reads a display
 *     name as an address: `"demi@verdergroep.nl" <attacker@evil.tld>` must
 *     contribute nothing, neither the decoy nor the attacker. A candidate is
 *     kept only when it falls under the operator list (whole domain or whole
 *     address, `matchesList`) or IS a party's address, and never when it is
 *     Martin's own. The single exception is the mail agent's external message,
 *     whose sender the watchlist already chose (Task 20).
 *   - `tasks`/`debts` — the only targets a question's options may act on.
 *
 * A JMAP thread id is a Stalwart id and a Gmail thread id is Gmail's, so a
 * thread is the rows sharing `gmail_thread_id` AND `source`; joining across the
 * two namespaces would hand the drafter a stranger's conversation.
 *
 * Reads only. Writes nothing, appends nothing.
 */

export interface ContextItem {
  type: "email" | "entry" | "debt" | "task" | "stop" | "document" | "party" | "kb" | "proposal";
  id: string;
  label: string;
  text?: string;
  /** For a thread email: its effective (not discarded, not purged) attachments. */
  attachments?: ContextItem[];
  /** For a task: its effective status when the context was gathered, so
   *  `validateDraft` can judge a `set-task-status` option without the DB. */
  status?: string;
}

export interface ProposalContext {
  trigger: ContextItem;
  thread: ContextItem[];
  party: ContextItem | null;
  parentParty: ContextItem | null;
  entries: ContextItem[];
  debts: ContextItem[];
  tasks: ContextItem[];
  stops: ContextItem[];
  kb: ContextItem[];
  sentDocuments: ContextItem[];
  attachable: ContextItem[];
  addresses: string[];
  threadKey: string | null;
  gmailThreadId: string | null;
  reply: { inReplyTo?: string; references?: string; subject: string } | null;
}

/** The mail agent's non-dossier message (Task 20), as stored in
 *  `proposals.trigger_external`. */
export interface ExternalMail {
  gmailId: string; threadId: string; messageId: string | null;
  from: string; to: string; subject: string; date: string; body: string;
}

export type ProposalTrigger =
  | { rawEmailId: string }
  | { documentId: string; senderGuess: LetterSender }
  | { taskId: string }
  | { external: ExternalMail }
  | { parentProposalId: string };

export interface ContextDeps { db: Db; retrieveRefs: RetrieveRefsFn; vaultDir: string }

const TRIGGER_TEXT_CHARS = 6000;
const THREAD_TEXT_CHARS = 2000;
const KB_BODY_CHARS = 2000;
const MAX_ENTRIES = 20;
const MAX_KB = 5;
/** A follow-up of a follow-up of …: bounded so a cycle cannot hang the job. */
const MAX_PARENT_DEPTH = 5;
const LIVE_TASK_STATUSES = new Set(["open", "in-progress", "waiting"]);

type RawRow = typeof schema.rawEmails.$inferSelect;
type Reply = NonNullable<ProposalContext["reply"]>;

/** What one trigger contributes before the party-centred gathering. */
interface Base {
  trigger: ContextItem;
  thread: ContextItem[];
  partyId: string | null;
  kbQuery: string;
  reply: Reply | null;
  threadKey: string | null;
  gmailThreadId: string | null;
  /** Single-mailbox strings, each judged by `senderAddress` + the address rule. */
  candidates: string[];
  /** Addresses admitted without the operator/party rule (already decided). */
  admitted: string[];
  docIds: string[];
  debtIds: string[];
  taskIds: string[];
}

const clip = (s: string | null | undefined, n: number): string | undefined =>
  s ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const euro = (cents: number | null): string =>
  cents == null ? "bedrag onbekend" : `€ ${(cents / 100).toFixed(2).replace(".", ",")}`;

async function readRaw(vaultDir: string, sha256: string): Promise<Buffer | null> {
  try { return await readFile(readFilePath(vaultDir, sha256)); } catch { return null; }
}

/** Effective, live documents by id, in the order asked. */
async function liveDocuments(db: Db, ids: string[]): Promise<ContextItem[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: schema.documents.id, title: effectiveTitleSql })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, ids), notDiscardedSql, notPurgedSql));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uniq(ids).flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ type: "document" as const, id: r.id, label: r.title }] : [];
  });
}

/** Rows of the trigger's thread, oldest first, never across namespaces. */
async function threadRows(db: Db, row: RawRow): Promise<RawRow[]> {
  return db.select().from(schema.rawEmails)
    .where(and(eq(schema.rawEmails.gmailThreadId, row.gmailThreadId),
      eq(schema.rawEmails.source, row.source)))
    .orderBy(asc(schema.rawEmails.sentAt), asc(schema.rawEmails.id));
}

function emailItem(row: RawRow, attachments: ContextItem[], textChars: number): ContextItem {
  return {
    type: "email", id: row.id,
    label: `${dayKey(row.sentAt)} · ${row.fromAddr} — ${row.subject}`,
    text: clip(row.bodyText, textChars), attachments,
  };
}

/** Every mailbox of the To and Cc headers. `to` comes from the row (both ports
 *  store it); Cc only exists in the raw bytes. */
function listCandidates(toHeader: string, raw: Buffer | null): string[] {
  const cc = raw ? (headerFields(raw) ?? []).filter((f) => f.name === "cc").map((f) => f.value) : [];
  return [toHeader, ...cc].flatMap(mailboxList);
}

async function fromRawEmail(deps: ContextDeps, rawEmailId: string): Promise<Base> {
  const { db } = deps;
  const [row] = await db.select().from(schema.rawEmails).where(eq(schema.rawEmails.id, rawEmailId));
  if (!row) throw new Error(`raw email ${rawEmailId} not found`);
  const rows = await threadRows(db, row);
  const atts = rows.length === 0 ? [] : await db
    .select({ id: schema.documents.id, title: effectiveTitleSql, sourceRef: schema.documents.sourceRef })
    .from(schema.documents)
    .where(and(eq(schema.documents.source, "email-attachment"),
      inArray(schema.documents.sourceRef, rows.map((r) => r.gmailMessageId)),
      notDiscardedSql, notPurgedSql))
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
  const raws = new Map<string, Buffer | null>();
  for (const r of rows) raws.set(r.id, await readRaw(deps.vaultDir, r.rawRfc822Sha256));

  const thread = rows.map((r) => emailItem(r,
    atts.filter((a) => a.sourceRef === r.gmailMessageId)
      .map((a) => ({ type: "document" as const, id: a.id, label: a.title })),
    r.id === row.id ? TRIGGER_TEXT_CHARS : THREAD_TEXT_CHARS));
  const trigger = thread.find((t) => t.id === row.id) ?? emailItem(row, [], TRIGGER_TEXT_CHARS);

  // The counterparty. Martin's own outbound (a follow-up's trigger) is from
  // him, so the party is whoever he wrote to.
  const own = ownMailboxAddresses();
  const fromAddr = senderAddress(row.fromAddr);
  let partyId: string | undefined;
  if (fromAddr && !own.includes(fromAddr)) partyId = await resolveSenderPartyId(db, fromAddr);
  else if (fromAddr) {
    for (const m of mailboxList(row.toAddr)) {
      const a = senderAddress(m);
      if (a && !own.includes(a)) partyId = await resolveSenderPartyId(db, a);
      if (partyId) break;
    }
  }

  const raw = raws.get(row.id) ?? null;
  const h = raw ? threadingHeaders(raw) : { messageId: null, inReplyTo: null, references: [] };
  const reply: Reply = {
    ...replyHeaders({ messageId: h.messageId ?? row.messageId, references: threadAncestry(h) }),
    subject: replySubject(row.subject),
  };
  const isGmail = row.source === "gmail";
  return {
    trigger, thread, partyId: partyId ?? null,
    kbQuery: `${row.subject}\n${row.bodyText.slice(0, KB_BODY_CHARS)}`,
    reply, threadKey: isGmail ? `gmail:${row.gmailThreadId}` : null,
    gmailThreadId: isGmail ? row.gmailThreadId : null,
    candidates: rows.flatMap((r) => [r.fromAddr, ...listCandidates(r.toAddr, raws.get(r.id) ?? null)]),
    admitted: [], docIds: atts.map((a) => a.id), debtIds: [], taskIds: [],
  };
}

async function fromLetter(deps: ContextDeps, documentId: string, guess: LetterSender): Promise<Base> {
  const { db } = deps;
  const [d] = await db.select({
    id: schema.documents.id, title: effectiveTitleSql, partyId: effectivePartyIdSql,
  }).from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!d) throw new Error(`document ${documentId} not found`);
  const [t] = await db.select({ text: schema.documentTexts.text }).from(schema.documentTexts)
    .where(eq(schema.documentTexts.documentId, documentId));
  // For a Verder letter the recipients are Verder's own people the dossier
  // knows: parties whose address falls under the operator list (Task 18).
  const admitted: string[] = [];
  if (guess.kind === "verder") {
    const operator = operatorAddresses().addrs;
    const emails = (await db.select({ email: schema.parties.email }).from(schema.parties))
      .map((p) => p.email ?? "");
    for (const a of sanitizeAddresses(emails, ownMailboxAddresses(), "party").addrs) {
      if (matchesList(operator, a)) admitted.push(a);
    }
  }
  return {
    trigger: { type: "document", id: d.id, label: d.title, text: clip(t?.text, TRIGGER_TEXT_CHARS) },
    thread: [],
    partyId: guess.kind === "creditor" ? guess.partyId : d.partyId,
    kbQuery: `${d.title}\n${(t?.text ?? "").slice(0, KB_BODY_CHARS)}`,
    reply: null, threadKey: null, gmailThreadId: null,
    candidates: [], admitted, docIds: [d.id], debtIds: [], taskIds: [],
  };
}

async function fromTask(deps: ContextDeps, taskId: string): Promise<Base> {
  const [t] = await deps.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (!t) throw new Error(`task ${taskId} not found`);
  return {
    trigger: { type: "task", id: t.id, label: t.title, text: clip(t.details, TRIGGER_TEXT_CHARS) },
    thread: [], partyId: t.assigneePartyId,
    kbQuery: `${t.title}\n${(t.details ?? "").slice(0, KB_BODY_CHARS)}`,
    reply: null, threadKey: null, gmailThreadId: null, candidates: [], admitted: [],
    docIds: t.documentId ? [t.documentId] : [], debtIds: t.debtId ? [t.debtId] : [], taskIds: [t.id],
  };
}

async function fromExternal(deps: ContextDeps, m: ExternalMail): Promise<Base> {
  const sender = senderAddress(m.from);
  const own = ownMailboxAddresses();
  const item: ContextItem = {
    type: "email", id: m.gmailId, label: `${m.date} · ${m.from} — ${m.subject}`,
    text: clip(m.body, TRIGGER_TEXT_CHARS), attachments: [],
  };
  const partyId = sender && !own.includes(sender) ? await resolveSenderPartyId(deps.db, sender) : undefined;
  const id = m.messageId ? normaliseMessageId(m.messageId) : null;
  return {
    trigger: item, thread: [item], partyId: partyId ?? null,
    kbQuery: `${m.subject}\n${m.body.slice(0, KB_BODY_CHARS)}`,
    reply: { ...replyHeaders({ messageId: id, references: [] }), subject: replySubject(m.subject) },
    threadKey: `gmail:${m.threadId}`, gmailThreadId: m.threadId,
    candidates: mailboxList(m.to),
    // The watchlist already chose this correspondent (Task 20).
    admitted: sender ? [sender] : [], docIds: [], debtIds: [], taskIds: [],
  };
}

type ProposalRow = typeof schema.proposals.$inferSelect;

function triggerOf(p: ProposalRow): ProposalTrigger {
  if (p.parentProposalId) return { parentProposalId: p.parentProposalId };
  if (p.triggerRawEmailId) return { rawEmailId: p.triggerRawEmailId };
  if (p.triggerDocumentId) return { documentId: p.triggerDocumentId, senderGuess: p.senderGuess as LetterSender };
  if (p.triggerTaskId) return { taskId: p.triggerTaskId };
  if (p.triggerExternal) return { external: p.triggerExternal as ExternalMail };
  throw new Error(`proposal ${p.id} has no trigger`);
}

/**
 * A follow-up whose last outbound message is a proposal verder sent (Task 17).
 * The thread is the parent's, with the sent message at its end, and the reply
 * answers THAT message — its Message-ID is the one verder generated and Gmail
 * kept (measured in Task 21 before any real send).
 */
async function fromParent(deps: ContextDeps, parentId: string, depth: number): Promise<Base> {
  const [p] = await deps.db.select().from(schema.proposals).where(eq(schema.proposals.id, parentId));
  if (!p) throw new Error(`proposal ${parentId} not found`);
  const base = await baseFor(deps, triggerOf(p), depth + 1);
  const pl = (p.finalPayload ?? p.payload ?? {}) as {
    subject?: unknown; body?: unknown; references?: unknown;
  };
  const subject = typeof pl.subject === "string" ? pl.subject : (base.reply?.subject ?? "");
  const item: ContextItem = {
    type: "proposal", id: p.id,
    label: `${p.sentAt ? dayKey(p.sentAt) : "niet verstuurd"} · verstuurd via verder — ${subject}`,
    text: typeof pl.body === "string" ? clip(pl.body, THREAD_TEXT_CHARS) : undefined,
  };
  const sentId = p.status === "sent" && p.messageId ? normaliseMessageId(p.messageId) : null;
  const refs = typeof pl.references === "string"
    ? [...pl.references.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]) : [];
  return {
    ...base, trigger: item, thread: [...base.thread, item],
    reply: sentId
      ? { ...replyHeaders({ messageId: sentId, references: refs }), subject: replySubject(subject) }
      : base.reply,
    threadKey: p.threadKey ?? base.threadKey,
    gmailThreadId: p.gmailThreadId ?? base.gmailThreadId,
  };
}

async function baseFor(deps: ContextDeps, trigger: ProposalTrigger, depth: number): Promise<Base> {
  if (depth > MAX_PARENT_DEPTH) throw new Error("proposal parent chain too deep");
  if ("rawEmailId" in trigger) return fromRawEmail(deps, trigger.rawEmailId);
  if ("documentId" in trigger) return fromLetter(deps, trigger.documentId, trigger.senderGuess);
  if ("taskId" in trigger) return fromTask(deps, trigger.taskId);
  if ("external" in trigger) return fromExternal(deps, trigger.external);
  return fromParent(deps, trigger.parentProposalId, depth);
}

export async function gatherContext(deps: ContextDeps, trigger: ProposalTrigger): Promise<ProposalContext> {
  const { db } = deps;
  const base = await baseFor(deps, trigger, 0);
  const own = ownMailboxAddresses();
  const operator = operatorAddresses().addrs;

  const parties = await db.select().from(schema.parties);
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const partyAddrs = new Set(sanitizeAddresses(parties.map((p) => p.email ?? ""), own, "party").addrs);
  const partyRow = base.partyId ? partyById.get(base.partyId) ?? null : null;
  const parentRow = partyRow?.parentPartyId ? partyById.get(partyRow.parentPartyId) ?? null : null;
  const partyItem = (p: typeof parties[number]): ContextItem => ({
    type: "party", id: p.id,
    label: p.organization && p.organization !== p.name ? `${p.name} (${p.organization})` : p.name,
    text: [p.email, p.notes].filter(Boolean).join("\n") || undefined,
  });

  // --- the party's log entries: the last MAX_ENTRIES it took part in.
  const entryRows = partyRow ? await db.select({
    id: schema.logEntries.id, occurredAt: schema.logEntries.occurredAt,
    direction: schema.logEntries.direction, channel: schema.logEntries.channel,
    summary: schema.logEntries.summary, details: schema.logEntries.details,
  }).from(schema.logEntries)
    .innerJoin(schema.entryParticipants, eq(schema.entryParticipants.entryId, schema.logEntries.id))
    .where(eq(schema.entryParticipants.partyId, partyRow.id))
    .orderBy(desc(schema.logEntries.occurredAt), desc(schema.logEntries.id))
    .limit(MAX_ENTRIES) : [];
  const entries: ContextItem[] = entryRows.map((e) => ({
    type: "entry", id: e.id,
    label: `${dayKey(e.occurredAt)} · ${e.direction} ${e.channel}: ${e.summary}`,
    text: clip(e.details, THREAD_TEXT_CHARS),
  }));
  const entryIds = entryRows.map((e) => e.id);

  // --- debts: through a debt_parties edge (with its role) or as creditor.
  const roles = new Map<string, string[]>();
  const addRole = (debtId: string, role: string) => roles.set(debtId, [...(roles.get(debtId) ?? []), role]);
  if (partyRow) {
    const edges = await db.select({ debtId: schema.debtParties.debtId, role: schema.debtParties.role })
      .from(schema.debtParties).where(eq(schema.debtParties.partyId, partyRow.id));
    for (const e of edges) addRole(e.debtId, e.role);
    const asCreditor = await db.select({ id: schema.debts.id }).from(schema.debts)
      .where(eq(schema.debts.creditorPartyId, partyRow.id));
    for (const d of asCreditor) addRole(d.id, "schuldeiser");
  }
  for (const id of base.debtIds) if (!roles.has(id)) roles.set(id, []);
  const debtIds = [...roles.keys()];
  const debtRows = debtIds.length === 0 ? [] : await db.select().from(schema.debts)
    .where(inArray(schema.debts.id, debtIds))
    .orderBy(asc(schema.debts.createdAt), asc(schema.debts.id));
  const debts: ContextItem[] = debtRows.map((d) => {
    const r = uniq(roles.get(d.id) ?? []);
    return {
      type: "debt", id: d.id,
      label: `${d.creditorName}${r.length ? ` (${r.join(", ")})` : ""} — ${euro(d.claimedCents)}`,
      text: [d.references_ && `Kenmerk: ${d.references_}`, d.origin].filter(Boolean).join("\n") || undefined,
    };
  });

  // --- tasks still alive (open, in-progress, waiting), linked to the above.
  const taskLinks = [
    ...(debtIds.length ? [inArray(schema.tasks.debtId, debtIds)] : []),
    ...(entryIds.length ? [inArray(schema.tasks.entryId, entryIds)] : []),
    ...(partyRow ? [eq(schema.tasks.assigneePartyId, partyRow.id)] : []),
    ...(base.taskIds.length ? [inArray(schema.tasks.id, base.taskIds)] : []),
  ];
  const taskRows = taskLinks.length === 0 ? [] : await db.select().from(schema.tasks)
    .where(or(...taskLinks)).orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.id));
  const statuses = await effectiveTaskStatuses(db, taskRows.map((t) => t.id));
  const liveTasks = taskRows.filter((t) => LIVE_TASK_STATUSES.has(statuses.get(t.id) ?? "open"));
  const tasks: ContextItem[] = liveTasks.map((t) => ({
    type: "task", id: t.id, status: statuses.get(t.id) ?? "open",
    label: `${t.title} [${statuses.get(t.id)}]${t.dueAt ? ` · uiterlijk ${dayKey(t.dueAt)}` : ""}`,
    text: clip(t.details, THREAD_TEXT_CHARS),
  }));
  const taskIds = liveTasks.map((t) => t.id);

  // --- documents already sent to this party: outbound entries it took part in.
  const sentRows = partyRow ? await db.selectDistinct({
    id: schema.documents.id, title: effectiveTitleSql, createdAt: schema.documents.createdAt,
  }).from(schema.entryDocuments)
    .innerJoin(schema.logEntries, eq(schema.logEntries.id, schema.entryDocuments.entryId))
    .innerJoin(schema.entryParticipants, eq(schema.entryParticipants.entryId, schema.logEntries.id))
    .innerJoin(schema.documents, eq(schema.documents.id, schema.entryDocuments.documentId))
    .where(and(eq(schema.entryParticipants.partyId, partyRow.id),
      eq(schema.logEntries.direction, "outbound")))
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id)) : [];
  const sentDocuments: ContextItem[] = sentRows.map((d) => ({ type: "document", id: d.id, label: d.title }));

  const debtDocIds = debtIds.length === 0 ? [] : (await db
    .select({ id: schema.debtDocuments.documentId }).from(schema.debtDocuments)
    .where(inArray(schema.debtDocuments.debtId, debtIds))).map((r) => r.id);

  // --- knowledge base: best-effort, never fatal (retrieveRefs degrades to []).
  const refs = (await deps.retrieveRefs(base.kbQuery)).slice(0, MAX_KB);
  const kb: ContextItem[] = refs.map((r) => ({
    type: "kb", id: r.entityId, label: `${r.entityType}: ${r.title}`, text: r.snippet,
  }));
  const kbDocIds = refs.filter((r) => r.entityType === "document").map((r) => r.entityId);

  const docIds = uniq([...base.docIds, ...sentRows.map((d) => d.id), ...debtDocIds]);

  // --- stops on the case map that point at anything above.
  const stopLinks = [
    ...(entryIds.length ? [inArray(schema.stops.entryId, entryIds)] : []),
    ...(taskIds.length ? [inArray(schema.stops.taskId, taskIds)] : []),
    ...(docIds.length ? [inArray(schema.stops.documentId, docIds)] : []),
  ];
  const stopRows = stopLinks.length === 0 ? [] : await db.select({
    id: schema.stops.id, title: schema.stops.title, state: schema.stops.state,
    happenedAt: schema.stops.happenedAt, note: schema.stops.note,
  }).from(schema.stops).where(or(...stopLinks)).orderBy(asc(schema.stops.createdAt), asc(schema.stops.id));
  const stops: ContextItem[] = stopRows.map((s) => ({
    type: "stop", id: s.id,
    label: `${s.title} (${s.state}${s.happenedAt ? `, ${dayKey(s.happenedAt)}` : ""})`,
    text: clip(s.note, THREAD_TEXT_CHARS),
  }));

  const attachable = await liveDocuments(db, uniq([...docIds, ...kbDocIds]));

  // --- addresses: the only recipients a draft may name.
  const addresses: string[] = [];
  const add = (a: string | null) => { if (a && !own.includes(a) && !addresses.includes(a)) addresses.push(a); };
  for (const c of base.candidates) {
    const a = senderAddress(c);
    if (a && (matchesList(operator, a) || partyAddrs.has(a))) add(a);
  }
  for (const a of base.admitted) add(a);
  if (partyRow?.email) {
    const [a] = sanitizeAddresses([partyRow.email], own, "party").addrs;
    add(a ?? null);
  }

  return {
    trigger: base.trigger, thread: base.thread,
    party: partyRow ? partyItem(partyRow) : null,
    parentParty: parentRow ? partyItem(parentRow) : null,
    entries, debts, tasks, stops, kb, sentDocuments, attachable, addresses,
    threadKey: base.threadKey, gmailThreadId: base.gmailThreadId, reply: base.reply,
  };
}
