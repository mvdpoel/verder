import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { DRAIN_WORKER_NAME, readIndexHealth } from "./health";

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
