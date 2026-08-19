import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";

// Curated key events: Martin's hand-picked story of the process. Editable and
// deliberately NOT ledgered (like milestones) — the linked logbook entries and
// documents remain the evidence; this table is the narrative on top of them.

export const TIMELINE_EVENT_KINDS = ["process", "mail", "call", "meeting", "document", "other"] as const;

export const timelineEventFields = z.object({
  title: z.string().min(1),
  happenedAt: z.coerce.date(),
  kind: z.enum(TIMELINE_EVENT_KINDS).default("other"),
  note: z.string().nullish(),
  entryId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
  milestoneId: z.string().uuid().nullish(),
});

/** Strip undefined values so partial updates only touch provided columns. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

type EventRow = typeof schema.timelineEvents.$inferSelect;

/**
 * Attach small summaries for whatever each event links to, so the screen can
 * offer "→ see the logbook entry" jumps without a second round trip. Batched:
 * three lookups total, never one per row.
 */
async function withLinks(db: Db, rows: EventRow[]) {
  const ids = (pick: (r: EventRow) => string | null) =>
    [...new Set(rows.map(pick).filter((v): v is string => v !== null))];
  const entryIds = ids((r) => r.entryId);
  const documentIds = ids((r) => r.documentId);
  const milestoneIds = ids((r) => r.milestoneId);

  const [entries, documents, milestones] = await Promise.all([
    entryIds.length
      ? db.select({ id: schema.logEntries.id, summary: schema.logEntries.summary })
        .from(schema.logEntries).where(inArray(schema.logEntries.id, entryIds))
      : [],
    documentIds.length
      ? db.select({ id: schema.documents.id, title: schema.documents.title })
        .from(schema.documents).where(inArray(schema.documents.id, documentIds))
      : [],
    milestoneIds.length
      ? db.select({ id: schema.milestones.id, title: schema.milestones.title })
        .from(schema.milestones).where(inArray(schema.milestones.id, milestoneIds))
      : [],
  ]);

  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((r) => [r.id, r]));
  const entryMap = byId(entries);
  const documentMap = byId(documents);
  const milestoneMap = byId(milestones);

  return rows.map((r) => ({
    ...r,
    entry: (r.entryId && entryMap.get(r.entryId)) || null,
    document: (r.documentId && documentMap.get(r.documentId)) || null,
    milestone: (r.milestoneId && milestoneMap.get(r.milestoneId)) || null,
  }));
}

/** Newest first; id breaks ties so the order is stable across calls. */
function newestFirst(db: Db, limit?: number) {
  const q = db.select().from(schema.timelineEvents)
    .orderBy(desc(schema.timelineEvents.happenedAt), desc(schema.timelineEvents.id));
  return limit === undefined ? q : q.limit(limit);
}

export const timelineRouter = router({
  /** The full curated story, newest first. */
  list: protectedProcedure.query(async ({ ctx }) =>
    withLinks(ctx.db, await newestFirst(ctx.db))),

  /** Dashboard strip: the latest few key events. */
  recent: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(20).default(5) }).default({}))
    .query(async ({ ctx, input }) => withLinks(ctx.db, await newestFirst(ctx.db, input.limit))),

  create: protectedProcedure.input(timelineEventFields).mutation(async ({ ctx, input }) => {
    const [event] = await ctx.db.insert(schema.timelineEvents).values(input).returning();
    return event;
  }),

  update: protectedProcedure.input(timelineEventFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [event] = await ctx.db.select().from(schema.timelineEvents)
          .where(eq(schema.timelineEvents.id, id));
        if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Key event not found" });
        return event;
      }
      const [event] = await ctx.db.update(schema.timelineEvents).set(patch)
        .where(eq(schema.timelineEvents.id, id)).returning();
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Key event not found" });
      return event;
    }),
});
