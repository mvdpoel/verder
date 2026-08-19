import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { WSNP_STAGES, deriveTimeline } from "../wsnp-timeline";

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

  /** Dashboard strip: per-stage done/current/future/empty + settlement countdown. */
  timeline: protectedProcedure.query(async ({ ctx }) =>
    deriveTimeline(await allRows(ctx.db), new Date())),
});
