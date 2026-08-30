import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, isNull, max, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { buildTrackMap, filterDebtEpisodes, type StopRow, type TrackRow } from "../track-map";
import {
  effectiveTaskStatuses, resolveStopEvidence, type StopEvidence,
} from "../track-evidence";
import { effectiveTitleSql, notDiscardedSql } from "../effective-status";

/**
 * The case as a metro map. This router owns two editable display aids and
 * appends NO ledger events: the evidence stays in log_entries, documents and
 * tasks, and a stop only ever points at it.
 */

const TRACK_STATUSES = ["open", "done", "ended"] as const;
const STOP_STATES = ["done", "open", "expected"] as const;
const STOP_KINDS = ["process", "mail", "call", "meeting", "document", "other"] as const;
const WSNP_STAGES = ["application", "accepted", "onboarding", "wsnp-start",
  "settlement", "clean-slate"] as const;

const trackFields = z.object({
  title: z.string().min(1),
  status: z.enum(TRACK_STATUSES).default("open"),
  parentTrackId: z.string().uuid().nullish(),
  branchesAtStopId: z.string().uuid().nullish(),
  mergesAtStopId: z.string().uuid().nullish(),
  note: z.string().nullish(),
});

const stopFields = z.object({
  trackId: z.string().uuid(),
  title: z.string().min(1),
  kind: z.enum(STOP_KINDS).default("other"),
  state: z.enum(STOP_STATES).default("done"),
  happenedAt: z.coerce.date().nullish(),
  expectedAt: z.coerce.date().nullish(),
  stage: z.enum(WSNP_STAGES).nullish(),
  entryId: z.string().uuid().nullish(),
  taskId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
  note: z.string().nullish(),
  orderIndex: z.number().int().nullish(),
});

/** Strip undefined so a partial update only touches the columns it was given. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * A track may not become its own ancestor. Postgres cannot express this
 * cheaply, and buildTrackMap survives one — but a map that has to be repaired
 * on every read is a map with a bug in it, so the write is refused here.
 */
async function assertNoAncestryCycle(
  db: Db, trackId: string, parentTrackId: string | null
): Promise<void> {
  if (!parentTrackId) return;
  if (parentTrackId === trackId) {
    throw new TRPCError({ code: "BAD_REQUEST",
      message: "Een spoor kan niet zijn eigen vertrekpunt zijn." });
  }
  const rows = await db.select({
    id: schema.tracks.id, parentTrackId: schema.tracks.parentTrackId,
  }).from(schema.tracks);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentTrackId]));
  const seen = new Set<string>([trackId]);
  let cur: string | null = parentTrackId;
  while (cur) {
    if (seen.has(cur)) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Dat maakt het spoor zijn eigen voorganger." });
    }
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
}

/**
 * A spoor departs from a halte on the line it LEAVES, and rejoins the line it
 * left — never a third one. The check constraint cannot see this: it knows only
 * that a branch point is present, not whose halte it is.
 *
 * Without this the router happily writes the contradiction the map then has to
 * survive on every read — branching off a stop on a descendant closes a cycle —
 * and a map that must be repaired on every read is a map with a bug in it.
 */
async function assertBranchPointsBelongToParent(db: Db, opts: {
  parentTrackId: string | null;
  branchesAtStopId: string | null;
  mergesAtStopId: string | null;
}): Promise<void> {
  const checks = [
    { stopId: opts.branchesAtStopId,
      onRoot: "De hoofdlijn vertrekt niet vanaf een halte.",
      wrongLine: "Een spoor vertrekt vanaf een halte op de lijn die het verlaat." },
    { stopId: opts.mergesAtStopId,
      onRoot: "De hoofdlijn komt nergens op terug.",
      wrongLine: "Een spoor komt terug op de lijn die het verliet." },
  ];
  const ids = [...new Set(checks.map((c) => c.stopId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  // One query for both points, not one each.
  const rows = await db.select({ id: schema.stops.id, trackId: schema.stops.trackId })
    .from(schema.stops).where(inArray(schema.stops.id, ids));
  const trackOf = new Map(rows.map((r) => [r.id, r.trackId]));
  for (const c of checks) {
    if (!c.stopId) continue;
    if (!opts.parentTrackId)
      throw new TRPCError({ code: "BAD_REQUEST", message: c.onRoot });
    const owner = trackOf.get(c.stopId);
    if (!owner)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Die halte bestaat niet." });
    if (owner !== opts.parentTrackId)
      throw new TRPCError({ code: "BAD_REQUEST", message: c.wrongLine });
  }
}

/** % and _ typed into the search box are characters Martin meant, not wildcards. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const tracksRouter = router({
  /**
   * The whole map plus the evidence behind every stop. One query per table and
   * one batched evidence resolution — never one per stop.
   *
   * `hideDebtEpisodes` filters the ROWS handed to `buildTrackMap`, never the
   * `CaseMap` it returns — see `filterDebtEpisodes`'s own comment for why a
   * post-hoc filter would leave bands and lanes pointing at rows that no
   * longer exist. `hiddenDebtTrackCount` is returned so the page can say how
   * many spoors it folded away rather than let them disappear silently.
   */
  map: protectedProcedure
    .input(z.object({ hideDebtEpisodes: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const [tracks, stops] = await Promise.all([
        ctx.db.select().from(schema.tracks).orderBy(asc(schema.tracks.createdAt)),
        ctx.db.select().from(schema.stops)
          .orderBy(asc(schema.stops.trackId), asc(schema.stops.orderIndex)),
      ]);
      const filtered = filterDebtEpisodes({
        tracks: tracks as TrackRow[], stops: stops as StopRow[],
      }, input?.hideDebtEpisodes ?? false);
      const map = buildTrackMap(filtered);
      const evidence = await resolveStopEvidence(ctx.db, map.stops.map((s) => ({
        id: s.id, entryId: s.entryId, taskId: s.taskId, documentId: s.documentId,
      })));
      return {
        map,
        evidence: Object.fromEntries(evidence) as Record<string, StopEvidence>,
        hiddenDebtTrackCount: filtered.hiddenTrackCount,
      };
    }),

  /**
   * What a halte can be linked to. Without this the third level of the map —
   * the mail and its files behind a stop, the branch Martin drew on paper — is
   * reachable only from the migration: createStop has always taken
   * entryId/taskId/documentId and nothing ever offered him the choice.
   *
   * Bounded and batched: three list queries plus ONE status lookup for every
   * task returned, never one per row.
   *
   * Discarded documents are excluded through the same effective-status
   * resolution documents.list uses, because a discard is APPENDED to
   * document_status_changes and never written back — documents.status reads
   * "inbox" forever, so a raw read would offer him the signature image he threw
   * away. IS DISTINCT FROM, not <>: the subquery is NULL for a document nobody
   * ever touched and NULL <> 'discarded' is NULL, which would offer nothing.
   */
  linkOptions: protectedProcedure.input(z.object({
    // Deliberately not .min(1): an empty or whitespace-only box is "no filter",
    // not a validation error the search field has to defend against.
    search: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(50),
  }).default({})).query(async ({ ctx, input }) => {
    const needle = input.search?.trim();
    const like = needle ? `%${escapeLike(needle)}%` : null;
    // The live title, so a document renamed after filing is findable — and
    // offered — under the name it now has. effectiveTitleSql, the shared
    // expression, and not a COALESCE spelled out here: it reads the newest
    // change row that NAMES a title, so a rename followed by a change that is
    // silent about the title still offers the new name.
    const liveTitle = effectiveTitleSql;

    const [entries, tasks, documents] = await Promise.all([
      ctx.db.select({
        id: schema.logEntries.id, summary: schema.logEntries.summary,
        occurredAt: schema.logEntries.occurredAt, channel: schema.logEntries.channel,
      }).from(schema.logEntries)
        .where(like ? ilike(schema.logEntries.summary, like) : undefined)
        .orderBy(desc(schema.logEntries.occurredAt), desc(schema.logEntries.recordedAt))
        .limit(input.limit),
      ctx.db.select({ id: schema.tasks.id, title: schema.tasks.title })
        .from(schema.tasks)
        .where(like ? ilike(schema.tasks.title, like) : undefined)
        .orderBy(desc(schema.tasks.createdAt)).limit(input.limit),
      ctx.db.select({
        id: schema.documents.id, title: liveTitle,
        receivedAt: schema.documents.receivedAt,
      }).from(schema.documents).where(and(
        notDiscardedSql,
        like ? sql`${liveTitle} ILIKE ${like}` : undefined,
      )).orderBy(desc(schema.documents.receivedAt)).limit(input.limit),
    ]);

    const statuses = await effectiveTaskStatuses(ctx.db, tasks.map((t) => t.id));
    return {
      entries,
      // The effective status, read live: a stop never copies it.
      tasks: tasks.map((t) => ({ ...t, status: statuses.get(t.id) ?? "open" })),
      documents,
    };
  }),

  createTrack: protectedProcedure.input(trackFields).mutation(async ({ ctx, input }) => {
    if (!input.parentTrackId) {
      // The single-root index would refuse this anyway; catching it here turns a
      // constraint violation into a sentence Martin can read.
      const existing = await ctx.db.select({ id: schema.tracks.id })
        .from(schema.tracks).where(isNull(schema.tracks.parentTrackId));
      if (existing.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST",
          message: "Er is al een hoofdlijn. Een zijspoor vertrekt vanaf een halte." });
      }
    } else if (!input.branchesAtStopId) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Kies de halte waar dit spoor vertrekt." });
    }
    await assertBranchPointsBelongToParent(ctx.db, {
      parentTrackId: input.parentTrackId ?? null,
      branchesAtStopId: input.branchesAtStopId ?? null,
      mergesAtStopId: input.mergesAtStopId ?? null,
    });
    const [track] = await ctx.db.insert(schema.tracks).values(input).returning();
    return track;
  }),

  updateTrack: protectedProcedure
    .input(trackFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (patch.parentTrackId !== undefined || patch.branchesAtStopId !== undefined
        || patch.mergesAtStopId !== undefined) {
        const [existing] = await ctx.db.select().from(schema.tracks)
          .where(eq(schema.tracks.id, id));
        if (!existing)
          throw new TRPCError({ code: "NOT_FOUND", message: "Spoor niet gevonden" });
        // The EFFECTIVE geometry, not only the half being written: moving a
        // spoor to another parent invalidates a branch point that was fine
        // before, and moving the merge has to be judged against the parent the
        // spoor will actually have.
        const pick = (k: "parentTrackId" | "branchesAtStopId" | "mergesAtStopId") =>
          (patch[k] !== undefined ? patch[k] : existing[k]) as string | null;
        await assertNoAncestryCycle(ctx.db, id, pick("parentTrackId"));
        await assertBranchPointsBelongToParent(ctx.db, {
          parentTrackId: pick("parentTrackId"),
          branchesAtStopId: pick("branchesAtStopId"),
          mergesAtStopId: pick("mergesAtStopId"),
        });
      }
      if (Object.keys(patch).length === 0) {
        const [track] = await ctx.db.select().from(schema.tracks)
          .where(eq(schema.tracks.id, id));
        if (!track) throw new TRPCError({ code: "NOT_FOUND", message: "Spoor niet gevonden" });
        return track;
      }
      const [track] = await ctx.db.update(schema.tracks).set(patch)
        .where(eq(schema.tracks.id, id)).returning();
      if (!track) throw new TRPCError({ code: "NOT_FOUND", message: "Spoor niet gevonden" });
      return track;
    }),

  /** Appends to the end of its track unless an explicit position is given. */
  createStop: protectedProcedure.input(stopFields).mutation(async ({ ctx, input }) => {
    const { orderIndex, ...fields } = input;
    let position = orderIndex ?? null;
    if (position === null) {
      const [row] = await ctx.db.select({ last: max(schema.stops.orderIndex) })
        .from(schema.stops).where(eq(schema.stops.trackId, input.trackId));
      position = (row?.last ?? -1) + 1;
    }
    const [stop] = await ctx.db.insert(schema.stops)
      .values({ ...fields, orderIndex: position }).returning();
    return stop;
  }),

  updateStop: protectedProcedure
    .input(stopFields.partial().omit({ trackId: true }).extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [stop] = await ctx.db.select().from(schema.stops)
          .where(eq(schema.stops.id, id));
        if (!stop) throw new TRPCError({ code: "NOT_FOUND", message: "Halte niet gevonden" });
        return stop;
      }
      const [stop] = await ctx.db.update(schema.stops).set(patch)
        .where(eq(schema.stops.id, id)).returning();
      if (!stop) throw new TRPCError({ code: "NOT_FOUND", message: "Halte niet gevonden" });
      return stop;
    }),
});
