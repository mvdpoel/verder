import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { WEEKLY_SUMMARY_WORKER_NAME } from "@verder/api/src/worker-names";
import type { WaitingItem } from "@verder/api/src/waiting";
import type { WeeklySummary } from "@verder/api/src/weekly-summary";
import {
  composeWeekly, loadWeekly, runWeeklySummary, summaryWeek, weekOf, weeklyBody, type WeeklyInput,
} from "./weekly-summary";
import { notify, type NotifyFn } from "./notify/notify";
import { fakeNotify } from "./test-support/fake-notify";

const OWN = ["martin@vanderpoel.pro"];
// ISO week 2026-W44: Monday 26 October … Sunday 1 November (CET from 25-10).
const W44 = { from: "2026-10-26", to: "2026-11-01" };

function input(over: Partial<WeeklyInput> = {}): WeeklyInput {
  return {
    week: W44, ownAddresses: OWN, outboundEntries: [], sentProposals: [], emails: [],
    statusChanges: [], documentStatus: {}, tasksDone: [], waiting: [], ...over,
  };
}

const item = (n: number): WaitingItem => ({
  kind: "task", id: `t${n}`, title: `Geheime taak ${n}`, subtitle: null, priority: 3,
  at: "2026-10-30T10:00:00.000Z", dueAt: null, verder: false,
});

describe("composeWeekly (pure)", () => {
  it("week boundaries are Amsterdam Monday to Sunday", () => {
    // Sunday 18:00 Amsterdam = 17:00 UTC in winter time.
    expect(weekOf(new Date("2026-11-01T17:00:00Z"))).toEqual({ ...W44, key: "2026-W44" });
    // Monday 00:30 Amsterdam is still Sunday 23:30 UTC — it belongs to the NEW week.
    expect(weekOf(new Date("2026-10-25T23:30:00Z"))).toEqual({ ...W44, key: "2026-W44" });

    const s = composeWeekly(input({
      outboundEntries: [
        { occurredAt: new Date("2026-10-25T22:30:00Z") }, // Sun 23:30 Amsterdam (CET) → previous week
        { occurredAt: new Date("2026-10-25T23:30:00Z") }, // Mon 00:30 Amsterdam → in
        { occurredAt: new Date("2026-11-01T22:59:00Z") }, // Sun 23:59 Amsterdam → in
        { occurredAt: new Date("2026-11-01T23:00:00Z") }, // Mon 00:00 Amsterdam → next week
      ],
    }));
    expect(s).toMatchObject({ week: "2026-W44", from: W44.from, to: W44.to, sent: 2 });
  });

  it("a run summarises the newest week whose Sunday 18:00 has passed", () => {
    const W43 = { from: "2026-10-19", to: "2026-10-25", key: "2026-W43" };
    // Sunday 18:00 Amsterdam (CET) exactly, and later that evening: this week.
    expect(summaryWeek(new Date("2026-11-01T17:00:00Z"))).toEqual({ ...W44, key: "2026-W44" });
    expect(summaryWeek(new Date("2026-11-01T22:59:00Z"))).toEqual({ ...W44, key: "2026-W44" });
    // Sunday 17:59: the week has not been summarised yet — last week.
    expect(summaryWeek(new Date("2026-11-01T16:59:00Z"))).toEqual(W43);
    // Monday 00:30 Amsterdam (a pg-boss job that started late): the week that just ENDED.
    expect(summaryWeek(new Date("2026-11-01T23:30:00Z"))).toEqual({ ...W44, key: "2026-W44" });
    // Wednesday, a hand-run: still the week that ended last Sunday.
    expect(summaryWeek(new Date("2026-11-04T12:00:00Z"))).toEqual({ ...W44, key: "2026-W44" });
    // Summer time: Sunday 18:00 CEST is 16:00 UTC, so 16:30 UTC is past it…
    expect(summaryWeek(new Date("2026-10-18T16:30:00Z")).key).toBe("2026-W42");
    // …and 15:30 UTC (17:30 CEST) is not.
    expect(summaryWeek(new Date("2026-10-18T15:30:00Z")).key).toBe("2026-W41");
    // Across a year boundary: Monday 2027-01-04 recovers 2026-W53.
    expect(summaryWeek(new Date("2027-01-04T09:00:00Z")))
      .toEqual({ from: "2026-12-28", to: "2027-01-03", key: "2026-W53" });
  });

  it("sent counts entries plus proposals with no entry yet, never a question", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    const s = composeWeekly(input({
      outboundEntries: [{ occurredAt: at }],
      sentProposals: [
        { kind: "reply", sentAt: at, resultEntryId: null }, // no entry yet → counted
        { kind: "follow-up", sentAt: at, resultEntryId: "e1" }, // its entry is counted already
        { kind: "question", sentAt: at, resultEntryId: null }, // nothing left the house
      ],
    }));
    expect(s.sent).toBe(2);
  });

  it("own outbound mail is not received", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    const s = composeWeekly(input({
      emails: [
        { fromAddr: "martin@vanderpoel.pro", sentAt: at }, // JMAP: a parsed address
        { fromAddr: "incasso@stam.nl", sentAt: at },
        { fromAddr: "demi@verdergroep.nl", sentAt: new Date("2026-10-20T10:00:00Z") }, // previous week
      ],
    }));
    expect(s.received).toBe(1);
  });

  it("a Gmail-era whole From header is parsed, not substring-matched", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    const s = composeWeekly(input({
      emails: [
        { fromAddr: "Martin van der Poel <martin@vanderpoel.pro>", sentAt: at }, // own
        { fromAddr: "Martin <MARTIN@VanderPoel.pro>", sentAt: at }, // own, ASCII-folded
        // Contains Martin's address as TEXT but was sent by someone else.
        { fromAddr: '"martin@vanderpoel.pro" <attacker@evil.tld>', sentAt: at },
        { fromAddr: "Demi Willemse <demi@verdergroep.nl>", sentAt: at },
      ],
    }));
    expect(s.received).toBe(2);
  });

  it("filed splits by actor", () => {
    const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
    const s = composeWeekly(input({
      documentStatus: { a: "inbox", b: "inbox", c: "inbox", d: "inbox" },
      statusChanges: [
        { id: "1", documentId: "a", status: "filed", actor: null, createdAt: at("27") },
        { id: "2", documentId: "b", status: "filed", actor: "verder", createdAt: at("28") },
        { id: "3", documentId: "c", status: "filed", actor: "verder", createdAt: at("29") },
        // Filed LAST week: not this week's.
        { id: "4", documentId: "d", status: "filed", actor: null, createdAt: at("20") },
      ],
    }));
    expect(s).toMatchObject({ filedByMartin: 1, filedByVerder: 2 });
  });

  it("renaming an already-filed document does not count as filed again", () => {
    const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
    const s = composeWeekly(input({
      documentStatus: { a: "inbox", b: "inbox" },
      statusChanges: [
        // a: filed last week, renamed this week — every change row restates the status.
        { id: "1", documentId: "a", status: "filed", actor: null, createdAt: at("20") },
        { id: "2", documentId: "a", status: "filed", actor: null, createdAt: at("27") },
        // b: filed, unfiled, filed again inside one week — counted ONCE.
        { id: "3", documentId: "b", status: "filed", actor: "verder", createdAt: at("27") },
        { id: "4", documentId: "b", status: "inbox", actor: null, createdAt: at("28") },
        { id: "5", documentId: "b", status: "filed", actor: null, createdAt: at("29") },
      ],
    }));
    expect(s).toMatchObject({ filedByMartin: 0, filedByVerder: 1 });
  });

  it("tasks done counts each task once, inside the week", () => {
    const s = composeWeekly(input({
      tasksDone: [
        { taskId: "x", createdAt: new Date("2026-10-27T10:00:00Z") },
        { taskId: "x", createdAt: new Date("2026-10-28T10:00:00Z") },
        { taskId: "y", createdAt: new Date("2026-10-29T10:00:00Z") },
        { taskId: "z", createdAt: new Date("2026-10-19T10:00:00Z") },
      ],
    }));
    expect(s.tasksDone).toBe(2);
  });

  it("waiting is the whole list, topWaiting its first three", () => {
    const s = composeWeekly(input({ waiting: [item(1), item(2), item(3), item(4)] }));
    expect(s.waiting).toBe(4);
    expect(s.topWaiting.map((w) => w.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("body holds counts only", () => {
    const s: WeeklySummary = {
      week: "2026-W44", from: W44.from, to: W44.to, sent: 3, received: 7,
      filedByMartin: 2, filedByVerder: 3, tasksDone: 2, waiting: 4,
      topWaiting: [item(1), item(2), item(3)],
    };
    const body = weeklyBody(s);
    expect(body).toBe("3 verstuurd · 7 binnen · 5 opgeborgen · 2 taken klaar — 4 wachten op jou");
    expect(body).not.toContain("Geheime");
    expect(weeklyBody({ ...s, tasksDone: 1, waiting: 1 }))
      .toBe("3 verstuurd · 7 binnen · 5 opgeborgen · 1 taak klaar — 1 wacht op jou");
    expect(weeklyBody({ ...s, waiting: 0 }))
      .toBe("3 verstuurd · 7 binnen · 5 opgeborgen · 2 taken klaar — niets wacht op jou");
  });
});

// ---- against the database, as verder_worker --------------------------------
// Every test is a transaction that is ROLLED BACK (the shared dev database is
// never truncated). The week is a random ISO week in the 1990s, so its window
// holds only this test's fixtures.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let worker: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { worker = createDb(WORKER_URL); });
afterAll(() => worker.pool.end());

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await worker.db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** Sunday 18:00 Amsterdam (17:00 UTC in winter) in a random week of the 1990s. */
function sundayLongAgo(): Date {
  // 1995-01-01 was a Sunday.
  const weeks = Math.floor(Math.random() * 250);
  return new Date(Date.UTC(1995, 0, 1 + 7 * weeks, 17));
}
const uid = () => crypto.randomUUID();
const noWaiting = async () => [] as WaitingItem[];

describe("loadWeekly and the job (database)", () => {
  it("loadWeekly reads every source for the week", async () => {
    await isolated(async (db) => {
      const now = sundayLongAgo();
      const week = weekOf(now);
      const midweek = new Date(now.getTime() - 3 * 24 * 3600_000);
      const [user] = await db.insert(schema.users).values({
        email: `weekly-${uid()}@example.test`, name: "Weekly Testfixture" }).returning();
      const [entry] = await db.insert(schema.logEntries).values({ occurredAt: midweek,
        channel: "email", direction: "outbound", summary: `Weekly Testfixture ${uid()}`,
        source: "manual", createdBy: user.id }).returning();
      // A correction supersedes the entry: one outbound message, counted once.
      await db.insert(schema.logEntries).values({ occurredAt: midweek, channel: "email",
        direction: "outbound", summary: `Weekly Testfixture ${uid()}`, source: "manual",
        createdBy: user.id, supersedesId: entry.id });
      await db.insert(schema.logEntries).values({ occurredAt: midweek, channel: "email",
        direction: "inbound", summary: `Weekly Testfixture ${uid()}`, source: "manual", createdBy: user.id });
      for (const from of ["Martin van der Poel <martin@vanderpoel.pro>", `Stam <incasso-${uid()}@stam.nl>`]) {
        await db.insert(schema.rawEmails).values({ gmailMessageId: `weekly-${uid()}`,
          gmailThreadId: `t-${uid()}`, fromAddr: from, toAddr: "x@example.test",
          subject: "Weekly Testfixture", sentAt: midweek, rawRfc822Sha256: uid(), bodyText: "" });
      }
      const [doc] = await db.insert(schema.documents).values({
        sha256: (uid() + uid()).replaceAll("-", ""), sizeBytes: 1, mime: "application/pdf",
        title: `Weekly Testfixture ${uid()}.pdf`, source: "upload", receivedAt: midweek }).returning();
      await db.insert(schema.documentTexts).values({ documentId: doc.id, sha256: doc.sha256,
        extractor: "none", text: "", charCount: 0 });
      await db.insert(schema.documentStatusChanges).values({ documentId: doc.id, status: "filed",
        title: doc.title, createdAt: midweek });
      const [task] = await db.insert(schema.tasks).values({ title: `Weekly Testfixture ${uid()}`,
        createdBy: user.id }).returning();
      await db.insert(schema.taskStatusChanges).values({ taskId: task.id, status: "done",
        createdBy: user.id, createdAt: midweek });

      const loaded = await loadWeekly(db, week, { waiting: noWaiting, ownAddresses: () => OWN });
      const s = composeWeekly(loaded);
      expect(s).toMatchObject({ week: week.key, sent: 1, received: 1, filedByMartin: 1,
        filedByVerder: 0, tasksDone: 1, waiting: 0 });
    });
  });

  it("the job records the summary and sends one passive weekly push", async () => {
    await isolated(async (db) => {
      const now = sundayLongAgo();
      const fake = fakeNotify();
      const out = await runWeeklySummary({ db, notify: fake.notify, now: () => now, waiting: noWaiting });
      const key = weekOf(now).key;
      expect(fake.sent).toEqual([{
        kind: "weekly", level: "passive", title: "Je week", body: weeklyBody(out.summary),
        link: "verder://inbox", dedupKey: `weekly:${key}`,
      }]);
      const rows = await db.select().from(schema.workerRuns)
        .where(eq(schema.workerRuns.worker, WEEKLY_SUMMARY_WORKER_NAME));
      const mine = rows.find((r) => (r.detail as { summary?: WeeklySummary } | null)?.summary?.week === key);
      expect(mine).toMatchObject({ status: "ok", detail: { summary: out.summary } });
    });
  });

  it("a retried job sends one push", async () => {
    await isolated(async (db) => {
      const now = sundayLongAgo();
      // The REAL notify(), with no APNs key and no VAPID keys: the dedup is the
      // notifications table's, and that is what a pg-boss retry meets.
      const real: NotifyFn = (n) => notify({ db, apns: async () => null, webPush: () => null,
        waitingCount: async () => 0 }, n);
      const first = await runWeeklySummary({ db, notify: real, now: () => now, waiting: noWaiting });
      const retry = await runWeeklySummary({ db, notify: real,
        now: () => new Date(now.getTime() + 60_000), waiting: noWaiting });
      expect(first.sent).toBe(true);
      expect(retry.sent).toBe(false);
      const rows = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `weekly:${weekOf(now).key}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "weekly", level: "passive", title: "Je week" });
    });
  });

  it("a hand-run on Monday recovers the PREVIOUS week, and the next Sunday still sends", async () => {
    await isolated(async (db) => {
      const sunday = sundayLongAgo();
      const monday = new Date(sunday.getTime() + 15 * 3600_000); // Monday ~09:00
      const nextSunday = new Date(sunday.getTime() + 7 * 24 * 3600_000);
      const ended = weekOf(sunday);
      // A fixture on the Wednesday of the week that ended: the recovery must count it.
      const wednesday = new Date(sunday.getTime() - 4 * 24 * 3600_000);
      const [user] = await db.insert(schema.users).values({
        email: `weekly-${uid()}@example.test`, name: "Weekly Testfixture" }).returning();
      await db.insert(schema.logEntries).values({ occurredAt: wednesday, channel: "email",
        direction: "outbound", summary: `Weekly Testfixture ${uid()}`, source: "manual", createdBy: user.id });
      const real: NotifyFn = (n) => notify({ db, apns: async () => null, webPush: () => null,
        waitingCount: async () => 0 }, n);

      // The Sunday 18:00 job failed; Martin runs it by hand on Monday.
      const recovered = await runWeeklySummary({ db, notify: real, now: () => monday, waiting: noWaiting });
      expect(recovered.summary).toMatchObject({ week: ended.key, from: ended.from, to: ended.to, sent: 1 });
      expect(recovered.sent).toBe(true);
      const recoveredRows = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `weekly:${ended.key}`));
      expect(recoveredRows).toHaveLength(1);

      // Six days later the real job for the NEW week is not a duplicate.
      const next = await runWeeklySummary({ db, notify: real, now: () => nextSunday, waiting: noWaiting });
      expect(next.summary.week).toBe(weekOf(nextSunday).key);
      expect(next.summary.week).not.toBe(ended.key);
      expect(next.sent).toBe(true);
    });
  });

  it("a dry run sends nothing and records nothing", async () => {
    await isolated(async (db) => {
      const now = sundayLongAgo();
      const fake = fakeNotify();
      const before = (await db.select().from(schema.workerRuns)
        .where(eq(schema.workerRuns.worker, WEEKLY_SUMMARY_WORKER_NAME))).length;
      const out = await runWeeklySummary({ db, notify: fake.notify, now: () => now, waiting: noWaiting },
        { dry: true });
      expect(out.sent).toBe(false);
      expect(fake.sent).toEqual([]);
      const after = (await db.select().from(schema.workerRuns)
        .where(eq(schema.workerRuns.worker, WEEKLY_SUMMARY_WORKER_NAME))).length;
      expect(after).toBe(before);
    });
  });
});
