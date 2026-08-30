import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { bundleRuleSchema, parseBundleRule, type BundleRule } from "../bundle-rule";
import { effectiveDocStatusSql, effectivePartyIdSql, notDiscardedSql } from "../effective-status";
import { docTypeKeySql } from "./documents";
import { docTypeKey } from "../doc-type";

/**
 * A bundle is NOT evidence. Nothing in this file appends a ledger event, and
 * that is deliberate: a bundle is a VIEW onto evidence, never a claim about the
 * case. It is also why DELETE is granted on these two tables and nowhere else.
 */

/**
 * The bare Amsterdam timestamp receivedMonthSql's month key is built from.
 * A rule's date range compares against this rather than the raw UTC column
 * for the same reason receivedMonthSql exists: date membership is an
 * Amsterdam question — a UTC comparison would misjudge a booking near
 * midnight the same way a UTC month bucket would.
 */
const receivedAtAmsterdamSql = sql`(documents.received_at AT TIME ZONE 'Europe/Amsterdam')`;

function ruleWhere(rule: BundleRule): SQL {
  const parts: (SQL | undefined)[] = [
    // A rule excludes discarded documents UNLESS it asks for them by name.
    // That is the only route: nothing else can pull a discarded document into
    // a rule bundle.
    rule.status ? sql`${effectiveDocStatusSql} = ${rule.status}` : notDiscardedSql,
    // The SAME key the tree groups its soort branch on and browse's soort
    // branch filters on (docTypeKeySql), compared against the rule's literal
    // folded through docTypeKey — Task 4's fold, not a third hand-rolled copy
    // of it — so both sides collapse whitespace/case identically. A rule's
    // count must never disagree with the branch it was built from.
    rule.docType ? sql`${docTypeKeySql} = ${docTypeKey(rule.docType)}` : undefined,
    rule.partyId ? sql`${effectivePartyIdSql} = ${rule.partyId}` : undefined,
    rule.source ? sql`documents.source = ${rule.source}` : undefined,
    rule.from ? sql`${receivedAtAmsterdamSql} >= ${rule.from}` : undefined,
    rule.to ? sql`${receivedAtAmsterdamSql} <= ${rule.to}` : undefined,
  ];
  return sql.join(parts.filter((p): p is SQL => p !== undefined), sql` AND `);
}

/**
 * Which documents a bundle holds — the one place that knows the difference
 * between the two kinds. The zip route calls this, so a rule bundle's download
 * is always current and a manual bundle's download is always what was curated.
 */
export async function resolveBundleDocumentIds(db: Db, bundleId: string): Promise<string[]> {
  const [b] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, bundleId));
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Bundle not found" });
  if (b.kind === "manual") {
    const rows = await db.select({ id: schema.bundleDocuments.documentId })
      .from(schema.bundleDocuments)
      .where(eq(schema.bundleDocuments.bundleId, bundleId))
      .orderBy(schema.bundleDocuments.addedAt);
    return rows.map((r) => r.id);
  }
  const parsed = parseBundleRule(b.rule);
  if (!parsed.ok) return [];
  const rows = await db.select({ id: schema.documents.id })
    .from(schema.documents).where(ruleWhere(parsed.rule))
    .orderBy(desc(schema.documents.receivedAt));
  return rows.map((r) => r.id);
}

export const bundlesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.bundles)
      .orderBy(desc(schema.bundles.updatedAt));
    return Promise.all(rows.map(async (b) => {
      const parsed = b.kind === "rule" ? parseBundleRule(b.rule) : null;
      const ids = await resolveBundleDocumentIds(ctx.db, b.id);
      return { ...b,
        rule: parsed?.ok ? parsed.rule : null,
        broken: parsed && !parsed.ok ? parsed.message : null,
        count: ids.length };
    }));
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [b] = await ctx.db.select().from(schema.bundles)
        .where(eq(schema.bundles.id, input.id));
      if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Bundle not found" });
      const parsed = b.kind === "rule" ? parseBundleRule(b.rule) : null;
      return { ...b,
        rule: parsed?.ok ? parsed.rule : null,
        broken: parsed && !parsed.ok ? parsed.message : null,
        documentIds: await resolveBundleDocumentIds(ctx.db, input.id) };
    }),

  create: protectedProcedure.input(z.object({
    name: z.string().min(1), note: z.string().optional(),
    kind: z.enum(["manual", "rule"]), rule: bundleRuleSchema.optional(),
  })).mutation(async ({ ctx, input }) => {
    if ((input.kind === "rule") !== (input.rule !== undefined)) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Een regelbundel heeft een regel nodig; een handmatige bundel juist niet" });
    }
    const [b] = await ctx.db.insert(schema.bundles).values({
      name: input.name, note: input.note, kind: input.kind,
      rule: input.rule ?? null }).returning();
    return b;
  }),

  rename: protectedProcedure.input(z.object({
    id: z.string().uuid(), name: z.string().min(1), note: z.string().optional(),
  })).mutation(async ({ ctx, input }) => {
    const [b] = await ctx.db.update(schema.bundles)
      .set({ name: input.name, note: input.note, updatedAt: new Date() })
      .where(eq(schema.bundles.id, input.id)).returning();
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Bundle not found" });
    return b;
  }),

  remove: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => ctx.db.transaction(async (tx) => {
      // The links first: bundle_documents references bundles.
      await tx.delete(schema.bundleDocuments)
        .where(eq(schema.bundleDocuments.bundleId, input.id));
      await tx.delete(schema.bundles).where(eq(schema.bundles.id, input.id));
    })),

  addDocuments: protectedProcedure.input(z.object({
    id: z.string().uuid(), documentIds: z.array(z.string().uuid()).min(1),
  })).mutation(async ({ ctx, input }) => {
    const [b] = await ctx.db.select().from(schema.bundles)
      .where(eq(schema.bundles.id, input.id));
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Bundle not found" });
    // The cross-table half of bundles_rule_ck, guarded here because a trigger
    // is a worse thing to own than a guard with a test.
    if (b.kind === "rule") {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Deze bundel volgt een regel — pas de regel aan in plaats van stukken toe te voegen" });
    }
    await ctx.db.insert(schema.bundleDocuments)
      .values(input.documentIds.map((documentId) => ({ bundleId: input.id, documentId })))
      .onConflictDoNothing();
    await ctx.db.update(schema.bundles)
      .set({ updatedAt: new Date() }).where(eq(schema.bundles.id, input.id));
  }),

  removeDocument: protectedProcedure.input(z.object({
    id: z.string().uuid(), documentId: z.string().uuid(),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(schema.bundleDocuments).where(and(
      eq(schema.bundleDocuments.bundleId, input.id),
      eq(schema.bundleDocuments.documentId, input.documentId)));
  }),
});
