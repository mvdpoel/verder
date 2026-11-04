import { describe, expect, it } from "vitest";
import type { StopRow } from "./track-map";
import type { RequestThreadRow } from "./request-threads";
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

describe("Vraag Grip in waitingOnMartin (the final frames' folding rule)", () => {
  const req = (over: Partial<RequestThreadRow> & { id: string }): RequestThreadRow => ({
    parentRequestId: null, text: `Vraag ${over.id}`, title: null, status: "answered",
    createdAt: ago(3), answeredAt: ago(2), openedAt: null, dismissedAt: null, updatedAt: ago(2),
    martinSteps: [], stepsDone: {}, proposal: null, ...over,
  });
  const fromRequest = (id: string, requestId: string, over: Partial<ProposalRow> = {}) =>
    proposal({ id, priority: "verder", createdAt: ago(2), triggerRequestId: requestId, ...over });

  it("an answered request with a pending proposal is ONE item, the proposal not listed apart", () => {
    const items = run({
      requests: [req({ id: "r", title: "Boedelbeschrijving Noordkust",
        proposal: { id: "pr", status: "pending", priority: "verder" }, martinSteps: ["Check het huurcontract"] })],
      proposals: [fromRequest("pr", "r"), proposal({ id: "p-ilse", priority: "verder", createdAt: ago(30) })],
    });
    expect(items.map((i) => i.id)).toEqual(["r", "p-ilse"]);
    expect(items[0]).toMatchObject({ kind: "request", title: "Boedelbeschrijving Noordkust",
      subtitle: "Nieuw antwoord · 1 voorstel", verder: true });
    expect(waitingCounts(items)).toEqual({ count: 2, todo: 2, review: 0 });
  });

  it("read, it still waits while a step is open or its proposal is pending", () => {
    const opened = { openedAt: ago(1) };
    const both = run({ requests: [req({ id: "r", ...opened, martinSteps: ["a"],
      proposal: { id: "pr", status: "pending", priority: "other" } })], proposals: [fromRequest("pr", "r")] });
    expect(both.map((i) => [i.id, i.subtitle])).toEqual([["r", "1 voorstel · 1 stap voor jou"]]);
    const stepOnly = run({ requests: [req({ id: "r", ...opened, martinSteps: ["a", "b"], stepsDone: { 0: ago(1).toISOString() } })] });
    expect(stepOnly.map((i) => i.subtitle)).toEqual(["1 stap voor jou"]);
    const allDone = run({ requests: [req({ id: "r", ...opened, martinSteps: ["a"], stepsDone: { 0: ago(1).toISOString() } })] });
    expect(allDone).toEqual([]);
    const sent = run({ requests: [req({ id: "r", ...opened, proposal: { id: "pr", status: "sent", priority: "other" } })] });
    expect(sent).toEqual([]);
  });

  it("a FAILED request waits on Martin (retry or drop), and counts as todo", () => {
    const items = run({ requests: [req({ id: "r", status: "failed", answeredAt: null, updatedAt: ago(0.5) })] });
    expect(items).toMatchObject([{ kind: "request", id: "r", subtitle: "Lukte niet · Opnieuw" }]);
    expect(waitingCounts(items).todo).toBe(1);
  });

  it("queued and working requests wait on Grip and are not listed", () => {
    expect(run({ requests: [req({ id: "q", status: "queued", answeredAt: null }),
      req({ id: "w", status: "working", answeredAt: null })] })).toEqual([]);
  });

  it("Laat maar releases the proposal as its own row: the count stays the same", () => {
    const before = run({
      requests: [req({ id: "r", openedAt: ago(1), proposal: { id: "pr", status: "pending", priority: "verder" } })],
      proposals: [fromRequest("pr", "r", { partyName: "Bewindkantoor Noordkust" })],
    });
    const after = run({
      requests: [req({ id: "r", openedAt: ago(1), dismissedAt: ago(0.2),
        proposal: { id: "pr", status: "pending", priority: "verder" } })],
      proposals: [fromRequest("pr", "r", { partyName: "Bewindkantoor Noordkust" })],
    });
    expect(before.map((i) => i.kind)).toEqual(["request"]);
    expect(after).toMatchObject([{ kind: "proposal", id: "pr", subtitle: "Uit je vraag" }]);
    expect(waitingCounts(after).todo).toBe(waitingCounts(before).todo);
  });

  it("a put-away failure, or one without a proposal, leaves Voor jou entirely", () => {
    expect(run({ requests: [req({ id: "r", status: "failed", dismissedAt: ago(0.1) })] })).toEqual([]);
  });

  it("while a follow-up works, the thread waits on Grip and version 1 is NOT offered", () => {
    const items = run({
      requests: [
        req({ id: "r", openedAt: ago(1), proposal: { id: "pr", status: "pending", priority: "verder" } }),
        req({ id: "f", parentRequestId: "r", status: "working", createdAt: ago(0.5), answeredAt: null }),
      ],
      proposals: [fromRequest("pr", "r")],
    });
    expect(items).toEqual([]);
  });

  it("a thread is one row, by its newest answer; a stopped follow-up hands it back", () => {
    const answered = run({ requests: [
      req({ id: "r", title: "Boedelbeschrijving Noordkust", openedAt: ago(1) }),
      req({ id: "f", parentRequestId: "r", createdAt: ago(0.5), answeredAt: ago(0.4),
        proposal: { id: "p2", status: "pending", priority: "verder" } }),
    ], proposals: [fromRequest("p2", "f")] });
    expect(answered.map((i) => [i.id, i.title])).toEqual([["f", "Boedelbeschrijving Noordkust"]]);
    const stopped = run({ requests: [
      req({ id: "r", martinSteps: ["a"], openedAt: ago(1) }),
      req({ id: "f", parentRequestId: "r", status: "cancelled", createdAt: ago(0.5), answeredAt: null }),
    ] });
    expect(stopped.map((i) => i.id)).toEqual(["r"]);
  });

  it("a retried failure is replaced by its retry, never shown twice", () => {
    const items = run({ requests: [
      req({ id: "old", text: "Zoek de polis", status: "failed", dismissedAt: ago(0.3), createdAt: ago(5) }),
      req({ id: "new", text: "Zoek de polis", status: "queued", createdAt: ago(0.3), answeredAt: null }),
    ] });
    expect(items).toEqual([]);
  });
});
