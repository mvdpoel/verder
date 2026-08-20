import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

// The router builds its own embed port from OLLAMA_URL. Point it at a closed port for
// the whole file: the tests are then deterministic (embeddings come back null, so only
// the keyword branch runs) and no test in this repo ever depends on a live GPU.
process.env.OLLAMA_URL = "http://127.0.0.1:1";

const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

const WINDOW_MS = 60_000;
const BASE = Date.UTC(2999, 6, 1) + Math.floor(Math.random() * 2_000_000) * WINDOW_MS;
let slot = 0;
function testWindow() {
  const start = new Date(BASE + slot++ * WINDOW_MS);
  return {
    start,
    from: start.toISOString(),
    to: new Date(start.getTime() + WINDOW_MS - 1).toISOString(),
  };
}

describe("search router", () => {
  let writer: Db;
  let db: Db;
  let userId: string;
  beforeAll(async () => {
    writer = createDb(WORKER_URL).db;
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `se${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function chunk(entityId: string, title: string, body: string, occurredAt: Date) {
    await writer.execute(sql`
      INSERT INTO search_chunks
        (entity_type, entity_id, chunk_index, title, body, occurred_at, source_hash)
      VALUES ('entry', ${entityId}::uuid, 0, ${title}, ${body}, ${occurredAt}::timestamptz,
              ${`test-${crypto.randomUUID()}`})`);
  }

  it("takes a FLAT input and paginates with an opaque string cursor", async () => {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) await chunk(id, `Brief ${i}`, `opzegging nummer ${i}`, w.start);

    const page1 = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, limit: 2,
    });
    expect(page1.hits).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.nextCursor).toBe("Mg==");
    expect(page1.semanticAvailable).toBe(false);
    expect(page1.reranked).toBe(false);
    expect(page1.rerankPromptVersion).toBeNull();

    const page2 = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, limit: 2, cursor: page1.nextCursor,
    });
    expect(page2.hits).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.hits, ...page2.hits].map((h) => h.entityId))).toEqual(new Set(ids));
  });

  it("accepts every status in the deduped SEARCH_STATUSES union", async () => {
    const w = testWindow();
    const id = crypto.randomUUID();
    await chunk(id, "Registry", "opzegging bij de provider", w.start);
    // 'to-cancel' and 'settled' are registry/debt statuses. The old plan's router
    // rejected them with BAD_REQUEST while the filter rail offered them.
    for (const status of ["to-cancel", "canceled", "settled", "in-progress"] as const) {
      const res = await caller().search.query({ q: "opzegging", from: w.from, to: w.to, status });
      expect(res.hits).toEqual([]);
    }
  });

  it("rejects an unknown status instead of silently ignoring it", async () => {
    // A zod input failure surfaces as a TRPCError whose *code* is BAD_REQUEST; the
    // message carries the zod issue list, so assert on the code (as registry-import
    // does) rather than on the message text.
    await expect(caller().search.query({ q: "opzegging", status: "verzonnen" as never }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an unauthenticated caller", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.search.query({ q: "opzegging" })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("deep mode reports the prompt version and degrades to the fused order when Ollama is down", async () => {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) await chunk(id, `Brief ${i}`, `opzegging nummer ${i}`, w.start);

    const fast = await caller().search.query({ q: "opzegging", from: w.from, to: w.to });
    expect(fast.rerankPromptVersion).toBeNull();

    const deep = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, mode: "deep",
    });
    // The router really does hand retrieve() a rerank port — the version is recorded
    // even though the model never answered.
    expect(deep.rerankPromptVersion).toBe("rerank-v1");
    expect(deep.reranked).toBe(false);
    // Degraded, not errored: same hits, same order as fast mode.
    expect(deep.hits.map((h) => h.entityId)).toEqual(fast.hits.map((h) => h.entityId));
  });

  it("deep mode records the degradation in worker_runs", async () => {
    const w = testWindow();
    await chunk(crypto.randomUUID(), "Brief", "opzegging bevestigd", w.start);
    const before = await db.select().from(schema.workerRuns).where(and(
      eq(schema.workerRuns.worker, "search-rerank"), eq(schema.workerRuns.status, "error")));
    await caller().search.query({ q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    const after = await db.select().from(schema.workerRuns).where(and(
      eq(schema.workerRuns.worker, "search-rerank"), eq(schema.workerRuns.status, "error")));
    expect(after.length).toBe(before.length + 1);
  });
});
