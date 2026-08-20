import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { EMBED_DIMENSIONS, type EmbedPort } from "@verder/api/src/search/embed";
import { DRAIN_WORKER_NAME } from "@verder/api/src/search/health";
import { drainOnce } from "./search-drain";

const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

const vec = (n: number) => Array.from({ length: EMBED_DIMENSIONS }, () => n);

/** Records every text it is asked to embed so a test can assert on the texts
 *  that belong to IT — the dev database is shared and every other suite keeps
 *  filling the same outbox. */
function recordingEmbed(mode: "ok" | "null" = "ok") {
  const seen: string[] = [];
  const port: EmbedPort = {
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => (mode === "ok" ? vec(1) : null));
    },
  };
  return { port, seen };
}

async function makeEvent(db: ReturnType<typeof createDb>["db"], title: string) {
  const [event] = await db.insert(schema.timelineEvents)
    .values({ title, happenedAt: new Date("2026-08-03T09:00:00Z"), kind: "mail" })
    .returning();
  return event;
}

const chunksFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "timeline_event"),
      eq(schema.searchChunks.entityId, entityId)));

const outboxFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchOutbox)
    .where(eq(schema.searchOutbox.entityId, entityId));

describe("drainOnce", () => {
  it("indexes an enqueued entity, deletes its outbox row and records the run", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Opzegging Ziggo bevestigd ${crypto.randomUUID()}`);
    const { port, seen } = recordingEmbed("ok");

    const result = await drainOnce({ db, embed: port }, { entityIds: [event.id] });

    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    const chunks = await chunksFor(db, event.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.embedding).not.toBeNull();
    expect(chunks[0]!.embedAttempts).toBe(0);
    // Indexed text carries nomic's document prefix; the query side uses
    // asQuery. Mixing the two silently halves recall.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith("search_document: ")).toBe(true);
    expect(seen[0]).toContain(event.title);
    expect(await outboxFor(db, event.id)).toHaveLength(0);
    // The sweep is visible to index health on /verify.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME));
    expect(runs.length).toBeGreaterThan(0);
    await pool.end();
  });

  it("re-embeds nothing when a touch leaves the rendered text unchanged", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Onveranderd ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [event.id] });

    // An UPDATE always fires the trigger, even when it writes the same value,
    // so the entity is re-enqueued while its rendered text is identical — that
    // is exactly what source_hash exists for.
    await db.update(schema.timelineEvents).set({ title: event.title })
      .where(eq(schema.timelineEvents.id, event.id));
    expect(await outboxFor(db, event.id)).toHaveLength(1);

    const second = recordingEmbed("ok");
    const result = await drainOnce({ db, embed: second.port }, { entityIds: [event.id] });

    expect(second.seen).toHaveLength(0);
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(await chunksFor(db, event.id)).toHaveLength(1);
    expect(await outboxFor(db, event.id)).toHaveLength(0);
    await pool.end();
  });

  it("keeps the entity enqueued when the embedding fails, and the chunk lexically searchable", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Opzegging per 1 oktober ${crypto.randomUUID()}`);

    // Ollama down: the port signals per-text failure with null, never a throw.
    const result = await drainOnce({ db, embed: recordingEmbed("null").port },
      { entityIds: [event.id] });

    expect(result).toEqual({ claimed: 1, indexed: 0, failed: 0 });
    const [chunk] = await chunksFor(db, event.id);
    expect(chunk).toBeDefined();
    expect(chunk!.embedding).toBeNull();
    expect(chunk!.embedAttempts).toBe(1);
    // Left in the outbox on purpose, so the next sweep retries the vector once
    // Ollama is back. A stuck backlog shows up as outbox depth on /verify.
    expect(await outboxFor(db, event.id)).toHaveLength(1);

    // Dutch stemming over the generated tsvector column: 'opzeggen' finds
    // 'Opzegging' with no vector involved at all.
    const rows = (await db.execute(sql`
      SELECT embedding IS NULL AS no_vector FROM search_chunks
      WHERE entity_type = 'timeline_event' AND entity_id = ${event.id}
        AND tsv @@ websearch_to_tsquery('dutch', 'opzeggen')`))
      .rows as { no_vector: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.no_vector).toBe(true);
    await pool.end();
  });

  it("does not let one failing entity stop the sweep", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const bad = await makeEvent(db, `Kapot ${marker}`);
    const good = await makeEvent(db, `Goed ${marker}`);
    // A THROW from the port is a genuine fault (a crashed client), not the
    // documented Ollama-down path, and must propagate out of indexEntity so the
    // drain can isolate it to the one entity being indexed.
    const port: EmbedPort = {
      embed: async (texts) => {
        if (texts.some((t) => t.includes(`Kapot ${marker}`))) {
          throw new Error("embed client crashed");
        }
        return texts.map(() => vec(1));
      },
    };

    const result = await drainOnce({ db, embed: port }, { entityIds: [bad.id, good.id] });

    expect(result).toEqual({ claimed: 2, indexed: 1, failed: 1 });
    expect(await chunksFor(db, good.id)).toHaveLength(1);
    expect(await outboxFor(db, good.id)).toHaveLength(0);
    expect(await outboxFor(db, bad.id)).toHaveLength(1); // retried next sweep
    const runs = await db.select().from(schema.workerRuns)
      .where(and(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME),
        eq(schema.workerRuns.status, "error")));
    expect(runs.length).toBeGreaterThan(0);
    await pool.end();
  });

  it("scopes the sweep to entityIds and respects limit", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const first = await makeEvent(db, `Eerste ${marker}`);
    const second = await makeEvent(db, `Tweede ${marker}`);

    const result = await drainOnce({ db, embed: recordingEmbed("ok").port },
      { entityIds: [first.id, second.id], limit: 1 });

    // Claimed in outbox id order, so the first event and nothing else.
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(await chunksFor(db, first.id)).toHaveLength(1);
    expect(await chunksFor(db, second.id)).toHaveLength(0);
    expect(await outboxFor(db, second.id)).toHaveLength(1);
    await pool.end();
  });

  it("appends no ledger events — indexing is derived, not evidence", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Ledgerloos ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [event.id] });
    const events = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, event.id));
    expect(events).toHaveLength(0);
    await pool.end();
  });
});
