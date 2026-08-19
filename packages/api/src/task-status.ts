// Pure status logic for tasks (no DB access). Statuses are process steps for
// a task's lifecycle; the edge matrix below comes from the design spec and is
// enforced by setTaskStatus() — with a recorded override as the only escape
// hatch.

export type TaskStatus = "open" | "in-progress" | "waiting" | "done" | "dropped";

export const TASK_STATUSES: readonly TaskStatus[] =
  ["open", "in-progress", "waiting", "done", "dropped"];

const TASK_EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in-progress", "waiting", "done", "dropped"],
  "in-progress": ["waiting", "done", "dropped"],
  waiting: ["in-progress", "done", "dropped"],
  done: [],
  dropped: [],
};

export function isValidTaskTransition(from: string, to: string): boolean {
  const edges: Record<string, readonly string[]> = TASK_EDGES;
  // Object.hasOwn guard: an overridden change can put any string into the
  // status column, and a bare edges[from] lookup would resolve prototype keys
  // ("constructor", "toString", …) to non-arrays and throw.
  return Object.hasOwn(edges, from) ? edges[from].includes(to) : false;
}
