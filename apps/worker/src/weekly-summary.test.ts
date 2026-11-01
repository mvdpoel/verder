import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { WEEKLY_SUMMARY_WORKER_NAME } from "@verder/api/src/worker-names";
import type { WaitingItem } from "@verder/api/src/waiting";
import type { WeeklySummary } from "@verder/api/src/weekly-summary";
import {
  composeWeekly, loadWeekly, runWeeklySummary, summaryWeek, weeklyBody, type WeeklyInput,
} from "./weekly-summary";
import { notify, type NotifyFn } from "./notify/notify";
import { fakeNotify } from "./test-support/fake-notify";

const OWN = ["martin@vanderpoel.pro"];
// The window that closes ISO week 2026-W44: from Sunday 25 October 18:00 to
// Sunday 1 November 18:00 Amsterdam (CET from 25-10 03:00, so both are 17:00 UTC).
const W44 = {
  key: "2026-W44",
  from: new Date("2026-10-25T17:00:00.000Z"),
  to: new Date("2026-11-01T17:00:00.000Z"),
};
const W45 = {
  key: "2026-W45",
  from: new Date("2026-11-01T17:00:00.000Z"),
  to: new Date("2026-11-08T17:00:00.000Z"),
};

function input(over: Partial<WeeklyInput> = {}): WeeklyInput {
  return {
    window: W44, ownAddresses: OWN, outboundEntries: [], sentProposals: [], emails: [],
    statusChanges: [], documentStatus: {}, tasksDone: [], waiting: [], ...over,
  };
}

const item = (n: number): WaitingItem => ({
  kind: "task", id: `t${n}`, title: `Geheime taak ${n}`, subtitle: null, priority: 3,
  at: "2026-10-30T10:00:00.000Z", dueAt: null, verder: false,
});

describe("composeWeekly (pure)", () => {
  it("windows abut on Sunday 18:00 Amsterdam, the instant the job runs", () => {
    const s = composeWeekly(input({
      outboundEntries: [
        { occurredAt: new Date("2026-10-25T16:59:00Z"), recordedAt: new Date("2026-10-25T16:59:00Z") }, // Sun 17:59 → W43
        { occurredAt: new Date("2026-10-25T17:00:00Z"), recordedAt: new Date("2026-10-25T17:00:00Z") }, // Sun 18:00 → in
        { occurredAt: new Date("2026-11-01T16:59:00Z"), recordedAt: new Date("2026-11-01T16:59:00Z") }, // Sun 17:59 → in
        { occurredAt: new Date("2026-11-01T17:00:00Z"), recordedAt: new Date("2026-11-01T17:00:00Z") }, // Sun 18:00 → W45
      ],
    }));
    expect(s).toMatchObject({
      week: "2026-W44", from: "2026-10-25T17:00:00.000Z", to: "2026-11-01T17:00:00.000Z", sent: 2,
    });
  });

  it("activity on Sunday evening after the job is counted exactly once, in the next summary", () => {
    // Sunday 1 November 19:00 Amsterdam — an hour after W44's push went out.
    const evening = new Date("2026-11-01T18:00:00Z");
    const docs = { a: "inbox" };
    const sources: Partial<WeeklyInput> = {
      documentStatus: docs,
      outboundEntries: [{ occurredAt: evening, recordedAt: evening }],
      sentProposals: [{ kind: "reply", sentAt: evening, resultEntryId: null }],
      emails: [{ fromAddr: "demi@verdergroep.nl", sentAt: evening, fetchedAt: evening }],
      statusChanges: [{ id: "1", documentId: "a", status: "filed", actor: null, createdAt: evening }],
      tasksDone: [{ taskId: "x", createdAt: evening }],
    };
    const counts = (w: typeof W44) => {
      const s = composeWeekly(input({ ...sources, window: w }));
      return [s.sent, s.received, s.filedByMartin, s.tasksDone];
    };
    expect(counts(W44)).toEqual([0, 0, 0, 0]);
    expect(counts(W45)).toEqual([2, 1, 1, 1]);
  });

  it("mail dated before the run but ingested after it is counted in the next summary", () => {
    const at = (iso: string) => new Date(iso);
    const emails = [
      // Dated Sun 17:50, picked up by the */15 Gmail poll at 18:05: W44 had already gone out.
      { fromAddr: "demi@verdergroep.nl", sentAt: at("2026-11-01T16:50:00Z"), fetchedAt: at("2026-11-01T17:05:00Z") },
      // A backfill of old mail (fetched weeks later) is judged on its own date, never dumped into one week.
      { fromAddr: "demi@verdergroep.nl", sentAt: at("2026-09-01T10:00:00Z"), fetchedAt: at("2026-11-03T10:00:00Z") },
    ];
    expect(composeWeekly(input({ emails, window: W44 })).received).toBe(0);
    expect(composeWeekly(input({ emails, window: W45 })).received).toBe(1);
    // The same rule for an outbound entry recorded after the run it happened before.
    const late = [{ occurredAt: at("2026-11-01T16:00:00Z"), recordedAt: at("2026-11-01T20:00:00Z") }];
    expect(composeWeekly(input({ outboundEntries: late, window: W44 })).sent).toBe(0);
    expect(composeWeekly(input({ outboundEntries: late, window: W45 })).sent).toBe(1);
  });

  it("a run summarises the newest week whose Sunday 18:00 has passed", () => {
    const W43 = { key: "2026-W43", from: new Date("2026-10-18T16:00:00.000Z"), to: W44.from };
    // Sunday 18:00 Amsterdam (CET) exactly, and later that evening: this week.
    expect(summaryWeek(new Date("2026-11-01T17:00:00Z"))).toEqual(W44);
    expect(summaryWeek(new Date("2026-11-01T22:59:00Z"))).toEqual(W44);
    // Sunday 17:59: the week has not been summarised yet — last week (whose
    // window opened on a CEST Sunday, 16:00 UTC, and closed on a CET one).
    expect(summaryWeek(new Date("2026-11-01T16:59:00Z"))).toEqual(W43);
    // Monday 00:30 Amsterdam (a pg-boss job that started late): the week that just ENDED,
    // with the SAME window a punctual run would have used.
    expect(summaryWeek(new Date("2026-11-01T23:30:00Z"))).toEqual(W44);
    // Wednesday, a hand-run: still the week that ended last Sunday.
    expect(summaryWeek(new Date("2026-11-04T12:00:00Z"))).toEqual(W44);
    // Summer time: Sunday 18:00 CEST is 16:00 UTC, so 16:30 UTC is past it…
    expect(summaryWeek(new Date("2026-10-18T16:30:00Z")).key).toBe("2026-W42");
    // …and 15:30 UTC (17:30 CEST) is not.
    expect(summaryWeek(new Date("2026-10-18T15:30:00Z")).key).toBe("2026-W41");
    // Across a year boundary: Monday 2027-01-04 recovers 2026-W53.
    expect(summaryWeek(new Date("2027-01-04T09:00:00Z"))).toEqual({
      key: "2026-W53", from: new Date("2026-12-27T17:00:00.000Z"), to: new Date("2027-01-03T17:00:00.000Z"),
    });
  });

  it("sent counts entries plus proposals with no entry yet, never a question", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    const s = composeWeekly(input({
      outboundEntries: [{ occurredAt: at, recordedAt: at }],
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
        { fromAddr: "martin@vanderpoel.pro", sentAt: at, fetchedAt: at }, // JMAP: a parsed address
        { fromAddr: "incasso@stam.nl", sentAt: at, fetchedAt: at },
        { fromAddr: "demi@verdergroep.nl", sentAt: new Date("2026-10-20T10:00:00Z"),
          fetchedAt: new Date("2026-10-20T10:00:00Z") }, // previous week
      ],
    }));
    expect(s.received).toBe(1);
  });

  it("a Gmail-era whole From header is parsed, not substring-matched", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    const s = composeWeekly(input({
      emails: [
        { fromAddr: "Martin van der Poel <martin@vanderpoel.pro>", sentAt: at, fetchedAt: at }, // own
        { fromAddr: "Martin <MARTIN@VanderPoel.pro>", sentAt: at, fetchedAt: at }, // own, ASCII-folded
        // Contains Martin's address as TEXT but was sent by someone else.
        { fromAddr: '"martin@vanderpoel.pro" <attacker@evil.tld>', sentAt: at, fetchedAt: at },
        { fromAddr: "Demi Willemse <demi@verdergroep.nl>", sentAt: at, fetchedAt: at },
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
      week: "2026-W44", from: W44.from.toISOString(), to: W44.to.toISOString(), sent: 3, received: 7,
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
      const week = summaryWeek(now);
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
      const key = summaryWeek(now).key;
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
        .where(eq(schema.notifications.dedupKey, `weekly:${summaryWeek(now).key}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "weekly", level: "passive", title: "Je week" });
    });
  });

  it("a hand-run on Monday recovers the PREVIOUS week, and the next Sunday still sends", async () => {
    await isolated(async (db) => {
      const sunday = sundayLongAgo();
      const monday = new Date(sunday.getTime() + 15 * 3600_000); // Monday ~09:00
      const nextSunday = new Date(sunday.getTime() + 7 * 24 * 3600_000);
      const ended = summaryWeek(sunday);
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
      expect(recovered.summary).toMatchObject({ week: ended.key,
        from: ended.from.toISOString(), to: ended.to.toISOString(), sent: 1 });
      expect(recovered.sent).toBe(true);
      const recoveredRows = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `weekly:${ended.key}`));
      expect(recoveredRows).toHaveLength(1);

      // Six days later the real job for the NEW week is not a duplicate.
      const next = await runWeeklySummary({ db, notify: real, now: () => nextSunday, waiting: noWaiting });
      expect(next.summary.week).toBe(summaryWeek(nextSunday).key);
      expect(next.summary.week).not.toBe(ended.key);
      expect(next.sent).toBe(true);
    });
  });

  it("Sunday-evening activity is counted once, in the next run, whenever the run happens", async () => {
    await isolated(async (db) => {
      const sunday = sundayLongAgo(); // 18:00 Amsterdam, the instant the job fires
      const evening = new Date(sunday.getTime() + 3600_000); // 19:00, after the push
      const [user] = await db.insert(schema.users).values({
        email: `weekly-${uid()}@example.test`, name: "Weekly Testfixture" }).returning();
      await db.insert(schema.logEntries).values({ occurredAt: evening, recordedAt: evening,
        channel: "email", direction: "outbound", summary: `Weekly Testfixture ${uid()}`,
        source: "manual", createdBy: user.id });
      // Dated 17:55 but only picked up by the */15 Gmail poll at 18:10.
      await db.insert(schema.rawEmails).values({ gmailMessageId: `weekly-${uid()}`,
        gmailThreadId: `t-${uid()}`, fromAddr: `Stam <incasso-${uid()}@stam.nl>`, toAddr: "x@example.test",
        subject: "Weekly Testfixture", sentAt: new Date(sunday.getTime() - 5 * 60_000),
        fetchedAt: new Date(sunday.getTime() + 10 * 60_000), rawRfc822Sha256: uid(), bodyText: "" });
      const [doc] = await db.insert(schema.documents).values({
        sha256: (uid() + uid()).replaceAll("-", ""), sizeBytes: 1, mime: "application/pdf",
        title: `Weekly Testfixture ${uid()}.pdf`, source: "upload", receivedAt: evening }).returning();
      await db.insert(schema.documentTexts).values({ documentId: doc.id, sha256: doc.sha256,
        extractor: "none", text: "", charCount: 0 });
      await db.insert(schema.documentStatusChanges).values({ documentId: doc.id, status: "filed",
        title: doc.title, createdAt: evening });
      const [task] = await db.insert(schema.tasks).values({ title: `Weekly Testfixture ${uid()}`,
        createdBy: user.id }).returning();
      await db.insert(schema.taskStatusChanges).values({ taskId: task.id, status: "done",
        createdBy: user.id, createdAt: evening });

      const deps = { db, notify: fakeNotify().notify, waiting: noWaiting, ownAddresses: () => OWN };
      const counts = async (at: Date) => {
        const { summary: s } = await runWeeklySummary({ ...deps, now: () => at }, { dry: true });
        return { week: s.week, sent: s.sent, received: s.received, filed: s.filedByMartin, tasks: s.tasksDone };
      };
      const ended = summaryWeek(sunday).key;
      const zero = { week: ended, sent: 0, received: 0, filed: 0, tasks: 0 };
      // The punctual run and a Monday recovery run of the same week agree: nothing of the evening.
      expect(await counts(sunday)).toEqual(zero);
      expect(await counts(new Date(sunday.getTime() + 15 * 3600_000))).toEqual(zero);
      // The next Sunday counts every one of them, once.
      const next = new Date(sunday.getTime() + 7 * 24 * 3600_000);
      expect(await counts(next)).toEqual({ week: summaryWeek(next).key, sent: 1, received: 1, filed: 1, tasks: 1 });
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
