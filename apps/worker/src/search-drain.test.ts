import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { EMBED_DIMENSIONS, type EmbedPort } from "@verder/api/src/search/embed";
import { DRAIN_WORKER_NAME } from "@verder/api/src/search/health";
import { drainOnce } from "./search-drain";

const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
// Only ever used to plant a row the worker role is not allowed to write.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

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

/** One side track to hang this suite's haltes on. The main line is shared with
 *  every other suite and only one root may exist, so the fixtures branch off it
 *  rather than landing stops on Martin's own line. */
let fixtureTrackId: string | null = null;
async function fixtureTrack(db: ReturnType<typeof createDb>["db"]) {
  if (fixtureTrackId) return fixtureTrackId;
  const [root] = await db.select().from(schema.tracks)
    .where(isNull(schema.tracks.parentTrackId));
  const [anchor] = await db.select({ id: schema.stops.id }).from(schema.stops)
    .where(eq(schema.stops.trackId, root.id)).orderBy(asc(schema.stops.orderIndex));
  const [track] = await db.insert(schema.tracks).values({
    title: `search-drain fixtures ${crypto.randomUUID()}`,
    parentTrackId: root.id, branchesAtStopId: anchor.id,
  }).returning();
  fixtureTrackId = track.id;
  return fixtureTrackId;
}

let nextOrderIndex = 0;
async function makeStop(db: ReturnType<typeof createDb>["db"], title: string) {
  const [stop] = await db.insert(schema.stops)
    .values({ trackId: await fixtureTrack(db), orderIndex: nextOrderIndex++, title,
      kind: "mail", state: "done", happenedAt: new Date("2026-08-03T09:00:00Z") })
    .returning();
  return stop;
}

const chunksFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "stop"),
      eq(schema.searchChunks.entityId, entityId)));

const outboxFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchOutbox)
    .where(eq(schema.searchOutbox.entityId, entityId));

describe("drainOnce", () => {
  it("indexes an enqueued entity, deletes its outbox row and records the run", async () => {
    const { db, pool } = createDb(DB_URL);
    const stop = await makeStop(db, `Opzegging Ziggo bevestigd ${crypto.randomUUID()}`);
    const { port, seen } = recordingEmbed("ok");

    const result = await drainOnce({ db, embed: port }, { entityIds: [stop.id] });

    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0, skipped: 0 });
    const chunks = await chunksFor(db, stop.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.embedding).not.toBeNull();
    expect(chunks[0]!.embedAttempts).toBe(0);
    // Indexed text carries nomic's document prefix; the query side uses
    // asQuery. Mixing the two silently halves recall.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith("search_document: ")).toBe(true);
    expect(seen[0]).toContain(stop.title);
    expect(await outboxFor(db, stop.id)).toHaveLength(0);
    // The sweep is visible to index health on /verify.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME));
    expect(runs.length).toBeGreaterThan(0);
    await pool.end();
  });

  it("re-embeds nothing when a touch leaves the rendered text unchanged", async () => {
    const { db, pool } = createDb(DB_URL);
    const stop = await makeStop(db, `Onveranderd ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [stop.id] });

    // An UPDATE always fires the trigger, even when it writes the same value,
    // so the entity is re-enqueued while its rendered text is identical — that
    // is exactly what source_hash exists for.
    await db.update(schema.stops).set({ title: stop.title })
      .where(eq(schema.stops.id, stop.id));
    expect(await outboxFor(db, stop.id)).toHaveLength(1);

    const second = recordingEmbed("ok");
    const result = await drainOnce({ db, embed: second.port }, { entityIds: [stop.id] });

    expect(second.seen).toHaveLength(0);
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0, skipped: 0 });
    expect(await chunksFor(db, stop.id)).toHaveLength(1);
    expect(await outboxFor(db, stop.id)).toHaveLength(0);
    await pool.end();
  });

  it("keeps the entity enqueued when the embedding fails, and the chunk lexically searchable", async () => {
    const { db, pool } = createDb(DB_URL);
    const stop = await makeStop(db, `Opzegging per 1 oktober ${crypto.randomUUID()}`);

    // Ollama down: the port signals per-text failure with null, never a throw.
    const result = await drainOnce({ db, embed: recordingEmbed("null").port },
      { entityIds: [stop.id] });

    expect(result).toEqual({ claimed: 1, indexed: 0, failed: 0, skipped: 0 });
    const [chunk] = await chunksFor(db, stop.id);
    expect(chunk).toBeDefined();
    expect(chunk!.embedding).toBeNull();
    expect(chunk!.embedAttempts).toBe(1);
    // Left in the outbox on purpose, so the next sweep retries the vector once
    // Ollama is back. A stuck backlog shows up as outbox depth on /verify.
    expect(await outboxFor(db, stop.id)).toHaveLength(1);

    // Dutch stemming over the generated tsvector column: 'opzeggen' finds
    // 'Opzegging' with no vector involved at all.
    const rows = (await db.execute(sql`
      SELECT embedding IS NULL AS no_vector FROM search_chunks
      WHERE entity_type = 'stop' AND entity_id = ${stop.id}
        AND tsv @@ websearch_to_tsquery('dutch', 'opzeggen')`))
      .rows as { no_vector: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.no_vector).toBe(true);
    await pool.end();
  });

  it("does not let one failing entity stop the sweep", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const bad = await makeStop(db, `Kapot ${marker}`);
    const good = await makeStop(db, `Goed ${marker}`);
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

    expect(result).toEqual({ claimed: 2, indexed: 1, failed: 1, skipped: 0 });
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
    const first = await makeStop(db, `Eerste ${marker}`);
    const second = await makeStop(db, `Tweede ${marker}`);

    const result = await drainOnce({ db, embed: recordingEmbed("ok").port },
      { entityIds: [first.id, second.id], limit: 1 });

    // Claimed in outbox id order, so the first stop and nothing else.
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0, skipped: 0 });
    expect(await chunksFor(db, first.id)).toHaveLength(1);
    expect(await chunksFor(db, second.id)).toHaveLength(0);
    expect(await outboxFor(db, second.id)).toHaveLength(1);
    await pool.end();
  });

  it("skips and DELETES an outbox row for an entity type it cannot index", async () => {
    const { db, pool } = createDb(DB_URL);
    // A retired kind, the way migration 0023 found them: 'milestone' rows were
    // enqueued by a trigger that has since been dropped. indexEntity's
    // exhaustive default THROWS on one, so before this the row was retained,
    // retried every 60 s, and every drain run recorded as `error` — one dead
    // row and index health is red forever. The migration cleaned the known
    // ones; the drain must survive the next kind that is retired.
    //
    // Inserted through the ADMIN role on purpose: verder_worker has SELECT and
    // DELETE on search_outbox and no INSERT (migration 0016), so nothing the
    // worker can do produces this row any more. That is the point — it is a row
    // that should not exist.
    const admin = createDb(ADMIN_URL);
    const ghostId = crypto.randomUUID();
    await admin.db.insert(schema.searchOutbox)
      .values({ entityType: "milestone", entityId: ghostId });
    await admin.pool.end();
    const stop = await makeStop(db, `Naast een spook ${crypto.randomUUID()}`);

    const result = await drainOnce({ db, embed: recordingEmbed("ok").port },
      { entityIds: [ghostId, stop.id] });

    // Skipped, not failed — and the entity beside it is indexed as usual.
    expect(result).toEqual({ claimed: 2, indexed: 1, failed: 0, skipped: 1 });
    expect(await outboxFor(db, ghostId)).toHaveLength(0);
    expect(await chunksFor(db, stop.id)).toHaveLength(1);
    expect(await outboxFor(db, stop.id)).toHaveLength(0);
    // The sweep stays `ok` and names what it dropped, so /verify shows it once
    // instead of an error every minute.
    const [run] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME))
      .orderBy(desc(schema.workerRuns.ranAt), desc(schema.workerRuns.id)).limit(1);
    const detail = run.detail as { skipped: number; skippedTypes: string[] };
    expect(run.status).toBe("ok");
    expect(detail.skipped).toBe(1);
    expect(detail.skippedTypes).toContain("milestone");
    await pool.end();
  });

  it("indexes a spoor whose merge the map REFUSED as ending, not as merged back", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    const [anchor] = await db.select({ id: schema.stops.id }).from(schema.stops)
      .where(eq(schema.stops.trackId, root.id)).orderBy(asc(schema.stops.orderIndex));
    const [track] = await db.insert(schema.tracks).values({
      title: `Ontruiming ${marker}`, status: "ended",
      parentTrackId: root.id, branchesAtStopId: anchor.id,
    }).returning();
    const [stop] = await db.insert(schema.stops).values({
      trackId: track.id, orderIndex: 0, title: `Aanzegging ${marker}`,
      kind: "mail", state: "done", happenedAt: new Date("2026-08-03T09:00:00Z"),
    }).returning();
    try {
      // A merge into the spoor's OWN last stop would close a cycle, so
      // buildTrackMap drops the edge and /timeline draws the spoor as ending.
      await db.update(schema.tracks).set({ mergesAtStopId: stop.id })
        .where(eq(schema.tracks.id, track.id));

      await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [track.id] });

      const [chunk] = await db.select().from(schema.searchChunks)
        .where(and(eq(schema.searchChunks.entityType, "track"),
          eq(schema.searchChunks.entityId, track.id)));
      // merges_at_stop_id is set, so the naive reading indexes this as a
      // prerequisite that came back — while the map draws it ending.
      expect(chunk.body).toContain("geëindigd op zichzelf");
      expect(chunk.body).not.toContain("teruggekomen op de hoofdlijn");
    } finally {
      // The dev map is shared with every other suite and nothing may delete a
      // track: leave no permanent contradiction behind.
      await db.update(schema.tracks).set({ mergesAtStopId: null })
        .where(eq(schema.tracks.id, track.id));
      await pool.end();
    }
  });

  it("appends no ledger events — indexing is derived, not evidence", async () => {
    const { db, pool } = createDb(DB_URL);
    const stop = await makeStop(db, `Ledgerloos ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [stop.id] });
    const events = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, stop.id));
    expect(events).toHaveLength(0);
    await pool.end();
  });
});
