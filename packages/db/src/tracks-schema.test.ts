import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, ensureCaseMap, schema, type Db } from "./index";

// ADMIN role: this suite is about the CONSTRAINTS and TRIGGERS the map depends
// on (one root, no floating branch, no poisoned index queue), not about grants
// — the grant shape is the same one milestones and timeline_events carry.
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

  it("seeds exactly one root track, with its two anchors", async () => {
    const roots = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    expect(roots).toHaveLength(1);
    expect(roots[0].title).toBe("Einde bewindvoering");

    const anchors = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, roots[0].id));
    const start = anchors.find((s) => s.title === "Start");
    expect(start).toBeDefined();
    // DONE — the case is under way — but with NO date. A seeded now() would
    // render "Start · <the day of the migration>" as a fact about when Martin's
    // case began, which nobody measured, and it would also put the start AFTER
    // every copied key event and so flag all of them as out of order.
    expect(start?.state).toBe("done");
    expect(start?.happenedAt).toBeNull();

    const goal = anchors.find((s) => s.title === "Einde bewindvoering");
    expect(goal?.state).toBe("expected"); // it has not happened; do not imply it has
    expect(goal?.happenedAt).toBeNull();
  });

  it("refuses a second root track", async () => {
    await expect(
      db.insert(schema.tracks).values({ title: "tweede hoofdlijn" })
    ).rejects.toThrow(/tracks_single_root_uq/);
  });

  it("refuses a child track with no branch point", async () => {
    const r = await root();
    await expect(
      db.insert(schema.tracks).values({ title: "zwevend spoor", parentTrackId: r.id })
    ).rejects.toThrow(/track_branch_root_ck/);
  });

  it("seeds the WSNP track with all six stages, merging back", async () => {
    const [wsnp] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, "WSNP"));
    expect(wsnp.mergesAtStopId).not.toBeNull(); // WSNP is a prerequisite, so it rejoins

    const stops = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, wsnp.id));
    const stages = stops.map((s) => s.stage).filter(Boolean) as string[];
    expect([...new Set(stages)].sort()).toEqual([
      "accepted", "application", "clean-slate", "onboarding", "settlement", "wsnp-start",
    ]);

    // The synthetic filler adds a stop only for a stage that has NO stop at all,
    // and puts it on the round slot (pos * 100); a stop copied from a real
    // milestone sits at pos * 100 + n with n >= 1. So there is at most one
    // synthetic stop per stage, and that is the whole invariant.
    //
    // What CANNOT be asserted here: that a synthetic stop stands alone in its
    // stage. This dev database is shared and the api suites keep adding staged
    // stops to this very track (milestones.test.ts parks one on `clean-slate`
    // by design, because the app role has no DELETE on stops). A stage holding
    // a synthetic plus a foreign fixture is a healthy database, not a broken
    // seed, and asserting otherwise makes this test fail on run order.
    for (const stage of new Set(stages)) {
      const group = stops.filter((s) => s.stage === stage);
      const synthetic = group.filter((s) => s.orderIndex % 100 === 0);
      expect(synthetic.length).toBeLessThanOrEqual(1);
    }
  });

  it("ensureCaseMap creates nothing on a database that already has the map", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    const created = await ensureCaseMap(db);
    expect(created).toEqual({
      rootTrack: false, startStop: false, goalStop: false,
      wsnpTrack: false, spineStops: [], stageStops: [],
    });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    expect(after[0].n).toBe(before[0].n);
  });

  it("no longer enqueues the models the map replaced", async () => {
    // 0017 put search outbox triggers on milestones and timeline_events. Those
    // entity types left SEARCH_ENTITY_TYPES with this sub-project, and
    // loadAndRender THROWS on an unknown type — so every row those triggers
    // write is a job search.drain retries forever, failing every 60 s. 0023
    // drops the triggers and deletes what they already queued and indexed.
    await db.insert(schema.milestones)
      .values({ stage: "application", title: `trigger probe ${Date.now()}` });
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
      .where(and(eq(schema.stops.trackId, r.id), eq(schema.stops.title, "Start")));
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

  it("runs the main line Start -> aanvraag -> bewindvoering -> ... -> Einde", async () => {
    // The spine is what the page is FOR: the road to the end of the
    // bewindvoering, with the two facts that shape it on the way. Asserted as
    // relative order, never as absolute order_index values, because migration
    // 0024 renumbers whatever 0023 had already copied in between the anchors.
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    const line = (await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, root.id)))
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const at = (title: string) => line.findIndex((s) => s.title === title);

    expect(at("Start")).toBe(0);
    expect(at("Aanvraag bewindvoering")).toBeGreaterThan(at("Start"));
    expect(at("bewindvoering")).toBeGreaterThan(at("Aanvraag bewindvoering"));
    // The goal is the far right of the line, always — nothing is ever added
    // after it, which is what the 1000000 slot is for.
    expect(at("Einde bewindvoering")).toBe(line.length - 1);

    const station = (title: string) => line.find((s) => s.title === title)!;
    // Undated on purpose: nobody recorded when either happened, and this app
    // does not invent a date for Martin's own case.
    expect(station("Aanvraag bewindvoering").happenedAt).toBeNull();
    expect(station("Aanvraag bewindvoering").state).toBe("done");
    // "loopt nog" — the period he is in, not a thing that finished.
    expect(station("bewindvoering").state).toBe("open");
    expect(station("bewindvoering").happenedAt).toBeNull();
    expect(station("Einde bewindvoering").state).toBe("expected");
  });

});
