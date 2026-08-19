import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { decide, effectiveStatus } from "../registry-decide";
import { DEBT_STATUSES, ITEM_STATUSES, isValidTransition } from "../registry-status";
import { effectiveTaskStatus } from "../task-decide";

// --- input schemas -----------------------------------------------------------

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Exported: suggestions.approveRegistryItem/approveDebt reuse these shapes so
// queue approval and manual creation can never drift apart.
export const itemFields = z.object({
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

export const debtFields = z.object({
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

/** Task statuses that still block a registry decision (same set as tasks.list "open ball"). */
const BLOCKING_TASK_STATUSES: readonly string[] = ["open", "in-progress", "waiting"];

/** Task statuses that count as "cleared": the linked work was finished or let go. */
const CLEARED_TASK_STATUSES: readonly string[] = ["done", "dropped"];

/**
 * Linked-task view for a financial item: tasks linked via financialItemId,
 * split by EFFECTIVE status (latest by ledger seq — see task-decide.ts) into
 * live blockers (open/in-progress/waiting) and a cleared count (done/dropped).
 * The cleared count is what makes the "blocker cleared" nudge truthful — an
 * item that never had a linked task has nothing to clear. Blockers ordered
 * like the tasks screen: dueAt ascending with nulls last, then createdAt —
 * the most urgent blocker first.
 */
async function linkedTasksForItem(db: Db, financialItemId: string) {
  const rows = await db
    .select({
      id: schema.tasks.id, title: schema.tasks.title,
      dueAt: schema.tasks.dueAt, createdAt: schema.tasks.createdAt,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.financialItemId, financialItemId));
  const withStatus = await Promise.all(rows.map(async (t) => ({
    ...t, effectiveStatus: await effectiveTaskStatus(db, t.id),
  })));
  const blockingTasks = withStatus
    .filter((t) => BLOCKING_TASK_STATUSES.includes(t.effectiveStatus))
    .sort((a, b) => {
      const dueA = a.dueAt?.getTime() ?? Infinity;
      const dueB = b.dueAt?.getTime() ?? Infinity;
      if (dueA !== dueB) return dueA - dueB;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map(({ id, title, effectiveStatus: status, dueAt }) => ({
      id, title, effectiveStatus: status, dueAt,
    }));
  const clearedTaskCount = withStatus
    .filter((t) => CLEARED_TASK_STATUSES.includes(t.effectiveStatus)).length;
  return { blockingTasks, clearedTaskCount };
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
      const { blockingTasks, clearedTaskCount } = await linkedTasksForItem(ctx.db, item.id);
      return {
        ...item,
        effectiveStatus: decisions[0]?.status ?? "identified",
        monthlyCents: monthlyCents(item),
        decisions,
        transactions,
        documents: await decisionDocuments(ctx.db, decisions),
        blockingTasks,
        clearedTaskCount,
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

  /** Allowed next statuses from a given status — drives the decision form. */
  validNext: protectedProcedure
    .input(z.object({ kind: z.enum(["item", "debt"]), from: z.string().min(1) }))
    .query(({ input }) => {
      const all = input.kind === "item" ? ITEM_STATUSES : DEBT_STATUSES;
      return all.filter((to) => isValidTransition(input.kind, input.from, to));
    }),

  /**
   * Items whose blocker actually cleared: the latest ledgered decision carries
   * a blockerNote, no linked task still has a live effective status
   * (open/in-progress/waiting), and at least one linked task finished
   * (done/dropped). Items that never had a linked task are excluded — nothing
   * was cleared there, the note is just a note. Drives the dashboard nudge.
   *
   * Set-based on purpose (one query, not N× items.get). Both "latest" lookups
   * order by ledger seq, exactly like decisionTimeline/effectiveTaskStatus —
   * createdAt ties within a transaction (sub-project 2 lesson). A task with no
   * status changes coalesces to 'open', matching effectiveTaskStatus.
   */
  clearedBlockers: protectedProcedure.query(async ({ ctx }) => {
    const rows = (await ctx.db.execute(sql`
      WITH latest_decision AS (
        SELECT DISTINCT ON (d.financial_item_id) d.financial_item_id, d.blocker_note
        FROM registry_decisions d
        JOIN ledger_events e
          ON e.entity_id = d.id AND e.event_type = 'registry.decision'
        WHERE d.financial_item_id IS NOT NULL
        ORDER BY d.financial_item_id, e.seq DESC
      ),
      task_effective AS (
        SELECT t.financial_item_id,
          COALESCE(
            (SELECT c.status FROM task_status_changes c
             JOIN ledger_events te
               ON te.entity_id = c.id AND te.event_type = 'task.status'
             WHERE c.task_id = t.id ORDER BY te.seq DESC LIMIT 1),
            'open') AS status
        FROM tasks t
        WHERE t.financial_item_id IS NOT NULL
      )
      SELECT i.id, i.name, ld.blocker_note
      FROM financial_items i
      JOIN latest_decision ld ON ld.financial_item_id = i.id
      WHERE ld.blocker_note IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_effective te
          WHERE te.financial_item_id = i.id
            AND te.status IN ('open', 'in-progress', 'waiting'))
        AND EXISTS (
          SELECT 1 FROM task_effective te
          WHERE te.financial_item_id = i.id
            AND te.status IN ('done', 'dropped'))
      ORDER BY i.name`)).rows as { id: string; name: string; blocker_note: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, blockerNote: r.blocker_note }));
  }),

  /**
   * Full registry snapshot for the VerderGroep report (print export): every
   * item with provider name, monthly-normalized cost and its latest ledgered
   * decision, every debt with its status, plus the ledger head hash so the
   * report carries the same tamper-evidence statement as the logbook export.
   */
  exportReport: protectedProcedure.query(async ({ ctx }) => {
    const itemRows = await ctx.db
      .select({ item: schema.financialItems, providerName: schema.parties.name })
      .from(schema.financialItems)
      .leftJoin(schema.parties, eq(schema.financialItems.providerPartyId, schema.parties.id))
      .orderBy(schema.financialItems.name);
    const items = await Promise.all(itemRows.map(async ({ item, providerName }) => {
      const decisions = await decisionTimeline(ctx.db, { financialItemId: item.id });
      return {
        id: item.id, name: item.name, category: item.category,
        providerName: providerName ?? null,
        amountCents: item.amountCents, billingCycle: item.billingCycle,
        monthlyCents: monthlyCents(item),
        status: decisions[0]?.status ?? "identified",
        latestExplanation: decisions[0]?.explanation ?? null,
      };
    }));
    const debtRows = await ctx.db.select().from(schema.debts)
      .orderBy(schema.debts.creditorName);
    const debts = await Promise.all(debtRows.map(async (debt) => {
      const decisions = await decisionTimeline(ctx.db, { debtId: debt.id });
      return {
        id: debt.id, creditorName: debt.creditorName,
        principalCents: debt.principalCents, claimedCents: debt.claimedCents,
        references: debt.references_,
        status: decisions[0]?.status ?? "identified",
      };
    }));
    const [head] = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    return {
      generatedAt: new Date().toISOString(),
      headHash: head?.eventHash ?? null,
      items, debts,
    };
  }),

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
