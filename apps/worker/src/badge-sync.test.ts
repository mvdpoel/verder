import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { BADGE_SYNC_WORKER_NAME } from "@verder/api/src/worker-names";
import { loadWaiting, waitingCounts } from "@verder/api/src/waiting";
import type { ApnsRaw } from "./notify/apns";
import type { PushCounts } from "./notify/notify";
import { syncBadge } from "./badge-sync";

// Runs as verder_worker, the role badge.sync meets in production — which also
// proves that role may read everything loadWaiting reads. Every test is a
// transaction that is ROLLED BACK (the shared dev database is never truncated),
// and it first renames any committed badge-sync row out of the way, so the
// "previous count" is only what the test itself put there. Nothing is sent:
// `push` is a fake that records its input.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.update(schema.workerRuns).set({ worker: `${BADGE_SYNC_WORKER_NAME}-hidden-by-test` })
        .where(eq(schema.workerRuns.worker, BADGE_SYNC_WORKER_NAME));
      await fn(db);
      throw new Rollback();
    });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

function fakePush(answer: PushCounts = { delivered: 1, failed: 0, skipped: 0 }) {
  const calls: ApnsRaw[] = [];
  return { calls, push: async (raw: ApnsRaw) => { calls.push(raw); return { ...answer }; } };
}

/** A prior tick, five minutes ago (inside one transaction now() never moves). */
async function priorRun(db: Db, count: number, status: "ok" | "error" = "ok") {
  await db.insert(schema.workerRuns).values({
    worker: BADGE_SYNC_WORKER_NAME, status, detail: { count, sent: true, delivered: 1, failed: 0, skipped: 0 },
    ranAt: sql`now() - interval '5 minutes'`,
  });
}

async function newestRun(db: Db) {
  const [r] = await db.select().from(schema.workerRuns)
    .where(and(eq(schema.workerRuns.worker, BADGE_SYNC_WORKER_NAME), sql`${schema.workerRuns.ranAt} = now()`))
    .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
  return r;
}

describe("syncBadge", () => {
  it("first run sends", async () => {
    await isolated(async (db) => {
      const expected = waitingCounts(await loadWaiting(db)).todo;
      const fake = fakePush();
      const r = await syncBadge(db, { push: fake.push });
      expect(r).toEqual({ count: expected, sent: true });
      expect(fake.calls).toHaveLength(2);
      const run = await newestRun(db);
      expect(run.status).toBe("ok");
      expect(run.detail).toEqual({ count: expected, sent: true, delivered: 2, failed: 0, skipped: 0 });
    });
  });

  it("unchanged count does not send but still records", async () => {
    await isolated(async (db) => {
      await priorRun(db, 4);
      const fake = fakePush();
      const r = await syncBadge(db, { push: fake.push, count: async () => 4 });
      expect(r).toEqual({ count: 4, sent: false });
      expect(fake.calls).toHaveLength(0);
      const run = await newestRun(db);
      expect(run.status).toBe("ok");
      expect(run.detail).toEqual({ count: 4, sent: false, delivered: 0, failed: 0, skipped: 0 });
    });
  });

  it("changed count sends one badge push and one background push", async () => {
    await isolated(async (db) => {
      await priorRun(db, 4);
      const fake = fakePush();
      expect(await syncBadge(db, { push: fake.push, count: async () => 3 })).toEqual({ count: 3, sent: true });
      expect(fake.calls.map((c) => c.pushType)).toEqual(["alert", "background"]);
      expect((await newestRun(db)).detail).toMatchObject({ count: 3, sent: true });
    });
  });

  it("badge payload is alert-type with only aps.badge", async () => {
    await isolated(async (db) => {
      const fake = fakePush();
      await syncBadge(db, { push: fake.push, count: async () => 0 });
      // Zero is sent too: it is what clears the icon.
      expect(fake.calls[0]).toEqual({ pushType: "alert", priority: 5, payload: { aps: { badge: 0 } } });
    });
  });

  it("background payload carries no badge", async () => {
    await isolated(async (db) => {
      const fake = fakePush();
      await syncBadge(db, { push: fake.push, count: async () => 2 });
      expect(fake.calls[1]).toEqual({ pushType: "background", priority: 5, payload: { aps: { "content-available": 1 } } });
    });
  });

  it("a badge push that reached no device is recorded error and retried next tick", async () => {
    await isolated(async (db) => {
      await priorRun(db, 2);
      await priorRun(db, 5, "error"); // the newer, failed attempt to tell 5
      const fake = fakePush({ delivered: 0, failed: 1, skipped: 0 });
      // The last count the phone was TOLD is 2, so 5 is sent again.
      expect(await syncBadge(db, { push: fake.push, count: async () => 5 })).toEqual({ count: 5, sent: true });
      const run = await newestRun(db);
      expect(run.status).toBe("error");
      expect(run.detail).toEqual({ count: 5, sent: true, delivered: 0, failed: 2, skipped: 0 });
    });
  });

  it("no registered device is nothing to retry", async () => {
    await isolated(async (db) => {
      const fake = fakePush({ delivered: 0, failed: 0, skipped: 0 });
      await syncBadge(db, { push: fake.push, count: async () => 1 });
      expect((await newestRun(db)).status).toBe("ok");
    });
  });
});
