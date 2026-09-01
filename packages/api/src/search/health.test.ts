import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { DRAIN_STALE_MS, DRAIN_WORKER_NAME, readIndexHealth } from "./health";
import { cadenceMs, declFor, workerState } from "../worker-health";

// APP role: the same grants the web app runs with, so a missing SELECT on
// search_outbox fails here rather than in production. Fixtures go in as the
// worker role, which is the only role holding INSERT on search_chunks.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

// The dev postgres is shared by every test file, so every assertion below is a
// delta around rows THIS file creates — never an absolute count.
describe("readIndexHealth", () => {
  let app: Db; let worker: Db;
  beforeAll(() => {
    app = createDb(APP_URL).db;
    worker = createDb(WORKER_URL).db;
  });

  it("counts chunks and the ones that failed to embed", async () => {
    const before = await readIndexHealth(app);
    const entityId = crypto.randomUUID();
    await worker.insert(schema.searchChunks).values([
      { entityType: "party", entityId, chunkIndex: 0, title: "Health probe A",
        body: "keyword only", sourceHash: crypto.randomUUID(), embedAttempts: 3 },
      { entityType: "party", entityId, chunkIndex: 1, title: "Health probe B",
        body: "keyword only", sourceHash: crypto.randomUUID(), embedAttempts: 0 },
    ]);

    const after = await readIndexHealth(app);
    expect(after.chunks - before.chunks).toBe(2);
    // Only the chunk that was tried and failed counts as a failure; a chunk
    // nobody has attempted yet is simply not embedded yet.
    expect(after.embedFailures - before.embedFailures).toBe(1);
  });

  it("reports the newest search-drain run as an ISO timestamp", async () => {
    await worker.insert(schema.workerRuns).values({
      worker: DRAIN_WORKER_NAME, status: "ok", detail: { probe: "index-health" },
    });
    const health = await readIndexHealth(app);
    expect(health.lastDrainAt).not.toBeNull();
    expect(Date.now() - Date.parse(health.lastDrainAt!)).toBeLessThan(60_000);
  });

  it("flags degraded while chunks are still missing their embedding", async () => {
    await worker.insert(schema.searchChunks).values({
      entityType: "party", entityId: crypto.randomUUID(), chunkIndex: 0,
      title: "Health probe C", body: "keyword only",
      sourceHash: crypto.randomUUID(), embedAttempts: 2,
    });
    const health = await readIndexHealth(app);
    expect(health.embedFailures).toBeGreaterThan(0);
    expect(health.degraded).toBe(true);
  });
});

describe("DRAIN_STALE_MS — one cadence, two tolerances", () => {
  it("derives from the declared cadence instead of hard-coding a second one", () => {
    // THE BUG THIS PINS: this file used to carry its own 10 * 60 * 1000 while
    // worker-health.ts separately declared search.drain at 60 s and judged it
    // at three missed ticks. Nothing tied the two together, so a change to the
    // boss.schedule line could only ever reach one of them, and the two screens
    // already disagreed: a drain that died at 12:00 was amber on the dashboard
    // at 12:04 while /verify still said "alles is doorzoekbaar" until 12:10.
    expect(DRAIN_STALE_MS).toBe(cadenceMs(declFor(DRAIN_WORKER_NAME)) * 10);
    // And it still comes out at the ten minutes this page has always used, so
    // the refactor changed the SHAPE of the number and not the number.
    expect(DRAIN_STALE_MS).toBe(10 * 60 * 1000);
  });

  it("stays deliberately looser than the dashboard's bound on the same row", () => {
    // The two tolerances differ ON PURPOSE and this is where that is written
    // down: the dashboard's job is to notice a dead watcher fast, /verify's job
    // is to tell Martin whether what he searches is complete, and a queue a few
    // minutes behind still answers his question. If these ever converge it
    // should be because somebody decided so, not because a number drifted.
    const ranAt = new Date(Date.now() - DRAIN_STALE_MS + 1_000);
    expect(workerState(declFor(DRAIN_WORKER_NAME), "ok", ranAt, Date.now())).toBe("down");
  });
});
