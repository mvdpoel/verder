import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";
import { TASK_STATUSES, isValidTaskTransition, type TaskStatus } from "@grip/api/src/task-status";

/**
 * Strict, so an `overrideReason` is REFUSED rather than ignored: overriding a
 * blocked transition is a deliberate act the phone never offers, and a client
 * that sends one is not this app. A `taskId` in the body is refused too — the
 * path names the task.
 */
const statusBody = z.object({
  status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]),
  note: z.string().max(2000).optional(),
}).strict();

/**
 * Moves a task through `tasks.setStatus`, the ledgered path the web uses; the
 * procedure re-reads the effective status under lock and refuses an illegal
 * move (400). Answers the new status and where it may go next, so the phone
 * redraws its buttons without a second request.
 */
export const POST = mobilePost(async (caller, body, { id }) => {
  const { status, note } = statusBody.parse(body);
  const change = await caller.tasks.setStatus({ taskId: id, status, note });
  return {
    taskId: change.taskId, status: change.status,
    validNext: TASK_STATUSES.filter((to) => isValidTaskTransition(change.status, to)),
  };
});
