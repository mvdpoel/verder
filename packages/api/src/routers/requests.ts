import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveDocTypeSql, effectiveTitleSql, notDiscardedSql, notPurgedSql } from "../effective-status";
import { requestActivity, requestFailureDetail, requestFailureText, requestProgress } from "../request-progress";
import {
  doneSteps, requestListItem, requestName, requestThreads,
  type RequestThread, type RequestThreadRow,
} from "../request-threads";
import { loadRequestThreadRows } from "../waiting";

/**
 * VRAAG GRIP — MARTIN'S SIDE (spec docs/superpowers/specs/2026-11-04-vraag-grip-design.md,
 * and the final Figma frames "Vraag Grip · it6").
 *
 * He asks; the host runner (ops/request-runner.sh) researches with a read-only
 * tool server and the worker's `requests-store` writes the answer. Nothing here
 * researches, answers or sends: create queues a row, cancel stops one that has
 * not been answered, markOpened records that he read the answer, `step` ticks
 * one of the things only he can do, `dismiss` is "Laat maar" (and `undismiss`
 * its undo), `retry` is "Opnieuw proberen". A request is NOT evidence and
 * appends no ledger event; a proposal it carried goes through the existing
 * approval screen.
 *
 * The phone lists THREADS, one row each, by their head (`request-threads.ts`):
 * the same rule `loadWaiting` counts with.
 */

type RequestRow = typeof schema.requests.$inferSelect;

/** Structural copies of the jsonb shapes in @grip/db's schema, so the router's
 *  inferred type never names that module's deep path (TS2742). */
export interface RequestSourceView { type: string; id: string; why: string; label?: string }
type AboutView = Partial<Record<"rawEmailId" | "documentId" | "partyId" | "stopId" | "taskId", string>>;
const DAY_MS = 24 * 3600 * 1000;
/** How long a finished thread stays under Eerdere vragen. */
const EARLIER_MS = 60 * DAY_MS;
const EARLIER_MAX = 50;
/** A follow-up chain is shown this deep, oldest first. */
const THREAD_DEPTH = 10;
const TEXT_MAX = 4000;

const ABOUT_KEYS = ["rawEmailId", "documentId", "partyId", "stopId", "taskId"] as const;
type AboutKey = typeof ABOUT_KEYS[number];

const aboutInput = z.object({
  rawEmailId: z.string().uuid(), documentId: z.string().uuid(), partyId: z.string().uuid(),
  stopId: z.string().uuid(), taskId: z.string().uuid(),
}).partial().strict().refine((a) => Object.keys(a).length === 1, "about names exactly one item");

export const createRequestInput = z.object({
  clientId: z.string().uuid(),
  text: z.string().trim().min(1).max(TEXT_MAX),
  about: aboutInput.nullish(),
  parentRequestId: z.string().uuid().nullish(),
}).strict();

const idInput = z.object({ id: z.string().uuid() });

function bad(message: string): never { throw new TRPCError({ code: "BAD_REQUEST", message }); }
function conflict(message: string): never { throw new TRPCError({ code: "CONFLICT", message }); }
function notFound(): never { throw new TRPCError({ code: "NOT_FOUND", message: "Request not found" }); }

/** The label of what a request is about, or null when it no longer resolves.
 *  A discarded or purged document is NOT offered as something to ask about. */
export async function aboutLabel(db: Db, about: Partial<Record<AboutKey, string>> | null): Promise<
  { type: "mail" | "document" | "party" | "stop" | "task"; id: string; label: string; meta: string[]; at: string | null } | null> {
  if (!about) return null;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  if (about.rawEmailId) {
    const [r] = await db.select({ subject: schema.rawEmails.subject, from: schema.rawEmails.fromAddr,
      sentAt: schema.rawEmails.sentAt }).from(schema.rawEmails).where(eq(schema.rawEmails.id, about.rawEmailId));
    return r ? { type: "mail", id: about.rawEmailId, label: r.subject, meta: [senderName(r.from)].filter(nonEmpty), at: iso(r.sentAt) } : null;
  }
  if (about.documentId) {
    const [d] = await db.select({ title: effectiveTitleSql, docType: effectiveDocTypeSql,
      receivedAt: schema.documents.receivedAt }).from(schema.documents)
      .where(and(eq(schema.documents.id, about.documentId), notDiscardedSql, notPurgedSql));
    return d ? { type: "document", id: about.documentId, label: d.title, meta: [d.docType].filter(nonEmpty), at: iso(d.receivedAt) } : null;
  }
  if (about.partyId) {
    const [p] = await db.select({ name: schema.parties.name }).from(schema.parties)
      .where(eq(schema.parties.id, about.partyId));
    return p ? { type: "party", id: about.partyId, label: p.name, meta: [], at: null } : null;
  }
  if (about.stopId) {
    const [s] = await db.select({ title: schema.stops.title, track: schema.tracks.title, at: schema.stops.happenedAt })
      .from(schema.stops).leftJoin(schema.tracks, eq(schema.tracks.id, schema.stops.trackId))
      .where(eq(schema.stops.id, about.stopId));
    return s ? { type: "stop", id: about.stopId, label: s.title, meta: [s.track].filter(nonEmpty), at: iso(s.at) } : null;
  }
  if (about.taskId) {
    const [t] = await db.select({ title: schema.tasks.title, dueAt: schema.tasks.dueAt }).from(schema.tasks)
      .where(eq(schema.tasks.id, about.taskId));
    return t ? { type: "task", id: about.taskId, label: t.title, meta: [], at: iso(t.dueAt) } : null;
  }
  return null;
}

const nonEmpty = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** "Ilse de Vries <ilse@noordkust.example>" → "Ilse de Vries"; a bare address stays. */
export function senderName(from: string | null | undefined): string | null {
  if (!from) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  const name = m?.[1]?.trim();
  return name ? name : from.trim();
}

async function threadFor(db: Db, id: string): Promise<{ thread: RequestThread; rows: RequestThreadRow[] } | null> {
  const rows = await loadRequestThreadRows(db);
  // A retried failure is in no thread's members; it still opens, alone.
  const thread = requestThreads(rows).find((t) => t.members.some((m) => m.id === id)) ?? null;
  return thread ? { thread, rows } : null;
}

type SourceDetail = {
  type: string; id: string; why: string; label: string;
  /** The row's meta words before the date ("Dossier · contract", "Gmail · niet in je dossier"). */
  meta: string[];
  at: string | null;
  /** Whether Grip keeps it: false only for a live Gmail message. */
  inDossier: boolean;
  transaction?: { amountCents: number; bookedAt: string; counterparty: string | null; accountIban: string | null;
    description: string | null; mandate: boolean };
  gmail?: { from: string; to: string; subject: string; date: string; body: string };
};

/** Every source, resolved NOW (a document's effective title and soort, a mail's
 *  sender, a bank row's figures, a Gmail message as the tool read it). A source
 *  that no longer resolves keeps the label the tool showed. */
async function sourceDetails(db: Db, sources: RequestSourceView[], logs: RequestRow["toolLog"][]): Promise<SourceDetail[]> {
  const ids = (type: string) => sources.filter((s) => s.type === type).map((s) => s.id).filter(isUuid);
  const [docs, mails, txs, parties, stops, tasks] = await Promise.all([
    ids("document").length ? db.select({ id: schema.documents.id, title: effectiveTitleSql, docType: effectiveDocTypeSql,
      receivedAt: schema.documents.receivedAt }).from(schema.documents).where(inArray(schema.documents.id, ids("document"))) : [],
    ids("mail").length ? db.select({ id: schema.rawEmails.id, subject: schema.rawEmails.subject, from: schema.rawEmails.fromAddr,
      sentAt: schema.rawEmails.sentAt }).from(schema.rawEmails).where(inArray(schema.rawEmails.id, ids("mail"))) : [],
    ids("transaction").length ? db.select({ id: schema.transactions.id, amountCents: schema.transactions.amountCents,
      bookedAt: schema.transactions.bookedAt, counterparty: schema.transactions.counterpartyName,
      accountIban: schema.transactions.accountIban, description: schema.transactions.description,
      mandateId: schema.transactions.mandateId }).from(schema.transactions).where(inArray(schema.transactions.id, ids("transaction"))) : [],
    ids("party").length ? db.select({ id: schema.parties.id, name: schema.parties.name }).from(schema.parties)
      .where(inArray(schema.parties.id, ids("party"))) : [],
    ids("stop").length ? db.select({ id: schema.stops.id, title: schema.stops.title, at: schema.stops.happenedAt })
      .from(schema.stops).where(inArray(schema.stops.id, ids("stop"))) : [],
    ids("task").length ? db.select({ id: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt })
      .from(schema.tasks).where(inArray(schema.tasks.id, ids("task"))) : [],
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const D = by(docs), M = by(mails), T = by(txs), P = by(parties), S = by(stops), K = by(tasks);
  const gmail = new Map<string, NonNullable<schema.RequestToolCall["mail"]>>();
  for (const log of logs) for (const c of log ?? []) if (c.tool === "gmail_read" && c.mail && !c.error) gmail.set(c.mail.gmailId, c.mail);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  return sources.map((s): SourceDetail => {
    const base = { type: s.type, id: s.id, why: s.why, label: s.label ?? s.id, meta: [] as string[], at: null as string | null, inDossier: true };
    switch (s.type) {
      case "document": {
        const d = D.get(s.id);
        return d ? { ...base, label: d.title, meta: ["Dossier", d.docType].filter(nonEmpty), at: iso(d.receivedAt) } : { ...base, meta: ["Dossier"] };
      }
      case "mail": {
        const m = M.get(s.id);
        return m ? { ...base, label: m.subject, meta: ["Mail", "In dossier", senderFirst(m.from)].filter(nonEmpty), at: iso(m.sentAt) }
          : { ...base, meta: ["Mail", "In dossier"] };
      }
      case "gmail": {
        const g = gmail.get(s.id);
        const at = g ? new Date(g.date) : null;
        return { ...base, label: g?.subject ?? base.label, meta: ["Gmail", "Niet in je dossier"], inDossier: false,
          at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
          ...(g ? { gmail: { from: g.from, to: g.to, subject: g.subject, date: g.date, body: g.body } } : {}) };
      }
      case "transaction": {
        const t = T.get(s.id);
        if (!t) return { ...base, meta: ["Bankregel"] };
        return { ...base, label: t.counterparty ?? base.label, meta: [], at: iso(t.bookedAt),
          transaction: { amountCents: t.amountCents, bookedAt: t.bookedAt.toISOString(), counterparty: t.counterparty,
            accountIban: t.accountIban, description: t.description, mandate: t.mandateId !== null } };
      }
      case "party": {
        const p = P.get(s.id);
        return { ...base, label: p?.name ?? base.label, meta: ["Partij"] };
      }
      case "stop": {
        const st = S.get(s.id);
        return { ...base, label: st?.title ?? base.label, meta: ["Halte"], at: iso(st?.at) };
      }
      case "task": {
        const k = K.get(s.id);
        return { ...base, label: k?.title ?? base.label, meta: ["Taak"], at: iso(k?.dueAt) };
      }
      case "debt": return { ...base, meta: ["Vordering"] };
      case "entry": return { ...base, meta: ["Logboek"] };
      default: return base;
    }
  });
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
/** "Ilse de Vries <…>" → "Ilse": the row's meta is one line. */
function senderFirst(from: string): string | null {
  const name = senderName(from);
  if (!name) return null;
  return name.includes("@") ? name : name.split(/\s+/)[0];
}

async function proposalCard(db: Db, id: string | null) {
  if (!id) return null;
  const [p] = await db.select({
    id: schema.proposals.id, status: schema.proposals.status, kind: schema.proposals.kind,
    priority: schema.proposals.priority, payload: schema.proposals.payload, finalPayload: schema.proposals.finalPayload,
    partyName: schema.parties.name, updatedAt: schema.proposals.updatedAt,
  }).from(schema.proposals).leftJoin(schema.parties, eq(schema.parties.id, schema.proposals.partyId))
    .where(eq(schema.proposals.id, id));
  if (!p) return null;
  const reply = (p.finalPayload ?? (p.payload as { reply?: unknown } | undefined)?.reply ?? null) as
    { to?: string[]; subject?: string; attachmentDocumentIds?: string[] } | null;
  const ask = (p.payload as { ask?: unknown } | null)?.ask;
  return {
    id: p.id, status: p.status, kind: p.kind, priority: p.priority,
    /** "Antwoord aan Bewindkantoor Noordkust": what the proposal screen calls it. */
    title: p.partyName ? `${p.kind === "compose" ? "Bericht" : "Antwoord"} aan ${p.partyName}`
      : (typeof ask === "string" ? ask : null),
    to: reply?.to ?? [], subject: reply?.subject ?? null,
    attachmentCount: reply?.attachmentDocumentIds?.length ?? 0,
    sentAt: p.status === "sent" ? p.updatedAt : null,
  };
}

export const requestsRouter = router({
  /**
   * Queue a request. IDEMPOTENT on `clientId`: the phone retries a post whose
   * response it lost (or that waited offline), and the retry returns the row
   * the first one made.
   */
  create: protectedProcedure.input(createRequestInput).mutation(async ({ ctx, input }) => {
    const clientId = input.clientId.toLowerCase();
    const [existing] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.clientId, clientId));
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };

    const about = input.about ?? null;
    if (about && (await aboutLabel(ctx.db, about)) === null) bad("the item the request is about does not exist (or was discarded)");
    if (input.parentRequestId) {
      const [parent] = await ctx.db.select({ status: schema.requests.status }).from(schema.requests)
        .where(eq(schema.requests.id, input.parentRequestId));
      if (!parent) bad("the request this follows up does not exist");
      // "Vraag door" follows an ANSWER: a follow-up of a request still being
      // researched would be asked without the answer it builds on.
      if (parent.status !== "answered" && parent.status !== "failed") {
        conflict(`the request this follows up is ${parent.status}`);
      }
    }
    const inserted = await ctx.db.insert(schema.requests).values({
      clientId, text: input.text, about, parentRequestId: input.parentRequestId ?? null,
    }).onConflictDoNothing({ target: schema.requests.clientId }).returning();
    if (inserted.length > 0) return { id: inserted[0].id, status: inserted[0].status, duplicate: false };
    const [raced] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.clientId, clientId));
    if (!raced) throw new Error("requests.create: conflict on clientId, but no row to return");
    return { id: raced.id, status: raced.status, duplicate: true };
  }),

  /**
   * The phone's list, ONE ROW PER THREAD: everything queued, being worked on
   * or waiting on Martin, then — under Eerdere vragen — the threads that are
   * done (answered and ticked off, put away, or stopped) of the last 60 days.
   * Newest first by the moment each row shows.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const since = Date.now() - EARLIER_MS;
    const threads = requestThreads(await loadRequestThreadRows(ctx.db));
    const open = threads.filter((t) => t.phase !== "done");
    const done = threads.filter((t) => t.phase === "done" && t.at.getTime() >= since).slice(0, EARLIER_MAX);
    return [...open, ...done].map(requestListItem);
  }),

  /** One request: the answer, its sources, the steps only Martin can do, the
   *  proposal card, the thread, and — while working — live progress. */
  get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const [r] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.id, input.id));
    if (!r) notFound();

    // Ancestors, oldest first, bounded so a cycle cannot hang the route.
    const ancestors: RequestRow[] = [];
    let parentId = r.parentRequestId;
    while (parentId && ancestors.length < THREAD_DEPTH) {
      const [p] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.id, parentId));
      if (!p || ancestors.some((a) => a.id === p.id)) break;
      ancestors.unshift(p);
      parentId = p.parentRequestId;
    }
    const followUps = await ctx.db.select({ id: schema.requests.id, text: schema.requests.text,
      status: schema.requests.status, createdAt: schema.requests.createdAt })
      .from(schema.requests).where(eq(schema.requests.parentRequestId, r.id))
      .orderBy(schema.requests.createdAt);

    const found = await threadFor(ctx.db, r.id);
    const t = found?.thread ?? null;
    const progress = requestProgress(r.toolLog ?? []);
    const live = r.status === "working" || r.status === "queued";
    const done = new Set(doneSteps({ martinSteps: r.martinSteps ?? [], stepsDone: r.stepsDone ?? {} }));
    const answered = r.status === "answered";
    // The card the answer shows: this request's own proposal; while a
    // follow-up is being researched, the one it is rewriting.
    const cardId = r.proposalId ?? (t?.head.id === r.id ? t?.carried?.id ?? null : null);

    return {
      id: r.id, rootId: t?.root.id ?? r.id, clientId: r.clientId, text: r.text, status: r.status as string,
      title: t ? t.title : requestName(r.title ?? r.text),
      headline: answered ? r.headline : null,
      phase: t?.head.id === r.id ? t.phase : null,
      todoReason: t?.head.id === r.id ? t.todoReason : null,
      doneReason: t?.head.id === r.id ? t.doneReason : null,
      parentRequestId: r.parentRequestId,
      createdAt: r.createdAt, claimedAt: r.claimedAt, answeredAt: r.answeredAt, openedAt: r.openedAt,
      dismissedAt: r.dismissedAt, updatedAt: r.updatedAt,
      unread: answered && r.openedAt === null,
      progressLine: r.status === "working" ? progress.line : null,
      failure: r.status === "failed" ? requestFailureText(r.error) : null,
      failureDetail: r.status === "failed" ? requestFailureDetail(r.error) : null,
      about: await aboutLabel(ctx.db, (r.about ?? null) as AboutView | null),
      answer: answered ? r.answer : null,
      sources: answered ? await sourceDetails(ctx.db, (r.sources ?? []) as RequestSourceView[],
        [r.toolLog, ...ancestors.map((a) => a.toolLog)]) : [],
      martinSteps: answered ? (r.martinSteps ?? []) as string[] : [],
      steps: answered ? (r.martinSteps ?? []).map((text, index) => ({
        index, text, doneAt: done.has(index) ? r.stepsDone[String(index)] : null })) : [],
      proposal: await proposalCard(ctx.db, cardId),
      /** The proposal is being rewritten by a follow-up (version n+1). */
      proposalUpdating: !r.proposalId && cardId !== null && live,
      progress: live || r.status === "failed"
        ? { calls: progress.calls, documents: progress.documents, mails: progress.mails,
          gmail: progress.gmail, line: progress.line,
          steps: requestActivity(r.toolLog ?? [], r.status === "failed") }
        : null,
      thread: await Promise.all(ancestors.map(async (a) => ({
        id: a.id, text: a.text, status: a.status, createdAt: a.createdAt,
        title: requestName(a.title ?? a.text), headline: a.status === "answered" ? a.headline : null,
        answer: a.status === "answered" ? a.answer : null,
        proposal: await proposalCard(ctx.db, a.proposalId),
      }))),
      followUps,
    };
  }),

  /** Stop a request that has not been answered. The runner checks the status
   *  before it stores, so an answer that arrives afterwards is discarded. */
  cancel: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const [row] = await ctx.db.update(schema.requests).set({ status: "cancelled", updatedAt: now })
      .where(and(eq(schema.requests.id, input.id), inArray(schema.requests.status, ["queued", "working"])))
      .returning({ id: schema.requests.id, status: schema.requests.status });
    if (row) return row;
    const [r] = await ctx.db.select({ status: schema.requests.status }).from(schema.requests)
      .where(eq(schema.requests.id, input.id));
    if (!r) notFound();
    if (r.status === "cancelled") return { id: input.id, status: r.status };
    conflict(`request is ${r.status}; only a queued or working request can be cancelled`);
  }),

  /** Martin opened the answer: it no longer waits on him for being unread. Idempotent. */
  markOpened: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const [r] = await ctx.db.select({ status: schema.requests.status, openedAt: schema.requests.openedAt })
      .from(schema.requests).where(eq(schema.requests.id, input.id));
    if (!r) notFound();
    if (r.openedAt) return { id: input.id, openedAt: r.openedAt };
    if (r.status !== "answered" && r.status !== "failed") conflict(`request is ${r.status}, there is nothing to open yet`);
    const now = new Date();
    const [u] = await ctx.db.update(schema.requests)
      .set({ openedAt: sql`COALESCE(${schema.requests.openedAt}, ${now})`, updatedAt: now })
      .where(eq(schema.requests.id, input.id)).returning({ openedAt: schema.requests.openedAt });
    return { id: input.id, openedAt: u.openedAt };
  }),

  /**
   * Tick (or untick) one of "Wat jij nog moet doen". Martin's own note about
   * work he did OUTSIDE Grip: nothing in the dossier changes. Idempotent; the
   * first tick's moment is kept.
   */
  step: protectedProcedure.input(z.object({ id: z.string().uuid(), index: z.number().int().min(0).max(50), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await ctx.db.select({ status: schema.requests.status, steps: schema.requests.martinSteps,
        done: schema.requests.stepsDone }).from(schema.requests).where(eq(schema.requests.id, input.id));
      if (!r) notFound();
      if (r.status !== "answered") conflict(`request is ${r.status}; only an answer has steps`);
      if (input.index >= (r.steps ?? []).length) bad("no such step");
      const key = String(input.index);
      const now = new Date();
      const next = { ...(r.done ?? {}) };
      if (input.done) next[key] = next[key] ?? now.toISOString(); else delete next[key];
      await ctx.db.update(schema.requests).set({ stepsDone: next, updatedAt: now })
        .where(eq(schema.requests.id, input.id));
      return { id: input.id, index: input.index, doneAt: next[key] ?? null };
    }),

  /**
   * "Laat maar": the thread leaves Voor jou and stops counting, and stands
   * under Eerdere vragen. A queued or working request is STOPPED first (the
   * runner discards a late answer). A pending proposal it carried is released
   * as a Voor jou row of its own (`request-threads.ts`). Idempotent.
   */
  dismiss: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const [r] = await ctx.db.select({ status: schema.requests.status, dismissedAt: schema.requests.dismissedAt })
      .from(schema.requests).where(eq(schema.requests.id, input.id));
    if (!r) notFound();
    if (r.dismissedAt) return { id: input.id, dismissedAt: r.dismissedAt, status: r.status };
    const now = new Date();
    const stop = r.status === "queued" || r.status === "working";
    const [u] = await ctx.db.update(schema.requests)
      .set({ dismissedAt: now, updatedAt: now, ...(stop ? { status: "cancelled" as const } : {}) })
      .where(eq(schema.requests.id, input.id))
      .returning({ dismissedAt: schema.requests.dismissedAt, status: schema.requests.status });
    return { id: input.id, dismissedAt: u.dismissedAt, status: u.status };
  }),

  /** The undo toast's "Ongedaan maken": back in Voor jou as it was. A request
   *  that "Laat maar" stopped stays stopped (its research is gone). */
  undismiss: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const [u] = await ctx.db.update(schema.requests).set({ dismissedAt: null, updatedAt: new Date() })
      .where(and(eq(schema.requests.id, input.id), isNotNull(schema.requests.dismissedAt)))
      .returning({ id: schema.requests.id });
    if (!u) {
      const [r] = await ctx.db.select({ id: schema.requests.id }).from(schema.requests).where(eq(schema.requests.id, input.id));
      if (!r) notFound();
    }
    return { id: input.id, dismissedAt: null };
  }),

  /**
   * "Opnieuw proberen" on a failed request: the SAME question asked again, as
   * a NEW request (its own prompt, tool log and answer, so the record of the
   * failed run stays whole), under the same parent and about the same item.
   * The failed one is put away. IDEMPOTENT on `clientId`, like create.
   */
  retry: protectedProcedure.input(z.object({ id: z.string().uuid(), clientId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const clientId = input.clientId.toLowerCase();
      const [existing] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.clientId, clientId));
      if (existing) return { id: existing.id, status: existing.status, duplicate: true };
      const [old] = await ctx.db.select().from(schema.requests).where(eq(schema.requests.id, input.id));
      if (!old) notFound();
      if (old.status !== "failed" && old.status !== "cancelled") conflict(`request is ${old.status}; only a failed or stopped request is asked again`);
      const now = new Date();
      const [fresh] = await ctx.db.insert(schema.requests).values({
        clientId, text: old.text, about: old.about, parentRequestId: old.parentRequestId,
      }).returning();
      if (old.status === "failed") {
        await ctx.db.update(schema.requests).set({ dismissedAt: sql`COALESCE(${schema.requests.dismissedAt}, ${now})`, updatedAt: now })
          .where(eq(schema.requests.id, old.id));
      }
      return { id: fresh.id, status: fresh.status, duplicate: false };
    }),

  /**
   * "Koppel een stuk": the newest item of each kind a request can be about —
   * a mail, a document, a party, a stop, an open task — for the picker's
   * RECENT list. Searching the rest goes through the dossier search.
   */
  attachable: protectedProcedure.query(async ({ ctx }) => {
    const [mail] = await ctx.db.select({ id: schema.rawEmails.id }).from(schema.rawEmails)
      .orderBy(desc(schema.rawEmails.sentAt)).limit(1);
    const [doc] = await ctx.db.select({ id: schema.documents.id }).from(schema.documents)
      .where(and(notDiscardedSql, notPurgedSql)).orderBy(desc(schema.documents.receivedAt)).limit(1);
    const [party] = await ctx.db.select({ id: schema.parties.id }).from(schema.parties)
      .orderBy(desc(schema.parties.createdAt)).limit(1);
    const [stop] = await ctx.db.select({ id: schema.stops.id }).from(schema.stops)
      .orderBy(sql`${schema.stops.happenedAt} DESC NULLS LAST`).limit(1);
    const [task] = await ctx.db.select({ id: schema.tasks.id }).from(schema.tasks)
      .orderBy(desc(schema.tasks.createdAt)).limit(1);
    const out = await Promise.all([
      mail && aboutLabel(ctx.db, { rawEmailId: mail.id }), doc && aboutLabel(ctx.db, { documentId: doc.id }),
      party && aboutLabel(ctx.db, { partyId: party.id }), stop && aboutLabel(ctx.db, { stopId: stop.id }),
      task && aboutLabel(ctx.db, { taskId: task.id }),
    ]);
    return out.filter((x): x is NonNullable<typeof x> => !!x);
  }),
});
