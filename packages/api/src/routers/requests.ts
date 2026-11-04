import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "../effective-status";
import { requestFailureText, requestProgress } from "../request-progress";

/**
 * VRAAG GRIP — MARTIN'S SIDE (spec docs/superpowers/specs/2026-11-04-vraag-grip-design.md).
 *
 * He asks; the host runner (ops/request-runner.sh) researches with a read-only
 * tool server and the worker's `requests-store` writes the answer. Nothing here
 * researches, answers or sends: create queues a row, cancel stops one that has
 * not been answered, markOpened records that he read the answer (which takes it
 * off "waiting on Martin"). A request is NOT evidence and appends no ledger
 * event; a proposal it carried goes through the existing approval screen.
 */

type RequestRow = typeof schema.requests.$inferSelect;

/** Structural copies of the jsonb shapes in @grip/db's schema, so the router's
 *  inferred type never names that module's deep path (TS2742). */
export interface RequestSourceView { type: string; id: string; why: string; label?: string }
type AboutView = Partial<Record<"rawEmailId" | "documentId" | "partyId" | "stopId" | "taskId", string>>;
const DAY_MS = 24 * 3600 * 1000;
/** How long an answered (read) or failed request stays on the phone's list. */
const RECENT_MS = 7 * DAY_MS;
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
  { type: "mail" | "document" | "party" | "stop" | "task"; id: string; label: string } | null> {
  if (!about) return null;
  if (about.rawEmailId) {
    const [r] = await db.select({ subject: schema.rawEmails.subject }).from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, about.rawEmailId));
    return r ? { type: "mail", id: about.rawEmailId, label: r.subject } : null;
  }
  if (about.documentId) {
    const [d] = await db.select({ title: effectiveTitleSql }).from(schema.documents)
      .where(and(eq(schema.documents.id, about.documentId), notDiscardedSql, notPurgedSql));
    return d ? { type: "document", id: about.documentId, label: d.title } : null;
  }
  if (about.partyId) {
    const [p] = await db.select({ name: schema.parties.name }).from(schema.parties)
      .where(eq(schema.parties.id, about.partyId));
    return p ? { type: "party", id: about.partyId, label: p.name } : null;
  }
  if (about.stopId) {
    const [s] = await db.select({ title: schema.stops.title }).from(schema.stops)
      .where(eq(schema.stops.id, about.stopId));
    return s ? { type: "stop", id: about.stopId, label: s.title } : null;
  }
  if (about.taskId) {
    const [t] = await db.select({ title: schema.tasks.title }).from(schema.tasks)
      .where(eq(schema.tasks.id, about.taskId));
    return t ? { type: "task", id: about.taskId, label: t.title } : null;
  }
  return null;
}

function listItem(r: RequestRow, proposal: { id: string; status: string } | null) {
  const progress = requestProgress(r.toolLog ?? []);
  return {
    id: r.id, clientId: r.clientId, text: r.text, status: r.status as string,
    parentRequestId: r.parentRequestId,
    createdAt: r.createdAt, claimedAt: r.claimedAt, answeredAt: r.answeredAt, openedAt: r.openedAt,
    /** Answered and not yet opened: this one waits on Martin. */
    unread: r.status === "answered" && r.openedAt === null,
    progressLine: r.status === "working" ? progress.line : null,
    failure: r.status === "failed" ? requestFailureText(r.error) : null,
    proposal,
  };
}

async function proposalsFor(db: Db, ids: (string | null)[]): Promise<Map<string, { id: string; status: string; kind: string; payload: unknown; finalPayload: unknown }>> {
  const want = ids.filter((x): x is string => !!x);
  if (want.length === 0) return new Map();
  const rows = await db.select({
    id: schema.proposals.id, status: schema.proposals.status, kind: schema.proposals.kind,
    payload: schema.proposals.payload, finalPayload: schema.proposals.finalPayload,
  }).from(schema.proposals).where(inArray(schema.proposals.id, want));
  return new Map(rows.map((r) => [r.id, r]));
}

export const requestsRouter = router({
  /**
   * Queue a request. IDEMPOTENT on `clientId`: the phone retries a post whose
   * response it lost, and the retry returns the row the first one made.
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
   * The phone's list: everything queued or being worked on, every answer not
   * yet opened, and the read answers and failures of the last 7 days. Newest
   * first. Cancelled requests are not listed.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const since = new Date(Date.now() - RECENT_MS);
    const rows = await ctx.db.select().from(schema.requests).where(or(
      inArray(schema.requests.status, ["queued", "working"]),
      and(eq(schema.requests.status, "answered"), isNull(schema.requests.openedAt)),
      and(inArray(schema.requests.status, ["answered", "failed"]), gte(schema.requests.updatedAt, since)),
    )).orderBy(desc(schema.requests.createdAt), asc(schema.requests.id));
    const proposals = await proposalsFor(ctx.db, rows.map((r) => r.proposalId));
    return rows.map((r) => {
      const p = r.proposalId ? proposals.get(r.proposalId) : undefined;
      return listItem(r, p ? { id: p.id, status: p.status } : null);
    });
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
      .orderBy(asc(schema.requests.createdAt));

    const proposals = await proposalsFor(ctx.db, [r.proposalId]);
    const p = r.proposalId ? proposals.get(r.proposalId) : undefined;
    const reply = (p?.finalPayload ?? (p?.payload as { reply?: unknown } | undefined)?.reply ?? null) as
      { to?: string[]; subject?: string; attachmentDocumentIds?: string[] } | null;
    const progress = requestProgress(r.toolLog ?? []);

    return {
      ...listItem(r, p ? { id: p.id, status: p.status } : null),
      about: await aboutLabel(ctx.db, (r.about ?? null) as AboutView | null),
      answer: r.status === "answered" ? r.answer : null,
      sources: r.status === "answered" ? (r.sources ?? []) as RequestSourceView[] : [],
      martinSteps: r.status === "answered" ? (r.martinSteps ?? []) as string[] : [],
      proposal: p ? {
        id: p.id, status: p.status, kind: p.kind,
        to: reply?.to ?? [], subject: reply?.subject ?? null,
        attachmentCount: reply?.attachmentDocumentIds?.length ?? 0,
      } : null,
      progress: r.status === "working" || r.status === "queued"
        ? { calls: progress.calls, documents: progress.documents, mails: progress.mails,
          gmail: progress.gmail, line: progress.line }
        : null,
      thread: ancestors.map((a) => ({
        id: a.id, text: a.text, status: a.status, createdAt: a.createdAt,
        answer: a.status === "answered" ? a.answer : null,
      })),
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

  /** Martin opened the answer: it no longer waits on him. Idempotent. */
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
});
