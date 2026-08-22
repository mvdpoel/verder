# Timeline Tracks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat curated timeline with a metro map — a main line running to *Einde bewindvoering*, side tracks that branch off it, run stops, and either merge back or end.

**Architecture:** Two new tables (`tracks`, `stops`) where the main line is the track with no parent. A pure `track-map.ts` turns rows into a drawable map by longest-path layering — never a time axis, because an expected stop has no date. Evidence (entry, task, documents, the email and its attachments) is resolved batched at read time and never stored. Nothing in this sub-project appends a ledger event.

**Tech Stack:** Postgres 17 + drizzle-orm, tRPC v11, Next.js 15 (App Router, React 19), vitest, inline SVG (no chart library).

**Spec:** `docs/superpowers/specs/2026-08-22-timeline-tracks-design.md`

## Global Constraints

- **Nothing here is evidence.** `tracks` and `stops` append **no `ledger_events`** and are never part of the hash chain, exactly like the `timeline_events` and `milestones` they replace. If a task seems to need a ledger event, stop — the design is being violated.
- **Evidence tables stay append-only.** `log_entries`, `documents`, `task_status_changes` are untouched by this plan.
- **A stop never copies a fact from what it links to.** `title` and `note` are Martin's words; date, channel, party and attachments are read live at render time. A stop may be *ahead of* reality; it may never *contradict* it.
- **Run every build and test with `env -u NODE_ENV`** — the shell exports `NODE_ENV=development`, which breaks `next build`.
- **`pnpm --filter <pkg> test -- <name>` does NOT filter vitest.** Use `cd <pkgdir> && env -u NODE_ENV pnpm exec vitest run <path>`.
- **Vitest does not typecheck.** A green suite is not evidence the change compiles. Run `env -u NODE_ENV pnpm -r typecheck` too.
- **The dev postgres is shared** between every suite in the repo. Scope every DB assertion to fixtures the suite itself created; never to absolute counts.
- **Dutch for money/process concepts Martin and VerderGroep use** (`halte`, `spoor`, `verwacht`, `afgerond`, `geëindigd`); English for app chrome, matching the existing pages.
- **Tone toward Martin:** the map reports, it never judges. A track that ended without merging back is a clean outcome, not a failure.
- **Deploy order, non-negotiable:** migration from the homelab HOST → rebuild images → `reindex` → `nightly-verify`.

### Two decisions taken before this plan, recorded so they are not re-litigated

1. **`kind` stays on the stop, but a linked entry's channel wins for display.** A stop can exist with nothing behind it, so it needs its own kind; the moment it links to an entry, the entry's `channel` is the truth. This is the anti-drift rule applied to one field.
2. **The migration seeds structure only** — the root track, its two anchor stops, and the WSNP track. Martin's three real tracks (*WSNP-aanvraag*, *Ontruiming*, *Team Opstart*) are built by hand in Task 13, because that first pass through the editor is the acceptance test of the editor.

### Verified before writing this plan (do not re-probe)

Run against the real dev Postgres 17 on 2026-08-22:

- `CREATE UNIQUE INDEX ... ON tracks ((true)) WHERE parent_track_id IS NULL` **is accepted** and a second root fails with `duplicate key value violates unique constraint`.
- `enum_range(NULL::wsnp_stage)::text[]` returns `{application,accepted,onboarding,wsnp-start,settlement,clean-slate}` and `array_position(..., 'onboarding')` returns `3`.
- A circular FK between two tables **works** when both FKs are added by `ALTER TABLE` after both tables exist.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/db/drizzle/0023_timeline_tracks.sql` | Enums, both tables, constraints, grants, search triggers, data migration |
| `packages/api/src/track-map.ts` | PURE derivation: edges, columns, lanes, stations, current stop, problems |
| `packages/api/src/track-map.test.ts` | Its tests — no database |
| `packages/api/src/track-evidence.ts` | Batched resolution of entry / task / documents / email per stop |
| `packages/api/src/routers/tracks.ts` | `map` + track and stop CRUD |
| `packages/api/src/routers/tracks.test.ts` | Router tests against the dev database |
| `apps/web/src/lib/track-marks.ts` | PURE mark decisions (filled / hollow / dashed / station / junction) + hrefs |
| `apps/web/src/lib/track-marks.test.ts` | Its tests — no React |
| `apps/web/src/components/track-map.tsx` | The inline-SVG map |
| `apps/web/src/components/track-editor.tsx` | Create/edit a track |
| `apps/web/src/components/stop-editor.tsx` | Create/edit/reorder a stop |

**Modified:**

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | `trackStatusEnum`, `stopStateEnum`, `tracks`, `stops` |
| `packages/core/src/search/entity-types.ts` | `milestone`,`timeline_event` → `track`,`stop` |
| `packages/api/src/search/render.ts` | `renderTrack`, `renderStop` replace `renderMilestone`, `renderTimelineEvent` |
| `packages/api/src/search/index-entity.ts` | The two new cases |
| `packages/api/src/routers/milestones.ts` | `timeline` reads stops; `deriveTimeline` itself is **unchanged** |
| `packages/api/src/root.ts` | Mount `tracksRouter`; drop `timelineRouter` |
| `apps/web/src/app/(app)/timeline/page.tsx` | Rewritten as the map |
| `apps/web/src/app/(app)/dashboard/page.tsx` | Strip becomes "where you are now" |
| `apps/web/src/components/search-kinds.ts` | Labels and badges for the two new kinds |
| `apps/worker/src/reindex.ts` | `SOURCES` entries for `track` and `stop` |
| `CLAUDE.md`, `docs/deploy.md` | Deploy ordering and the traps |

**Deleted:** `packages/api/src/routers/timeline.ts`, `packages/api/src/routers/timeline.test.ts`, `apps/web/src/components/timeline-editor.tsx`. The **tables** `timeline_events` and `milestones` are left in place, unread — nothing in this project stops reading a table and drops it in the same change.

---

## Task 1: Schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0023_timeline_tracks.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `packages/db/src/tracks-schema.test.ts`

**Interfaces:**
- Consumes: existing `timelineEventKindEnum`, `wsnpStageEnum`, `logEntries`, `tasks`, `documents`.
- Produces: `schema.tracks`, `schema.stops`, `schema.trackStatusEnum`, `schema.stopStateEnum`.

- [ ] **Step 1: Add the tables to the drizzle schema**

Append to `packages/db/src/schema.ts`, after the `timelineEvents` block. `parent_track_id`, `branches_at_stop_id` and `merges_at_stop_id` are declared as plain `uuid` columns **without** `.references()`: two of them are circular and one is a self-reference, and the foreign keys are added by `ALTER TABLE` in the migration where they read clearly.

```ts
// --- timeline tracks (sub-project 6) ---
// The case as a metro map. tracks + stops REPLACE timeline_events and the
// milestone model: the main line is simply the track with no parent, and a
// side track either merges back into its parent (it was a prerequisite for
// Einde bewindvoering) or it ends.
//
// Both tables are editable display aids, deliberately NOT ledgered — exactly
// what timeline_events and milestones already were. A stop asserts nothing; it
// points at the evidence, which stays in log_entries, documents and tasks.

export const trackStatusEnum = pgEnum("track_status", ["open", "done", "ended"]);
export const stopStateEnum = pgEnum("stop_state", ["done", "open", "expected"]);

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  status: trackStatusEnum("status").notNull().default("open"),
  // NULL = the main line. A unique index on a constant expression, filtered to
  // these rows, allows exactly one of them to exist.
  parentTrackId: uuid("parent_track_id"),
  // Where it leaves the parent; NULL iff parentTrackId is NULL (check constraint).
  branchesAtStopId: uuid("branches_at_stop_id"),
  // The stop on the parent it feeds into; NULL = it just ends, which is a real
  // outcome and not an unfinished one.
  mergesAtStopId: uuid("merges_at_stop_id"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stops = pgTable("stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id").notNull().references(() => tracks.id),
  orderIndex: integer("order_index").notNull(),
  title: text("title").notNull(),
  kind: timelineEventKindEnum("kind").notNull().default("other"),
  state: stopStateEnum("state").notNull().default("done"),
  // NULL for a stop that has not happened yet — which is the point of an
  // expected stop, and the reason the map is laid out structurally.
  happenedAt: timestamp("happened_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  // NULL, or a WSNP stage — what makes a stop a big named station.
  stage: wsnpStageEnum("stage"),
  entryId: uuid("entry_id").references(() => logEntries.id),
  taskId: uuid("task_id").references(() => tasks.id),
  documentId: uuid("document_id").references(() => documents.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("stops_track_order_idx").on(t.trackId, t.orderIndex)]);
```

- [ ] **Step 2: Generate the migration skeleton, then hand-write it**

Run:

```bash
cd packages/db && env -u NODE_ENV pnpm exec drizzle-kit generate --name timeline_tracks
```

This writes `drizzle/0023_timeline_tracks.sql`, `drizzle/meta/0023_snapshot.json` and the `_journal.json` entry. **Generating first and then replacing the SQL body is deliberate:** it is what keeps the snapshot in step with the TS schema, so the next `drizzle-kit generate` does not try to create these tables a second time.

Now replace the generated file's contents with the version below. Everything the generator cannot know — the check constraint, the single-root index, grants, search triggers and the data migration — is added by hand, exactly as 0011, 0013 and 0017 did.

```sql
-- Timeline tracks (sub-project 6): the case as a metro map.
--
-- tracks + stops REPLACE timeline_events and the milestone model. The main line
-- is the track with no parent; a side track either merges back into its parent
-- (it was a prerequisite for Einde bewindvoering) or it simply ends.
--
-- NEITHER TABLE IS EVIDENCE. Both are editable display aids and append no
-- ledger_events, exactly as timeline_events and milestones already did — the
-- facts stay in log_entries, documents and tasks. /verify is untouched.
--
-- timeline_events and milestones are READ FROM here and then left in place,
-- unread, forever after. Nothing in this project stops reading a table and
-- drops it in the same change; the drop is a later migration, if ever.
CREATE TYPE "public"."track_status" AS ENUM('open', 'done', 'ended');
--> statement-breakpoint
CREATE TYPE "public"."stop_state" AS ENUM('done', 'open', 'expected');
--> statement-breakpoint
CREATE TABLE "tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "status" "public"."track_status" DEFAULT 'open' NOT NULL,
  "parent_track_id" uuid,
  "branches_at_stop_id" uuid,
  "merges_at_stop_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A branch with no parent, or a parent with no branch point, cannot be drawn.
  CONSTRAINT "track_branch_root_ck"
    CHECK (("parent_track_id" IS NULL) = ("branches_at_stop_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stops" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "track_id" uuid NOT NULL,
  "order_index" integer NOT NULL,
  "title" text NOT NULL,
  "kind" "public"."timeline_event_kind" DEFAULT 'other' NOT NULL,
  "state" "public"."stop_state" DEFAULT 'done' NOT NULL,
  "happened_at" timestamp with time zone,
  "expected_at" timestamp with time zone,
  "stage" "public"."wsnp_stage",
  "entry_id" uuid,
  "task_id" uuid,
  "document_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_track_id_fk"
  FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_entry_id_fk"
  FOREIGN KEY ("entry_id") REFERENCES "public"."log_entries"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_task_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_document_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id");
--> statement-breakpoint
-- tracks and stops reference each other. Both directions are nullable on one
-- side, so the cycle resolves as long as these are added after both tables
-- exist. Verified on PG17 before this migration was written.
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_parent_track_id_fk"
  FOREIGN KEY ("parent_track_id") REFERENCES "public"."tracks"("id");
--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_branches_at_stop_id_fk"
  FOREIGN KEY ("branches_at_stop_id") REFERENCES "public"."stops"("id");
--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_merges_at_stop_id_fk"
  FOREIGN KEY ("merges_at_stop_id") REFERENCES "public"."stops"("id");
--> statement-breakpoint
-- EXACTLY ONE root track, ever. Indexing a constant expression means only one
-- row can satisfy the predicate: a second root is a corrupt map, not a second
-- opinion. Verified on PG17 — the second insert fails on this index.
CREATE UNIQUE INDEX "tracks_single_root_uq" ON "tracks" ((true))
  WHERE "parent_track_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "stops_track_order_idx" ON "stops" ("track_id", "order_index");
--> statement-breakpoint
-- Editable display aids (a typo is a typo), but nothing is ever deleted — the
-- same grant shape milestones and timeline_events carry.
GRANT SELECT, INSERT, UPDATE ON "tracks", "stops" TO verder_app, verder_worker;
--> statement-breakpoint
-- Search outbox triggers, using the function migration 0017 installed.
CREATE OR REPLACE TRIGGER "tracks_search_outbox_trg" AFTER INSERT OR UPDATE ON "tracks"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('track', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "stops_search_outbox_trg" AFTER INSERT OR UPDATE ON "stops"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('stop', 'id');
--> statement-breakpoint
-- Data migration. Order matters: a track cannot branch from or merge into a
-- stop that does not exist yet, so the root's two anchors are written before
-- any child track is.
--
-- order_index leaves room on purpose: the goal anchor sits at 1000000 so every
-- key event copied below slots between the two anchors without a renumber.
DO $$
DECLARE
  root_id uuid;
  start_stop_id uuid;
  goal_stop_id uuid;
  wsnp_id uuid;
  next_order integer := 1;
  r record;
  stage_name text;
  stage_title text;
BEGIN
  INSERT INTO tracks (title, status, note)
  VALUES ('Einde bewindvoering', 'open',
          'De hoofdlijn. Alles hier is een stap richting het einde van de bewindvoering.')
  RETURNING id INTO root_id;

  INSERT INTO stops (track_id, order_index, title, kind, state, happened_at)
  VALUES (root_id, 0, 'Start', 'process', 'done', now())
  RETURNING id INTO start_stop_id;

  -- The goal has not happened yet, and the map says so rather than implying it.
  INSERT INTO stops (track_id, order_index, title, kind, state)
  VALUES (root_id, 1000000, 'Einde bewindvoering', 'process', 'expected')
  RETURNING id INTO goal_stop_id;

  -- WSNP is a procedure INSIDE the goal of ending bewindvoering, not the same
  -- road: it runs as its own track and merges back at the end.
  INSERT INTO tracks (title, status, parent_track_id, branches_at_stop_id,
                      merges_at_stop_id, note)
  VALUES ('WSNP', 'open', root_id, start_stop_id, goal_stop_id,
          'De zes fases van de wettelijke schuldsanering.')
  RETURNING id INTO wsnp_id;

  -- Every milestone becomes a stop, in WSNP stage order.
  FOR r IN
    SELECT m.*,
           array_position(enum_range(NULL::wsnp_stage)::text[], m.stage::text) AS pos,
           row_number() OVER (PARTITION BY m.stage ORDER BY m.created_at, m.id) AS n
    FROM milestones m
    ORDER BY array_position(enum_range(NULL::wsnp_stage)::text[], m.stage::text),
             m.created_at, m.id
  LOOP
    INSERT INTO stops (track_id, order_index, title, kind, state, happened_at,
                       expected_at, stage, entry_id, document_id, note)
    VALUES (wsnp_id, r.pos * 100 + r.n::integer, r.title, 'process',
            CASE WHEN r.done THEN 'done'::stop_state ELSE 'open'::stop_state END,
            r.happened_at, r.expected_at, r.stage, r.entry_id, r.document_id, r.note);
  END LOOP;

  -- Any stage Martin has not recorded gets one synthetic expected stop, so the
  -- strip is complete WITHOUT duplicating a stage he already wrote down.
  FOREACH stage_name IN ARRAY enum_range(NULL::wsnp_stage)::text[] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM stops
      WHERE track_id = wsnp_id AND stage::text = stage_name
    ) THEN
      stage_title := CASE stage_name
        WHEN 'application' THEN 'Aanvraag'
        WHEN 'accepted'    THEN 'Toegelaten'
        WHEN 'onboarding'  THEN 'Intake'
        WHEN 'wsnp-start'  THEN 'Start WSNP'
        WHEN 'settlement'  THEN 'Regeling'
        WHEN 'clean-slate' THEN 'Schone lei'
      END;
      INSERT INTO stops (track_id, order_index, title, kind, state, stage)
      VALUES (wsnp_id,
              array_position(enum_range(NULL::wsnp_stage)::text[], stage_name) * 100,
              stage_title, 'process', 'expected', stage_name::wsnp_stage);
    END IF;
  END LOOP;

  -- Every curated key event becomes a stop on the main line, between the anchors.
  FOR r IN SELECT * FROM timeline_events ORDER BY happened_at, id LOOP
    INSERT INTO stops (track_id, order_index, title, kind, state, happened_at,
                       entry_id, document_id, note)
    VALUES (root_id, next_order, r.title, r.kind,
            CASE WHEN r.happened_at <= now() THEN 'done'::stop_state
                 ELSE 'expected'::stop_state END,
            r.happened_at, r.entry_id, r.document_id, r.note);
    next_order := next_order + 1;
  END LOOP;
END $$;
```

- [ ] **Step 3: Write the failing schema test**

Create `packages/db/src/tracks-schema.test.ts`. Follow the shape of `registry-schema.test.ts` (read it first for the connection helper it uses).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

describe("tracks and stops", () => {
  let db: Db;
  beforeAll(() => { db = createDb(ADMIN_URL).db; });

  it("seeds exactly one root track, with its two anchors", async () => {
    const roots = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    expect(roots).toHaveLength(1);
    expect(roots[0].title).toBe("Einde bewindvoering");

    const anchors = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, roots[0].id));
    expect(anchors.some((s) => s.title === "Start")).toBe(true);
    const goal = anchors.find((s) => s.title === "Einde bewindvoering");
    expect(goal?.state).toBe("expected"); // it has not happened; do not imply it has
  });

  it("refuses a second root track", async () => {
    await expect(
      db.insert(schema.tracks).values({ title: "tweede hoofdlijn" })
    ).rejects.toThrow(/tracks_single_root_uq/);
  });

  it("refuses a child track with no branch point", async () => {
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    await expect(
      db.insert(schema.tracks).values({ title: "zwevend spoor", parentTrackId: root.id })
    ).rejects.toThrow(/track_branch_root_ck/);
  });

  it("seeds the WSNP track with all six stages exactly once, merging back", async () => {
    const [wsnp] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, "WSNP"));
    expect(wsnp.mergesAtStopId).not.toBeNull(); // WSNP is a prerequisite, so it rejoins
    const stops = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, wsnp.id));
    const stages = stops.map((s) => s.stage).filter(Boolean).sort();
    expect(stages).toEqual([
      "accepted", "application", "clean-slate", "onboarding", "settlement", "wsnp-start",
    ]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd packages/db && env -u NODE_ENV pnpm exec vitest run src/tracks-schema.test.ts
```

Expected: FAIL — the `tracks` relation does not exist yet.

- [ ] **Step 5: Apply the migration and re-run**

```bash
cd packages/db && env -u NODE_ENV pnpm exec drizzle-kit migrate
env -u NODE_ENV pnpm exec vitest run src/tracks-schema.test.ts
```

Expected: 4 passed. If the second-root test reports a check-constraint violation instead of the unique index, the index predicate is wrong — fix the migration, do not relax the test.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/tracks-schema.test.ts \
  packages/db/drizzle/0023_timeline_tracks.sql packages/db/drizzle/meta/
git commit -m "feat(db): tracks and stops, and the one root the map is allowed"
```

---

## Task 2: The map — edges, columns and the cycles they can hide

**Files:**
- Create: `packages/api/src/track-map.ts`
- Test: `packages/api/src/track-map.test.ts`

**Interfaces:**
- Consumes: nothing. This module is PURE — no I/O, no `@verder/db` import, no React. It is the `money-series.ts` of this sub-project.
- Produces: the types below plus `buildTrackMap(input: { tracks: TrackRow[]; stops: StopRow[] }): TrackMap`. Tasks 3, 5, 8, 9 and 10 all consume these exact names.

- [ ] **Step 1: Write the types and the failing tests**

Create `packages/api/src/track-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTrackMap, type StopRow, type TrackRow } from "./track-map";

const track = (over: Partial<TrackRow> & { id: string; title: string }): TrackRow => ({
  status: "open", parentTrackId: null, branchesAtStopId: null,
  mergesAtStopId: null, note: null, ...over,
});

const stop = (over: Partial<StopRow> & { id: string; trackId: string }): StopRow => ({
  orderIndex: 0, title: over.id, kind: "process", state: "done",
  happenedAt: null, expectedAt: null, stage: null,
  entryId: null, taskId: null, documentId: null, note: null, ...over,
});

/** Main line m0..m3, with a child branching at m1 and merging at m3. */
function branchingFixture() {
  const tracks = [
    track({ id: "main", title: "Einde bewindvoering" }),
    track({
      id: "aanvraag", title: "WSNP-aanvraag", parentTrackId: "main",
      branchesAtStopId: "m1", mergesAtStopId: "m3",
    }),
  ];
  const stops = [
    stop({ id: "m0", trackId: "main", orderIndex: 0 }),
    stop({ id: "m1", trackId: "main", orderIndex: 1 }),
    stop({ id: "m2", trackId: "main", orderIndex: 2 }),
    stop({ id: "m3", trackId: "main", orderIndex: 3 }),
    stop({ id: "a1", trackId: "aanvraag", orderIndex: 0 }),
    stop({ id: "a2", trackId: "aanvraag", orderIndex: 1 }),
    stop({ id: "a3", trackId: "aanvraag", orderIndex: 2 }),
  ];
  return { tracks, stops };
}

const columnOf = (map: ReturnType<typeof buildTrackMap>, id: string) =>
  map.stops.find((s) => s.id === id)!.column;

describe("buildTrackMap columns", () => {
  it("puts a branch's first stop after the stop it branches from", () => {
    const map = buildTrackMap(branchingFixture());
    expect(columnOf(map, "a1")).toBeGreaterThan(columnOf(map, "m1"));
  });

  it("puts a merge target after every stop that fed into it", () => {
    const map = buildTrackMap(branchingFixture());
    // m3 waits for the whole child track, so it must sit right of a3 — even
    // though on its own track it is only three stops along.
    expect(columnOf(map, "m3")).toBeGreaterThan(columnOf(map, "a3"));
    expect(columnOf(map, "m3")).toBeGreaterThan(columnOf(map, "m2"));
  });

  it("orders stops within a track by order_index", () => {
    const map = buildTrackMap(branchingFixture());
    expect(columnOf(map, "m0")).toBeLessThan(columnOf(map, "m1"));
    expect(columnOf(map, "a1")).toBeLessThan(columnOf(map, "a2"));
  });

  it("drops a merge that points backwards, and reports it", () => {
    // Branches at m2 but claims to merge at m1 — that is a loop, not a track.
    const { tracks, stops } = branchingFixture();
    tracks[1] = { ...tracks[1], branchesAtStopId: "m2", mergesAtStopId: "m1" };
    const map = buildTrackMap({ tracks, stops });
    expect(map.edges.some((e) => e.kind === "merge")).toBe(false);
    expect(map.problems.some((p) => p.kind === "backwards-merge")).toBe(true);
    // and it still draws: every stop got a column
    expect(map.stops).toHaveLength(7);
  });

  it("survives a track whose ancestry never reaches the root", () => {
    const tracks = [
      track({ id: "main", title: "hoofdlijn" }),
      track({ id: "x", title: "x", parentTrackId: "y", branchesAtStopId: "s" }),
      track({ id: "y", title: "y", parentTrackId: "x", branchesAtStopId: "s" }),
    ];
    const stops = [stop({ id: "m0", trackId: "main" }), stop({ id: "s", trackId: "x" })];
    const map = buildTrackMap({ tracks, stops });
    expect(map.problems.some((p) => p.kind === "ancestry-cycle")).toBe(true);
    expect(map.tracks.map((t) => t.id)).toEqual(["main"]);
  });

  it("returns an empty map, not an exception, when there is no root", () => {
    const map = buildTrackMap({ tracks: [], stops: [] });
    expect(map.stops).toEqual([]);
    expect(map.problems.some((p) => p.kind === "no-root")).toBe(true);
  });

  it("keeps a track with no stops as a labelled stub", () => {
    const { tracks, stops } = branchingFixture();
    tracks.push(track({
      id: "leeg", title: "Team Opstart", parentTrackId: "main", branchesAtStopId: "m2",
    }));
    const map = buildTrackMap({ tracks, stops });
    const leeg = map.tracks.find((t) => t.id === "leeg")!;
    // A track opens the moment something arrives, before anyone has written
    // down what happens next. It gets a lane and a position anyway.
    expect(leeg.firstColumn).toBeGreaterThan(columnOf(map, "m2") - 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-map.test.ts
```

Expected: FAIL — `Cannot find module './track-map'`.

- [ ] **Step 3: Write the module**

Create `packages/api/src/track-map.ts`:

```ts
/**
 * The /timeline map. PURE: no database, no I/O, no imports from @verder/db.
 * Rows in, a drawable map out — the same discipline as money-series.ts, and
 * for the same reason: every rule below is unit-testable without a database.
 *
 * TOTAL: any input renders. A corrupt map is reported through `problems` and
 * still draws what it can, because a page that throws tells Martin nothing
 * about his case.
 *
 * POSITION IS A LAYERING, NOT A TIME AXIS. A metro map is deliberately not to
 * scale, and here that is honesty rather than style: an expected stop has no
 * date, and putting it on a time axis would mean inventing one. Dates are
 * labels on a stop; they are never geometry.
 */

export interface TrackRow {
  id: string;
  title: string;
  status: "open" | "done" | "ended";
  parentTrackId: string | null;
  branchesAtStopId: string | null;
  mergesAtStopId: string | null;
  note: string | null;
}

export interface StopRow {
  id: string;
  trackId: string;
  orderIndex: number;
  title: string;
  kind: string;
  state: "done" | "open" | "expected";
  happenedAt: Date | null;
  expectedAt: Date | null;
  stage: string | null;
  entryId: string | null;
  taskId: string | null;
  documentId: string | null;
  note: string | null;
}

export interface MapStop extends StopRow {
  column: number;
  lane: number;
  /** Carries a WSNP stage: draws as a large named station. */
  isStation: boolean;
  /** Another track branches from or merges into it. */
  isJunction: boolean;
  /** Its date precedes the previous dated stop on the same track. */
  datesOutOfOrder: boolean;
}

export interface MapTrack extends TrackRow {
  lane: number;
  firstColumn: number;
  lastColumn: number;
  mergesBack: boolean;
  /** Its merge pointed backwards and was refused; it renders as ending. */
  droppedMerge: boolean;
}

export interface MapEdge {
  kind: "track" | "branch" | "merge";
  fromStopId: string;
  toStopId: string;
}

export interface MapProblem {
  kind: "no-root" | "backwards-merge" | "ancestry-cycle" | "orphan-stop";
  trackId?: string;
  stopId?: string;
  detail: string;
}

export interface TrackMap {
  tracks: MapTrack[];
  stops: MapStop[];
  edges: MapEdge[];
  laneCount: number;
  columnCount: number;
  /** What is waiting on Martin right now — the page's actual answer. */
  currentStopId: string | null;
  problems: MapProblem[];
}

/** order_index, then date, then id: total and stable, so the map never reshuffles. */
function compareStops(a: StopRow, b: StopRow): number {
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  const at = a.happenedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.happenedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

/**
 * Longest path from any source, over a DAG. Every edge strictly increases the
 * column, which is what makes the result a valid drawing: a branch can never
 * point left and a merge can never land on top of what it waited for.
 */
function longestPathColumns(
  nodeIds: string[], edges: MapEdge[]
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const e of edges) {
    if (!indegree.has(e.fromStopId) || !indegree.has(e.toStopId)) continue;
    const list = outgoing.get(e.fromStopId);
    if (list) list.push(e.toStopId);
    else outgoing.set(e.fromStopId, [e.toStopId]);
    indegree.set(e.toStopId, (indegree.get(e.toStopId) ?? 0) + 1);
  }
  const column = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  // Sorted queue, so two independent sources never depend on insertion order.
  const queue = nodeIds.filter((id) => indegree.get(id) === 0).sort();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of outgoing.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return column;
}

export function buildTrackMap(input: {
  tracks: TrackRow[]; stops: StopRow[];
}): TrackMap {
  const problems: MapProblem[] = [];
  const byId = new Map(input.tracks.map((t) => [t.id, t]));

  const root = input.tracks.find((t) => t.parentTrackId === null);
  if (!root) {
    problems.push({ kind: "no-root", detail: "geen hoofdlijn gevonden" });
    return { tracks: [], stops: [], edges: [], laneCount: 0, columnCount: 0,
      currentStopId: null, problems };
  }

  // Only tracks whose ancestry actually reaches the root are drawable. A cycle
  // among parents is refused at write time; if one is ever in the data it is
  // reported here and the tracks in it are left out rather than looped over.
  const reachable: TrackRow[] = [];
  for (const t of input.tracks) {
    const seen = new Set<string>();
    let cur: TrackRow | undefined = t;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentTrackId === null) break;
      cur = byId.get(cur.parentTrackId);
    }
    if (cur && cur.parentTrackId === null) reachable.push(t);
    else problems.push({ kind: "ancestry-cycle", trackId: t.id,
      detail: `spoor "${t.title}" hangt niet aan de hoofdlijn` });
  }
  const drawable = new Set(reachable.map((t) => t.id));

  const byTrack = new Map<string, StopRow[]>();
  for (const s of input.stops) {
    if (!drawable.has(s.trackId)) {
      if (!byId.has(s.trackId)) {
        problems.push({ kind: "orphan-stop", stopId: s.id,
          detail: `halte "${s.title}" hoort bij geen enkel spoor` });
      }
      continue;
    }
    const bucket = byTrack.get(s.trackId);
    if (bucket) bucket.push(s);
    else byTrack.set(s.trackId, [s]);
  }
  for (const list of byTrack.values()) list.sort(compareStops);

  const drawnStops = [...byTrack.values()].flat();
  const stopIds = drawnStops.map((s) => s.id);
  const known = new Set(stopIds);

  // Phase A: track and branch edges only. That graph is a forest of chains, so
  // it is acyclic by construction.
  const structural: MapEdge[] = [];
  for (const list of byTrack.values()) {
    for (let i = 1; i < list.length; i++) {
      structural.push({ kind: "track", fromStopId: list[i - 1].id, toStopId: list[i].id });
    }
  }
  for (const t of reachable) {
    const own = byTrack.get(t.id);
    if (t.branchesAtStopId && known.has(t.branchesAtStopId) && own?.length) {
      structural.push({ kind: "branch", fromStopId: t.branchesAtStopId, toStopId: own[0].id });
    }
  }
  const phaseA = longestPathColumns(stopIds, structural);

  // Phase B: a merge survives only if it lands strictly right of the stop it
  // comes from. That single rule keeps the whole graph acyclic — every edge now
  // strictly increases the phase-A column — and it is exactly the case a
  // backwards merge describes: a track that claims to rejoin before it left.
  const merges: MapEdge[] = [];
  const droppedMerge = new Set<string>();
  for (const t of reachable) {
    const own = byTrack.get(t.id);
    if (!t.mergesAtStopId || !known.has(t.mergesAtStopId) || !own?.length) continue;
    const from = own[own.length - 1].id;
    if ((phaseA.get(t.mergesAtStopId) ?? 0) > (phaseA.get(from) ?? 0)) {
      merges.push({ kind: "merge", fromStopId: from, toStopId: t.mergesAtStopId });
    } else {
      droppedMerge.add(t.id);
      problems.push({ kind: "backwards-merge", trackId: t.id,
        detail: `spoor "${t.title}" komt terug vóór het vertrok — die verbinding is niet getekend` });
    }
  }

  const edges = [...structural, ...merges];
  const column = longestPathColumns(stopIds, edges);

  return finishMap({ root, reachable, byTrack, edges, column, droppedMerge, problems });
}
```

`finishMap` — lanes, stations, the current stop and the date flag — is Task 3. For this task, add a temporary implementation at the bottom of the file so the column tests can run:

```ts
// Replaced in full by Task 3. Lanes, stations and the current stop are that
// task's subject; this stub exists only so Task 2's tests can run.
function finishMap(x: {
  root: TrackRow; reachable: TrackRow[]; byTrack: Map<string, StopRow[]>;
  edges: MapEdge[]; column: Map<string, number>; droppedMerge: Set<string>;
  problems: MapProblem[];
}): TrackMap {
  const stops: MapStop[] = [...x.byTrack.values()].flat().map((s) => ({
    ...s, column: x.column.get(s.id) ?? 0, lane: 0,
    isStation: s.stage !== null, isJunction: false, datesOutOfOrder: false,
  }));
  const tracks: MapTrack[] = x.reachable.map((t) => {
    const own = x.byTrack.get(t.id) ?? [];
    const cols = own.map((s) => x.column.get(s.id) ?? 0);
    return {
      ...t, lane: 0,
      firstColumn: cols.length ? Math.min(...cols)
        : (x.column.get(t.branchesAtStopId ?? "") ?? 0) + 1,
      lastColumn: cols.length ? Math.max(...cols)
        : (x.column.get(t.branchesAtStopId ?? "") ?? 0) + 1,
      mergesBack: t.mergesAtStopId !== null && !x.droppedMerge.has(t.id),
      droppedMerge: x.droppedMerge.has(t.id),
    };
  });
  return {
    tracks, stops, edges: x.edges,
    laneCount: 1,
    columnCount: stops.reduce((m, s) => Math.max(m, s.column), 0) + 1,
    currentStopId: null, problems: x.problems,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-map.test.ts
env -u NODE_ENV pnpm exec tsc --noEmit
```

Expected: 7 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/track-map.ts packages/api/src/track-map.test.ts
git commit -m "feat(api): lay the map out by longest path, and refuse a merge that points backwards"
```

---

## Task 3: The map — lanes, stations, and what is waiting on Martin

**Files:**
- Modify: `packages/api/src/track-map.ts` (replace the `finishMap` stub)
- Modify: `packages/api/src/track-map.test.ts` (add the cases below)

**Interfaces:**
- Consumes: `buildTrackMap`, `MapStop`, `MapTrack`, `TrackMap` from Task 2.
- Produces: populated `lane`, `laneCount`, `isJunction`, `datesOutOfOrder`, `currentStopId`. Tasks 8, 9 and 10 render exactly these fields.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/src/track-map.test.ts`:

```ts
describe("buildTrackMap lanes and state", () => {
  it("keeps the main line in lane 0 and puts a branch beside it", () => {
    const map = buildTrackMap(branchingFixture());
    expect(map.tracks.find((t) => t.id === "main")!.lane).toBe(0);
    expect(map.tracks.find((t) => t.id === "aanvraag")!.lane).toBeGreaterThan(0);
  });

  it("reuses a lane for two tracks that do not overlap in time", () => {
    const tracks = [
      track({ id: "main", title: "hoofdlijn" }),
      track({ id: "vroeg", title: "Ontruiming", parentTrackId: "main",
        branchesAtStopId: "m0" }),
      track({ id: "laat", title: "Team Opstart", parentTrackId: "main",
        branchesAtStopId: "m3" }),
    ];
    const stops = [
      stop({ id: "m0", trackId: "main", orderIndex: 0 }),
      stop({ id: "m1", trackId: "main", orderIndex: 1 }),
      stop({ id: "m2", trackId: "main", orderIndex: 2 }),
      stop({ id: "m3", trackId: "main", orderIndex: 3 }),
      stop({ id: "v1", trackId: "vroeg", orderIndex: 0 }),
      stop({ id: "l1", trackId: "laat", orderIndex: 0 }),
    ];
    const map = buildTrackMap({ tracks, stops });
    const lane = (id: string) => map.tracks.find((t) => t.id === id)!.lane;
    // They never overlap, so the map does not grow a second row for them.
    expect(lane("vroeg")).toBe(lane("laat"));
    expect(map.laneCount).toBe(2);
  });

  it("gives overlapping tracks their own lanes", () => {
    const { tracks, stops } = branchingFixture();
    tracks.push(track({ id: "tweede", title: "Ontruiming", parentTrackId: "main",
      branchesAtStopId: "m1" }));
    stops.push(stop({ id: "t1", trackId: "tweede", orderIndex: 0 }));
    const map = buildTrackMap({ tracks, stops });
    const lane = (id: string) => map.tracks.find((t) => t.id === id)!.lane;
    expect(lane("aanvraag")).not.toBe(lane("tweede"));
  });

  it("marks a stop with a stage as a station, and a branch point as a junction", () => {
    const { tracks, stops } = branchingFixture();
    stops[2] = { ...stops[2], stage: "accepted" }; // m2
    const map = buildTrackMap({ tracks, stops });
    const at = (id: string) => map.stops.find((s) => s.id === id)!;
    expect(at("m2").isStation).toBe(true);
    expect(at("m0").isStation).toBe(false);
    expect(at("m1").isJunction).toBe(true);  // the child branches here
    expect(at("m3").isJunction).toBe(true);  // and merges here
    expect(at("m0").isJunction).toBe(false);
  });

  it("flags a dated stop that sits before the one ahead of it, and does not reorder", () => {
    const { tracks, stops } = branchingFixture();
    stops[0] = { ...stops[0], happenedAt: new Date("2026-06-01T00:00:00Z") };
    stops[1] = { ...stops[1], happenedAt: new Date("2026-05-01T00:00:00Z") };
    const map = buildTrackMap({ tracks, stops });
    const at = (id: string) => map.stops.find((s) => s.id === id)!;
    expect(at("m1").datesOutOfOrder).toBe(true);
    expect(at("m0").datesOutOfOrder).toBe(false);
    // Structure still wins: the map draws the order it was given.
    expect(at("m1").column).toBeGreaterThan(at("m0").column);
  });

  it("points at the furthest open stop as the current one", () => {
    const { tracks, stops } = branchingFixture();
    stops[1] = { ...stops[1], state: "open" };  // m1, early
    stops[6] = { ...stops[6], state: "open" };  // a3, late
    const map = buildTrackMap({ tracks, stops });
    expect(map.currentStopId).toBe("a3");
  });

  it("has no current stop when nothing is open", () => {
    expect(buildTrackMap(branchingFixture()).currentStopId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-map.test.ts
```

Expected: FAIL — lanes are all 0, junctions all false, `currentStopId` null.

- [ ] **Step 3: Replace the `finishMap` stub**

Replace the whole stub in `packages/api/src/track-map.ts` with:

```ts
/**
 * Lanes, stations, the current stop and the date flag.
 *
 * The root is lane 0. Every other track takes the LOWEST lane whose occupants
 * do not overlap its column span, so two tracks that never ran at the same time
 * share a row and the map stays readable instead of growing one row per track
 * forever.
 */
function finishMap(x: {
  root: TrackRow; reachable: TrackRow[]; byTrack: Map<string, StopRow[]>;
  edges: MapEdge[]; column: Map<string, number>; droppedMerge: Set<string>;
  problems: MapProblem[];
}): TrackMap {
  const col = (id: string | null) => (id ? x.column.get(id) ?? 0 : 0);

  // Junctions: every stop another track leaves from or lands on.
  const junctions = new Set<string>();
  for (const t of x.reachable) {
    if (t.branchesAtStopId) junctions.add(t.branchesAtStopId);
    if (t.mergesAtStopId && !x.droppedMerge.has(t.id)) junctions.add(t.mergesAtStopId);
  }

  const spanOf = (t: TrackRow) => {
    const own = x.byTrack.get(t.id) ?? [];
    if (own.length === 0) {
      // A track with no stops is a real state — it opens the moment something
      // arrives, before anyone has written down what happens next. It gets a
      // stub one column right of where it branched.
      const at = col(t.branchesAtStopId) + 1;
      return { firstColumn: at, lastColumn: at };
    }
    const cols = own.map((s) => col(s.id));
    return {
      firstColumn: Math.min(...cols, col(t.branchesAtStopId) + 1),
      lastColumn: Math.max(...cols, x.droppedMerge.has(t.id) ? 0 : col(t.mergesAtStopId)),
    };
  };

  // Depth-first from the root, children ordered by where they branch, so the
  // lane assignment never depends on the order rows came out of the database.
  const childrenOf = new Map<string, TrackRow[]>();
  for (const t of x.reachable) {
    if (t.parentTrackId === null) continue;
    const list = childrenOf.get(t.parentTrackId);
    if (list) list.push(t);
    else childrenOf.set(t.parentTrackId, [t]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) =>
      col(a.branchesAtStopId) - col(b.branchesAtStopId) ||
      a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  const ordered: TrackRow[] = [];
  const walk = (t: TrackRow) => {
    ordered.push(t);
    for (const child of childrenOf.get(t.id) ?? []) walk(child);
  };
  walk(x.root);

  const laneSpans = new Map<number, { from: number; to: number }[]>();
  const laneOf = new Map<string, number>();
  const spans = new Map<string, { firstColumn: number; lastColumn: number }>();
  for (const t of ordered) {
    const span = spanOf(t);
    spans.set(t.id, span);
    if (t.parentTrackId === null) {
      laneOf.set(t.id, 0);
      laneSpans.set(0, [{ from: span.firstColumn, to: span.lastColumn }]);
      continue;
    }
    let lane = 1;
    for (;; lane++) {
      const taken = laneSpans.get(lane) ?? [];
      const clash = taken.some((s) =>
        span.firstColumn <= s.to && s.from <= span.lastColumn);
      if (!clash) {
        laneSpans.set(lane, [...taken, { from: span.firstColumn, to: span.lastColumn }]);
        break;
      }
    }
    laneOf.set(t.id, lane);
  }

  const stops: MapStop[] = [];
  for (const [trackId, list] of x.byTrack) {
    // Within a track, a dated stop earlier than the last dated one is REPORTED,
    // never reordered. It usually means the stop is on the wrong track, and
    // silently sorting it away would destroy the signal.
    let lastDated: number | null = null;
    for (const s of list) {
      const at = s.happenedAt?.getTime() ?? null;
      const out = at !== null && lastDated !== null && at < lastDated;
      if (at !== null && !out) lastDated = at;
      stops.push({
        ...s,
        column: col(s.id),
        lane: laneOf.get(trackId) ?? 0,
        isStation: s.stage !== null,
        isJunction: junctions.has(s.id),
        datesOutOfOrder: out,
      });
    }
  }

  const tracks: MapTrack[] = ordered.map((t) => ({
    ...t,
    lane: laneOf.get(t.id) ?? 0,
    firstColumn: spans.get(t.id)!.firstColumn,
    lastColumn: spans.get(t.id)!.lastColumn,
    mergesBack: t.mergesAtStopId !== null && !x.droppedMerge.has(t.id),
    droppedMerge: x.droppedMerge.has(t.id),
  }));

  // "What is waiting on me" — the furthest open stop. This is the question the
  // page is opened to answer, so the map hands over the answer rather than
  // making Martin find it.
  const current = stops
    .filter((s) => s.state === "open")
    .sort((a, b) => b.column - a.column || a.lane - b.lane || a.id.localeCompare(b.id))[0];

  return {
    tracks, stops, edges: x.edges,
    laneCount: Math.max(1, ...[...laneOf.values()].map((l) => l + 1)),
    columnCount: stops.reduce((m, s) => Math.max(m, s.column), 0) + 1,
    currentStopId: current?.id ?? null,
    problems: x.problems,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-map.test.ts
env -u NODE_ENV pnpm exec tsc --noEmit
```

Expected: 14 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/track-map.ts packages/api/src/track-map.test.ts
git commit -m "feat(api): lanes, junctions, and the stop that is actually waiting on you"
```

---

## Task 4: Evidence behind a stop, resolved batched

**Files:**
- Create: `packages/api/src/track-evidence.ts`
- Test: `packages/api/src/track-evidence.test.ts`

**Interfaces:**
- Consumes: `schema` from `@verder/db`; `effectiveTaskStatus` from `./task-decide` (read that file first for its exact export name and signature); `effectiveDocument` from `./verification` or wherever the discard resolution lives — **grep for `effectiveDocument` before writing this task** and use the existing helper, never a re-implementation.
- Produces: `resolveStopEvidence(db: Db, stops: EvidenceInput[]): Promise<Map<string, StopEvidence>>` and the `StopEvidence` type. Tasks 5 and 10 consume both.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/track-evidence.test.ts`:

```ts
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { resolveStopEvidence } from "./track-evidence";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared: every assertion is scoped to rows this suite made.
describe("resolveStopEvidence", () => {
  let db: Db; let userId: string;
  let entryId: string; let documentId: string; let gmailId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `stops${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;

    gmailId = `gmail-${Date.now()}`;
    const sha = createHash("sha256").update(gmailId).digest("hex");
    const [doc] = await db.insert(schema.documents).values({
      title: "Beschikking.pdf", source: "email-attachment", sourceRef: gmailId,
      sha256: sha, mime: "application/pdf", sizeBytes: 10, receivedAt: new Date(),
    }).returning();
    documentId = doc.id;

    await db.insert(schema.rawEmails).values({
      gmailMessageId: gmailId, gmailThreadId: `thread-${gmailId}`,
      fromAddr: "demi@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Uitnodiging intake", sentAt: new Date("2026-06-12T09:00:00Z"),
      rawRfc822Sha256: createHash("sha256").update(`raw-${gmailId}`).digest("hex"),
      bodyText: "Beste Martin,",
    });

    const [entry] = await db.insert(schema.logEntries).values({
      occurredAt: new Date("2026-06-12T09:00:00Z"), channel: "email",
      direction: "inbound", summary: "Uitnodiging intake van Demi",
      source: "gmail-watch", createdBy: userId,
    }).returning();
    entryId = entry.id;
    await db.insert(schema.entryDocuments).values({ entryId, documentId });
  });

  it("resolves the entry, its documents and the e-mail behind them", async () => {
    const found = await resolveStopEvidence(db, [
      { id: "s1", entryId, taskId: null, documentId: null },
    ]);
    const e = found.get("s1")!;
    expect(e.entry?.summary).toBe("Uitnodiging intake van Demi");
    expect(e.entry?.channel).toBe("email"); // the entry's channel, not the stop's kind
    expect(e.documents.map((d) => d.id)).toContain(documentId);
    expect(e.email?.subject).toBe("Uitnodiging intake");
  });

  it("returns an entry for every stop asked about, even an empty one", async () => {
    const found = await resolveStopEvidence(db, [
      { id: "leeg", entryId: null, taskId: null, documentId: null },
    ]);
    const e = found.get("leeg")!;
    expect(e.entry).toBeNull();
    expect(e.documents).toEqual([]);
    expect(e.email).toBeNull();
  });

  it("yields no e-mail — and no error — when the source ref matches nothing", async () => {
    const sha = createHash("sha256").update(`orphan-${Date.now()}`).digest("hex");
    const [orphan] = await db.insert(schema.documents).values({
      title: "los.pdf", source: "email-attachment", sourceRef: "gmail-does-not-exist",
      sha256: sha, mime: "application/pdf", sizeBytes: 4, receivedAt: new Date(),
    }).returning();
    const found = await resolveStopEvidence(db, [
      { id: "s2", entryId: null, taskId: null, documentId: orphan.id },
    ]);
    expect(found.get("s2")!.email).toBeNull();
    expect(found.get("s2")!.documents.map((d) => d.id)).toEqual([orphan.id]);
  });

  it("reads one query per link type, not one per stop", async () => {
    // Fifty stops must not mean fifty round trips. The registry's N+1 was found
    // in production code twice; this one starts batched and stays batched.
    const many = Array.from({ length: 50 }, (_, n) => ({
      id: `bulk-${n}`, entryId, taskId: null, documentId: null,
    }));
    let queries = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") queries++;
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    await resolveStopEvidence(counted, many);
    expect(queries).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-evidence.test.ts
```

Expected: FAIL — `Cannot find module './track-evidence'`.

- [ ] **Step 3: Write the module**

Create `packages/api/src/track-evidence.ts`. Before writing, grep for the two helpers it must reuse:

```bash
grep -rn "export async function effectiveTaskStatus" packages/api/src
grep -rn "export function effectiveDocument\|export async function effectiveDocument" packages/api/src
```

```ts
/**
 * What is really behind a stop: the logbook entry, the task and its effective
 * status, the documents, and the e-mail those documents came off.
 *
 * DERIVED, NEVER STORED. This is the map's third level — the mail and its files
 * hanging off a stop — and it is resolved on read precisely so it cannot go
 * stale. A stop points; this module follows the pointer.
 *
 * Every lookup is BATCHED: one query per link type for the whole map, never one
 * per stop. Fifty stops on a map is normal and fifty round trips is not.
 *
 * Defensive throughout: a source_ref matching no e-mail yields NO e-mail link,
 * never an error. A stop can legitimately point at something that has been
 * discarded or was never there.
 */

import { inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveTaskStatus } from "./task-decide";

export interface EvidenceInput {
  id: string;
  entryId: string | null;
  taskId: string | null;
  documentId: string | null;
}

export interface StopEvidence {
  entry: {
    id: string; summary: string; occurredAt: Date; channel: string; direction: string;
  } | null;
  task: { id: string; title: string; status: string; dueAt: Date | null } | null;
  documents: { id: string; title: string; mime: string }[];
  email: {
    id: string; subject: string; fromAddr: string; sentAt: Date; gmailMessageId: string;
  } | null;
}

const EMPTY: StopEvidence = { entry: null, task: null, documents: [], email: null };

const idsOf = <T>(rows: T[], pick: (r: T) => string | null) =>
  [...new Set(rows.map(pick).filter((v): v is string => v !== null))];

export async function resolveStopEvidence(
  db: Db, stops: EvidenceInput[]
): Promise<Map<string, StopEvidence>> {
  const out = new Map<string, StopEvidence>(stops.map((s) => [s.id, { ...EMPTY }]));
  if (stops.length === 0) return out;

  const entryIds = idsOf(stops, (s) => s.entryId);
  const taskIds = idsOf(stops, (s) => s.taskId);
  const directDocIds = idsOf(stops, (s) => s.documentId);

  const [entries, tasks, entryDocs] = await Promise.all([
    entryIds.length
      ? db.select({
          id: schema.logEntries.id, summary: schema.logEntries.summary,
          occurredAt: schema.logEntries.occurredAt, channel: schema.logEntries.channel,
          direction: schema.logEntries.direction,
        }).from(schema.logEntries).where(inArray(schema.logEntries.id, entryIds))
      : [],
    taskIds.length
      ? db.select({
          id: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt,
        }).from(schema.tasks).where(inArray(schema.tasks.id, taskIds))
      : [],
    entryIds.length
      ? db.select().from(schema.entryDocuments)
          .where(inArray(schema.entryDocuments.entryId, entryIds))
      : [],
  ]);

  const allDocIds = [...new Set([...directDocIds, ...entryDocs.map((d) => d.documentId)])];
  const documents = allDocIds.length
    ? await db.select({
        id: schema.documents.id, title: schema.documents.title,
        mime: schema.documents.mime, source: schema.documents.source,
        sourceRef: schema.documents.sourceRef,
      }).from(schema.documents).where(inArray(schema.documents.id, allDocIds))
    : [];

  // The e-mail: an attachment carries its Gmail message id in source_ref, which
  // is the same value raw_emails.gmail_message_id holds.
  const messageIds = idsOf(
    documents.filter((d) => d.source === "email-attachment"), (d) => d.sourceRef);
  const emails = messageIds.length
    ? await db.select({
        id: schema.rawEmails.id, subject: schema.rawEmails.subject,
        fromAddr: schema.rawEmails.fromAddr, sentAt: schema.rawEmails.sentAt,
        gmailMessageId: schema.rawEmails.gmailMessageId,
      }).from(schema.rawEmails)
        .where(inArray(schema.rawEmails.gmailMessageId, messageIds))
    : [];

  // Task status lives in task_status_changes ordered by ledger seq, never on the
  // task row. These are the only per-row queries here, and there is one per
  // LINKED TASK — not one per stop.
  const statuses = new Map<string, string>();
  await Promise.all(taskIds.map(async (id) => {
    statuses.set(id, await effectiveTaskStatus(db, id));
  }));

  const docById = new Map(documents.map((d) => [d.id, d]));
  const emailByMessageId = new Map(emails.map((e) => [e.gmailMessageId, e]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const docsByEntry = new Map<string, string[]>();
  for (const link of entryDocs) {
    const list = docsByEntry.get(link.entryId);
    if (list) list.push(link.documentId);
    else docsByEntry.set(link.entryId, [link.documentId]);
  }

  for (const s of stops) {
    const docIds = [
      ...(s.documentId ? [s.documentId] : []),
      ...(s.entryId ? docsByEntry.get(s.entryId) ?? [] : []),
    ];
    const docs = [...new Set(docIds)]
      .map((id) => docById.get(id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    const task = s.taskId ? taskById.get(s.taskId) : undefined;
    const messageId = docs.find(
      (d) => d.source === "email-attachment" && d.sourceRef)?.sourceRef ?? null;

    out.set(s.id, {
      entry: (s.entryId && entryById.get(s.entryId)) || null,
      task: task
        ? { id: task.id, title: task.title, dueAt: task.dueAt,
            status: statuses.get(task.id) ?? "open" }
        : null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, mime: d.mime })),
      email: (messageId && emailByMessageId.get(messageId)) || null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/track-evidence.test.ts
env -u NODE_ENV pnpm exec tsc --noEmit
```

Expected: 4 passed, typecheck clean. If `effectiveTaskStatus` has a different name or signature, fix the import — do not inline the query.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/track-evidence.ts packages/api/src/track-evidence.test.ts
git commit -m "feat(api): follow a stop's pointer to the entry, the task and the mail behind it"
```

---

## Task 5: The tracks router

**Files:**
- Create: `packages/api/src/routers/tracks.ts`
- Test: `packages/api/src/routers/tracks.test.ts`
- Modify: `packages/api/src/root.ts`
- Delete: `packages/api/src/routers/timeline.ts`, `packages/api/src/routers/timeline.test.ts`

**Interfaces:**
- Consumes: `buildTrackMap`, `TrackRow`, `StopRow` (Task 2/3); `resolveStopEvidence`, `StopEvidence` (Task 4).
- Produces: `tracksRouter` mounted at `tracks`, with `tracks.map`, `tracks.createTrack`, `tracks.updateTrack`, `tracks.createStop`, `tracks.updateStop`. `tracks.map` returns `{ map: TrackMap; evidence: Record<string, StopEvidence> }`. Tasks 9–12 consume that exact shape.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routers/tracks.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// Scoped to the tracks this suite creates. The seeded root is shared with every
// other suite, so nothing here asserts a total.
describe("tracks router", () => {
  let db: Db; let userId: string; let rootId: string; let anchorId: string;
  let mine: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `tracks${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    rootId = root.id;
    const [anchor] = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, rootId));
    anchorId = anchor.id;
    mine = `probe-${Date.now()}`;
  });

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("creates a side track that branches from a stop on the main line", async () => {
    const track = await caller().tracks.createTrack({
      title: `${mine} Ontruiming`, parentTrackId: rootId, branchesAtStopId: anchorId,
    });
    expect(track.parentTrackId).toBe(rootId);
    expect(track.mergesAtStopId).toBeNull(); // it may simply end; that is a real outcome
    const { map } = await caller().tracks.map();
    expect(map.tracks.some((t) => t.id === track.id)).toBe(true);
  });

  it("refuses a second root track", async () => {
    await expect(caller().tracks.createTrack({ title: `${mine} tweede hoofdlijn` }))
      .rejects.toThrow(/hoofdlijn/i);
  });

  it("refuses a track that would become its own ancestor", async () => {
    const a = await caller().tracks.createTrack({
      title: `${mine} A`, parentTrackId: rootId, branchesAtStopId: anchorId,
    });
    const stopOnA = await caller().tracks.createStop({ trackId: a.id, title: "halte" });
    const b = await caller().tracks.createTrack({
      title: `${mine} B`, parentTrackId: a.id, branchesAtStopId: stopOnA.id,
    });
    await expect(caller().tracks.updateTrack({ id: a.id, parentTrackId: b.id }))
      .rejects.toThrow(/eigen/i);
  });

  it("appends a stop at the end of its track and hands back the evidence map", async () => {
    const track = await caller().tracks.createTrack({
      title: `${mine} Team Opstart`, parentTrackId: rootId, branchesAtStopId: anchorId,
    });
    const first = await caller().tracks.createStop({
      trackId: track.id, title: "documenten opgevraagd", state: "done",
      happenedAt: new Date("2026-08-01T00:00:00Z"),
    });
    const second = await caller().tracks.createStop({
      trackId: track.id, title: "bijzondere bijstand aanvragen", state: "open",
    });
    expect(second.orderIndex).toBeGreaterThan(first.orderIndex);

    const { map, evidence } = await caller().tracks.map();
    const cols = (id: string) => map.stops.find((s) => s.id === id)!.column;
    expect(cols(second.id)).toBeGreaterThan(cols(first.id));
    // Every stop on the map has an evidence entry, even an empty one.
    expect(evidence[second.id]).toBeDefined();
    expect(evidence[second.id].documents).toEqual([]);
  });

  it("marks the furthest open stop as current", async () => {
    const { map } = await caller().tracks.map();
    const current = map.stops.find((s) => s.id === map.currentStopId);
    if (current) expect(current.state).toBe("open");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/routers/tracks.test.ts
```

Expected: FAIL — `tracks` is not a procedure on the router.

- [ ] **Step 3: Write the router**

Create `packages/api/src/routers/tracks.ts`:

```ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq, isNull, max } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { buildTrackMap, type StopRow, type TrackRow } from "../track-map";
import { resolveStopEvidence, type StopEvidence } from "../track-evidence";

/**
 * The case as a metro map. This router owns two editable display aids and
 * appends NO ledger events: the evidence stays in log_entries, documents and
 * tasks, and a stop only ever points at it.
 */

const TRACK_STATUSES = ["open", "done", "ended"] as const;
const STOP_STATES = ["done", "open", "expected"] as const;
const STOP_KINDS = ["process", "mail", "call", "meeting", "document", "other"] as const;
const WSNP_STAGES = ["application", "accepted", "onboarding", "wsnp-start",
  "settlement", "clean-slate"] as const;

const trackFields = z.object({
  title: z.string().min(1),
  status: z.enum(TRACK_STATUSES).default("open"),
  parentTrackId: z.string().uuid().nullish(),
  branchesAtStopId: z.string().uuid().nullish(),
  mergesAtStopId: z.string().uuid().nullish(),
  note: z.string().nullish(),
});

const stopFields = z.object({
  trackId: z.string().uuid(),
  title: z.string().min(1),
  kind: z.enum(STOP_KINDS).default("other"),
  state: z.enum(STOP_STATES).default("done"),
  happenedAt: z.coerce.date().nullish(),
  expectedAt: z.coerce.date().nullish(),
  stage: z.enum(WSNP_STAGES).nullish(),
  entryId: z.string().uuid().nullish(),
  taskId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
  note: z.string().nullish(),
  orderIndex: z.number().int().nullish(),
});

/** Strip undefined so a partial update only touches the columns it was given. */
function definedOnly<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * A track may not become its own ancestor. Postgres cannot express this
 * cheaply, and buildTrackMap survives one — but a map that has to be repaired
 * on every read is a map with a bug in it, so the write is refused here.
 */
async function assertNoAncestryCycle(
  db: Db, trackId: string, parentTrackId: string | null
): Promise<void> {
  if (!parentTrackId) return;
  if (parentTrackId === trackId) {
    throw new TRPCError({ code: "BAD_REQUEST",
      message: "Een spoor kan niet zijn eigen vertrekpunt zijn." });
  }
  const rows = await db.select({
    id: schema.tracks.id, parentTrackId: schema.tracks.parentTrackId,
  }).from(schema.tracks);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentTrackId]));
  const seen = new Set<string>([trackId]);
  let cur: string | null = parentTrackId;
  while (cur) {
    if (seen.has(cur)) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Dat maakt het spoor zijn eigen voorganger." });
    }
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
}

export const tracksRouter = router({
  /**
   * The whole map plus the evidence behind every stop. One query per table and
   * one batched evidence resolution — never one per stop.
   */
  map: protectedProcedure.query(async ({ ctx }) => {
    const [tracks, stops] = await Promise.all([
      ctx.db.select().from(schema.tracks).orderBy(asc(schema.tracks.createdAt)),
      ctx.db.select().from(schema.stops)
        .orderBy(asc(schema.stops.trackId), asc(schema.stops.orderIndex)),
    ]);
    const map = buildTrackMap({
      tracks: tracks as TrackRow[], stops: stops as StopRow[],
    });
    const evidence = await resolveStopEvidence(ctx.db, map.stops.map((s) => ({
      id: s.id, entryId: s.entryId, taskId: s.taskId, documentId: s.documentId,
    })));
    return {
      map,
      evidence: Object.fromEntries(evidence) as Record<string, StopEvidence>,
    };
  }),

  createTrack: protectedProcedure.input(trackFields).mutation(async ({ ctx, input }) => {
    if (!input.parentTrackId) {
      // The single-root index would refuse this anyway; catching it here turns a
      // constraint violation into a sentence Martin can read.
      const existing = await ctx.db.select({ id: schema.tracks.id })
        .from(schema.tracks).where(isNull(schema.tracks.parentTrackId));
      if (existing.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST",
          message: "Er is al een hoofdlijn. Een zijspoor vertrekt vanaf een halte." });
      }
    } else if (!input.branchesAtStopId) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Kies de halte waar dit spoor vertrekt." });
    }
    const [track] = await ctx.db.insert(schema.tracks).values(input).returning();
    return track;
  }),

  updateTrack: protectedProcedure
    .input(trackFields.partial().extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (patch.parentTrackId !== undefined) {
        await assertNoAncestryCycle(ctx.db, id, patch.parentTrackId as string | null);
      }
      if (Object.keys(patch).length === 0) {
        const [track] = await ctx.db.select().from(schema.tracks)
          .where(eq(schema.tracks.id, id));
        if (!track) throw new TRPCError({ code: "NOT_FOUND", message: "Spoor niet gevonden" });
        return track;
      }
      const [track] = await ctx.db.update(schema.tracks).set(patch)
        .where(eq(schema.tracks.id, id)).returning();
      if (!track) throw new TRPCError({ code: "NOT_FOUND", message: "Spoor niet gevonden" });
      return track;
    }),

  /** Appends to the end of its track unless an explicit position is given. */
  createStop: protectedProcedure.input(stopFields).mutation(async ({ ctx, input }) => {
    const { orderIndex, ...fields } = input;
    let position = orderIndex ?? null;
    if (position === null) {
      const [row] = await ctx.db.select({ last: max(schema.stops.orderIndex) })
        .from(schema.stops).where(eq(schema.stops.trackId, input.trackId));
      position = (row?.last ?? -1) + 1;
    }
    const [stop] = await ctx.db.insert(schema.stops)
      .values({ ...fields, orderIndex: position }).returning();
    return stop;
  }),

  updateStop: protectedProcedure
    .input(stopFields.partial().omit({ trackId: true }).extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const patch = definedOnly(fields);
      if (Object.keys(patch).length === 0) {
        const [stop] = await ctx.db.select().from(schema.stops)
          .where(eq(schema.stops.id, id));
        if (!stop) throw new TRPCError({ code: "NOT_FOUND", message: "Halte niet gevonden" });
        return stop;
      }
      const [stop] = await ctx.db.update(schema.stops).set(patch)
        .where(eq(schema.stops.id, id)).returning();
      if (!stop) throw new TRPCError({ code: "NOT_FOUND", message: "Halte niet gevonden" });
      return stop;
    }),
});
```

- [ ] **Step 4: Mount it and remove the old router**

In `packages/api/src/root.ts`: delete the `timelineRouter` import and its `timeline:` line, add `import { tracksRouter } from "./routers/tracks";` and `tracks: tracksRouter,`. Then:

```bash
git rm packages/api/src/routers/timeline.ts packages/api/src/routers/timeline.test.ts
```

- [ ] **Step 5: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/routers/tracks.test.ts
env -u NODE_ENV pnpm exec tsc --noEmit
```

Expected: 5 passed. Typecheck will still fail in `apps/web` (the timeline page calls `caller.timeline.list()`) — that is Task 10's job and is expected until then. `packages/api` itself must be clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/tracks.ts packages/api/src/routers/tracks.test.ts packages/api/src/root.ts
git commit -m "feat(api): the tracks router, and a track that cannot become its own ancestor"
```

---

## Task 6: The WSNP strip and the countdown, re-pointed at stops

**Files:**
- Modify: `packages/api/src/routers/milestones.ts`
- Test: `packages/api/src/routers/milestones.test.ts` (extend)
- **Unchanged on purpose:** `packages/api/src/wsnp-timeline.ts` and `packages/api/src/wsnp-timeline.test.ts`

**Interfaces:**
- Consumes: `deriveTimeline(rows: MilestoneRow[], now: Date)` — **unchanged**. `MilestoneRow` is `{ stage: string; done: boolean; happenedAt: Date | null }`, and a stop maps onto it exactly.
- Produces: `milestones.timeline` returning the same `{ stages, countdown }` shape it returns today.

**Why the derivation module is not touched:** the 18-month countdown works. Re-pointing where its rows come from is a small change; rewriting the rule is a large one with nothing to gain. **A rebuilt countdown that returns a different number of days is a bug in the rebuild, not a new answer.**

- [ ] **Step 1: Write the failing test**

Add to `packages/api/src/routers/milestones.test.ts`:

```ts
it("derives the strip and the countdown from the WSNP track's stops", async () => {
  const [wsnp] = await db.select().from(schema.tracks)
    .where(eq(schema.tracks.title, "WSNP"));
  // A real start date on the wsnp-start station is what the countdown hangs off.
  const [startStop] = await db.select().from(schema.stops)
    .where(and(eq(schema.stops.trackId, wsnp.id), eq(schema.stops.stage, "wsnp-start")));
  const startedAt = new Date("2026-08-01T00:00:00Z");
  await db.update(schema.stops)
    .set({ state: "done", happenedAt: startedAt })
    .where(eq(schema.stops.id, startStop.id));

  const { stages, countdown } = await caller().milestones.timeline();
  expect(stages.map((s) => s.stage)).toEqual([
    "application", "accepted", "onboarding", "wsnp-start", "settlement", "clean-slate",
  ]);
  // 547 days, unchanged — the rule did not move, only where it reads from.
  expect(countdown!.endsAt.toISOString().slice(0, 10)).toBe("2028-01-30");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/routers/milestones.test.ts
```

Expected: FAIL — `milestones.timeline` still reads the (empty) `milestones` table, so `countdown` is null.

- [ ] **Step 3: Re-point the procedure**

In `packages/api/src/routers/milestones.ts`, replace the `timeline` procedure:

```ts
  /**
   * Dashboard strip: per-stage done/current/future/empty + settlement countdown.
   *
   * Reads the WSNP TRACK's stops, not the milestones table — WSNP is a
   * procedure inside the goal of ending bewindvoering and runs as its own
   * track. deriveTimeline itself is deliberately untouched: a stop carrying a
   * stage maps onto MilestoneRow exactly, and the 547-day rule must produce the
   * same answer it produced before this sub-project.
   */
  timeline: protectedProcedure.query(async ({ ctx }) => {
    const [wsnp] = await ctx.db.select({ id: schema.tracks.id })
      .from(schema.tracks).where(eq(schema.tracks.title, "WSNP"));
    const rows = wsnp
      ? await ctx.db.select().from(schema.stops)
          .where(and(eq(schema.stops.trackId, wsnp.id), isNotNull(schema.stops.stage)))
          .orderBy(asc(schema.stops.orderIndex), asc(schema.stops.id))
      : [];
    return deriveTimeline(
      rows.map((s) => ({
        ...s,
        stage: s.stage as string,
        done: s.state === "done",
        happenedAt: s.happenedAt,
      })),
      new Date()
    );
  }),
```

Add `and`, `isNotNull` to the `drizzle-orm` import.

- [ ] **Step 4: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/routers/milestones.test.ts src/wsnp-timeline.test.ts
```

Expected: all pass, **including every pre-existing `wsnp-timeline` assertion untouched**.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/milestones.ts packages/api/src/routers/milestones.test.ts
git commit -m "feat(api): the WSNP strip reads its own track, and the countdown does not move"
```

---

## Task 7: Search — two new entity kinds

**Files:**
- Modify: `packages/core/src/search/entity-types.ts`
- Modify: `packages/api/src/search/render.ts`
- Modify: `packages/api/src/search/index-entity.ts`
- Modify: `apps/worker/src/reindex.ts`
- Modify: `apps/web/src/components/search-kinds.ts`
- Test: `packages/api/src/search/render.test.ts` (extend — read it first for its style)

**Interfaces:**
- Consumes: `Rendered` from `render.ts`; `SEARCH_ENTITY_TYPES` from `@verder/core`.
- Produces: `renderTrack`, `renderStop`; entity types `"track"` and `"stop"`.

**Note:** `search_chunks.entity_type` is a `text` column, not an enum — **no migration is needed**. Old `milestone` and `timeline_event` chunks are removed by `reindex --prune` at deploy time (Task 13).

- [ ] **Step 1: Write the failing renderer tests**

Add to `packages/api/src/search/render.test.ts`:

```ts
describe("renderTrack / renderStop", () => {
  it("renders a track that merged back differently from one that ended", () => {
    const merged = renderTrack({
      title: "WSNP-aanvraag", status: "done", note: null, mergesBack: true,
    });
    const ended = renderTrack({
      title: "Ontruiming", status: "ended", note: null, mergesBack: false,
    });
    expect(merged.body).toContain("teruggekomen op de hoofdlijn");
    expect(ended.body).toContain("geëindigd");
    // A track that ended is not a failure and the text must not read as one.
    expect(ended.body).not.toMatch(/mislukt|niet afgemaakt/i);
  });

  it("dates a stop by what happened, falling back to what is expected", () => {
    const done = renderStop({
      title: "Intake Almere", kind: "meeting", state: "done", note: null,
      happenedAt: new Date("2026-06-19T00:00:00Z"), expectedAt: null,
      stage: null, trackTitle: "WSNP-aanvraag",
    });
    expect(done.occurredAt?.toISOString().slice(0, 10)).toBe("2026-06-19");
    expect(done.body).toContain("WSNP-aanvraag");

    const expected = renderStop({
      title: "Uitspraak", kind: "process", state: "expected", note: null,
      happenedAt: null, expectedAt: new Date("2026-09-01T00:00:00Z"),
      stage: null, trackTitle: "WSNP-aanvraag",
    });
    expect(expected.occurredAt?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(expected.body).toContain("verwacht");
  });

  it("gives neither a SEARCH_STATUSES status — they are display aids", () => {
    const r = renderStop({
      title: "x", kind: "other", state: "open", note: null, happenedAt: null,
      expectedAt: null, stage: null, trackTitle: "t",
    });
    expect(r.status).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/search/render.test.ts
```

Expected: FAIL — `renderTrack` is not exported.

- [ ] **Step 3: Widen the entity vocabulary**

In `packages/core/src/search/entity-types.ts`, replace the two names in the tuple and update the comment:

```ts
// The nine record types the knowledge base indexes. One tuple, one spelling:
// the schema's entity_type column, the trigger arguments, the router's input
// schema and the /search filter rail all read this list.
//
// `track` and `stop` replaced `milestone` and `timeline_event` in sub-project 6:
// the curated narrative became a map. entity_type is a text column, so this
// needed no migration — but the old chunks only disappear on `reindex --prune`.
export const SEARCH_ENTITY_TYPES = ["document", "entry", "email", "financial_item",
  "debt", "task", "track", "stop", "party"] as const;
```

- [ ] **Step 4: Add the renderers**

In `packages/api/src/search/render.ts`, replace `renderMilestone` and `renderTimelineEvent` with:

```ts
export function renderTrack(t: {
  title: string; status: string; note: string | null; mergesBack: boolean;
}): Rendered {
  return {
    title: t.title,
    body: lines(
      field("Spoor", t.title),
      field("Status", nlLabel(t.status)),
      // A track that ended is a clean outcome — handled and closed — and the
      // indexed text must not read as an unfinished one.
      field("Verloop", t.mergesBack
        ? "teruggekomen op de hoofdlijn (was een voorwaarde voor het einddoel)"
        : "geëindigd op zichzelf"),
      t.note?.trim() || null),
    occurredAt: null,
    status: null,
  };
}

export function renderStop(s: {
  title: string; kind: string; state: string; note: string | null;
  happenedAt: Date | null; expectedAt: Date | null; stage: string | null;
  trackTitle: string;
}): Rendered {
  const at = s.happenedAt ?? s.expectedAt;
  return {
    title: s.title,
    body: lines(
      field("Halte", s.title),
      field("Spoor", s.trackTitle),
      field("Soort", nlLabel(s.kind)),
      field("Status", s.state === "expected" ? "verwacht" : nlLabel(s.state)),
      field("Fase", s.stage ? nlLabel(s.stage) : null),
      field("Datum", day(at)),
      s.note?.trim() || null),
    occurredAt: at,
    // done/open/expected are not SEARCH_STATUSES: they stay prose in the body
    // so a status filter cannot half-match them. Same rule milestones followed.
    status: null,
  };
}
```

Add `open: "open"` and `expected: "verwacht"` to the `NL` map if they are not already there (`done` and `open` already are).

- [ ] **Step 5: Wire the loader**

In `packages/api/src/search/index-entity.ts`, replace the `milestone` and `timeline_event` cases:

```ts
    case "track": {
      const [track] = await db.select().from(schema.tracks)
        .where(eq(schema.tracks.id, entityId));
      return track
        ? renderTrack({ ...track, mergesBack: track.mergesAtStopId !== null })
        : null;
    }
    case "stop": {
      const [stop] = await db.select().from(schema.stops)
        .where(eq(schema.stops.id, entityId));
      if (!stop) return null;
      // The track's title is part of what makes a stop findable: "intake" alone
      // is ambiguous, "intake op het WSNP-aanvraag spoor" is not.
      const [track] = await db.select({ title: schema.tracks.title })
        .from(schema.tracks).where(eq(schema.tracks.id, stop.trackId));
      return renderStop({ ...stop, trackTitle: track?.title ?? "" });
    }
```

Update the import to `renderTrack, renderStop`.

- [ ] **Step 6: Teach reindex where the rows live**

In `apps/worker/src/reindex.ts`, replace the two `SOURCES` entries:

```ts
  track: { table: "tracks", sinceColumn: "created_at" },
  stop:  { table: "stops",  sinceColumn: "created_at" },
```

- [ ] **Step 7: Label them in the UI**

In `apps/web/src/components/search-kinds.ts`, replace the two entries in both records:

```ts
  track: "Spoor",
  stop: "Halte",
```
```ts
  track: "bg-teal-100 text-teal-800",
  stop: "bg-orange-100 text-orange-800",
```

- [ ] **Step 8: Run the tests**

```bash
cd packages/api && env -u NODE_ENV pnpm exec vitest run src/search
cd ../../packages/core && env -u NODE_ENV pnpm exec vitest run
cd ../../apps/worker && env -u NODE_ENV pnpm exec vitest run src/reindex.test.ts
```

Expected: all pass. Any test still naming `milestone` or `timeline_event` as an entity type is updated to the new names — that is the point of the change, not a regression.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/search/entity-types.ts packages/api/src/search apps/worker/src/reindex.ts apps/web/src/components/search-kinds.ts
git commit -m "feat(search): index sporen and haltes instead of milestones and key events"
```

---

## Task 8: The map's marks, pure and testable

**Files:**
- Create: `apps/web/src/lib/track-marks.ts`
- Test: `apps/web/src/lib/track-marks.test.ts`

**Interfaces:**
- Consumes: the `MapStop` / `MapTrack` shape from Task 3 (structurally — this module declares its own minimal input types and imports nothing from `@verder/api`, exactly as `money-columns.ts` does).
- Produces: `stopMark(stop): StopMark`, `trackTerminus(track): Terminus`, `stopHref(stopId, current): string`, `STOP_STATE_LABEL`.

**Why:** `apps/web` has no DOM testing stack and must not gain one. The established habit here is to extract the RULE into a pure module in `apps/web/src/lib` and unit-test it without React — `money-columns.ts`, `money-marks.ts`, `dashboard-money-slice.ts`. This continues it.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/track-marks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stopHref, stopMark, trackTerminus } from "@/lib/track-marks";

const stop = (over: Partial<Parameters<typeof stopMark>[0]> = {}) => ({
  state: "done" as const, isStation: false, isJunction: false,
  datesOutOfOrder: false, ...over,
});

describe("stopMark", () => {
  it("fills a stop that happened and outlines one that has not", () => {
    expect(stopMark(stop({ state: "done" })).fill).toBe("solid");
    expect(stopMark(stop({ state: "open" })).fill).toBe("hollow");
    expect(stopMark(stop({ state: "expected" })).fill).toBe("dashed");
  });

  it("never renders an expected stop as if it had happened", () => {
    // The whole reason the map is laid out structurally is that an expected
    // stop has no date. It must not look like a fact.
    const mark = stopMark(stop({ state: "expected" }));
    expect(mark.fill).not.toBe("solid");
  });

  it("draws a staged stop large and a plain one small", () => {
    expect(stopMark(stop({ isStation: true })).size).toBe("station");
    expect(stopMark(stop({ isStation: false })).size).toBe("stop");
  });

  it("rings a junction, so a branch point is visible without following the line", () => {
    expect(stopMark(stop({ isJunction: true })).ring).toBe(true);
    expect(stopMark(stop({ isJunction: false })).ring).toBe(false);
  });

  it("flags an out-of-order date instead of hiding it", () => {
    expect(stopMark(stop({ datesOutOfOrder: true })).flagged).toBe(true);
  });
});

describe("trackTerminus", () => {
  it("tells a track that rejoined apart from one that ended", () => {
    expect(trackTerminus({ mergesBack: true, status: "done", droppedMerge: false }))
      .toBe("merge");
    expect(trackTerminus({ mergesBack: false, status: "ended", droppedMerge: false }))
      .toBe("ended");
    expect(trackTerminus({ mergesBack: false, status: "open", droppedMerge: false }))
      .toBe("open");
  });

  it("renders a refused merge as ending, not as rejoining", () => {
    // buildTrackMap dropped the edge; the terminus must agree with the drawing.
    expect(trackTerminus({ mergesBack: false, status: "open", droppedMerge: true }))
      .toBe("ended");
  });
});

describe("stopHref", () => {
  it("round-trips selection: selecting a stop links to it, re-selecting clears it", () => {
    expect(stopHref("abc", null)).toBe("/timeline?stop=abc");
    expect(stopHref("abc", "other")).toBe("/timeline?stop=abc");
    expect(stopHref("abc", "abc")).toBe("/timeline");
  });

  it("encodes an id that would otherwise break the query string", () => {
    expect(stopHref("a b&c", null)).toBe("/timeline?stop=a%20b%26c");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && env -u NODE_ENV pnpm exec vitest run src/lib/track-marks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `apps/web/src/lib/track-marks.ts`:

```ts
/**
 * What the /timeline map draws, as plain decisions.
 *
 * Pure and structural (no api or component imports, no React) so the rules can
 * be unit-tested without a database and without rendering — the same habit as
 * `money-marks.ts` and `money-columns.ts`. `track-map.tsx` renders what comes
 * out of here one to one and decides nothing else.
 *
 * The four stop marks are visually distinct on purpose:
 *   solid   → it happened
 *   hollow  → it is open, and it is what is waiting on someone
 *   dashed  → it is expected: on the map before it is a fact, and it must
 *             never look like one
 *   ringed  → a junction: another track leaves from or lands on this stop
 */

export interface StopMark {
  fill: "solid" | "hollow" | "dashed";
  size: "station" | "stop";
  ring: boolean;
  /** Its date contradicts the stop before it — shown, never corrected. */
  flagged: boolean;
}

export function stopMark(stop: {
  state: "done" | "open" | "expected";
  isStation: boolean;
  isJunction: boolean;
  datesOutOfOrder: boolean;
}): StopMark {
  return {
    fill: stop.state === "done" ? "solid" : stop.state === "open" ? "hollow" : "dashed",
    size: stop.isStation ? "station" : "stop",
    ring: stop.isJunction,
    flagged: stop.datesOutOfOrder,
  };
}

export type Terminus = "merge" | "ended" | "open";

/**
 * How a track finishes. `ended` is a CLEAN outcome — the eviction warning was
 * handled and closed — and is drawn as a cap, not as a loose end.
 *
 * A merge the map refused (because it pointed backwards) renders as ending: the
 * terminus must agree with the line that was actually drawn.
 */
export function trackTerminus(track: {
  mergesBack: boolean; status: string; droppedMerge: boolean;
}): Terminus {
  if (track.mergesBack && !track.droppedMerge) return "merge";
  if (track.droppedMerge || track.status === "ended" || track.status === "done") return "ended";
  return "open";
}

export const STOP_STATE_LABEL: Record<string, string> = {
  done: "gebeurd", open: "loopt nog", expected: "verwacht",
};

/**
 * Selection lives in the URL so a view is linkable and survives a reload — the
 * same rule `?cat=` follows on /money. Clicking the selected stop clears it,
 * so the way out is the control that got you in.
 */
export function stopHref(stopId: string, currentSelection: string | null): string {
  return currentSelection === stopId
    ? "/timeline"
    : `/timeline?stop=${encodeURIComponent(stopId)}`;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && env -u NODE_ENV pnpm exec vitest run src/lib/track-marks.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/track-marks.ts apps/web/src/lib/track-marks.test.ts
git commit -m "feat(web): the map's marks, decided in a module a test can reach"
```

---

## Task 9: The map, in SVG

**Files:**
- Create: `apps/web/src/components/track-map.tsx`

**Interfaces:**
- Consumes: `stopMark`, `trackTerminus`, `stopHref` (Task 8); the `tracks.map` output type (Task 5) via `inferRouterOutputs`.
- Produces: `<TrackMap map={...} selected={...} />`. Task 10 renders it.

Inline SVG, no chart library: the web app has no runtime dependency beyond Next and React, and `money-chart.tsx` already holds that line. Read it first — the geometry-in-a-const, `role="img"` + `aria-label`, and `<title>` per mark conventions all come from there.

- [ ] **Step 1: Write the component**

```tsx
"use client";

import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@verder/api";
import { stopHref, stopMark, trackTerminus } from "@/lib/track-marks";

/**
 * The case as a metro map. This file DRAWS; it does not decide. Which stop gets
 * which mark is `@/lib/track-marks`, and where every stop sits is
 * `buildTrackMap` in the api package — both unit-tested without React.
 *
 * Position is a layering, never a time axis: an expected stop has no date, and
 * a time axis would mean inventing one. Dates are labels here, not geometry.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MapPayload = RouterOutputs["tracks"]["map"]["map"];

// Pixels, not facts.
const COL_W = 116;
const LANE_H = 64;
const PAD_X = 150;   // room for the track title at the left of its lane
const PAD_Y = 40;
const R_STOP = 7;
const R_STATION = 11;

const INK = "#52514e";
const MUTED = "#898781";
const RAIL = "#c3c2b7";
const CURRENT = "#0ca30c";
const FLAG = "#e34948";

export function TrackMap({
  map, selected,
}: {
  map: MapPayload;
  selected: string | null;
}) {
  if (map.stops.length === 0 && map.tracks.length === 0) return null;

  const x = (column: number) => PAD_X + column * COL_W;
  const y = (lane: number) => PAD_Y + lane * LANE_H;
  const width = PAD_X + Math.max(1, map.columnCount) * COL_W;
  const height = PAD_Y + Math.max(1, map.laneCount) * LANE_H + 30;

  const byId = new Map(map.stops.map((s) => [s.id, s]));

  return (
    <div className="overflow-x-auto rounded border bg-white p-4">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="De zaak als metrokaart: de hoofdlijn naar het einde van de bewindvoering, met zijsporen"
      >
        {/* One rail per track, with its name at the left of its own lane. */}
        {map.tracks.map((t) => {
          const from = x(t.firstColumn);
          const to = x(t.lastColumn);
          const lane = y(t.lane);
          const terminus = trackTerminus(t);
          return (
            <g key={t.id}>
              <line
                x1={from} x2={Math.max(to, from + 8)} y1={lane} y2={lane}
                stroke={t.lane === 0 ? INK : RAIL}
                strokeWidth={t.lane === 0 ? 3 : 2}
              />
              <text
                x={PAD_X - 12} y={lane + 4} textAnchor="end"
                fontSize="11" fill={t.lane === 0 ? INK : MUTED}
              >
                {t.title}
              </text>
              {/* A track that ended is a CLEAN outcome — handled and closed —
                  so it gets a cap, not a frayed end. */}
              {terminus === "ended" && (
                <line
                  x1={Math.max(to, from + 8) + 6} x2={Math.max(to, from + 8) + 6}
                  y1={lane - 7} y2={lane + 7} stroke={MUTED} strokeWidth="2"
                />
              )}
            </g>
          );
        })}

        {/* Branches and merges: a curve between two lanes. */}
        {map.edges.filter((e) => e.kind !== "track").map((e) => {
          const from = byId.get(e.fromStopId);
          const to = byId.get(e.toStopId);
          if (!from || !to) return null;
          const x1 = x(from.column); const y1 = y(from.lane);
          const x2 = x(to.column); const y2 = y(to.lane);
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${e.kind}-${e.fromStopId}-${e.toStopId}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none" stroke={RAIL} strokeWidth="2"
            />
          );
        })}

        {map.stops.map((s) => {
          const mark = stopMark(s);
          const cx = x(s.column);
          const cy = y(s.lane);
          const r = mark.size === "station" ? R_STATION : R_STOP;
          const isCurrent = s.id === map.currentStopId;
          const isSelected = s.id === selected;
          return (
            <Link key={s.id} href={stopHref(s.id, selected)}>
              <g>
                {isSelected && (
                  <circle cx={cx} cy={cy} r={r + 7} fill="#0b0b0b" opacity="0.06" />
                )}
                {/* What is waiting on Martin right now, marked so he does not
                    have to hunt for it. */}
                {isCurrent && (
                  <circle cx={cx} cy={cy} r={r + 4} fill="none"
                    stroke={CURRENT} strokeWidth="2" />
                )}
                {mark.ring && (
                  <circle cx={cx} cy={cy} r={r + 2} fill="none"
                    stroke={MUTED} strokeWidth="1" />
                )}
                <circle
                  cx={cx} cy={cy} r={r}
                  fill={mark.fill === "solid" ? INK : "#ffffff"}
                  stroke={INK}
                  strokeWidth="2"
                  strokeDasharray={mark.fill === "dashed" ? "3 2" : undefined}
                />
                {mark.flagged && (
                  <text x={cx + r + 3} y={cy - r} fontSize="12" fill={FLAG}>!</text>
                )}
                <text
                  x={cx} y={cy + r + 14} textAnchor="middle" fontSize="10"
                  fill={isSelected ? "#0b0b0b" : MUTED}
                >
                  {s.title.length > 16 ? `${s.title.slice(0, 15)}…` : s.title}
                </text>
                <title>
                  {`${s.title}${s.happenedAt
                    ? ` — ${new Date(s.happenedAt).toLocaleDateString("nl-NL")}`
                    : " — verwacht"}`}
                </title>
              </g>
            </Link>
          );
        })}
      </svg>

      <p className="mt-3 text-xs text-slate-500">
        Gevuld = gebeurd · open = loopt nog · gestippeld = verwacht · omcirkeld =
        vertrek- of aankomstpunt van een zijspoor ·{" "}
        <span style={{ color: CURRENT }}>groene ring</span> = waar het nu op wacht.
        De kaart staat niet op schaal: een verwachte halte heeft nog geen datum.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && env -u NODE_ENV pnpm exec tsc --noEmit
```

Expected: errors only in `app/(app)/timeline/page.tsx`, which Task 10 rewrites. `track-map.tsx` itself must be clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/track-map.tsx
git commit -m "feat(web): draw the case as a metro map"
```

---

## Task 10: `/timeline` becomes the map

**Files:**
- Modify: `apps/web/src/app/(app)/timeline/page.tsx` (rewrite)
- Delete: `apps/web/src/components/timeline-editor.tsx`

**Interfaces:**
- Consumes: `tracks.map` (Task 5), `<TrackMap>` (Task 9), `STOP_STATE_LABEL` (Task 8).

- [ ] **Step 1: Rewrite the page**

```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TrackMap } from "@/components/track-map";
import { STOP_STATE_LABEL } from "@/lib/track-marks";
import { AddTrackForm, TrackEditor } from "@/components/track-editor";
import { AddStopForm, StopEditor } from "@/components/stop-editor";

/**
 * De zaak als metrokaart. The main line runs to Einde bewindvoering; a side
 * track branches off when something arrives, runs its stops, and either merges
 * back (it was a prerequisite) or ends.
 *
 * Everything here is derived on read from tracks + stops and the evidence they
 * point at. Nothing on this page writes evidence or appends a ledger event: a
 * stop points, it never asserts.
 */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ stop?: string }>;
}) {
  const { stop } = await searchParams;
  const caller = await serverCaller();
  const { map, evidence } = await caller.tracks.map();

  const selected = stop && map.stops.some((s) => s.id === stop) ? stop : null;
  const current = map.stops.find((s) => s.id === map.currentStopId) ?? null;
  const shown = map.stops.find((s) => s.id === selected) ?? current;
  const shownTrack = shown ? map.tracks.find((t) => t.id === shown.trackId) : null;
  const shownEvidence = shown ? evidence[shown.id] : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">De zaak</h1>
        <p className="mt-1 text-slate-600">
          De hoofdlijn loopt naar het einde van de bewindvoering. Een zijspoor
          begint zodra er iets binnenkomt — een mail, een telefoontje, een brief —
          en komt daarna terug op de hoofdlijn of eindigt op zichzelf.
        </p>
      </div>

      {/* What is waiting on Martin, said before the map rather than hidden in
          it. This is the question the page is opened to answer. */}
      {current && (
        <div className="rounded border-l-4 border-l-green-600 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Waar het nu op wacht
          </p>
          <p className="mt-1 font-medium">{current.title}</p>
          <p className="text-sm text-slate-600">
            {map.tracks.find((t) => t.id === current.trackId)?.title}
          </p>
        </div>
      )}

      <TrackMap map={map} selected={selected} />

      {shown && (
        <section className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-semibold">{shown.title}</h2>
            <span className="text-sm text-slate-500">
              {shownTrack?.title} · {STOP_STATE_LABEL[shown.state] ?? shown.state}
              {shown.happenedAt
                ? ` · ${new Date(shown.happenedAt).toLocaleDateString("nl-NL")}`
                : shown.expectedAt
                  ? ` · verwacht ${new Date(shown.expectedAt).toLocaleDateString("nl-NL")}`
                  : ""}
            </span>
            {selected && (
              <Link href="/timeline" className="ml-auto text-sm text-slate-500 hover:underline">
                sluiten
              </Link>
            )}
          </div>
          {shown.note && <p className="mt-2 text-sm text-slate-600">{shown.note}</p>}

          {shown.datesOutOfOrder && (
            <p className="mt-2 text-sm text-red-700">
              De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de
              volgorde zoals hij is ingevoerd — meestal betekent dit dat deze halte
              op een ander spoor thuishoort.
            </p>
          )}

          {/* The third level: the entry, the task, the mail and its files.
              Derived on read, so it cannot go stale — and REAL links, so this
              is reachable with a keyboard, the lesson /money's month labels
              already learned. */}
          <div className="mt-3 space-y-2 text-sm">
            {shownEvidence?.entry && (
              <Link className="block text-slate-600 hover:underline"
                href={`/logbook/${shownEvidence.entry.id}`}>
                → logboek: {shownEvidence.entry.summary}
              </Link>
            )}
            {shownEvidence?.task && (
              <Link className="block text-slate-600 hover:underline"
                href={`/tasks/${shownEvidence.task.id}`}>
                → taak: {shownEvidence.task.title} ({shownEvidence.task.status})
              </Link>
            )}
            {shownEvidence?.email && (
              <p className="text-slate-600">
                → e-mail: {shownEvidence.email.subject}{" "}
                <span className="text-xs text-slate-400">
                  van {shownEvidence.email.fromAddr}
                </span>
              </p>
            )}
            {shownEvidence?.documents.map((d) => (
              <Link key={d.id} className="block text-slate-600 hover:underline"
                href={`/vault/${d.id}`}>
                → bestand: {d.title}
              </Link>
            ))}
            {shownEvidence &&
              !shownEvidence.entry && !shownEvidence.task &&
              !shownEvidence.email && shownEvidence.documents.length === 0 && (
              <p className="text-slate-500">
                Verwacht — nog niets achter deze halte. Zodra er een mail, een taak
                of een document aan hangt staat het hier.
              </p>
            )}
          </div>

          <div className="mt-3"><StopEditor stop={shown} /></div>
        </section>
      )}

      {map.problems.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Wat de kaart niet kon tekenen</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {map.problems.map((p, n) => <li key={n}>{p.detail}</li>)}
          </ul>
        </section>
      )}

      <section className="rounded border bg-white p-4">
        <h2 className="font-semibold">Sporen</h2>
        <ul className="mt-2 space-y-2">
          {map.tracks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-medium">{t.title}</span>
              <span className="text-slate-500">
                {t.parentTrackId === null
                  ? "hoofdlijn"
                  : t.mergesBack
                    ? "komt terug op de hoofdlijn"
                    : "eindigt op zichzelf"}
              </span>
              <span className="ml-auto flex gap-2">
                <AddStopForm trackId={t.id} />
                <TrackEditor track={t} stops={map.stops} />
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3"><AddTrackForm stops={map.stops} /></div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Remove the old editor and rename the nav label**

```bash
git rm apps/web/src/components/timeline-editor.tsx
```

In `apps/web/src/app/(app)/layout.tsx`, the nav item pointing at `/timeline` is relabelled from `Timeline` to `De zaak`.

- [ ] **Step 3: Build and check**

```bash
cd apps/web && env -u NODE_ENV pnpm exec tsc --noEmit
env -u NODE_ENV pnpm build
```

Expected: clean once Task 11's editors exist. Do Task 11 before running the build if the imports do not resolve yet.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/timeline/page.tsx" "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): /timeline is the map, and it opens on what is waiting"
```

---

## Task 11: Authoring — tracks and stops

**Files:**
- Create: `apps/web/src/components/track-editor.tsx`
- Create: `apps/web/src/components/stop-editor.tsx`

**Interfaces:**
- Consumes: `trpc.tracks.createTrack / updateTrack / createStop / updateStop` (Task 5).
- Produces: `<AddTrackForm stops>`, `<TrackEditor track stops>`, `<AddStopForm trackId>`, `<StopEditor stop>` — the four Task 10 imports.

Follow `milestone-editor.tsx` exactly: `"use client"`, `useState` for the form, `trpc.<x>.useMutation({ onSuccess: () => router.refresh() })`, and the `toDateInput` / `fromDateInput` helpers. Do not invent a second editing idiom.

- [ ] **Step 1: Write `track-editor.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

/**
 * Create and edit a spoor. Tracks are an editable display aid (NOT ledgered) —
 * the evidence stays in the logbook and the vault — so editing here is as
 * low-ceremony as fixing a typo, exactly like the milestone editor.
 */

type StopOption = { id: string; title: string; trackId: string };
type TrackData = {
  id: string; title: string; status: string;
  parentTrackId: string | null; branchesAtStopId: string | null;
  mergesAtStopId: string | null; note: string | null;
};

const STATUSES = [
  { value: "open", label: "loopt nog" },
  { value: "done", label: "afgerond" },
  // "ended" is a clean outcome: handled and closed, never rejoined.
  { value: "ended", label: "geëindigd (komt niet terug op de hoofdlijn)" },
];

export function AddTrackForm({ stops }: { stops: StopOption[] }) {
  const router = useRouter();
  const create = trpc.tracks.createTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", branchesAtStopId: "", note: "" });

  if (!open) {
    return (
      <button className="text-sm text-blue-600 hover:underline" onClick={() => setOpen(true)}>
        + nieuw zijspoor
      </button>
    );
  }
  const branchStop = stops.find((s) => s.id === form.branchesAtStopId);
  return (
    <div className="space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        placeholder="Waar gaat dit spoor over? (bijv. Ontruiming)"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <label className="block text-xs text-slate-600">
        Vertrekt bij welke halte?
        <select
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          value={form.branchesAtStopId}
          onChange={(e) => setForm({ ...form, branchesAtStopId: e.target.value })}
        >
          <option value="">— kies een halte —</option>
          {stops.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        placeholder="Notitie (optioneel)"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || !branchStop || create.isPending}
          onClick={() => create.mutate({
            title: form.title.trim(),
            parentTrackId: branchStop!.trackId,
            branchesAtStopId: branchStop!.id,
            note: form.note.trim() || null,
          })}
        >
          Aanmaken
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {create.error && <p className="text-sm text-red-700">{create.error.message}</p>}
    </div>
  );
}

export function TrackEditor({ track, stops }: { track: TrackData; stops: StopOption[] }) {
  const router = useRouter();
  const update = trpc.tracks.updateTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: track.title,
    status: track.status,
    mergesAtStopId: track.mergesAtStopId ?? "",
    note: track.note ?? "",
  });

  if (!open) {
    return (
      <button className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(true)}>
        bewerken
      </button>
    );
  }
  // Only stops on the PARENT track can be a merge point: a spoor rejoins the
  // line it left, never a third one.
  const mergeOptions = stops.filter((s) => s.trackId === track.parentTrackId);
  return (
    <div className="mt-2 w-full space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <label className="block text-xs text-slate-600">
        Status
        <select
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
        >
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      {track.parentTrackId && (
        <label className="block text-xs text-slate-600">
          Komt terug op de hoofdlijn bij
          <select
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            value={form.mergesAtStopId}
            onChange={(e) => setForm({ ...form, mergesAtStopId: e.target.value })}
          >
            <option value="">— komt niet terug, dit spoor eindigt —</option>
            {mergeOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      )}
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || update.isPending}
          onClick={() => update.mutate({
            id: track.id,
            title: form.title.trim(),
            status: form.status as "open" | "done" | "ended",
            mergesAtStopId: form.mergesAtStopId || null,
            note: form.note.trim() || null,
          })}
        >
          Opslaan
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Write `stop-editor.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

/**
 * Create and edit a halte.
 *
 * A stop may exist before anything in the ledger corresponds to it — that is
 * the point of `verwacht`. What it must never do is copy a fact: the title and
 * the note are Martin's words, and everything else is read live from whatever
 * the stop links to.
 */

type StopData = {
  id: string; title: string; kind: string; state: string;
  happenedAt: Date | string | null; expectedAt: Date | string | null;
  note: string | null;
};

const STATES = [
  { value: "done", label: "gebeurd" },
  { value: "open", label: "loopt nog" },
  { value: "expected", label: "verwacht" },
];

const KINDS = [
  { value: "process", label: "proces" }, { value: "mail", label: "post/mail" },
  { value: "call", label: "telefoon" }, { value: "meeting", label: "gesprek" },
  { value: "document", label: "document" }, { value: "other", label: "overig" },
];

const toDateInput = (d: Date | string | null): string =>
  d ? new Date(d).toISOString().slice(0, 10) : "";
const fromDateInput = (v: string): Date | null => (v ? new Date(v) : null);

export function AddStopForm({ trackId }: { trackId: string }) {
  const router = useRouter();
  const create = trpc.tracks.createStop.useMutation({
    onSuccess: () => { setOpen(false); setTitle(""); router.refresh(); },
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState("done");

  if (!open) {
    return (
      <button className="text-xs text-blue-600 hover:underline" onClick={() => setOpen(true)}>
        + halte
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        className="rounded border px-2 py-1 text-sm"
        placeholder="Wat gebeurde er?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <select
        className="rounded border px-2 py-1 text-sm"
        value={state}
        onChange={(e) => setState(e.target.value)}
      >
        {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <button
        className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
        disabled={!title.trim() || create.isPending}
        onClick={() => create.mutate({
          trackId, title: title.trim(),
          state: state as "done" | "open" | "expected",
        })}
      >
        Toevoegen
      </button>
      <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
        annuleren
      </button>
    </span>
  );
}

export function StopEditor({ stop }: { stop: StopData }) {
  const router = useRouter();
  const update = trpc.tracks.updateStop.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: stop.title, kind: stop.kind, state: stop.state,
    happenedAt: toDateInput(stop.happenedAt),
    expectedAt: toDateInput(stop.expectedAt),
    note: stop.note ?? "",
  });

  if (!open) {
    return (
      <button className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(true)}>
        halte bewerken
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <div className="flex flex-wrap gap-2">
        <select
          className="rounded border px-2 py-1 text-sm"
          value={form.state}
          onChange={(e) => setForm({ ...form, state: e.target.value })}
        >
          {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value })}
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <label className="text-xs text-slate-600">
          gebeurd op
          <input type="date" className="ml-1 rounded border px-2 py-1 text-sm"
            value={form.happenedAt}
            onChange={(e) => setForm({ ...form, happenedAt: e.target.value })} />
        </label>
        <label className="text-xs text-slate-600">
          verwacht op
          <input type="date" className="ml-1 rounded border px-2 py-1 text-sm"
            value={form.expectedAt}
            onChange={(e) => setForm({ ...form, expectedAt: e.target.value })} />
        </label>
      </div>
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || update.isPending}
          onClick={() => update.mutate({
            id: stop.id, title: form.title.trim(),
            kind: form.kind as "process" | "mail" | "call" | "meeting" | "document" | "other",
            state: form.state as "done" | "open" | "expected",
            happenedAt: fromDateInput(form.happenedAt),
            expectedAt: fromDateInput(form.expectedAt),
            note: form.note.trim() || null,
          })}
        >
          Opslaan
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd apps/web && env -u NODE_ENV pnpm exec tsc --noEmit && env -u NODE_ENV pnpm build
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/track-editor.tsx apps/web/src/components/stop-editor.tsx
git commit -m "feat(web): build a spoor and its haltes without leaving the map"
```

---

## Task 12: The dashboard says where you are

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`
- Modify: `apps/web/src/components/wsnp-timeline.tsx` (only if it names `milestones` in a way that no longer holds)

**Interfaces:**
- Consumes: `tracks.map` (Task 5), `milestones.timeline` (Task 6, shape unchanged).

- [ ] **Step 1: Add the "where you are now" block**

Read `apps/web/src/app/(app)/dashboard/page.tsx` first. Keep the existing WSNP strip exactly as it is — Task 6 kept its shape — and add above it:

```tsx
      {/* Where the case stands, in one line per open spoor. The dashboard shows
          LESS than /timeline on purpose: no map, no evidence, no problems — it
          points at the page that has them. */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-semibold">Waar de zaak staat</h2>
          <Link className="text-sm text-slate-500 hover:underline" href="/timeline">
            de hele kaart →
          </Link>
        </div>
        {openTracks.length === 0 ? (
          <p className="text-sm text-slate-500">
            Geen lopende sporen — alles wat begonnen is, is afgerond.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {openTracks.map(({ track, stop }) => (
              <li key={track.id} className="flex flex-wrap gap-x-2 rounded border bg-white p-3">
                <span className="font-medium">{track.title}</span>
                <span className="text-slate-600">
                  {stop ? stop.title : "nog geen halte"}
                </span>
                {stop?.id === map.currentStopId && (
                  <span className="ml-auto text-xs font-medium text-green-700">
                    wacht op jou
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
```

with, above the return:

```tsx
  const { map } = await caller.tracks.map();
  // One line per open spoor: its furthest stop that is not done yet, or its
  // last stop if everything on it is done.
  const openTracks = map.tracks
    .filter((t) => t.status === "open" && t.parentTrackId !== null)
    .map((t) => {
      const own = map.stops.filter((s) => s.trackId === t.id)
        .sort((a, b) => a.column - b.column);
      return { track: t, stop: own.find((s) => s.state !== "done") ?? own[own.length - 1] };
    });
```

- [ ] **Step 2: Build and check**

```bash
cd apps/web && env -u NODE_ENV pnpm exec tsc --noEmit && env -u NODE_ENV pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): the dashboard answers where the case stands"
```

---

## Task 13: Whole-suite green, docs, deploy, and the real map

**Files:**
- Modify: `CLAUDE.md`, `docs/deploy.md`

- [ ] **Step 1: The whole repo, green**

```bash
cd /Users/martin/Workspace/mp/verder
env -u NODE_ENV pnpm -r test
env -u NODE_ENV pnpm -r typecheck
```

Expected: every package passes. Any suite still asserting on `timeline.list`, `renderMilestone` or the `milestone`/`timeline_event` entity types is updated to the new names — those renames are the change, not a regression. **Do not delete a test to make the suite green.**

- [ ] **Step 2: Document it in `CLAUDE.md`**

Add to the deployment paragraph, in its existing dense style, covering: sub-project 6 and migration 0023; that `tracks`/`stops` replaced `timeline_events`/`milestones` as the narrative layer while **both old tables remain in place, unread**; that the map is laid out by longest-path layering and **never by date**, because an expected stop has no date; that a merge which points backwards is dropped and reported rather than drawn as a loop; that exactly one root track is enforced by a unique index on a constant expression; that `search_chunks.entity_type` is text so the two new entity kinds needed no migration **but `reindex --prune` is required or the old `milestone`/`timeline_event` chunks linger**; and that the 18-month countdown still runs through the unchanged `deriveTimeline`, only re-pointed at the WSNP track's stops.

- [ ] **Step 3: Add the deploy sequence to `docs/deploy.md`**

Under "Upgrading an existing deployment", the same shape the 0020/0021 entries use:

```bash
# 1. migration FIRST, from the homelab HOST — /timeline 500s on an unknown table otherwise
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
# 2. rsync the tree, rebuild web + worker
# 3. drop the retired chunk types and index the new ones
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker reindex --prune'
# 4. verify, and report the real numbers
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```

- [ ] **Step 4: Commit and push**

```bash
git add CLAUDE.md docs/deploy.md
git commit -m "docs: the case map, and the order it has to be deployed in"
git push origin main
```

- [ ] **Step 5: Deploy** (the human does this, not a subagent)

Run steps 1–4 of the deploy sequence above. `nightly-verify` must stay OK: this sub-project appends no ledger events, so **the event count must not change at all** — if it moves, something wrote evidence that should not have.

- [ ] **Step 6: Build the real map by hand — the acceptance test**

On the deployed app, create Martin's three real tracks through the editors. This is deliberately by hand: it is the only test of whether the editor is usable, and a seed would have hidden that.

1. **WSNP-aanvraag** — branches at the main line's start, **merges back** at the goal. Stops: *Uitnodiging intake (Demi Willemse)* → *Intake Gemeentehuis Almere* → *Zaak aangenomen* → *Documenten opgevraagd* → *Ingediend bij rechtbank* → *Aanvullende toelichting gevraagd* → *Rechtbank akkoord*.
2. **Ontruiming** — branches wherever the eviction warning arrived, **does not merge**, status `ended`. Its stops are the handled tasks.
3. **Team Opstart** — branches at onboarding, **open**. Stops: *Documenten opgevraagd per mail* (done) → *Documenten geleverd* (done) → *Formaat bankafschriften uitgezocht* (done) → *Aanvullende documenten voor bijzondere bijstand* (**open**).

Then confirm on `/timeline`:
- the "waar het nu op wacht" block names the **bijzondere bijstand** stop,
- the WSNP-aanvraag rail visibly leaves the main line and comes back to it,
- Ontruiming ends in a cap and never rejoins,
- selecting a stop with a linked mail shows that mail and its attachments,
- `map.problems` is empty.

Fill in the dates only where Martin knows them. A stop with no date is `verwacht` and that is a true statement; a guessed date is not.

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: data model and the two enforced constraints → 1; layering, backwards merges, ancestry cycles → 2; lanes, stations, current stop, out-of-order dates → 3; the derived third level → 4; router and cycle refusal at write time → 5; milestones-as-a-track and the unchanged countdown → 6; search → 7; marks → 8; the map → 9; the screen, selection-in-URL, empty evidence, problems → 10; authoring → 11; dashboard → 12; docs, deploy ordering, reindex and the hand-built acceptance → 13. The spec's "out of scope" list is respected: no agent proposals, no procedure library, no table drops, no design system.

**Type consistency.** `TrackRow`, `StopRow`, `MapStop`, `MapTrack`, `MapEdge`, `MapProblem`, `TrackMap` are defined once in Task 2 and referenced unchanged afterwards. `buildTrackMap`, `resolveStopEvidence`, `StopEvidence`, `stopMark`, `trackTerminus`, `stopHref`, `STOP_STATE_LABEL` keep the same names in their defining task, in the router, and in the components. `tracks.map` returns `{ map, evidence }` in Task 5 and is destructured that way in Tasks 10 and 12.

**Two risks flagged rather than hidden.**

1. **`finishMap` is written twice** — a stub in Task 2, replaced wholesale in Task 3. That is deliberate (Task 2's tests must run) and Task 3 says "replace the whole stub". An executor who *merges* the two instead of replacing will end up with lanes that are always 0.
2. **`drizzle-kit generate` then hand-editing the SQL** keeps the snapshot in step with the TS schema, but the snapshot will not know about the check constraint, the single-root index, the grants or the triggers. That is already true of migrations 0011, 0013 and 0017, so a future `generate` behaves no worse than it does today — but if a later migration ever drops the single-root index unprompted, this is why.
