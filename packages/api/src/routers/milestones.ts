import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { WSNP_STAGES, deriveTimeline, type MilestoneRow } from "../wsnp-timeline";

// Milestones are an editable fact table and a display aid — deliberately NOT
// ledgered (design spec): the underlying facts are logbook/vault evidence.

export const milestoneFields = z.object({
  stage: z.enum(WSNP_STAGES),
  title: z.string().min(1),
  happenedAt: z.coerce.date().nullish(),
  expectedAt: z.coerce.date().nullish(),
  done: z.boolean().default(false),
  note: z.string().nullish(),
  entryId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
});

/** Strip undefined values so partial updates only touch provided columns. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** All milestone rows in stable creation order (grouping happens per caller). */
function allRows(db: Db) {
  return db.select().from(schema.milestones)
    .orderBy(asc(schema.milestones.createdAt), asc(schema.milestones.id));
}

export const milestonesRouter = router({
  /** All six stages in fixed WSNP order, each with its milestones (may be empty). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await allRows(ctx.db);
    return WSNP_STAGES.map((stage) => ({
      stage, milestones: rows.filter((m) => m.stage === stage),
    }));
  }),

  create: protectedProcedure.input(milestoneFields).mutation(async ({ ctx, input }) => {
    const [milestone] = await ctx.db.insert(schema.milestones).values(input).returning();
    return milestone;
  }),

  update: protectedProcedure.input(milestoneFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [milestone] = await ctx.db.select().from(schema.milestones)
          .where(eq(schema.milestones.id, id));
        if (!milestone) throw new TRPCError({ code: "NOT_FOUND", message: "Milestone not found" });
        return milestone;
      }
      const [milestone] = await ctx.db.update(schema.milestones).set(patch)
        .where(eq(schema.milestones.id, id)).returning();
      if (!milestone) throw new TRPCError({ code: "NOT_FOUND", message: "Milestone not found" });
      return milestone;
    }),

  /**
   * Dashboard strip: per-stage done/current/future/empty + settlement countdown.
   *
   * Reads the STAGE, not a track title. A stop carrying a `wsnp_stage` is a
   * named station wherever it stands, so the strip selects `stage IS NOT NULL`
   * across EVERY track and never `tracks.title = 'WSNP'`: that title is a
   * free-text field in the track editor, and hanging the six stages and the
   * 18-month countdown off a display string means renaming the spoor empties
   * the strip silently. It also means a stage-carrying stop that Martin put on
   * his own hand-built WSNP-aanvraag spoor is part of the strip, which is the
   * only reading that matches what the map draws.
   *
   * deriveTimeline itself is deliberately untouched: the 547-day rule must
   * produce the same answer it produced before this sub-project.
   */
  timeline: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.stops)
      .where(isNotNull(schema.stops.stage))
      // The wsnp_stage enum is DECLARED in the fixed strip order, so Postgres
      // sorts by that order for free. Grouping happens per stage anyway; this
      // keeps the rows inside a stage in map order.
      .orderBy(asc(schema.stops.stage), asc(schema.stops.orderIndex), asc(schema.stops.id));
    return deriveTimeline(stageRows(rows), new Date());
  }),
});

/**
 * The staged stops the strip is allowed to reason about.
 *
 * A stop with `state: 'expected'` is a PLACEHOLDER — migration 0023 seeds one
 * for every stage that has no milestone behind it, and Martin can add more. It
 * is not evidence that a stage has begun, so it must not count towards
 * done/current: with the placeholders in, all six groups are non-empty forever,
 * `currentIdx` sticks on the first stage, and the strip claims the case is at
 * Aanvraag while the map draws it years further on. Dropping them restores the
 * "empty" state, which is exactly what a stage with nothing behind it read as
 * before this sub-project.
 *
 * A stop is "afgerond" or it is not; deriveTimeline speaks done/undone.
 */
export function stageRows<
  S extends { stage: string | null; state: string; happenedAt: Date | null },
>(stops: S[]): (Omit<S, "stage"> & MilestoneRow)[] {
  return stops
    .filter((s) => s.stage !== null && s.state !== "expected")
    .map((s) => ({ ...s, stage: s.stage as string, done: s.state === "done" }));
}
