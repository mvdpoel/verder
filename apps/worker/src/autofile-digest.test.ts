import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { AUTOFILE_DIGEST_WORKER_NAME } from "@verder/api/src/worker-names";
import { digestBody, runAutofileDigest } from "./autofile-digest";
import { notify, type NotifyFn } from "./notify/notify";
import { fakeNotify } from "./test-support/fake-notify";

// Runs as verder_worker, the role the digest meets in production. Every test
// runs inside a transaction that is ROLLED BACK: the shared dev DB is never
// truncated, and a committed `autofile:<day>` notification would make the
// next run of this suite a duplicate. `now` is a random day long ago, so the
// 24 h window holds only this test's fixtures.
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

/** 19:00 Amsterdam (17:00 UTC in summer) on a random day in 1990–1999. */
function eveningLongAgo(): Date {
  const d = new Date(Date.UTC(1990 + Math.floor(Math.random() * 10), 6, 1 + Math.floor(Math.random() * 28), 17));
  return d;
}

async function verderChanges(db: Db, at: Date, n: { filed: number; named: number }) {
  for (let i = 0; i < n.filed + n.named; i++) {
    const [doc] = await db.insert(schema.documents).values({
      sha256: (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""), sizeBytes: 1,
      mime: "application/pdf", title: `Digest Testfixture ${crypto.randomUUID()}.pdf`,
      source: "upload", receivedAt: at }).returning();
    let suggestionId: string | null = null;
    if (i < n.filed) {
      const [s] = await db.insert(schema.suggestions).values({ kind: "document-meta",
        status: "auto-applied", documentId: doc.id, proposed: {} }).returning();
      suggestionId = s.id;
    }
    await db.insert(schema.documentStatusChanges).values({ documentId: doc.id,
      status: suggestionId ? "filed" : "inbox", title: doc.title,
      actor: "verder", suggestionId, createdAt: new Date(at.getTime() - 60 * 60 * 1000) });
  }
}

const runs = async (db: Db) => db.select().from(schema.workerRuns)
  .where(eq(schema.workerRuns.worker, AUTOFILE_DIGEST_WORKER_NAME));

describe("autofile digest", () => {
  it("body is counts only", () => {
    expect(digestBody(3, 0)).toBe("3 documenten opgeborgen");
    expect(digestBody(1, 2)).toBe("1 document opgeborgen · 2 hernoemd");
    expect(digestBody(0, 1)).toBe("1 hernoemd");
  });

  it("digest sends nothing on a quiet day but records", async () => {
    await isolated(async (db) => {
      const now = eveningLongAgo();
      const before = (await runs(db)).length;
      const fake = fakeNotify();
      const out = await runAutofileDigest({ db, notify: fake.notify, now: () => now });
      expect(out).toEqual({ count: 0, filed: 0, named: 0, sent: false });
      expect(fake.sent).toEqual([]);
      const after = await runs(db);
      expect(after).toHaveLength(before + 1);
      expect(after.find((r) => (r.detail as { count?: number }).count === 0 && r.status === "ok")).toBeTruthy();
    });
  });

  it("a day with verder actions sends one passive filing push, counts only", async () => {
    await isolated(async (db) => {
      const now = eveningLongAgo();
      await verderChanges(db, now, { filed: 2, named: 1 });
      // Outside the window: 25 h before. Never counted.
      await verderChanges(db, new Date(now.getTime() - 24 * 60 * 60 * 1000), { filed: 1, named: 0 });
      const fake = fakeNotify();
      const out = await runAutofileDigest({ db, notify: fake.notify, now: () => now });
      expect(out).toMatchObject({ count: 3, filed: 2, named: 1, sent: true });
      expect(fake.sent).toEqual([{
        kind: "filing", level: "passive", title: "Door verder gedaan",
        body: "2 documenten opgeborgen · 1 hernoemd", link: "verder://inbox",
        dedupKey: expect.stringMatching(/^autofile:199\d-07-\d\d$/),
      }]);
    });
  });

  it("digest retry on the same day sends one push", async () => {
    await isolated(async (db) => {
      const now = eveningLongAgo();
      await verderChanges(db, now, { filed: 1, named: 0 });
      // The REAL notify(), with no APNs key and no VAPID keys: the dedup is
      // the notifications table's, and that is what a retry meets.
      const real: NotifyFn = (n) => notify({ db, apns: async () => null, webPush: () => null,
        waitingCount: async () => 0 }, n);
      const first = await runAutofileDigest({ db, notify: real, now: () => now });
      const retry = await runAutofileDigest({ db, notify: real, now: () => new Date(now.getTime() + 60_000) });
      expect(first.sent).toBe(true);
      expect(retry.sent).toBe(false);
      const rows = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.dedupKey, `autofile:${now.toISOString().slice(0, 10)}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "filing", level: "passive", body: "1 document opgeborgen" });
    });
  });
});
