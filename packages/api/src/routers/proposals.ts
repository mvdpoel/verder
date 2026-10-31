import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type Db } from "@verder/db";
import { createCallerFactory, protectedProcedure, router } from "../trpc";
import {
  canTransition, proposalDiff, verdictFor,
  type ProposalKind, type ProposalStatus, type ReplyPayload,
} from "../proposal-state";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "../effective-status";
import { effectiveTaskStatus } from "../task-decide";
import { TASK_STATUSES, isValidTaskTransition } from "../task-status";
import { effectiveDocument } from "./documents";
import { tasksRouter } from "./tasks";
import { registryRouter } from "./registry";

/**
 * MARTIN'S SIDE OF A PROPOSAL (spec §6.4.2–3, §6.5, Plan 2 Task 15).
 *
 * The worker drafts; this router is where Martin reads, edits, approves,
 * rejects or answers. Nothing here sends and nothing here writes a log entry:
 * approve only moves `pending → approved` and records the golden-rule verdict,
 * and the send job (Task 16) writes the outbound entry once Gmail has the
 * message. `proposals` is not evidence, so approve and reject append NO ledger
 * event; answering a question runs an EXISTING ledgered procedure on Martin's
 * own caller, so each of its writes keeps its own path and its own event.
 *
 * THE STORED CONTEXT IS THE FENCE, AGAIN. `validateDraft` already refused any
 * draft that addressed, attached or acted on something outside the context the
 * worker gathered. The phone is a second author of the same text, and the
 * world moves between drafting and the tap, so every decision here re-checks:
 *   - approve may REMOVE an attachment, never ADD one (`context.attachable`),
 *     and may address only `context.addresses`; a document discarded or
 *     purged since drafting is refused, not silently dropped — the text Martin
 *     approved must be the text that goes;
 *   - answer re-validates the chosen option exactly as `validateDraft` did, and
 *     judges a task move against the task's CURRENT effective status.
 *
 * The context and payload shapes are written by apps/worker
 * (`proposals/context.ts`, `proposals/validate-draft.ts`), which this package
 * cannot import; the interfaces below are the subset read here, structurally.
 */

export interface StoredItem { type: string; id: string; label: string; status?: string; attachments?: StoredItem[] }
export interface StoredContext {
  trigger: StoredItem; thread: StoredItem[]; party: StoredItem | null; parentParty: StoredItem | null;
  entries: StoredItem[]; debts: StoredItem[]; tasks: StoredItem[]; stops: StoredItem[]; kb: StoredItem[];
  sentDocuments: StoredItem[]; attachable: StoredItem[]; addresses: string[];
}
export type StoredOption =
  | { action: "set-task-status"; taskId: string; status: string; label: string }
  | { action: "link-document-to-debt"; documentId: string; debtId: string; label: string }
  | { action: "create-task"; title: string; dueAt: string | null; label: string }
  | { action: "none"; label: string };
export interface StoredReply { to: string[]; cc: string[]; subject: string; body: string; attachmentDocumentIds: string[] }
export interface StoredPayload {
  ask: string; dueAt: string | null; missing: string[]; entrySummary: string;
  reply: StoredReply | null; task: { title: string; dueAt: string | null } | null;
  question: { prompt: string; options: StoredOption[] } | null;
  reliedOn: { type: string; id: string; why: string }[];
}
export interface ExternalTrigger { gmailId: string; from: string; subject: string; date: string; body: string }
export type LetterGuess = { kind: "verder" } | { kind: "creditor"; partyId: string };

type ProposalRow = typeof schema.proposals.$inferSelect;

const DAY_MS = 24 * 3600 * 1000;
/** How long a send in flight or a failure stays on the list after it last moved. */
const RECENT_MS = 7 * DAY_MS;
const EXCERPT_CHARS = 300;
/** Same bounds `validateDraft` puts on the model's text. */
const SUBJECT_MAX = 300;
const BODY_MAX = 20_000;
const ENTRY_SUMMARY_MAX = 100;
const LIST_MAX = 20;

/** Dutch status words, as the task list renders them (apps/web task-list.tsx). */
const TASK_STATUS_NL: Record<string, string> = {
  open: "open", "in-progress": "mee bezig", waiting: "wacht op iemand", done: "klaar", dropped: "laten vallen",
};
const PRIORITY_ORDER: Record<string, number> = { verder: 0, creditor: 1, other: 2 };
const STATUS_ORDER: Record<string, number> = { pending: 0, failed: 1, sending: 2, approved: 3 };

function bad(message: string): never { throw new TRPCError({ code: "BAD_REQUEST", message }); }
function conflict(message: string): never { throw new TRPCError({ code: "CONFLICT", message }); }

const clip = (s: string | null | undefined): string | null =>
  s ? (s.length > EXCERPT_CHARS ? `${s.slice(0, EXCERPT_CHARS)}…` : s) : null;
const lower = (a: string) => a.trim().toLowerCase();
const domainOf = (a: string) => lower(a).split("@").pop() ?? "";
const parseDate = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "2026-11-07" or an ISO timestamp → "7-11" in Amsterdam. */
function dayMonth(s: string): string {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (plain) return `${Number(plain[3])}-${Number(plain[2])}`;
  const d = parseDate(s);
  if (!d) return s;
  const parts = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "numeric" })
    .formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}`;
}

/** Row lock + the checks every decision shares. */
async function lockPending(tx: Db, id: string, revision?: number): Promise<ProposalRow> {
  const [p] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, id)).for("update");
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  if (p.status !== "pending") conflict(`proposal is ${p.status}, not pending`);
  if (revision !== undefined && p.revision !== revision) {
    conflict(`proposal is at revision ${p.revision}, not ${revision}`);
  }
  return p;
}

function payloadOf(p: ProposalRow): StoredPayload {
  if (!p.payload) bad("proposal has no draft");
  return p.payload as StoredPayload;
}

/** Live (not discarded, not purged) documents among `ids`, with their titles. */
async function liveDocs(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: schema.documents.id, title: effectiveTitleSql })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, ids), notDiscardedSql, notPurgedSql));
  return new Map(rows.map((r) => [r.id, r.title]));
}

async function isLive(db: Db, id: string): Promise<boolean> {
  return (await liveDocs(db, [id])).has(id);
}

/**
 * The same checks `validateDraft` made on the option when it was drafted,
 * made again now against the stored context and the live database. Throws
 * BAD_REQUEST; returns nothing.
 */
async function revalidateOption(tx: Db, o: StoredOption, ctx: StoredContext): Promise<void> {
  switch (o.action) {
    case "set-task-status": {
      if (!ctx.tasks.some((t) => t.id === o.taskId)) bad("the option's task is not in the proposal's context");
      if (!(TASK_STATUSES as readonly string[]).includes(o.status)) bad(`unknown task status ${o.status}`);
      const current = await effectiveTaskStatus(tx, o.taskId);
      if (!isValidTaskTransition(current, o.status)) bad(`the task cannot move ${current} → ${o.status}`);
      return;
    }
    case "link-document-to-debt":
      if (!ctx.attachable.some((d) => d.id === o.documentId)) bad("the option's document is not in the proposal's context");
      if (!ctx.debts.some((d) => d.id === o.debtId)) bad("the option's debt is not in the proposal's context");
      if (!(await isLive(tx, o.documentId))) bad("the option's document was discarded or purged");
      return;
    case "create-task":
      if (typeof o.title !== "string" || o.title.trim() === "" || o.title.length > 200) bad("the option's task has no title");
      if (o.dueAt !== null && o.dueAt !== undefined && parseDate(o.dueAt) === null) bad("the option's due date is not a date");
      return;
    case "none":
      return;
    default:
      bad(`option action ${JSON.stringify((o as { action?: unknown }).action)?.slice(0, 40)} is not allowed`);
  }
}

/** A Dutch sentence saying what the option DOES, built from its validated ids,
 *  so the button never shows only the model's label. */
async function renderTarget(db: Db, o: StoredOption): Promise<string> {
  switch (o.action) {
    case "set-task-status": {
      const [t] = await db.select({ title: schema.tasks.title }).from(schema.tasks).where(eq(schema.tasks.id, o.taskId));
      return `Taak '${t?.title ?? "onbekend"}' → ${TASK_STATUS_NL[o.status] ?? o.status}`;
    }
    case "link-document-to-debt": {
      const [d] = await db.select({ title: effectiveTitleSql }).from(schema.documents)
        .where(eq(schema.documents.id, o.documentId));
      const [debt] = await db.select({ name: schema.debts.creditorName }).from(schema.debts)
        .where(eq(schema.debts.id, o.debtId));
      return `Document '${d?.title ?? "onbekend"}' koppelen aan vordering ${debt?.name ?? "onbekend"}`;
    }
    case "create-task":
      return `Nieuwe taak '${o.title}'${o.dueAt ? `, uiterlijk ${dayMonth(o.dueAt)}` : ""}`;
    case "none":
      return "Geen actie";
    default:
      return "Onbekende actie";
  }
}

/**
 * Whether the letter's guessed sender is still a guess (spec §12.5). Mail is
 * never unconfirmed. A letter is confirmed only by its EFFECTIVE party — set by
 * Martin's filing, read through `effectiveDocument` — matching the guess:
 *   - a creditor guess: that exact party;
 *   - a Verder guess: a party (or its parent organisation) whose address is on
 *     a domain of the Verder addresses the context admitted for this letter.
 *     That list is `RELEVANT_SENDERS` as the worker applied it at drafting
 *     time; the web app does not read that variable, and must not grow a
 *     second reader of it.
 */
async function senderUnconfirmed(db: Db, p: ProposalRow, ctx: StoredContext): Promise<boolean> {
  if (!p.triggerDocumentId) return false;
  const guess = p.senderGuess as LetterGuess | null;
  if (!guess) return true;
  let partyId: string | null;
  try { partyId = (await effectiveDocument(db, p.triggerDocumentId)).effectivePartyId; } catch { return true; }
  if (!partyId) return true;
  if (guess.kind === "creditor") return partyId !== guess.partyId;
  const verderDomains = new Set(ctx.addresses.map(domainOf).filter(Boolean));
  if (verderDomains.size === 0) return true;
  const [party] = await db.select({ email: schema.parties.email, parent: schema.parties.parentPartyId })
    .from(schema.parties).where(eq(schema.parties.id, partyId));
  const emails = [party?.email];
  if (party?.parent) {
    const [parent] = await db.select({ email: schema.parties.email }).from(schema.parties)
      .where(eq(schema.parties.id, party.parent));
    emails.push(parent?.email);
  }
  return !emails.some((e) => e && e.includes("@") && verderDomains.has(domainOf(e)));
}

export interface TriggerView { type: string; id: string; from: string | null; subject: string | null; date: Date | null; excerpt: string | null }

async function triggerView(db: Db, p: ProposalRow, partyName: string | null): Promise<TriggerView> {
  if (p.triggerRawEmailId) {
    const [r] = await db.select().from(schema.rawEmails).where(eq(schema.rawEmails.id, p.triggerRawEmailId));
    return { type: "email", id: p.triggerRawEmailId, from: r?.fromAddr ?? null, subject: r?.subject ?? null,
      date: r?.sentAt ?? null, excerpt: clip(r?.bodyText) };
  }
  if (p.triggerDocumentId) {
    const id = p.triggerDocumentId;
    const d = await effectiveDocument(db, id).catch(() => null);
    const [t] = d && d.purge === null
      ? await db.select({ text: schema.documentTexts.text }).from(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, id))
      : [];
    const guess = p.senderGuess as LetterGuess | null;
    return { type: "document", id, from: guess?.kind === "verder" ? "Verder" : partyName,
      subject: d?.effectiveTitle ?? null, date: d?.receivedAt ?? null, excerpt: clip(t?.text) };
  }
  if (p.triggerTaskId) {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, p.triggerTaskId));
    return { type: "task", id: p.triggerTaskId, from: null, subject: t?.title ?? null,
      date: t?.createdAt ?? null, excerpt: clip(t?.details) };
  }
  if (p.triggerExternal) {
    const e = p.triggerExternal as ExternalTrigger;
    return { type: "external", id: e.gmailId, from: e.from, subject: e.subject, date: parseDate(e.date),
      excerpt: clip(e.body) };
  }
  const [parent] = p.parentProposalId
    ? await db.select().from(schema.proposals).where(eq(schema.proposals.id, p.parentProposalId))
    : [];
  const sent = (parent?.finalPayload ?? null) as Partial<StoredReply> | null;
  return { type: "proposal", id: p.parentProposalId ?? "", from: "verder", subject: sent?.subject ?? null,
    date: parent?.sentAt ?? null, excerpt: clip(sent?.body) };
}

/** Every item of the stored context, by id, so a citation can be labelled. */
function contextIndex(ctx: StoredContext): Map<string, StoredItem> {
  const out = new Map<string, StoredItem>();
  const add = (i: StoredItem | null | undefined) => {
    if (!i) return;
    if (!out.has(i.id)) out.set(i.id, i);
    for (const a of i.attachments ?? []) add(a);
  };
  for (const i of [ctx.trigger, ...ctx.thread, ctx.party, ctx.parentParty, ...ctx.entries, ...ctx.debts,
    ...ctx.tasks, ...ctx.stops, ...ctx.kb, ...ctx.sentDocuments, ...ctx.attachable]) add(i);
  return out;
}

// --- inputs ------------------------------------------------------------------

const idInput = z.object({ id: z.string().uuid() });
const revision = z.number().int().positive();
const address = z.string().trim().min(3).max(320);

export const approveInput = z.object({
  id: z.string().uuid(),
  revision,
  payload: z.object({
    to: z.array(address).min(1).max(LIST_MAX),
    cc: z.array(address).max(LIST_MAX).default([]),
    subject: z.string().trim().min(1).max(SUBJECT_MAX),
    // Trailing whitespace is not Martin's words; validateDraft strips it from
    // the model's body too, so a text editor's final newline is not an edit.
    body: z.string().max(BODY_MAX).transform((b) => b.replace(/\s+$/, "")).pipe(z.string().min(1)),
    attachmentDocumentIds: z.array(z.string().uuid()).max(LIST_MAX).default([]),
    entrySummary: z.string().trim().min(1).max(ENTRY_SUMMARY_MAX),
  }),
});

export const answerInput = z.union([
  z.object({ id: z.string().uuid(), revision, option: z.number().int().min(0) }).strict(),
  z.object({ id: z.string().uuid(), revision, freeText: z.string().trim().min(1).max(2000) }).strict(),
]);

// --- router ------------------------------------------------------------------

/** The procedures an answer may run, on Martin's own caller. */
const actionCaller = createCallerFactory(router({ tasks: tasksRouter, registry: registryRouter }));

export const proposalsRouter = router({
  /** Pending proposals, plus a send in flight or a failure from the last 7 days. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const parent = alias(schema.proposals, "parent");
    const since = new Date(Date.now() - RECENT_MS);
    const rows = await ctx.db.select({
      p: schema.proposals, partyName: schema.parties.name,
      emailAt: schema.rawEmails.sentAt, docAt: schema.documents.receivedAt,
      taskAt: schema.tasks.createdAt, parentAt: parent.sentAt,
    }).from(schema.proposals)
      .leftJoin(schema.parties, eq(schema.parties.id, schema.proposals.partyId))
      .leftJoin(schema.rawEmails, eq(schema.rawEmails.id, schema.proposals.triggerRawEmailId))
      .leftJoin(schema.documents, eq(schema.documents.id, schema.proposals.triggerDocumentId))
      .leftJoin(schema.tasks, eq(schema.tasks.id, schema.proposals.triggerTaskId))
      .leftJoin(parent, eq(parent.id, schema.proposals.parentProposalId))
      .where(or(
        eq(schema.proposals.status, "pending"),
        and(inArray(schema.proposals.status, ["approved", "sending", "failed"]),
          gte(schema.proposals.updatedAt, since)),
      ))
      .orderBy(desc(schema.proposals.createdAt));
    return rows.map(({ p, partyName, emailAt, docAt, taskAt, parentAt }) => {
      const payload = p.payload as StoredPayload | null;
      const guess = p.senderGuess as LetterGuess | null;
      return {
        id: p.id, kind: p.kind, status: p.status, priority: p.priority,
        ask: payload?.ask ?? null,
        partyName: partyName ?? (guess?.kind === "verder" ? "Verder" : null),
        triggerAt: emailAt ?? docAt ?? taskAt ?? parentAt
          ?? parseDate((p.triggerExternal as ExternalTrigger | null)?.date) ?? null,
        createdAt: p.createdAt,
      };
    }).sort((a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      || (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
      || b.createdAt.getTime() - a.createdAt.getTime());
  }),

  get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const [found] = await ctx.db.select({ p: schema.proposals, partyName: schema.parties.name })
      .from(schema.proposals)
      .leftJoin(schema.parties, eq(schema.parties.id, schema.proposals.partyId))
      .where(eq(schema.proposals.id, input.id));
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    const { p } = found;
    const context = p.context as StoredContext;
    const payload = (p.payload ?? null) as StoredPayload | null;
    const guess = p.senderGuess as LetterGuess | null;
    const partyName = found.partyName ?? (guess?.kind === "verder" ? "Verder" : null);
    const trigger = await triggerView(ctx.db, p, partyName);

    const index = contextIndex(context);
    const reliedOn = (payload?.reliedOn ?? []).map((r) => ({
      type: r.type, id: r.id, label: index.get(r.id)?.label ?? r.id, why: r.why,
    }));

    // What the draft attaches NOW: the approved text once decided, else the model's.
    const reply = (p.finalPayload as StoredReply | null)?.attachmentDocumentIds
      ? p.finalPayload as StoredReply : payload?.reply ?? null;
    const attachments = [];
    for (const id of reply?.attachmentDocumentIds ?? []) {
      const d = await effectiveDocument(ctx.db, id).catch(() => null);
      attachments.push(d
        ? { id, title: d.effectiveTitle, sizeBytes: d.sizeBytes,
          unavailable: d.effectiveStatus === "discarded" || d.purge !== null }
        : { id, title: index.get(id)?.label ?? id, sizeBytes: 0, unavailable: true });
    }
    // The picker offers only what approve would accept.
    const live = await liveDocs(ctx.db, context.attachable.map((d) => d.id));
    const attachable = context.attachable.filter((d) => live.has(d.id))
      .map((d) => ({ id: d.id, title: live.get(d.id)! }));

    const options = [];
    for (const [i, o] of (payload?.question?.options ?? []).entries()) {
      options.push({ index: i, action: o.action, label: o.label, target: await renderTarget(ctx.db, o) });
    }

    return {
      id: p.id, kind: p.kind, status: p.status, priority: p.priority,
      ask: payload?.ask ?? null, partyName, triggerAt: trigger.date, createdAt: p.createdAt,
      trigger,
      dueAt: payload?.dueAt ?? null,
      missing: payload?.missing ?? [],
      entrySummary: (p.finalPayload as { entrySummary?: string } | null)?.entrySummary ?? payload?.entrySummary ?? null,
      proposedTask: payload?.task ? { title: payload.task.title, dueAt: payload.task.dueAt ?? null } : null,
      createdTaskId: p.createdTaskId,
      senderUnconfirmed: await senderUnconfirmed(ctx.db, p, context),
      reliedOn,
      payload,
      revision: p.revision,
      attachments,
      attachable,
      options,
      error: p.error,
    };
  }),

  /**
   * Martin approves the FINAL text. Records the golden-rule verdict and diff,
   * moves `pending → approved`, and writes NO ledger event: the outbound entry
   * is written on `sent` (Task 16), with `entrySummary` as its summary.
   */
  approve: protectedProcedure.input(approveInput).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const p = await lockPending(tx, input.id, input.revision);
      const kind = p.kind as ProposalKind;
      if (kind === "question") bad("a question is answered, not approved");
      if (!canTransition(p.status as ProposalStatus, "approved", kind)) conflict("approve is not a legal move");
      const payload = payloadOf(p);
      if (!payload.reply) bad("proposal has no reply to approve");
      const context = p.context as StoredContext;

      const allowed = new Set(context.addresses.map(lower));
      const recipients = (list: string[], field: string) => {
        const out: string[] = [];
        for (const a of list.map(lower)) {
          if (!allowed.has(a)) bad(`${field} recipient ${a.slice(0, 80)} is not in the proposal's context`);
          if (!out.includes(a)) out.push(a);
        }
        return out;
      };
      const to = recipients(input.payload.to, "to");
      const cc = recipients(input.payload.cc, "cc").filter((a) => !to.includes(a));

      const offered = new Set(context.attachable.map((d) => d.id));
      const attachmentDocumentIds = [...new Set(input.payload.attachmentDocumentIds)];
      for (const id of attachmentDocumentIds) {
        if (!offered.has(id)) bad(`attachment ${id} was not offered in the proposal's context`);
      }
      // Re-resolved, as approveEntry does: a discard is never written back to
      // documents.status, and a purge is a row of its own. Refused rather than
      // dropped, because the text Martin approved must be the text that goes.
      for (const id of attachmentDocumentIds) {
        const d = await effectiveDocument(tx, id);
        if (d.effectiveStatus === "discarded") bad(`attachment ${d.effectiveTitle} was discarded`);
        if (d.purge !== null) bad(`attachment ${d.effectiveTitle} was purged`);
      }

      const final: ReplyPayload = {
        to, cc, subject: input.payload.subject, body: input.payload.body,
        attachmentDocumentIds, entrySummary: input.payload.entrySummary,
      };
      const model: ReplyPayload = { ...payload.reply, entrySummary: payload.entrySummary };
      const verdict = verdictFor(model, final);
      const now = new Date();
      const [updated] = await tx.update(schema.proposals).set({
        status: "approved", finalPayload: final, verdict, diff: proposalDiff(model, final),
        decidedAt: now, decidedBy: ctx.userId, revision: p.revision + 1, updatedAt: now,
      }).where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "pending"))).returning();
      return { id: updated.id, status: updated.status, verdict, revision: updated.revision };
    })),

  reject: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().trim().max(1000).optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const p = await lockPending(tx, input.id);
      if (!canTransition("pending", "rejected", p.kind as ProposalKind)) conflict("reject is not a legal move");
      const now = new Date();
      const [updated] = await tx.update(schema.proposals).set({
        status: "rejected", verdict: "rejected", rejectReason: input.reason || null,
        decidedAt: now, decidedBy: ctx.userId, revision: p.revision + 1, updatedAt: now,
      }).where(eq(schema.proposals.id, p.id)).returning();
      return { id: updated.id, status: updated.status, revision: updated.revision };
    })),

  /**
   * Answers a question. The chosen option runs through the EXISTING procedure
   * on Martin's caller, inside this transaction, so a refusal anywhere leaves
   * nothing behind. `pending → sent` closes it: a question never leaves the
   * house. Plan 3's notification answer actions go through this same path.
   */
  answer: protectedProcedure.input(answerInput).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const p = await lockPending(tx, input.id, input.revision);
      const kind = p.kind as ProposalKind;
      if (kind !== "question") bad("only a question can be answered");
      if (!canTransition("pending", "sent", kind)) conflict("answer is not a legal move");
      const payload = payloadOf(p);
      if (!payload.question) bad("proposal has no question");
      const context = p.context as StoredContext;

      let answer: Record<string, unknown>;
      let taskId: string | null = null;
      if ("option" in input) {
        const option = payload.question.options[input.option];
        if (!option) bad(`the question has no option ${input.option}`);
        await revalidateOption(tx, option, context);
        const run = actionCaller({ db: tx, userId: ctx.userId });
        switch (option.action) {
          case "set-task-status":
            await run.tasks.setStatus({ taskId: option.taskId, status: option.status as never });
            break;
          case "link-document-to-debt":
            await run.registry.debts.linkDocument({ documentId: option.documentId, debtId: option.debtId });
            break;
          case "create-task":
            taskId = (await run.tasks.create({ title: option.title.trim(), dueAt: parseDate(option.dueAt) })).id;
            break;
          case "none":
            break;
        }
        answer = { option: input.option, action: option.action, label: option.label, ...(taskId ? { taskId } : {}) };
      } else {
        answer = { freeText: input.freeText };
      }

      const now = new Date();
      const [updated] = await tx.update(schema.proposals).set({
        status: "sent", finalPayload: { answer },
        // An option is the model's suggestion taken as offered; free text is
        // Martin saying none of them fit.
        verdict: "option" in input ? "approved" : "edited",
        decidedAt: now, decidedBy: ctx.userId, revision: p.revision + 1, updatedAt: now,
      }).where(eq(schema.proposals.id, p.id)).returning();
      return { id: updated.id, status: updated.status, revision: updated.revision, taskId };
    })),

  /**
   * Creates the proposed task, only on Martin's tap — never on drafting, never
   * on approve (spec §6.4.3, "and/or a task for Martin"). The row lock and
   * `created_task_id` make a second tap a no-op that returns the same task.
   */
  createProposedTask: protectedProcedure.input(idInput).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [p] = await tx.select().from(schema.proposals)
        .where(eq(schema.proposals.id, input.id)).for("update");
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      if (p.createdTaskId) return { taskId: p.createdTaskId, created: false };
      const task = payloadOf(p).task;
      if (!task) bad("proposal proposes no task");
      const run = actionCaller({ db: tx, userId: ctx.userId });
      const created = await run.tasks.create({ title: task.title, dueAt: parseDate(task.dueAt) });
      await tx.update(schema.proposals).set({ createdTaskId: created.id, updatedAt: new Date() })
        .where(eq(schema.proposals.id, p.id));
      return { taskId: created.id, created: true };
    })),
});
