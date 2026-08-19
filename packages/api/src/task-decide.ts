import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "./ledger";
import { isValidTaskTransition } from "./task-status";

export type TaskStatusChange = typeof schema.taskStatusChanges.$inferSelect;

export interface SetTaskStatusInput {
  taskId: string;
  status: string;
  note?: string;
  overrideReason?: string;
}

/**
 * Canonical ledger payload for task.status events. The verifier rebuilds this
 * from the live task_status_changes row to detect tampering, so any change to
 * this shape invalidates existing chains — never change it.
 */
export function taskStatusPayload(c: TaskStatusChange) {
  return {
    id: c.id,
    taskId: c.taskId,
    status: c.status,
    note: c.note ?? null,
    overrideReason: c.overrideReason ?? null,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Current status of a task: latest status-change row, default "open".
 *
 * "Latest" is defined by the ledger seq of each change's task.status event,
 * NOT by createdAt: createdAt is the transaction timestamp, so two changes
 * made in one transaction tie exactly, and under concurrency a transaction
 * that started earlier can commit later. The ledger seq is strictly monotonic
 * in recording order (appendLedgerEvent serializes on an advisory lock), and
 * every change gets its event in the same transaction. Any "latest change"
 * query elsewhere must order by seq the same way.
 */
export async function effectiveTaskStatus(db: Db, taskId: string): Promise<string> {
  const [latest] = await db
    .select({ status: schema.taskStatusChanges.status })
    .from(schema.taskStatusChanges)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.taskStatusChanges.id),
      eq(schema.ledgerEvents.eventType, "task.status"),
    ))
    .where(eq(schema.taskStatusChanges.taskId, taskId))
    .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
  return latest?.status ?? "open";
}

/**
 * Records a status change for a task: locks the tasks row (SELECT ... FOR
 * UPDATE) so a concurrent setTaskStatus on the same task blocks until this
 * transaction commits, then validates the transition against the re-read
 * effective status, inserts the insert-only change row and appends the
 * task.status ledger event in the SAME transaction (tx must be a transaction
 * handle). Without the lock, two transactions could both validate against the
 * same stale status and record a transition the matrix forbids — without an
 * overrideReason.
 *
 * An invalid transition throws unless an overrideReason is given — the
 * override is then itself part of the recorded change.
 */
export async function setTaskStatus(
  tx: Db, userId: string, input: SetTaskStatusInput
): Promise<TaskStatusChange> {
  const [task] = await tx.select({ id: schema.tasks.id }).from(schema.tasks)
    .where(eq(schema.tasks.id, input.taskId)).for("update");
  if (!task) throw new Error(`Task ${input.taskId} not found`);
  const current = await effectiveTaskStatus(tx, input.taskId);
  if (!isValidTaskTransition(current, input.status) && !input.overrideReason)
    throw new Error(
      `Invalid task status transition "${current}" → "${input.status}" — ` +
      "provide an overrideReason to record it anyway");
  const [change] = await tx.insert(schema.taskStatusChanges).values({
    taskId: input.taskId,
    status: input.status,
    note: input.note,
    overrideReason: input.overrideReason,
    createdBy: userId,
  }).returning();
  await appendLedgerEvent(tx, {
    eventType: "task.status",
    entityType: "task_status_change",
    entityId: change.id,
    payload: taskStatusPayload(change),
  });
  return change;
}
