import { describe, expect, it } from "vitest";
import type { StopRow } from "./track-map";
import {
  WAITING_TASK_STATUSES, waitingCounts, waitingOnMartin,
  type ProposalRow, type SuggestionRow, type TaskRow,
} from "./waiting";

const NOW = new Date("2026-10-31T10:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000);
const ahead = (hours: number) => new Date(NOW.getTime() + hours * 3600_000);

const proposal = (over: Partial<ProposalRow> & { id: string }): ProposalRow => ({
  kind: "reply", priority: "other", createdAt: ago(1),
  payload: { ask: `Vraag ${over.id}`, dueAt: null, question: null },
  partyName: null, senderGuess: null, ...over,
});
const suggestion = (over: Partial<SuggestionRow> & { id: string }): SuggestionRow => ({
  kind: "task", createdAt: ago(2), proposed: { title: `Suggestie ${over.id}` },
  documentTitle: null, emailSubject: null, ...over,
});
const task = (over: Partial<TaskRow> & { id: string }): TaskRow => ({
  title: `Taak ${over.id}`, status: "open", dueAt: null, createdAt: ago(48), ...over,
});
const stop = (over: Partial<StopRow> & { id: string }): StopRow => ({
  trackId: "spine", orderIndex: 100, title: `Halte ${over.id}`, kind: "process",
  state: "open", happenedAt: null, expectedAt: null, stage: null,
  entryId: null, taskId: null, documentId: null, note: null, ...over,
});

const run = (over: Partial<Parameters<typeof waitingOnMartin>[0]> = {}) =>
  waitingOnMartin({
    proposals: [], suggestions: [], tasks: [], currentStop: null, now: NOW, ...over,
  });

describe("waitingOnMartin", () => {
  it("verder proposal ranks above every other kind", () => {
    const items = run({
      // The verder proposal is the OLDEST item here, so only its rank can put it first.
      proposals: [
        proposal({ id: "p-other", priority: "creditor", createdAt: ago(1) }),
        proposal({ id: "p-verder", priority: "verder", createdAt: ago(500) }),
      ],
      suggestions: [suggestion({ id: "s1", createdAt: ago(0.5) })],
      tasks: [task({ id: "t1", dueAt: ahead(2) })],
      currentStop: stop({ id: "st1" }),
    });
    expect(items.map((i) => i.id)).toEqual(["p-verder", "p-other", "s1", "t1", "st1"]);
    expect(items[0]).toMatchObject({ kind: "proposal", verder: true, priority: 1 });
    expect(items.filter((i) => i.verder).map((i) => i.id)).toEqual(["p-verder"]);
  });

  it("a question proposal is a question item, titled by its prompt", () => {
    const [item] = run({ proposals: [proposal({ id: "q1", kind: "question",
      payload: { ask: "Nieuwe brief", dueAt: "2026-11-02T00:00:00.000Z",
        question: { prompt: "Is dit de loonstrook van oktober?", options: [] } } })] });
    expect(item).toMatchObject({ kind: "question", title: "Is dit de loonstrook van oktober?",
      dueAt: "2026-11-02T00:00:00.000Z" });
  });

  it("task due within 24h is priority 1 and amber-worthy", () => {
    const items = run({ tasks: [
      task({ id: "soon", dueAt: ahead(23) }),
      task({ id: "overdue", dueAt: ago(5) }),
      task({ id: "later", dueAt: ahead(25) }),
      task({ id: "undated" }),
    ] });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.soon.priority).toBe(1);
    expect(byId.overdue.priority).toBe(1);
    expect(byId.later.priority).toBe(3);
    expect(byId.undated.priority).toBe(3);
    // Every item on this list is waiting on Martin; that is what amber means.
    expect(items.map((i) => i.id)).toEqual(["overdue", "soon", "later", "undated"]);
  });

  it("waiting task is not waiting on Martin", () => {
    expect(run({ tasks: [task({ id: "w", status: "waiting" })] })).toEqual([]);
  });

  it("in-progress task is waiting on Martin", () => {
    expect(WAITING_TASK_STATUSES).toEqual(["open", "in-progress"]);
    const items = run({ tasks: [task({ id: "ip", status: "in-progress" })] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "task", id: "ip" });
  });

  it("done and dropped tasks are absent", () => {
    expect(run({ tasks: [task({ id: "d", status: "done" }),
      task({ id: "x", status: "dropped" })] })).toEqual([]);
  });

  it("no open stop adds nothing", () => {
    expect(run({ currentStop: null })).toEqual([]);
    // A stop that is not open is not "the current open stop", whatever handed it in.
    expect(run({ currentStop: stop({ id: "done", state: "done" }) })).toEqual([]);
  });

  it("current stop linked to an open task counts once", () => {
    const items = run({
      tasks: [task({ id: "t-linked" })],
      currentStop: stop({ id: "st", title: "Stukken aanleveren", taskId: "t-linked" }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "task", id: "t-linked", subtitle: "Stukken aanleveren" });
  });

  it("current stop linked to a task that is not waiting on Martin is its own item", () => {
    const items = run({
      tasks: [task({ id: "t-w", status: "waiting" })],
      currentStop: stop({ id: "st", taskId: "t-w" }),
    });
    expect(items.map((i) => [i.kind, i.id])).toEqual([["stop", "st"]]);
  });

  it("a proposal item names its party's id (the call sheet opens from it); other kinds carry null", () => {
    const items = run({
      proposals: [proposal({ id: "p", partyId: "party-1", partyName: "Bewindkantoor Noordkust" }),
        proposal({ id: "p-none" })],
      suggestions: [suggestion({ id: "s" })],
      tasks: [task({ id: "t" })],
      currentStop: stop({ id: "st" }),
    });
    expect(items.map((i) => [i.id, i.partyId])).toEqual([
      ["p", "party-1"], ["p-none", null], ["s", null], ["t", null], ["st", null]]);
  });

  it("ranking is stable for equal timestamps (ties break on id)", () => {
    const at = ago(3);
    const input = {
      proposals: [proposal({ id: "pb", createdAt: at }), proposal({ id: "pa", createdAt: at })],
      suggestions: [suggestion({ id: "sb", createdAt: at }), suggestion({ id: "sa", createdAt: at })],
      tasks: [task({ id: "tb", createdAt: at }), task({ id: "ta", createdAt: at })],
    };
    const forward = run(input).map((i) => i.id);
    const reversed = run({
      proposals: [...input.proposals].reverse(),
      suggestions: [...input.suggestions].reverse(),
      tasks: [...input.tasks].reverse(),
    }).map((i) => i.id);
    expect(forward).toEqual(["pa", "pb", "sa", "sb", "ta", "tb"]);
    expect(reversed).toEqual(forward);
  });

  it("serialises instants as ISO strings", () => {
    const [item] = run({ tasks: [task({ id: "t", dueAt: new Date("2026-11-05T09:00:00Z"),
      createdAt: new Date("2026-10-01T08:00:00Z") })] });
    expect(item.at).toBe("2026-10-01T08:00:00.000Z");
    expect(item.dueAt).toBe("2026-11-05T09:00:00.000Z");
  });
});

describe("waitingCounts", () => {
  it("the suggestion backlog is review; proposals, questions, tasks and the stop are todo", () => {
    const items = run({
      proposals: [proposal({ id: "p" }), proposal({ id: "q", kind: "question" })],
      suggestions: [suggestion({ id: "s1" }), suggestion({ id: "s2", kind: "log-entry" }),
        suggestion({ id: "s3", kind: "document-meta" })],
      tasks: [task({ id: "t" })],
      currentStop: stop({ id: "halte" }),
    });
    expect(waitingCounts(items)).toEqual({ count: 7, todo: 4, review: 3 });
  });
});
