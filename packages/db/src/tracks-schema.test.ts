import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { CASE_MAP_SPINE_SEED, createDb, ensureCaseMap, schema, type Db } from "./index";

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
    // Seven, and every one of them `done`. Seven because a spoor is one
    // episode: the trigger belongs here on the hoofdlijn and the ANSWERING of
    // it belongs on the spoor that answers it. So the line carries the
    // aanmelding, the beschikking, the handover, and the four moments
    // something arrived — never the work that followed.
    expect(spine).toHaveLength(7);
    expect(spine.find((s) => s.title === "Aanmelding bij Verder")).toBeDefined();
    expect(spine.find((s) => s.title === "Stukken opgevraagd door Regio 3")).toBeDefined();
    // The answering lives on a spoor, so it may never be seeded onto the trunk.
    for (const answered of ["Stukken aanleveren", "Verzoek onderbewindstelling ingediend",
      "Opstart van het dossier afgerond"]) {
      expect(spine.map((s) => s.title), answered).not.toContain(answered);
    }
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

  it("ensureCaseMap does not duplicate a spine stop that is still on a spoor", async () => {
    // THE PRODUCTION BUG, 2026-08-29. `case-history` promotes a trigger off its
    // spoor onto the hoofdlijn, and calls ensureCaseMap first. With a
    // root-scoped lookup the stop was invisible — still on the spoor — so a
    // second copy was inserted, and the original was moved up beside it. Two
    // rows for one fact, and `stops` has no DELETE to clean up after that.
    await ensureCaseMap(db);
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    const [spoor] = await db.insert(schema.tracks).values({
      title: "Tijdelijk spoor", status: "open", parentTrackId: root.id,
    }).returning();
    // Take a spine stop off the trunk and park it on the spoor, exactly the
    // state case-history is in when it calls ensureCaseMap mid-restructure.
    const title = CASE_MAP_SPINE_SEED[0].title;
    await db.update(schema.stops).set({ trackId: spoor.id })
      .where(eq(schema.stops.title, title));

    const created = await ensureCaseMap(db);

    expect(created.spineStops, "re-created a stop that was only moved").toEqual([]);
    const rows = await db.select().from(schema.stops)
      .where(eq(schema.stops.title, title));
    expect(rows, `"${title}" exists twice`).toHaveLength(1);

    // Put the map back: this suite shares one database and the next test reads
    // the spine. Restoring here rather than in an afterEach keeps the mutation
    // and its repair in one place, where the next reader can see both.
    await db.update(schema.stops).set({ trackId: root.id })
      .where(eq(schema.stops.title, title));
    await db.delete(schema.tracks).where(eq(schema.tracks.id, spoor.id));
  });

  it("ensureCaseMap creates nothing on a database that already has the map", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    await ensureCaseMap(db);
    const created = await ensureCaseMap(db);
    expect(created).toEqual({ rootTrack: false, spineStops: [] });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stops);
    expect(after[0].n).toBe(before[0].n);
  });

  it("refuses a branch point on the root, which has no parent to leave", async () => {
    // The surviving half of 0023's biconditional `track_branch_root_ck`. 0026
    // dropped that check so a spoor may leave its origin unrecorded — but the
    // main line has nothing to branch FROM, so a stop id here means nothing and
    // buildTrackMap would be reading a pointer it can never draw.
    const r = await root();
    const [anchor] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, r.id),
        eq(schema.stops.title, "Aanmelding bij Verder")));
    await expect(
      db.update(schema.tracks).set({ branchesAtStopId: anchor.id })
        .where(eq(schema.tracks.id, r.id)),
    ).rejects.toThrow(/track_root_no_branch_ck/);
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
      .toBeGreaterThan(at("Aanmelding bij Verder"));
    expect(at("Dossier naar Team Opstart"))
      .toBeGreaterThan(at("Beschikking: onder bewind gesteld"));
    // The newest thing that LANDED is the far end of the line — the request
    // from Regio 3, not the stukken that answered it. Those sit on the spoor
    // that answers it, which is the whole point of the episode rule.
    expect(at("Stukken opgevraagd door Regio 3")).toBe(line.length - 1);
    expect(at("Verzoek onderbewindstelling ingediend"), "answering is not a trigger")
      .toBe(-1);

    // Nothing on this line is a claim about the future: 0026 deleted every
    // expected stop, and the seed writes `done` only.
    expect(line.filter((s) => s.state === "expected")).toEqual([]);
  });
});
