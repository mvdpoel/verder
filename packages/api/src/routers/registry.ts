import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { decide, effectiveStatus } from "../registry-decide";

// --- input schemas -----------------------------------------------------------

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const itemFields = z.object({
  name: z.string().min(1),
  category: z.enum(["energy", "insurance", "telecom", "streaming", "software", "housing", "other"]),
  providerPartyId: z.string().uuid().nullish(),
  amountCents: z.number().int(),
  billingCycle: z.enum(["monthly", "quarterly", "yearly", "irregular"]),
  paymentChannel: z.enum(["direct-debit", "paypal", "apple", "invoice"]),
  contractStart: dateStr.nullish(),
  contractEnd: dateStr.nullish(),
  noticePeriod: z.string().nullish(),
  cancellationMethod: z.string().nullish(),
  cancellationDetails: z.string().nullish(),
  accountNumber: z.string().nullish(),
  discoveredVia: z.enum(["manual", "bank", "paypal", "apple", "email"]).default("manual"),
});

const debtFields = z.object({
  creditorPartyId: z.string().uuid().nullish(),
  creditorName: z.string().min(1),
  principalCents: z.number().int().nullish(),
  claimedCents: z.number().int(),
  references: z.string().nullish(),
  origin: z.string().nullish(),
  originStory: z.string().nullish(),
});

const decideInput = z.object({
  financialItemId: z.string().uuid().optional(),
  debtId: z.string().uuid().optional(),
  status: z.string().min(1),
  explanation: z.string().min(1),
  documentId: z.string().uuid().optional(),
  blockerNote: z.string().optional(),
  overrideReason: z.string().optional(),
});

// --- helpers -----------------------------------------------------------------

export type FinancialItem = typeof schema.financialItems.$inferSelect;
export type Debt = typeof schema.debts.$inferSelect;

/** Monthly-normalized cost in integer cents (integer division, never floats). */
export function monthlyCents(item: Pick<FinancialItem, "amountCents" | "billingCycle">): number {
  switch (item.billingCycle) {
    case "monthly": return item.amountCents;
    case "quarterly": return Math.trunc(item.amountCents / 3);
    case "yearly": return Math.trunc(item.amountCents / 12);
    case "irregular": return 0;
  }
}

/**
 * Decision timeline for one target, NEWEST FIRST. Ordered by ledger seq, not
 * createdAt — same rule as effectiveStatus (see registry-decide.ts): createdAt
 * is the transaction timestamp and ties within one transaction.
 */
async function decisionTimeline(
  db: Db, target: { financialItemId?: string; debtId?: string }
) {
  const where = target.financialItemId
    ? eq(schema.registryDecisions.financialItemId, target.financialItemId)
    : eq(schema.registryDecisions.debtId, target.debtId!);
  const rows = await db
    .select({ decision: schema.registryDecisions })
    .from(schema.registryDecisions)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.registryDecisions.id),
      eq(schema.ledgerEvents.eventType, "registry.decision"),
    ))
    .where(where)
    .orderBy(desc(schema.ledgerEvents.seq));
  return rows.map((r) => r.decision);
}

/** Documents referenced by a decision timeline (cancellation letters, claims). */
async function decisionDocuments(db: Db, decisions: { documentId: string | null }[]) {
  const ids = [...new Set(decisions.map((d) => d.documentId).filter((x): x is string => !!x))];
  if (!ids.length) return [];
  return db.select().from(schema.documents).where(inArray(schema.documents.id, ids));
}

/** Strip undefined values so partial updates only touch provided columns. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// --- routers -----------------------------------------------------------------

const itemsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.financialItems)
      .orderBy(desc(schema.financialItems.createdAt));
    return Promise.all(rows.map(async (item) => ({
      ...item,
      effectiveStatus: await effectiveStatus(ctx.db, { financialItemId: item.id }),
      monthlyCents: monthlyCents(item),
    })));
  }),

  create: protectedProcedure.input(itemFields).mutation(async ({ ctx, input }) => {
    const [item] = await ctx.db.insert(schema.financialItems).values(input).returning();
    return item;
  }),

  update: protectedProcedure.input(itemFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [item] = await ctx.db.select().from(schema.financialItems)
          .where(eq(schema.financialItems.id, id));
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Financial item not found" });
        return item;
      }
      const [item] = await ctx.db.update(schema.financialItems).set(patch)
        .where(eq(schema.financialItems.id, id)).returning();
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Financial item not found" });
      return item;
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [item] = await ctx.db.select().from(schema.financialItems)
        .where(eq(schema.financialItems.id, input.id));
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Financial item not found" });
      const decisions = await decisionTimeline(ctx.db, { financialItemId: item.id });
      const transactions = await ctx.db.select().from(schema.transactions)
        .where(eq(schema.transactions.financialItemId, item.id))
        .orderBy(desc(schema.transactions.bookedAt));
      return {
        ...item,
        effectiveStatus: decisions[0]?.status ?? "identified",
        monthlyCents: monthlyCents(item),
        decisions,
        transactions,
        documents: await decisionDocuments(ctx.db, decisions),
      };
    }),
});

const debtsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.debts)
      .orderBy(desc(schema.debts.createdAt));
    return Promise.all(rows.map(async (debt) => ({
      ...debt,
      effectiveStatus: await effectiveStatus(ctx.db, { debtId: debt.id }),
    })));
  }),

  create: protectedProcedure.input(debtFields).mutation(async ({ ctx, input }) => {
    const { references, ...rest } = input;
    const [debt] = await ctx.db.insert(schema.debts)
      .values({ ...rest, references_: references }).returning();
    return debt;
  }),

  update: protectedProcedure.input(debtFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, references, ...fields } = input;
      const patch = definedOnly({ ...fields, references_: references });
      if (Object.keys(patch).length === 0) {
        const [debt] = await ctx.db.select().from(schema.debts)
          .where(eq(schema.debts.id, id));
        if (!debt) throw new TRPCError({ code: "NOT_FOUND", message: "Debt not found" });
        return debt;
      }
      const [debt] = await ctx.db.update(schema.debts).set(patch)
        .where(eq(schema.debts.id, id)).returning();
      if (!debt) throw new TRPCError({ code: "NOT_FOUND", message: "Debt not found" });
      return debt;
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [debt] = await ctx.db.select().from(schema.debts)
        .where(eq(schema.debts.id, input.id));
      if (!debt) throw new TRPCError({ code: "NOT_FOUND", message: "Debt not found" });
      const decisions = await decisionTimeline(ctx.db, { debtId: debt.id });
      // Logbook entries involving the creditor (via the parties link).
      const relatedEntries = debt.creditorPartyId
        ? await ctx.db.select({ entry: schema.logEntries }).from(schema.logEntries)
            .innerJoin(schema.entryParticipants,
              eq(schema.entryParticipants.entryId, schema.logEntries.id))
            .where(eq(schema.entryParticipants.partyId, debt.creditorPartyId))
            .orderBy(desc(schema.logEntries.occurredAt))
            .then((rows) => rows.map((r) => r.entry))
        : [];
      // Documents: decision evidence + documents attached to related entries.
      const entryIds = relatedEntries.map((e) => e.id);
      const entryDocLinks = entryIds.length
        ? await ctx.db.select().from(schema.entryDocuments)
            .where(inArray(schema.entryDocuments.entryId, entryIds))
        : [];
      const decisionDocs = await decisionDocuments(ctx.db, decisions);
      const extraDocIds = [...new Set(entryDocLinks.map((l) => l.documentId))]
        .filter((id) => !decisionDocs.some((d) => d.id === id));
      const entryDocs = extraDocIds.length
        ? await ctx.db.select().from(schema.documents)
            .where(inArray(schema.documents.id, extraDocIds))
        : [];
      return {
        ...debt,
        effectiveStatus: decisions[0]?.status ?? "identified",
        decisions,
        relatedEntries,
        documents: [...decisionDocs, ...entryDocs],
      };
    }),
});

const transactionsRouter = router({
  listByItem: protectedProcedure
    .input(z.object({ financialItemId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      ctx.db.select().from(schema.transactions)
        .where(eq(schema.transactions.financialItemId, input.financialItemId))
        .orderBy(desc(schema.transactions.bookedAt))),

  link: protectedProcedure.input(z.object({
    transactionId: z.string().uuid(), financialItemId: z.string().uuid(),
  })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db.update(schema.transactions)
      .set({ financialItemId: input.financialItemId })
      .where(eq(schema.transactions.id, input.transactionId)).returning();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found" });
    return row;
  }),
});

export const registryRouter = router({
  items: itemsRouter,
  debts: debtsRouter,
  transactions: transactionsRouter,

  decide: protectedProcedure.input(decideInput).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => decide(tx, ctx.userId, input))),

  stats: protectedProcedure.query(async ({ ctx }) => {
    // Statuses come from effectiveStatus (ledger-seq ordered) so the tile can
    // never disagree with the screens. Integer cents throughout.
    const items = await ctx.db.select().from(schema.financialItems);
    const itemStatuses = await Promise.all(items.map((item) =>
      effectiveStatus(ctx.db, { financialItemId: item.id })));
    const debts = await ctx.db.select({ id: schema.debts.id }).from(schema.debts);
    const debtStatuses = await Promise.all(debts.map((d) =>
      effectiveStatus(ctx.db, { debtId: d.id })));
    let monthlyTotalCents = 0;
    let toCancelMonthlyCents = 0;
    let pendingDecisions = 0;
    items.forEach((item, i) => {
      const status = itemStatuses[i];
      // canceled items cost nothing anymore — excluded from the monthly total
      if (status !== "canceled") monthlyTotalCents += monthlyCents(item);
      if (status === "to-cancel") toCancelMonthlyCents += monthlyCents(item);
      if (status === "identified") pendingDecisions += 1;
    });
    pendingDecisions += debtStatuses.filter((s) => s === "identified").length;
    return { itemCount: items.length, monthlyTotalCents, toCancelMonthlyCents, pendingDecisions };
  }),
});
