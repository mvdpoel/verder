import { describe, expect, it } from "vitest";
import { isValidTaskTransition, TASK_STATUSES, type TaskStatus } from "./task-status";

// Full edge matrix from the design spec:
// open → {in-progress, waiting, done, dropped}; in-progress ↔ waiting;
// in-progress → {done, dropped}; waiting → {done, dropped};
// done → (none); dropped → (none)

const STATUSES: TaskStatus[] = ["open", "in-progress", "waiting", "done", "dropped"];

const EDGES: Record<TaskStatus, TaskStatus[]> = {
  open: ["in-progress", "waiting", "done", "dropped"],
  "in-progress": ["waiting", "done", "dropped"],
  waiting: ["in-progress", "done", "dropped"],
  done: [],
  dropped: [],
};

describe("isValidTaskTransition", () => {
  it("exports the five statuses in canonical order", () => {
    expect(TASK_STATUSES).toEqual(STATUSES);
  });

  it("matches the full edge matrix in both directions", () => {
    for (const from of STATUSES)
      for (const to of STATUSES)
        expect(isValidTaskTransition(from, to), `task ${from} → ${to}`)
          .toBe(EDGES[from].includes(to));
  });

  it("no status transitions to itself", () => {
    for (const s of STATUSES) expect(isValidTaskTransition(s, s)).toBe(false);
  });

  it("unknown statuses are never valid", () => {
    expect(isValidTaskTransition("open", "nonsense")).toBe(false);
    expect(isValidTaskTransition("nonsense", "done")).toBe(false);
    expect(isValidTaskTransition("", "open")).toBe(false);
    expect(isValidTaskTransition("open", "")).toBe(false);
    // registry statuses are unknown for tasks
    expect(isValidTaskTransition("identified", "allowed")).toBe(false);
    expect(isValidTaskTransition("open", "canceled")).toBe(false);
  });

  it("Object.prototype keys as statuses return false, never throw", () => {
    // A recorded override can put ANY string into a status-change row; a later
    // effective status of e.g. "constructor" must not crash validation
    // (edges["constructor"] on a plain object resolves to Object.prototype's
    // constructor — .includes is not a function) or the task is bricked.
    for (const s of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(() => isValidTaskTransition(s, "done"), `from=${s}`).not.toThrow();
      expect(isValidTaskTransition(s, "done")).toBe(false);
      expect(() => isValidTaskTransition("open", s), `to=${s}`).not.toThrow();
      expect(isValidTaskTransition("open", s)).toBe(false);
    }
  });
});
