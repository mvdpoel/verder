import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { NOTIFY_WORKER_NAME } from "@verder/api/src/worker-names";
import type { ApnsAlert, ApnsEnvironment, ApnsRaw, ApnsResult, ApnsSender } from "./apns";
import type { PushTransport } from "../push";
import { CATEGORY, notify, pushToDevices, type NotifyInput } from "./notify";
import { loadWaiting, waitingCounts } from "@verder/api/src/waiting";

// notify() runs as verder_worker, the role it meets in production — which also
// proves the column-level SELECT on "session" (0037) is enough for the session
// check. The better-auth user and sessions it checks against are fixtures the
// worker cannot write, so they are made on the ADMIN connection and committed.
//
// THE SHARED DEV DATABASE IS NEVER TRUNCATED, and other suites leave live
// push_subscriptions (push.test.ts used to insert one per run). So every test runs
// inside a transaction that first revokes every existing destination and is
// ROLLED BACK at the end: notify sees only this test's fixtures, and nothing
// it writes — notifications, attempts, worker_runs, revocations — survives.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

let worker: { db: Db; pool: { end(): Promise<void> } };
let admin: { db: Db; pool: { end(): Promise<void> } };
let userId: string;

beforeAll(async () => {
  worker = createDb(WORKER_URL);
  admin = createDb(ADMIN_URL);
  userId = `notify-test-${crypto.randomUUID()}`;
  await admin.db.insert(schema.user).values({
    id: userId, name: "Notify Testfixture", email: `notify-${crypto.randomUUID()}@example.test` });
});

afterAll(async () => {
  // Sessions cascade with the user.
  await admin.db.delete(schema.user).where(eq(schema.user.id, userId));
  await worker.pool.end();
  await admin.pool.end();
});

async function liveSession(): Promise<string> {
  const id = `notify-session-${crypto.randomUUID()}`;
  await admin.db.insert(schema.session).values({
    id, userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  return id;
}

class Rollback extends Error {}

/** Runs `fn` in a transaction with no pre-existing live destination, then rolls it back. */
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await worker.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.update(schema.pushDevices).set({ revokedAt: new Date(), revokedReason: "test-isolation" });
      await db.update(schema.pushSubscriptions).set({ revoked: true });
      await fn(db);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

const hexToken = () => crypto.randomUUID().replace(/-/g, "").repeat(2);

async function device(db: Db, opts: { environment?: ApnsEnvironment; sessionId?: string; revoked?: boolean } = {}) {
  const [d] = await db.insert(schema.pushDevices).values({
    token: hexToken(), environment: opts.environment ?? "development",
    bundleId: "pro.vanderpoel.verder", appVersion: "1.0 (1)",
    sessionId: opts.sessionId ?? await liveSession(),
    revokedAt: opts.revoked ? new Date() : null, revokedReason: opts.revoked ? "earlier" : null,
  }).returning();
  return d;
}

async function subscription(db: Db) {
  const [s] = await db.insert(schema.pushSubscriptions).values({
    endpoint: `https://push.example/${crypto.randomUUID()}`, p256dh: "k", auth: "a" }).returning();
  return s;
}

type Call = { env: ApnsEnvironment; token: string; alert: ApnsAlert };
type RawCall = { env: ApnsEnvironment; token: string; raw: ApnsRaw };
function fakeApns(answer: (c: { token: string }) => ApnsResult | Promise<ApnsResult> = () =>
  ({ statusCode: 200, apnsId: "apns-ok", reason: null })) {
  const calls: Call[] = [];
  const rawCalls: RawCall[] = [];
  const sender: ApnsSender = {
    async send(env, token, alert) { const c = { env, token, alert }; calls.push(c); return answer(c); },
    async sendRaw(env, token, raw) { const c = { env, token, raw }; rawCalls.push(c); return answer(c); },
    close() {},
  };
  return { calls, rawCalls, factory: async () => sender };
}

function fakeWebPush(fail?: (endpoint: string) => number | undefined) {
  const calls: string[] = [];
  const transport: PushTransport = {
    async send(sub) {
      calls.push(sub.endpoint);
      const code = fail?.(sub.endpoint);
      if (code !== undefined) {
        const e = new Error(`push service answered ${code}`) as Error & { statusCode: number };
        e.statusCode = code;
        throw e;
      }
      return { statusCode: 201 };
    },
  };
  return { calls, factory: () => transport };
}

const N: NotifyInput = { kind: "system", level: "active", title: "verder hersteld", body: "Automatisch hersteld: web." };

async function attempts(db: Db, notificationId: string) {
  return db.select().from(schema.notificationAttempts)
    .where(eq(schema.notificationAttempts.notificationId, notificationId));
}

async function lastRun(db: Db) {
  const [r] = await db.select().from(schema.workerRuns)
    .where(eq(schema.workerRuns.worker, NOTIFY_WORKER_NAME))
    .orderBy(desc(schema.workerRuns.ranAt), desc(schema.workerRuns.id)).limit(1);
  return r;
}

describe("notify", () => {
  it("inserts one notification and one attempt per device and subscription", async () => {
    await isolated(async (db) => {
      const dev = await device(db, { environment: "development" });
      const prod = await device(db, { environment: "production" });
      const sub = await subscription(db);
      const apns = fakeApns();
      const web = fakeWebPush();
      const r = await notify({ db, apns: apns.factory, webPush: web.factory },
        { ...N, kind: "verder-mail", level: "time-sensitive", link: "verder://document/x", threadId: "t1" });

      expect(r).toMatchObject({ duplicate: false, delivered: 3, failed: 0, skipped: 0 });
      const [row] = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.id, r.notificationId!));
      expect(row).toMatchObject({ kind: "verder-mail", level: "time-sensitive", link: "verder://document/x" });

      const rows = await attempts(db, r.notificationId!);
      expect(rows).toHaveLength(3);
      expect(rows.filter((a) => a.channel === "apns").map((a) => [a.pushDeviceId, a.environment, a.outcome, a.apnsId]).sort())
        .toEqual([[dev.id, "development", "delivered", "apns-ok"], [prod.id, "production", "delivered", "apns-ok"]].sort());
      expect(rows.filter((a) => a.channel === "web-push").map((a) => [a.pushSubscriptionId, a.outcome]))
        .toEqual([[sub.id, "delivered"]]);

      // The host is chosen per device, and the alert carries level and category.
      expect(apns.calls.map((c) => [c.token, c.env]).sort()).toEqual([[dev.token, "development"], [prod.token, "production"]].sort());
      expect(apns.calls[0].alert).toMatchObject({
        level: "time-sensitive", category: CATEGORY["verder-mail"], threadId: "t1", link: "verder://document/x" });
      expect(web.calls).toEqual([sub.endpoint]);

      const run = await lastRun(db);
      expect(run.status).toBe("ok");
      expect(run.detail).toEqual({ notificationId: r.notificationId, delivered: 3, failed: 0, skipped: 0 });
    });
  });

  it("second call with the same dedupKey sends nothing", async () => {
    await isolated(async (db) => {
      await device(db);
      const apns = fakeApns();
      const web = fakeWebPush();
      const dedupKey = `test:${crypto.randomUUID()}`;
      const first = await notify({ db, apns: apns.factory, webPush: web.factory }, { ...N, dedupKey });
      const second = await notify({ db, apns: apns.factory, webPush: web.factory }, { ...N, dedupKey });
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ notificationId: null, duplicate: true, delivered: 0, failed: 0, skipped: 0 });
      expect(apns.calls).toHaveLength(1);
      const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.dedupKey, dedupKey));
      expect(rows).toHaveLength(1);
    });
  });

  it("records reason and environment on 400", async () => {
    await isolated(async (db) => {
      const d = await device(db, { environment: "production" });
      const apns = fakeApns(() => ({ statusCode: 400, apnsId: "apns-400", reason: "BadDeviceToken" }));
      const r = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ channel: "apns", pushDeviceId: d.id, environment: "production",
        outcome: "rejected", statusCode: 400, reason: "BadDeviceToken", apnsId: "apns-400" });
      expect(r).toMatchObject({ delivered: 0, failed: 1 });
      // BadDeviceToken revokes too: the next launch re-registers a valid token
      // with the right environment.
      const [after] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, d.id));
      expect(after.revokedAt).not.toBeNull();
      expect(after.revokedReason).toBe("BadDeviceToken");
      expect((await lastRun(db)).status).toBe("error");
    });
  });

  it("a 400 with another reason is an error and does not revoke", async () => {
    await isolated(async (db) => {
      const d = await device(db);
      const apns = fakeApns(() => ({ statusCode: 400, apnsId: null, reason: "PayloadTooLarge" }));
      const r = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ outcome: "error", statusCode: 400, reason: "PayloadTooLarge" });
      const [after] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, d.id));
      expect(after.revokedAt).toBeNull();
    });
  });

  it("410 revokes the device", async () => {
    await isolated(async (db) => {
      const d = await device(db);
      const apns = fakeApns(() => ({ statusCode: 410, apnsId: "apns-410", reason: "Unregistered" }));
      const first = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      const [a] = await attempts(db, first.notificationId!);
      expect(a).toMatchObject({ outcome: "rejected", statusCode: 410, reason: "Unregistered" });
      const [after] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, d.id));
      expect(after.revokedAt).not.toBeNull();
      expect(after.revokedReason).toBe("Unregistered");

      // Later notifications skip it.
      const second = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect(apns.calls).toHaveLength(1);
      expect(await attempts(db, second.notificationId!)).toHaveLength(0);
    });
  });

  it("revoked device is skipped", async () => {
    await isolated(async (db) => {
      const revoked = await device(db, { revoked: true });
      const live = await device(db);
      const apns = fakeApns();
      const r = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect(apns.calls.map((c) => c.token)).toEqual([live.token]);
      const rows = await attempts(db, r.notificationId!);
      expect(rows.map((a) => a.pushDeviceId)).toEqual([live.id]);
      expect(rows.some((a) => a.pushDeviceId === revoked.id)).toBe(false);
    });
  });

  it("a device whose session was revoked receives no push", async () => {
    // /settings/security revokes a lost phone by deleting its session row.
    const sessionId = await liveSession();
    await admin.db.delete(schema.session).where(eq(schema.session.id, sessionId));
    await isolated(async (db) => {
      const d = await device(db, { sessionId });
      const apns = fakeApns();
      const r = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect(apns.calls).toHaveLength(0);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ channel: "apns", pushDeviceId: d.id, outcome: "skipped", reason: "session-ended" });
      const [after] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, d.id));
      expect(after.revokedAt).not.toBeNull();
      expect(after.revokedReason).toBe("session-ended");
    });
  });

  it("a device whose session has expired receives no push", async () => {
    const id = `notify-session-${crypto.randomUUID()}`;
    await admin.db.insert(schema.session).values({
      id, userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() - 60_000) });
    await isolated(async (db) => {
      await device(db, { sessionId: id });
      const apns = fakeApns();
      const r = await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect(apns.calls).toHaveLength(0);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ outcome: "skipped", reason: "session-ended" });
    });
  });

  it("missing key skips APNs and still sends web-push", async () => {
    await isolated(async (db) => {
      const d = await device(db);
      const sub = await subscription(db);
      const web = fakeWebPush();
      const r = await notify({ db, apns: async () => null, webPush: web.factory }, N);
      expect(r).toMatchObject({ delivered: 1, failed: 0, skipped: 1 });
      const rows = await attempts(db, r.notificationId!);
      expect(rows.find((a) => a.channel === "apns")).toMatchObject({
        pushDeviceId: d.id, outcome: "skipped", reason: "no-apns-key", environment: "development" });
      expect(rows.find((a) => a.channel === "web-push")).toMatchObject({
        pushSubscriptionId: sub.id, outcome: "delivered" });
      expect(web.calls).toEqual([sub.endpoint]);
      // A skipped APNs is not a revocation: the key may be added tomorrow.
      const [after] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, d.id));
      expect(after.revokedAt).toBeNull();
    });
  });

  it("missing VAPID keys are recorded as skipped", async () => {
    await isolated(async (db) => {
      const sub = await subscription(db);
      const r = await notify({ db, apns: async () => null, webPush: () => null }, N);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ channel: "web-push", pushSubscriptionId: sub.id, outcome: "skipped", reason: "no-vapid-keys" });
    });
  });

  it("web-push 500 is recorded, not dropped", async () => {
    await isolated(async (db) => {
      const bad = await subscription(db);
      const gone = await subscription(db);
      const web = fakeWebPush((e) => (e === bad.endpoint ? 500 : e === gone.endpoint ? 410 : undefined));
      const r = await notify({ db, apns: async () => null, webPush: web.factory }, N);
      const rows = await attempts(db, r.notificationId!);
      expect(rows.find((a) => a.pushSubscriptionId === bad.id)).toMatchObject({
        outcome: "error", statusCode: 500, reason: "push service answered 500" });
      expect(rows.find((a) => a.pushSubscriptionId === gone.id)).toMatchObject({ outcome: "rejected", statusCode: 410 });
      const subs = await db.select().from(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.id, [bad.id, gone.id]));
      // 404/410 revoke as before; a 500 is a transient failure and does not.
      expect(Object.fromEntries(subs.map((s) => [s.id, s.revoked]))).toEqual({ [bad.id]: false, [gone.id]: true });
      expect(r).toMatchObject({ delivered: 0, failed: 2 });
    });
  });

  it("no destinations records error", async () => {
    await isolated(async (db) => {
      const apns = fakeApns();
      const r = await notify({ db, apns: apns.factory, webPush: fakeWebPush().factory }, N);
      expect(r).toMatchObject({ duplicate: false, delivered: 0, failed: 0, skipped: 0 });
      expect(r.notificationId).not.toBeNull();
      expect(await attempts(db, r.notificationId!)).toHaveLength(0);
      const run = await lastRun(db);
      expect(run.status).toBe("error");
      expect(run.detail).toEqual({ notificationId: r.notificationId, delivered: 0, failed: 0, skipped: 0 });
    });
  });

  it("a throwing sender does not throw out of notify", async () => {
    await isolated(async (db) => {
      const d = await device(db);
      const sub = await subscription(db);
      const apns = fakeApns(() => { throw new Error("APNs request timed out after 10000 ms"); });
      const web: PushTransport = { send: async () => { throw new Error("ECONNRESET"); } };
      const r = await notify({ db, apns: apns.factory, webPush: () => web }, N);
      expect(r).toMatchObject({ delivered: 0, failed: 2 });
      const rows = await attempts(db, r.notificationId!);
      expect(rows.find((a) => a.pushDeviceId === d.id)).toMatchObject({
        outcome: "error", reason: "APNs request timed out after 10000 ms", statusCode: null });
      expect(rows.find((a) => a.pushSubscriptionId === sub.id)).toMatchObject({ outcome: "error", reason: "ECONNRESET" });
    });
  });

  it("a throwing factory does not throw out of notify", async () => {
    await isolated(async (db) => {
      await device(db);
      await subscription(db);
      const r = await notify({
        db,
        apns: async () => { throw new Error("boom"); },
        webPush: () => { throw new Error("bad vapid key"); },
      }, N);
      expect(r).toMatchObject({ delivered: 0, failed: 2 });
    });
  });

  it("a database failure is caught and logged, never thrown", async () => {
    const broken = { insert: () => { throw new Error("connection refused"); } } as unknown as Db;
    const r = await notify({ db: broken, apns: async () => null, webPush: () => null }, N);
    expect(r).toEqual({ notificationId: null, duplicate: false, delivered: 0, failed: 0, skipped: 0 });
  });

  it("every alert carries the todo count as badge", async () => {
    await isolated(async (db) => {
      await device(db);
      const apns = fakeApns();
      // The real default: THE one definition of what waits on Martin, read in
      // the same transaction the expectation is read in.
      const expected = waitingCounts(await loadWaiting(db)).todo;
      await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect(apns.calls[0].alert.badge).toBe(expected);
      // And it is what the counter says, not a number a caller passed.
      await notify({ db, apns: apns.factory, webPush: () => null, waitingCount: async () => 7 }, N);
      expect(apns.calls[1].alert.badge).toBe(7);
    });
  });

  it("a failing badge count omits the key and still delivers", async () => {
    await isolated(async (db) => {
      const d = await device(db);
      const apns = fakeApns();
      const r = await notify({ db, apns: apns.factory, webPush: () => null,
        waitingCount: async () => { throw new Error("count failed"); } }, N);
      expect(r).toMatchObject({ delivered: 1, failed: 0 });
      expect("badge" in apns.calls[0].alert).toBe(false);
      const [a] = await attempts(db, r.notificationId!);
      expect(a).toMatchObject({ pushDeviceId: d.id, outcome: "delivered" });
    });
  });

  it("options and revision reach the APNs sender", async () => {
    await isolated(async (db) => {
      await device(db);
      const apns = fakeApns();
      await notify({ db, apns: apns.factory, webPush: () => null },
        { ...N, kind: "proposal", link: "verder://proposal/x", options: ["Ja", "Nee"], revision: 2 });
      expect(apns.calls[0].alert).toMatchObject({ category: "PROPOSAL", options: ["Ja", "Nee"], revision: 2 });
      await notify({ db, apns: apns.factory, webPush: () => null }, N);
      expect("options" in apns.calls[1].alert).toBe(false);
      expect("revision" in apns.calls[1].alert).toBe(false);
    });
  });

  it("maps every kind to an iOS category", () => {
    expect(CATEGORY).toEqual({
      "verder-mail": "VERDER_MAIL", "creditor-mail": "CREDITOR_MAIL", proposal: "PROPOSAL",
      reminder: "REMINDER", "follow-up": "FOLLOW_UP", "task-due": "TASK_DUE",
      filing: "FILING", system: "SYSTEM", weekly: "WEEKLY",
    });
  });
});

describe("pushToDevices", () => {
  const BADGE: ApnsRaw = { pushType: "alert", priority: 5, payload: { aps: { badge: 2 } } };

  it("sends the raw push to every live device and writes no notification", async () => {
    await isolated(async (db) => {
      const a = await device(db, { environment: "development" });
      const b = await device(db, { environment: "production" });
      const apns = fakeApns();
      const [{ n: before }] = (await db.execute<{ n: string }>("select count(*)::text as n from notifications")).rows;
      const r = await pushToDevices({ db, apns: apns.factory }, BADGE);
      expect(r).toEqual({ delivered: 2, failed: 0, skipped: 0 });
      expect(apns.calls).toHaveLength(0);
      expect(apns.rawCalls.map((c) => [c.token, c.env]).sort())
        .toEqual([[a.token, "development"], [b.token, "production"]].sort());
      expect(apns.rawCalls[0].raw).toEqual(BADGE);
      const [{ n: after }] = (await db.execute<{ n: string }>("select count(*)::text as n from notifications")).rows;
      expect(after).toBe(before);
    });
  });

  it("still revokes a dead token and an ended session", async () => {
    const sessionId = await liveSession();
    await admin.db.delete(schema.session).where(eq(schema.session.id, sessionId));
    await isolated(async (db) => {
      const gone = await device(db);
      const ended = await device(db, { sessionId });
      const apns = fakeApns((c) => c.token === gone.token
        ? { statusCode: 410, apnsId: null, reason: "Unregistered" } : { statusCode: 200, apnsId: null, reason: null });
      const r = await pushToDevices({ db, apns: apns.factory }, BADGE);
      expect(r).toEqual({ delivered: 0, failed: 1, skipped: 1 });
      const rows = await db.select().from(schema.pushDevices)
        .where(inArray(schema.pushDevices.id, [gone.id, ended.id]));
      expect(Object.fromEntries(rows.map((d) => [d.id, d.revokedReason])))
        .toEqual({ [gone.id]: "Unregistered", [ended.id]: "session-ended" });
    });
  });

  it("no key skips, and a throwing sender is counted, never thrown", async () => {
    await isolated(async (db) => {
      await device(db);
      expect(await pushToDevices({ db, apns: async () => null }, BADGE)).toEqual({ delivered: 0, failed: 0, skipped: 1 });
      const apns = fakeApns(() => { throw new Error("timed out"); });
      expect(await pushToDevices({ db, apns: apns.factory }, BADGE)).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    });
  });
});

// Guards the test harness itself: a rolled-back transaction must leave nothing.
describe("notify test isolation", () => {
  it("leaves no rows behind", async () => {
    const dedupKey = `test:${crypto.randomUUID()}`;
    await isolated(async (db) => { await notify({ db, apns: async () => null, webPush: () => null }, { ...N, dedupKey }); });
    const rows = await worker.db.select().from(schema.notifications)
      .where(and(eq(schema.notifications.dedupKey, dedupKey)));
    expect(rows).toHaveLength(0);
  });
});
