import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, ensureCaseMap, schema, type Db } from "./index";

// ADMIN role: this suite is about the CONSTRAINTS and TRIGGERS the map depends
// on (one root, no poisoned index queue) and about what the seed puts back
// after a truncation — not about grants, whose shape is unchanged.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";
// APP role: the rename below is what the web app actually does, and that role
// has NO INSERT grant on search_outbox — only the SECURITY DEFINER function
// search_enqueue_track_stops() makes those rows land. Under the admin role a
// missing SECURITY DEFINER would pass unnoticed and 500 in production.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("tracks and stops", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];
  let appDb: Db;
  let appPool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    ({ db, pool } = createDb(ADMIN_URL));
    ({ db: appDb, pool: appPool } = createDb(APP_URL));
    // The seed lives in a one-shot migration AND in this function, because the
    // api suite's `TRUNCATE ... CASCADE` reaches stops through entry_id and
    // document_id and then tracks through branches_at_stop_id. Without this
    // call the assertions below depend on which suite ran last.
    await ensureCaseMap(db);
  });
  afterAll(async () => { await pool.end(); await appPool.end(); });

  const root = async () => {
    const [r] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    return r;
  };

  it("seeds exactly one root track, named for the period and not for a goal", async () => {
    const roots = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    expect(roots).toHaveLength(1);
    // Migration 0026 deleted `Einde bewindvoering` — the map shows history, so
    // the root is no longer a destination and its old name described nothing.
    expect(roots[0].title).toBe("Bewindvoering");

    const spine = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, roots[0].id));
    for (const title of ["Start", "Einde bewindvoering", "Aanvraag bewindvoering",
      "bewindvoering"]) {
      expect(spine.map((s) => s.title), title).not.toContain(title);
    }
    // The seed's own fifteen, and every one of them `done`: all fifteen have
    // happened, and nothing this function writes is ever `expected` again.
    expect(spine.find((s) => s.title === "Aanmelding bij Verder")).toBeDefined();
    expect(spine.find((s) => s.title === "Stukken aanleveren")).toBeDefined();
    expect(spine.filter((s) => s.state === "expected")).toEqual([]);
  });

  it("refuses a second root track", async () => {
    await expect(
      db.insert(schema.tracks).values({ title: "tweede hoofdlijn" })
    ).rejects.toThrow(/tracks_single_root_uq/);
  });

  it("allows a child track with no branch point", async () => {
    // 0023 forced one with `track_branch_root_ck`; 0026 dropped that check.
    // Branch geometry is date-driven now, so the pointer is semantic only and
    // NULL is the honest value for a spoor whose origin nobody recorded.
    const r = await root();
    const [side] = await db.insert(schema.tracks)
      .values({ title: `zwevend spoor ${Date.now()}`, parentTrackId: r.id }).returning();
    try {
      expect(side.branchesAtStopId).toBeNull();
    } finally {
      await db.delete(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, side.id));
      await db.delete(schema.tracks).where(eq(schema.tracks.id, side.id));
    }
  });

  it("ensureCaseMap creates nothing on a database that already has the map", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    await ensureCaseMap(db);
    const created = await ensureCaseMap(db);
    expect(created).toEqual({ rootTrack: false, spineStops: [] });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    expect(after[0].n).toBe(before[0].n);
  });

  it("no longer enqueues the models the map replaced", async () => {
    // 0017 put search outbox triggers on milestones and timeline_events. Those
    // entity types left SEARCH_ENTITY_TYPES with this sub-project, and
    // loadAndRender THROWS on an unknown type — so every row those triggers
    // write is a job search.drain retries forever, failing every 60 s. 0023
    // drops the triggers and deletes what they already queued and indexed;
    // 0026 dropped the milestones table itself, so only the retired
    // timeline_events kind can still be probed here.
    await db.insert(schema.timelineEvents)
      .values({ title: `trigger probe ${Date.now()}`, happenedAt: new Date() });

    const queued = await db.select().from(schema.searchOutbox)
      .where(sql`${schema.searchOutbox.entityType} IN ('milestone', 'timeline_event')`);
    expect(queued).toHaveLength(0);
    const indexed = await db.select().from(schema.searchChunks)
      .where(sql`${schema.searchChunks.entityType} IN ('milestone', 'timeline_event')`);
    expect(indexed).toHaveLength(0);
  });

  it("renaming a spoor re-enqueues its haltes", async () => {
    // renderStop writes the TRACK's title into every stop's chunk body, so a
    // rename that only enqueues the track leaves its stops findable under the
    // old name forever.
    const r = await root();
    const [anchor] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, r.id),
        eq(schema.stops.title, "Aanmelding bij Verder")));
    const [side] = await db.insert(schema.tracks).values({
      title: `rename probe ${Date.now()}`, parentTrackId: r.id,
      branchesAtStopId: anchor.id,
    }).returning();
    const [halte] = await db.insert(schema.stops).values({
      trackId: side.id, orderIndex: 1, title: "Eerste halte",
    }).returning();
    try {
      // The two triggers 0023 installs on the tables themselves, before the
      // queue is cleared for the rename assertion.
      expect(await db.select().from(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, side.id))).toHaveLength(1);
      expect(await db.select().from(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, halte.id))).toHaveLength(1);

      await db.delete(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, halte.id));

      // As the APP role, which is the role that renames a spoor in production.
      await appDb.update(schema.tracks).set({ title: "hernoemd spoor" })
        .where(eq(schema.tracks.id, side.id));

      const queued = await db.select().from(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, halte.id));
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.every((q) => q.entityType === "stop")).toBe(true);
    } finally {
      // Admin role, and neither table is evidence — so this suite can leave the
      // map exactly as it found it instead of growing a probe track per run.
      await db.delete(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, halte.id));
      await db.delete(schema.searchOutbox)
        .where(eq(schema.searchOutbox.entityId, side.id));
      await db.delete(schema.stops).where(eq(schema.stops.id, halte.id));
      await db.delete(schema.tracks).where(eq(schema.tracks.id, side.id));
    }
  });

  it("runs the main line from the aanmelding to the stukken, in date order", async () => {
    // The spine is what the page is FOR: how the bewindvoering itself has run,
    // oldest first. Asserted as relative order, never as absolute order_index
    // values, so a later insert between two stations does not fail this.
    const [r] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    const line = (await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, r.id)))
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const at = (title: string) => line.findIndex((s) => s.title === title);

    expect(at("Aanmelding bij Verder")).toBe(0);
    expect(at("Beschikking: onder bewind gesteld"))
      .toBeGreaterThan(at("Verzoek onderbewindstelling ingediend"));
    expect(at("Dossier naar Team Opstart"))
      .toBeGreaterThan(at("Beschikking: onder bewind gesteld"));
    // The newest thing waiting on Martin is the far end of the line — and the
    // map begins at the aanmelding, so nothing sits before it any more.
    expect(at("Stukken aanleveren")).toBe(line.length - 1);

    // Nothing on this line is a claim about the future: 0026 deleted every
    // expected stop, and the seed writes `done` only.
    expect(line.filter((s) => s.state === "expected")).toEqual([]);
  });
});
