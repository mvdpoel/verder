import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveTaskStatus, setTaskStatus } from "../task-decide";
import { TASK_STATUSES, isValidTaskTransition, type TaskStatus } from "../task-status";

// --- input schemas -----------------------------------------------------------

// Exported: suggestions.approveTask reuses this shape so queue approval and
// manual creation can never drift apart (same rule as registry itemFields).
export const taskFields = z.object({
  title: z.string().min(1),
  details: z.string().nullish(),
  assigneePartyId: z.string().uuid().nullish(),
  dueAt: z.coerce.date().nullish(),
  entryId: z.string().uuid().nullish(),
  financialItemId: z.string().uuid().nullish(),
  debtId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
});

// Only the five known statuses reach setTaskStatus — garbage strings are
// rejected at the API boundary and can never enter the ledger. TASK_STATUSES
// is the single source of truth (task-status.ts); the cast just narrows the
// readonly array to the tuple type z.enum wants.
const taskStatusEnum = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]);

// --- helpers -----------------------------------------------------------------

export type Task = typeof schema.tasks.$inferSelect;

/** Strip undefined values so partial updates only touch provided columns. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Status timeline for one task, NEWEST FIRST. Ordered by ledger seq, not
 * createdAt — same rule as effectiveTaskStatus (see task-decide.ts): createdAt
 * is the transaction timestamp and ties within one transaction.
 */
async function statusTimeline(db: Db, taskId: string) {
  const rows = await db
    .select({ change: schema.taskStatusChanges })
    .from(schema.taskStatusChanges)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.taskStatusChanges.id),
      eq(schema.ledgerEvents.eventType, "task.status"),
    ))
    .where(eq(schema.taskStatusChanges.taskId, taskId))
    .orderBy(desc(schema.ledgerEvents.seq));
  return rows.map((r) => r.change);
}

const OPEN_SET: readonly string[] = ["open", "in-progress", "waiting"];

/** list filter → set of effective statuses it shows. */
const FILTER_SETS: Record<"open" | "waiting" | "done", readonly string[]> = {
  open: ["open", "in-progress"],
  waiting: ["waiting"],
  done: ["done", "dropped"],
};

// --- router ------------------------------------------------------------------

export const tasksRouter = router({
  /**
   * Tasks with effective status and assignee name. Order: non-done first
   * (done/dropped sink to the bottom), then dueAt ascending with nulls last,
   * then createdAt ascending — the top of the list is what needs attention.
   */
  list: protectedProcedure
    .input(z.object({ filter: z.enum(["open", "waiting", "done"]).optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({ task: schema.tasks, assigneeName: schema.parties.name })
        .from(schema.tasks)
        .leftJoin(schema.parties, eq(schema.tasks.assigneePartyId, schema.parties.id));
      const withStatus = await Promise.all(rows.map(async ({ task, assigneeName }) => ({
        ...task,
        assigneeName: assigneeName ?? null,
        effectiveStatus: await effectiveTaskStatus(ctx.db, task.id),
      })));
      const filtered = input.filter
        ? withStatus.filter((t) => FILTER_SETS[input.filter!].includes(t.effectiveStatus))
        : withStatus;
      return filtered.sort((a, b) => {
        const doneA = OPEN_SET.includes(a.effectiveStatus) ? 0 : 1;
        const doneB = OPEN_SET.includes(b.effectiveStatus) ? 0 : 1;
        if (doneA !== doneB) return doneA - doneB;
        const dueA = a.dueAt?.getTime() ?? Infinity;
        const dueB = b.dueAt?.getTime() ?? Infinity;
        if (dueA !== dueB) return dueA - dueB;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
    }),

  create: protectedProcedure.input(taskFields).mutation(async ({ ctx, input }) => {
    const [task] = await ctx.db.insert(schema.tasks)
      .values({ ...input, createdBy: ctx.userId }).returning();
    return task;
  }),

  update: protectedProcedure.input(taskFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [task] = await ctx.db.select().from(schema.tasks)
          .where(eq(schema.tasks.id, id));
        if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        return task;
      }
      const [task] = await ctx.db.update(schema.tasks).set(patch)
        .where(eq(schema.tasks.id, id)).returning();
      if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      return task;
    }),

  /** Task facts + status timeline (newest first) + linked evidence summaries. */
  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ task: schema.tasks, assigneeName: schema.parties.name })
        .from(schema.tasks)
        .leftJoin(schema.parties, eq(schema.tasks.assigneePartyId, schema.parties.id))
        .where(eq(schema.tasks.id, input.id));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const { task, assigneeName } = row;
      // Linked evidence as id + title/name summaries only — the detail screens
      // for the full records live at their own routes.
      const [entry] = task.entryId
        ? await ctx.db.select({ id: schema.logEntries.id, summary: schema.logEntries.summary })
            .from(schema.logEntries).where(eq(schema.logEntries.id, task.entryId))
        : [];
      const [financialItem] = task.financialItemId
        ? await ctx.db.select({ id: schema.financialItems.id, name: schema.financialItems.name })
            .from(schema.financialItems).where(eq(schema.financialItems.id, task.financialItemId))
        : [];
      const [debt] = task.debtId
        ? await ctx.db.select({ id: schema.debts.id, creditorName: schema.debts.creditorName })
            .from(schema.debts).where(eq(schema.debts.id, task.debtId))
        : [];
      const [document] = task.documentId
        ? await ctx.db.select({ id: schema.documents.id, title: schema.documents.title })
            .from(schema.documents).where(eq(schema.documents.id, task.documentId))
        : [];
      const timeline = await statusTimeline(ctx.db, task.id);
      return {
        ...task,
        assigneeName: assigneeName ?? null,
        effectiveStatus: timeline[0]?.status ?? "open",
        statusTimeline: timeline,
        linked: {
          entry: entry ?? null,
          financialItem: financialItem ?? null,
          debt: debt ?? null,
          document: document ?? null,
        },
      };
    }),

  setStatus: protectedProcedure.input(z.object({
    taskId: z.string().uuid(),
    status: taskStatusEnum,
    note: z.string().optional(),
    overrideReason: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => setTaskStatus(tx, ctx.userId, input))),

  /** Allowed next statuses from a given status — drives the status form. */
  validNext: protectedProcedure.input(z.object({ from: z.string().min(1) }))
    .query(({ input }) =>
      TASK_STATUSES.filter((to) => isValidTaskTransition(input.from, to))),

  /**
   * Dashboard tile counts. Statuses come from effectiveTaskStatus (ledger-seq
   * ordered) so the tile can never disagree with the screens. "Waiting" IS the
   * ball-is-elsewhere signal — no user↔party mapping exists or is needed.
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const tasks = await ctx.db
      .select({ id: schema.tasks.id, dueAt: schema.tasks.dueAt })
      .from(schema.tasks);
    const statuses = await Promise.all(
      tasks.map((t) => effectiveTaskStatus(ctx.db, t.id)));
    const now = Date.now();
    let openCount = 0; let overdueCount = 0; let waitingOnOthersCount = 0;
    tasks.forEach((task, i) => {
      const status = statuses[i];
      if (!OPEN_SET.includes(status)) return;
      openCount += 1;
      if (task.dueAt && task.dueAt.getTime() < now) overdueCount += 1;
      if (status === "waiting") waitingOnOthersCount += 1;
    });
    return { openCount, overdueCount, waitingOnOthersCount };
  }),
});
