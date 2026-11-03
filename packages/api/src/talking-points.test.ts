import { describe, expect, it } from "vitest";
import {
  briefSummary, buildTalkingPoints, MAX_POINTS, type TalkingPointsInput,
} from "./talking-points";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

function input(over: Partial<TalkingPointsInput> = {}): TalkingPointsInput {
  return {
    now: NOW, lastRequestAt: null, tasks: [], sent: [], debts: [], documents: [], openStops: [],
    ...over,
  };
}

const task = (id: string, over: Partial<TalkingPointsInput["tasks"][number]> = {}) => ({
  id, title: `Taak ${id}`, status: "waiting", statusAt: daysAgo(1), dueAt: null, createdAt: daysAgo(10),
  ...over,
});

describe("buildTalkingPoints — ask", () => {
  it("a task waiting on them is an ask, linked to the task", () => {
    const r = buildTalkingPoints(input({ tasks: [task("t1", { title: "Beschikking toesturen" })] }));
    expect(r.ask).toEqual([{
      id: "ask:task:t1", text: "Vraag naar: Beschikking toesturen",
      source: { type: "task", id: "t1", link: "verder://task/t1" },
    }]);
    expect(r.tell).toEqual([]);
  });

  it("an open or in-progress task is Martin's own work, not something to ask them", () => {
    const r = buildTalkingPoints(input({ tasks: [task("a", { status: "open" }), task("b", { status: "in-progress" })] }));
    expect(r.ask).toEqual([]);
  });

  it("waiting tasks rank by deadline, undated last", () => {
    const r = buildTalkingPoints(input({ tasks: [
      task("undated"),
      task("late", { dueAt: new Date("2026-11-20T00:00:00Z") }),
      task("soon", { dueAt: new Date("2026-11-05T00:00:00Z") }),
    ] }));
    expect(r.ask.map((p) => p.source.id)).toEqual(["soon", "late", "undated"]);
    expect(r.ask[0].text).toBe("Vraag naar: Taak soon (uiterlijk 5 nov)");
  });

  it("a mail sent two or more days ago with no reply is an ask; a fresh one is a tell", () => {
    const r = buildTalkingPoints(input({ sent: [
      { id: "p-old", type: "proposal", subject: "Loonstrook oktober", sentAt: daysAgo(5), repliedAt: null },
      { id: "m-new", type: "mail", subject: "Huurcontract", sentAt: daysAgo(1), repliedAt: null },
    ] }));
    expect(r.ask).toEqual([{
      id: "ask:proposal:p-old", text: "Nog geen antwoord op je mail van 29 okt: Loonstrook oktober",
      source: { type: "proposal", id: "p-old", link: "verder://proposal/p-old" },
    }]);
    expect(r.tell).toEqual([{
      id: "tell:mail:m-new", text: "Gemaild op 2 nov: Huurcontract",
      source: { type: "mail", id: "m-new", link: "verder://dossier" },
    }]);
  });

  it("an answered mail and a silence older than a month are neither", () => {
    const r = buildTalkingPoints(input({ sent: [
      { id: "answered", type: "proposal", subject: "A", sentAt: daysAgo(6), repliedAt: daysAgo(4) },
      { id: "ancient", type: "mail", subject: "B", sentAt: daysAgo(45), repliedAt: null },
    ] }));
    expect(r.ask).toEqual([]);
    expect(r.tell).toEqual([]);
  });

  it("a debt with an unknown amount asks for it; a known amount does not", () => {
    const r = buildTalkingPoints(input({ debts: [
      { id: "d1", creditorName: "Stroomnet Energie", claimedCents: null, reference: "INC-2026-114" },
      { id: "d2", creditorName: "Duinzorg", claimedCents: 12000, reference: null },
    ] }));
    expect(r.ask).toEqual([{
      id: "ask:debt:d1", text: "Vraag het gevorderde bedrag: Stroomnet Energie (INC-2026-114)",
      source: { type: "debt", id: "d1", link: "verder://dossier" },
    }]);
  });

  it("an open stop on their spoor is something to bring up", () => {
    const r = buildTalkingPoints(input({ openStops: [{ id: "s1", title: "Regeling afspreken", at: null }] }));
    expect(r.ask).toEqual([{
      id: "ask:stop:s1", text: "Bespreek: Regeling afspreken",
      source: { type: "stop", id: "s1", link: "verder://timeline" },
    }]);
  });

  it("asks rank tasks, then silences (longest first), then debts, then stops — and stop at MAX_POINTS", () => {
    const r = buildTalkingPoints(input({
      tasks: [task("t1"), task("t2")],
      sent: [
        { id: "s-3d", type: "mail", subject: "x", sentAt: daysAgo(3), repliedAt: null },
        { id: "s-9d", type: "mail", subject: "y", sentAt: daysAgo(9), repliedAt: null },
      ],
      debts: [{ id: "d1", creditorName: "B", claimedCents: null, reference: null },
        { id: "d0", creditorName: "A", claimedCents: null, reference: null }],
      openStops: [{ id: "st", title: "Z", at: null }],
    }));
    expect(MAX_POINTS).toBe(6);
    expect(r.ask.map((p) => p.source.id)).toEqual(["t1", "t2", "s-9d", "s-3d", "d0", "d1"]);
  });
});

describe("buildTalkingPoints — tell", () => {
  it("what Martin finished and filed since their last request, newest first", () => {
    const r = buildTalkingPoints(input({
      lastRequestAt: daysAgo(7),
      tasks: [
        task("done-after", { status: "done", statusAt: daysAgo(2), title: "Formulier ingevuld" }),
        task("done-before", { status: "done", statusAt: daysAgo(9) }),
      ],
      documents: [
        { id: "doc-sent", title: "Loonstrook.2026-10.pdf", at: daysAgo(3), how: "sent", status: "filed", purged: false },
        { id: "doc-filed", title: "Brief.pdf", at: daysAgo(1), how: "filed", status: "filed", purged: false },
        { id: "doc-old", title: "Oud.pdf", at: daysAgo(8), how: "filed", status: "filed", purged: false },
      ],
    }));
    expect(r.tell).toEqual([
      { id: "tell:document:doc-filed", text: "Ontvangen en opgeborgen: Brief.pdf",
        source: { type: "document", id: "doc-filed", link: "verder://document/doc-filed" } },
      { id: "tell:task:done-after", text: "Gedaan: Formulier ingevuld",
        source: { type: "task", id: "done-after", link: "verder://task/done-after" } },
      { id: "tell:document:doc-sent", text: "Opgestuurd op 31 okt: Loonstrook.2026-10.pdf",
        source: { type: "document", id: "doc-sent", link: "verder://document/doc-sent" } },
    ]);
  });

  it("with no request on record the window is the last 30 days", () => {
    const r = buildTalkingPoints(input({ tasks: [
      task("recent", { status: "done", statusAt: daysAgo(20) }),
      task("old", { status: "done", statusAt: daysAgo(40) }),
    ] }));
    expect(r.tell.map((p) => p.source.id)).toEqual(["recent"]);
  });

  it("a discarded or purged document never appears, whatever the loader handed in", () => {
    const r = buildTalkingPoints(input({ documents: [
      { id: "gone", title: "image.png", at: daysAgo(1), how: "filed", status: "discarded", purged: false },
      { id: "destroyed", title: "x.pdf", at: daysAgo(1), how: "sent", status: "filed", purged: true },
    ] }));
    expect(r.tell).toEqual([]);
  });

  it("tell stops at MAX_POINTS, and every id is unique", () => {
    const documents = Array.from({ length: 9 }, (_, i) => ({
      id: `d${i}`, title: `D${i}`, at: daysAgo(i + 1), how: "filed" as const, status: "filed", purged: false }));
    const r = buildTalkingPoints(input({ documents }));
    expect(r.tell).toHaveLength(MAX_POINTS);
    expect(r.tell.map((p) => p.source.id)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5"]);
    const ids = [...r.tell, ...r.ask].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a long title is shortened, never wrapped into a paragraph", () => {
    const r = buildTalkingPoints(input({ tasks: [task("t", { title: "x".repeat(300) })] }));
    expect(r.ask[0].text.length).toBeLessThanOrEqual(140);
    expect(r.ask[0].text.endsWith("…")).toBe(true);
  });

  it("the same input in any row order gives the same answer", () => {
    const sent = [
      { id: "a", type: "mail" as const, subject: "A", sentAt: daysAgo(4), repliedAt: null },
      { id: "b", type: "mail" as const, subject: "B", sentAt: daysAgo(4), repliedAt: null },
    ];
    expect(buildTalkingPoints(input({ sent })).ask)
      .toEqual(buildTalkingPoints(input({ sent: [...sent].reverse() })).ask);
  });
});

describe("briefSummary", () => {
  const ready = {
    status: "ready", summary: "Ilse vroeg op 1 nov om je loonstrook; die is nog niet gestuurd.",
    model: "claude-cli 2.1", promptVersion: "brief-v1", generatedAt: new Date("2026-11-02T08:00:00Z"),
    sourceRefs: [{ type: "mail" as const, id: "r1" }],
  };

  it("is shown only when ready, and is labelled as AI", () => {
    expect(briefSummary(ready)).toEqual({
      text: ready.summary, model: "claude-cli 2.1", promptVersion: "brief-v1",
      generatedAt: "2026-11-02T08:00:00.000Z", sourceRefs: [{ type: "mail", id: "r1" }],
      ai: true, label: "Samenvatting door AI",
    });
  });

  it("is null while pending, drafting or failed, and when there is no brief", () => {
    for (const status of ["pending", "drafting", "failed"]) {
      expect(briefSummary({ ...ready, status })).toBeNull();
    }
    expect(briefSummary(null)).toBeNull();
    expect(briefSummary({ ...ready, summary: null })).toBeNull();
  });
});
