# Vertical Case Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redraw `/timeline` as a vertical, reverse-chronological map of Martin's case — newest at the top, month bands down the page, one full-width label column, and no expected future stops.

**Architecture:** `buildTrackMap` stops laying stops out by longest path over a DAG and starts ordering them by date. Every stop is `done` or `open` after migration 0026, so a time axis is honest for the first time. The pure module emits rows, lanes and month bands; the SVG component turns those into pixels and decides nothing. The WSNP strip and `/milestones`, which draw only future stages, are retired.

**Tech Stack:** TypeScript, Next 15 App Router, tRPC, Drizzle + Postgres 17, vitest, inline SVG (no chart library).

**Spec:** `docs/superpowers/specs/2026-08-29-case-timeline-vertical-design.md`

## Global Constraints

- Run every build and test with `env -u NODE_ENV` — the shell exports `NODE_ENV=development`, which breaks `next build`.
- Dev database: `docker compose up -d postgres`. Dev login `martin@vanderpoel.pro` / `devpass`.
- Branch: `feat/vertical-case-timeline` (already created, already holds the spec commit).
- Evidence tables stay append-only. **Nothing in this plan appends a `ledger_events` row, and nothing may.** Tracks and stops are a display aid, not evidence.
- `stops` and `tracks` keep `SELECT, INSERT, UPDATE` and no DELETE for `verder_app` and `verder_worker`. Only migration 0026, running as the `verder` admin role, removes rows.
- All user-facing copy is Dutch, lowercase-first in labels, and reports rather than judges.
- Purity rule: `packages/api/src/track-map.ts` and `apps/web/src/lib/track-marks.ts` import nothing from `@verder/db`, no React, no I/O. They are unit-tested without a database.
- Totality rule: `buildTrackMap` renders any input. A corrupt map is reported through `problems` and still draws what it can.

---

### Task 1: Retire the WSNP strip and /milestones

All six WSNP stages are future by definition — the WSNP has not been applied for — so the strip draws six empty stages and a countdown with no clock. The `milestones` table holds **0 rows in production** (measured 2026-08-29), so nothing is lost. Doing this first shrinks the surface every later task has to touch.

**Files:**
- Delete: `apps/web/src/components/wsnp-timeline.tsx`
- Delete: `apps/web/src/components/milestone-editor.tsx`
- Delete: `apps/web/src/app/(app)/milestones/page.tsx` (and the now-empty directory)
- Delete: `packages/api/src/routers/milestones.ts`, `packages/api/src/routers/milestones.test.ts`
- Delete: `packages/api/src/wsnp-timeline.ts`, `packages/api/src/wsnp-timeline.test.ts`
- Modify: `packages/api/src/root.ts` — drop the `milestonesRouter` import and its mount
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx:6,14,74` — drop the import, the `caller.milestones.timeline()` call, and the `<WsnpTimeline …/>` element
- Modify: `apps/web/src/components/retrieved-refs.tsx:17` — drop the `milestone` → `/milestones` branch
- Check: `apps/web/src/app/(app)/layout.tsx` and any nav component for a `/milestones` link

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `packages/api/src/routers/tracks.ts:20` declares its **own** local `WSNP_STAGES` constant, so deleting `wsnp-timeline.ts` does not break stop validation. Verify that line still reads `const WSNP_STAGES = ["application", …]` after the deletions.

- [ ] **Step 1: Delete the files**

```bash
git rm apps/web/src/components/wsnp-timeline.tsx \
       apps/web/src/components/milestone-editor.tsx \
       apps/web/src/app/\(app\)/milestones/page.tsx \
       packages/api/src/routers/milestones.ts \
       packages/api/src/routers/milestones.test.ts \
       packages/api/src/wsnp-timeline.ts \
       packages/api/src/wsnp-timeline.test.ts
```

- [ ] **Step 2: Unmount the router**

In `packages/api/src/root.ts`, remove the line `import { milestonesRouter } from "./routers/milestones";` and the line `milestones: milestonesRouter,` from the `appRouter` object. Leave every other router mounted.

- [ ] **Step 3: Clean the dashboard**

In `apps/web/src/app/(app)/dashboard/page.tsx`, remove:
- line 6: `import { WsnpTimeline } from "@/components/wsnp-timeline";`
- line 14: `const timeline = await caller.milestones.timeline();`
- line 74: `<WsnpTimeline stages={timeline.stages} countdown={timeline.countdown} />`

Leave the "Waar de zaak staat" section alone — it already reads `tracks.map()` and stays. Task 5 changes its sort.

- [ ] **Step 4: Clean the search-hit router**

In `apps/web/src/components/retrieved-refs.tsx`, delete the line
`if (entityType === "milestone") return "/milestones";`. A `milestone` chunk cannot exist — migration 0023 deleted them and removed the kind from `SEARCH_ENTITY_TYPES` — so this branch is unreachable and its target is about to 404.

- [ ] **Step 5: Find any straggler**

Run: `grep -rn "milestone\|wsnp-timeline\|WsnpTimeline" apps/web/src packages/api/src apps/worker/src`
Expected: only `packages/api/src/routers/tracks.ts` (its own `WSNP_STAGES` constant and the `stage` field) and `packages/db/src/schema.ts` (the `milestones` table and `wsnpStageEnum`, both removed in Task 2). Fix anything else you find.

- [ ] **Step 6: Typecheck and test**

Run: `env -u NODE_ENV pnpm -r typecheck && env -u NODE_ENV pnpm --filter @verder/api test`
Expected: PASS. No file should still reference `milestonesRouter`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: retire the WSNP strip and /milestones

All six stages are future by definition and the milestones table holds
zero rows in production, so the strip drew six empty stages and a
countdown with no clock. The vertical timeline shows history and the
current situation only; this is the same decision one screen over."
```

---

### Task 2: Migration 0026 — the data the new map draws

Deletes 15 stops and 3 tracks as the `verder` admin role, moves 15 stops onto the spine, and rewrites the two seeds so they cannot put any of it back. **The seeds are the trap:** `ensureCaseMap` and `case-history.ts` are idempotent-by-title, so if they are not rewritten in this same commit, the next run of either silently re-inserts every stop the migration deletes.

**Files:**
- Create: `packages/db/drizzle/0026_vertical_case_timeline.sql`
- Modify: `packages/db/src/schema.ts` — drop the `milestones` table declaration (~line 257)
- Modify: `packages/db/src/seed-case-map.ts` — new spine, no goal, no Start, no WSNP
- Modify: `apps/worker/src/ops/case-history.ts` — `SPINE_SEED`, `TRACK_SEED`, `SPINE_ANCHORS`
- Test: `apps/worker/src/ops/case-history.test.ts`, `packages/db/src/tracks-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a database in which every stop is `done` or `open`; the root track is titled `Bewindvoering` and carries 15 stops at `order_index` 100…1500; six sporen remain, each with `branches_at_stop_id = NULL`.

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0026_vertical_case_timeline.sql`. The statement order is not cosmetic — `branches_at_stop_id` and `merges_at_stop_id` are foreign keys into `stops`, so they must be nulled **before** the deletes or Postgres refuses them.

```sql
-- The case map goes vertical: newest at the top, oldest at the bottom, history
-- and the current situation only.
--
-- This is the ONLY migration in this project that deletes a row from `stops` or
-- `tracks`. It runs as the `verder` admin role. The app and worker grants are
-- unchanged: they keep SELECT, INSERT, UPDATE and no DELETE, and restructuring
-- through those roles stays rename-and-move forever.
--
-- Nothing here is evidence. No ledger event is appended, and `nightly-verify`
-- must report the chain head UNCHANGED after this runs.

-- 1. Pointers first: these are FKs into `stops`, and the deletes below fail
--    while any of them still points at a row that is about to go.
UPDATE tracks SET branches_at_stop_id = NULL, merges_at_stop_id = NULL
 WHERE parent_track_id IS NOT NULL;

-- Deliberately NOT rewired to a nearest preceding spine stop. Branch geometry
-- is date-driven now, so the pointer is semantic only: it means "this spoor
-- came out of THAT event". Guessing one would be the app inventing a fact about
-- Martin's case. NULL says "no recorded origin", which is true, and the editor
-- lets him set one when he knows.

-- 2. The spine absorbs the bewindvoering story. Both tracks' stops move onto
--    the root and are renumbered in date order, gaps of 100 so the editor can
--    insert without a renumber.
DO $$
DECLARE
  root_id uuid;
  s record;
  ix int := 100;
BEGIN
  SELECT id INTO root_id FROM tracks WHERE parent_track_id IS NULL;
  IF root_id IS NULL THEN
    RAISE NOTICE '0026: no root track, skipping — run pnpm --filter @verder/db seed-map';
    RETURN;
  END IF;

  FOR s IN
    SELECT st.id FROM stops st JOIN tracks t ON t.id = st.track_id
     WHERE t.title IN ('Aanvraag bewindvoering', 'Opstart en stukken')
       AND st.state <> 'expected'
     ORDER BY st.happened_at NULLS LAST, st.order_index
  LOOP
    UPDATE stops SET track_id = root_id, order_index = ix WHERE id = s.id;
    ix := ix + 100;
  END LOOP;
END $$;

-- 3. Remember what is about to go, so the search index can be cleaned by id.
CREATE TEMP TABLE gone_stops AS
  SELECT id FROM stops
   WHERE state = 'expected'
      OR (title IN ('Start', 'Aanvraag bewindvoering', 'bewindvoering')
          AND track_id = (SELECT id FROM tracks WHERE parent_track_id IS NULL));

CREATE TEMP TABLE gone_tracks AS
  SELECT id FROM tracks
   WHERE title IN ('Aanvraag bewindvoering', 'Opstart en stukken', 'WSNP')
     AND parent_track_id IS NOT NULL;

-- 4. The deletes.
--
--  * every `state = 'expected'` stop: WSNP x6, Schuldregeling 300-600 x4,
--    Opstart's "Aanvragen ingediend bij de gemeente", and the root's goal
--    "Einde bewindvoering";
--  * "Start", undated pre-history — the map now begins at the aanmelding;
--  * the root's "Aanvraag bewindvoering" (24-04) and "bewindvoering" (14-07),
--    which are the same two events as the spine's "Verzoek onderbewindstelling
--    ingediend" and "Beschikking: onder bewind gesteld".
DELETE FROM stops WHERE id IN (SELECT id FROM gone_stops);
DELETE FROM tracks WHERE id IN (SELECT id FROM gone_tracks);

-- 5. The root has no goal to run to any more, so its old name describes nothing.
UPDATE tracks SET title = 'Bewindvoering',
       note = 'De hoofdlijn: hoe de bewindvoering zelf is gelopen.'
 WHERE parent_track_id IS NULL;

-- 6. Orphaned index rows. `reindex --prune` CANNOT do this: it walks the live
--    entities of each type in SEARCH_ENTITY_TYPES and never visits an id that
--    no longer exists. Same shape of trap 0023 documented for the retired
--    `milestone` and `timeline_event` kinds, one level down.
DELETE FROM search_chunks
 WHERE (entity_type = 'stop'  AND entity_id IN (SELECT id FROM gone_stops))
    OR (entity_type = 'track' AND entity_id IN (SELECT id FROM gone_tracks));
DELETE FROM search_outbox
 WHERE (entity_type = 'stop'  AND entity_id IN (SELECT id FROM gone_stops))
    OR (entity_type = 'track' AND entity_id IN (SELECT id FROM gone_tracks));

DROP TABLE gone_stops;
DROP TABLE gone_tracks;

-- 7. The milestones table held 0 rows in production. Its router, its page and
--    its editor went in the previous commit.
DROP TABLE IF EXISTS milestones;
```

- [ ] **Step 2: Drop the table from the schema, and register the migration**

In `packages/db/src/schema.ts`, delete the `export const milestones = pgTable("milestones", { … })` declaration (~line 257). **Keep `wsnpStageEnum`** — `stops.stage` still uses it (line 329) and removing an enum a live column depends on means recreating the type for no gain.

**A hand-written `.sql` that drizzle does not know about never runs.** All 26 existing migrations have an entry in `packages/db/drizzle/meta/_journal.json` and a `NNNN_snapshot.json` beside it, the hand-written ones (0008, 0011, 0013, 0016, 0017) included. Register 0026 by letting drizzle do the bookkeeping and then replacing the body:

```bash
env -u NODE_ENV pnpm --filter @verder/db generate
```

Drizzle sees the dropped `milestones` table, writes a new `0026_<random-name>.sql`, appends `{"idx": 26, …, "tag": "0026_<random-name>"}` to `meta/_journal.json`, and writes `meta/0026_snapshot.json`. Then:

1. Replace the generated `.sql` file's contents with the migration from Step 1 **in full** — the generated `DROP TABLE "milestones"` is only the last statement of it.
2. `git mv` the file to `packages/db/drizzle/0026_vertical_case_timeline.sql`.
3. Edit the new journal entry's `"tag"` to `"0026_vertical_case_timeline"` so it matches the filename.
4. Leave `meta/0026_snapshot.json` exactly as generated — it is drizzle's picture of the schema, and the schema change is only the dropped table.

Verify: `grep -c 0026_vertical_case_timeline packages/db/drizzle/meta/_journal.json` prints `1`.

- [ ] **Step 3: Apply it to the dev database and read the result**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
docker compose exec -T postgres psql -U verder -d verder -c \
  "select t.title as spoor, count(s.id) stops from tracks t left join stops s on s.track_id=t.id group by t.title order by 2 desc;"
```
Expected: 7 tracks. `Bewindvoering` 15, `Ontruiming Woonhave` 4, `Moratorium` 4, `Bankrekening en leefgeld` 4, `Schuldeisers buiten het dossier` 3, `Schuldregeling` 2, `Schuldhulpverlening Almere` 2 — 34 stops total, and no row with `state = 'expected'`.

- [ ] **Step 4: Rewrite `ensureCaseMap` — the failing side first**

In `packages/db/src/seed-case-map.ts`, replace `ROOT_TITLE`, `ROOT_NOTE`, the `START_TITLE`/`GOAL_TITLE`/`GOAL_ORDER` constants, `SPINE_SEED`, and the whole WSNP block (`WSNP_TITLE`, `WSNP_NOTE`, `WSNP_STAGE_SEED`, and the two loops that use them) with:

```ts
/** The root track: the main line, and the only track with no parent. */
const ROOT_TITLE = "Bewindvoering";
const ROOT_NOTE = "De hoofdlijn: hoe de bewindvoering zelf is gelopen.";

/**
 * The spine, as the case actually ran — aanmelding, de gang naar de rechtbank,
 * de beschikking, de opstart.
 *
 * This REVERSES the bare-trunk rule ("a metro map's trunk shows where the line
 * goes, not every errand run along it"). That rule was right for a horizontal
 * map aimed at `Einde bewindvoering`. Migration 0026 deletes that goal, so the
 * root has nothing left to aim at: it is no longer a destination, it is the
 * spine of the story so far, and it has to carry that story.
 *
 * Undated here on purpose — this function only puts the SKELETON back after a
 * truncation. The dates live in the migration and in case-history's seed, and
 * `case-history` only ever dates a stop whose happened_at is still NULL, so a
 * date typed by hand always wins.
 */
const SPINE_SEED = [
  { title: "Aanmelding bij Verder", orderIndex: 100 },
  { title: "Intakegesprek bewindvoering", orderIndex: 200 },
  { title: "Ondernemingen uitgeschreven bij de KvK", orderIndex: 300 },
  { title: "Verzoek onderbewindstelling ingediend", orderIndex: 400 },
  { title: "Poststukken ingeleverd", orderIndex: 500 },
  { title: "Rechtbank vraagt een verklaring", orderIndex: 600 },
  { title: "Verklaring ontstaan schulden aangeleverd", orderIndex: 700 },
  { title: "Beschikking: onder bewind gesteld", orderIndex: 800 },
  { title: "Dossier naar Team Opstart", orderIndex: 900 },
  { title: "Team Opstart vraagt de opstartstukken", orderIndex: 1000 },
  { title: "Heen en weer over de bestandsformaten", orderIndex: 1100 },
  { title: "Opstart van het dossier afgerond", orderIndex: 1200 },
  { title: "Stukken opgevraagd door Regio 3", orderIndex: 1300 },
  { title: "Regio 3 vraagt de laatste drie loonstroken", orderIndex: 1400 },
  { title: "Stukken aanleveren", orderIndex: 1500 },
] as const satisfies readonly { title: string; orderIndex: number }[];
```

Change `EnsureCaseMapResult` to `{ rootTrack: boolean; spineStops: string[] }` and delete `startStop`, `goalStop`, `wsnpTrack` and `stageStops`. In the body, delete the `start`, `goal` and `wsnp` blocks entirely and write the spine as:

```ts
  for (const station of SPINE_SEED) {
    if (await stopOnRoot(station.title)) continue;
    await db.insert(schema.stops).values({
      trackId: root.id, orderIndex: station.orderIndex, title: station.title,
      kind: "process", state: "done",
    });
    created.spineStops.push(station.title);
  }
```

Every stop it seeds is `done`: all fifteen have happened. Nothing this function writes is ever `expected` again.

- [ ] **Step 5: Rewrite the case-history seed**

In `apps/worker/src/ops/case-history.ts`:

1. **`SPINE_SEED`** (line 158) stops being `[]`. Move the 9 stops of the `Aanvraag bewindvoering` `TRACK_SEED` entry and the 6 non-expected stops of `Opstart en stukken` into it **verbatim** — same `title`, `kind`, `state`, `happenedAt`, `note`, `doc`, `task` — changing only `orderIndex`, exactly as below. Do not retype the notes; move the objects.

| new `orderIndex` | title | from | its `happenedAt` |
| --- | --- | --- | --- |
| 100 | Aanmelding bij Verder | Aanvraag | 2026-04-16 |
| 200 | Intakegesprek bewindvoering | Aanvraag | 2026-04-22 |
| 300 | Ondernemingen uitgeschreven bij de KvK | Aanvraag | 2026-04-24 |
| 400 | Verzoek onderbewindstelling ingediend | Aanvraag | 2026-04-24 |
| 500 | Poststukken ingeleverd | Aanvraag | 2026-04-29 |
| 600 | Rechtbank vraagt een verklaring | Aanvraag | 2026-06-01 |
| 700 | Verklaring ontstaan schulden aangeleverd | Aanvraag | 2026-06-09 |
| 800 | Beschikking: onder bewind gesteld | Aanvraag | 2026-07-14 |
| 900 | Dossier naar Team Opstart | Aanvraag | 2026-07-20 |
| 1000 | Team Opstart vraagt de opstartstukken | Opstart | 2026-07-27 |
| 1100 | Heen en weer over de bestandsformaten | Opstart | 2026-07-31 |
| 1200 | Opstart van het dossier afgerond | Opstart | 2026-07-31 |
| 1300 | Stukken opgevraagd door Regio 3 | Opstart | 2026-08-12 |
| 1400 | Regio 3 vraagt de laatste drie loonstroken | Opstart | 2026-08-25 |
| 1500 | Stukken aanleveren | Opstart | 2026-08-28 |

`Aanvragen ingediend bij de gemeente` is the one `Opstart en stukken` stop that does **not** move: it is `expected`, and 0026 deletes it.

Replace the comment above `SPINE_SEED` with:

```ts
/**
 * The main line carries the bewindvoering story: aanmelding, de gang naar de
 * rechtbank, de beschikking, de opstart.
 *
 * This reverses the earlier bare-trunk correction, and the reason is that the
 * trunk changed meaning. It used to run to `Einde bewindvoering`; migration
 * 0026 deletes that goal because the map shows history only, so the root is no
 * longer a destination — it is the spine of the story so far. A spine with two
 * stops and nine sporen hanging off it is not a story.
 */
```

2. **`TRACK_SEED`**: delete the `Aanvraag bewindvoering` and `Opstart en stukken` entries whole. On each of the six survivors set `branchesAt` to `undefined` and drop `mergesAt`; change the `TrackSeed` interface so both are optional:

```ts
export interface TrackSeed {
  title: string;
  status: TrackStatus;
  note: string;
  /** Title of the root stop this track branches at, when one is recorded. */
  branchesAt?: string;
  /** Title of the root stop this track merges back into, if it merges at all. */
  mergesAt?: string;
  stops: StopSeed[];
}
```

3. In `applyCaseHistory`, the track loop must tolerate an absent branch. Replace

```ts
    const branch = await stopOn(root.id, seed.branchesAt);
    if (!branch) throw new Error(
      `track "${seed.title}" branches at "${seed.branchesAt}", which is not on the root`);
```

with

```ts
    // A spoor with no recorded origin is the normal case now: the map draws its
    // branch from the spine at its own oldest stop, so the pointer is semantic
    // only and NULL honestly means "nobody wrote down what this came out of".
    const branch = seed.branchesAt ? await stopOn(root.id, seed.branchesAt) : undefined;
    if (seed.branchesAt && !branch) throw new Error(
      `track "${seed.title}" branches at "${seed.branchesAt}", which is not on the root`);
```

and change the two later uses from `branch.id` to `branch?.id ?? null`.

4. **`SPINE_DATES`** (line 110) names `Aanvraag bewindvoering` and `bewindvoering`, both deleted by 0026. Delete the constant, the `spineDated` field on `CaseHistoryResult`, and the loop that applies it. The dates it carried now live on `Verzoek onderbewindstelling ingediend` and `Beschikking: onder bewind gesteld` in `SPINE_SEED`, which already have them.

5. **`SPINE_ANCHORS`** (line 819) becomes just the seed:

```ts
  // Nothing may be left stranded on the main line. The spine is exactly what
  // SPINE_SEED names, so any other stop still sitting on the root is one this
  // seed forgot to re-home.
  const SPINE_ANCHORS = SPINE_SEED.map((s) => s.title);
```

- [ ] **Step 6: Update the case-history test**

In `apps/worker/src/ops/case-history.test.ts`, update the assertions that count spine stops or name `Start` / `bewindvoering` / `Einde bewindvoering`. Keep both existing laws and add one:

```ts
it("keeps every stop title unique across the whole map", () => {
  const titles = [...SPINE_SEED.map((s) => s.title),
    ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.title))];
  expect(new Set(titles).size).toBe(titles.length);
});

it("seeds no expected stop — the map shows history only", () => {
  const states = [...SPINE_SEED.map((s) => s.state),
    ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.state))];
  expect(states).not.toContain("expected");
});

it("puts the fifteen spine stops in date order", () => {
  const dated = SPINE_SEED.filter((s) => s.happenedAt);
  expect(dated).toHaveLength(15);
  for (let i = 1; i < dated.length; i++) {
    expect(dated[i].happenedAt!.getTime())
      .toBeGreaterThanOrEqual(dated[i - 1].happenedAt!.getTime());
  }
});
```

- [ ] **Step 7: Update the two tests that call `ensureCaseMap`**

`EnsureCaseMapResult` lost four fields, so both callers need a look:

- `packages/db/src/tracks-schema.test.ts:28` seeds the map before its assertions, and line 105 asserts on the result of a second call. Change that assertion to the new shape:

```ts
  it("ensureCaseMap creates nothing on a database that already has the map", async () => {
    await ensureCaseMap(db);
    const created = await ensureCaseMap(db);
    expect(created).toEqual({ rootTrack: false, spineStops: [] });
  });
```

  Any assertion in that file about `Start`, `Einde bewindvoering`, the WSNP track or a stage stop is now wrong — the seed writes fifteen `done` spine stops on a root titled `Bewindvoering` and nothing else.

- `packages/api/src/routers/verify.test.ts:43` calls `ensureCaseMap(db)` after its `TRUNCATE … CASCADE` and ignores the result, so it needs no edit — but it is the test that proves the seed survives a truncation, so it must run green.

- [ ] **Step 8: Run the tests**

Run: `env -u NODE_ENV pnpm --filter worker test case-history && env -u NODE_ENV pnpm --filter @verder/db test && env -u NODE_ENV pnpm --filter @verder/api test verify`
Expected: PASS. `verify.test.ts` truncates `ledger_events, log_entries, documents, parties CASCADE`, which cascades through `stops.entry_id`/`document_id` and takes `stops` and then `tracks` with it — so a green run here is the proof that `ensureCaseMap` can rebuild the new map from nothing.

- [ ] **Step 9: Prove the seed cannot resurrect what the migration deleted**

```bash
env -u NODE_ENV pnpm --filter @verder/db seed-map
docker compose exec -T postgres psql -U verder -d verder -c \
  "select count(*) from stops where state = 'expected';"
```
Expected: `ensureCaseMap` prints `{"rootTrack":false,"spineStops":[]}` and the count is **0**. A non-zero count means the seed and the migration have drifted — fix the seed, not the count.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0026 — history-only case map with a real spine

Deletes the 12 expected stops, the Start anchor and the two root stops
duplicated by the spine; moves the Aanvraag and Opstart stops onto the
root in date order; renames the root to Bewindvoering. Both seeds move
with it, or the next run puts everything back."
```

---

### Task 3: `buildTrackMap` becomes reverse-chronological

The DAG machinery goes — `longestPathColumns`, the Kahn ordering, the reachability walk behind the merge refusal, and the column-span lane packing. Time is the axis now, so position no longer has to be derived from graph structure.

**Files:**
- Create: `packages/api/src/amsterdam.ts`, `packages/api/src/amsterdam.test.ts`
- Modify: `packages/api/src/money-series.ts` — import and re-export `monthKey` from the new module
- Modify: `packages/api/src/track-map.ts` — the rewrite
- Modify: `packages/api/src/routers/tracks.test.ts:112`, `apps/web/src/app/(app)/dashboard/page.tsx:27` — the two readers of the removed `column` field
- Test: `packages/api/src/track-map.test.ts` — rewritten

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface MapStop extends StopRow {
  row: number;        // 0 is the topmost row on the page
  lane: number;       // 0 is the spine
  bandKey: string;    // "nu" | "2026-08" | "onbekend"
  isJunction: boolean;
  datesOutOfOrder: boolean;
}
export interface MapTrack extends TrackRow {
  lane: number; firstRow: number; lastRow: number;   // firstRow is the NEWEST
  mergesBack: boolean; droppedMerge: boolean;
}
export interface MapBand {
  key: string; label: string;
  fromRow: number;   // inclusive
  toRow: number;     // exclusive; equal to fromRow when empty
  empty: boolean;
}
export interface MapEdge {
  kind: "branch" | "merge";
  trackId: string;
  fromLane: number; fromRow: number;   // on the parent
  toLane: number; toRow: number;       // on the child
  atStopId: string | null;             // the anchor stop, when one is recorded
}
export interface CaseMap {
  bands: MapBand[]; stops: MapStop[]; tracks: MapTrack[]; edges: MapEdge[];
  rowCount: number; laneCount: number;
  currentStopId: string | null; problems: MapProblem[];
}
export function buildTrackMap(input: { tracks: TrackRow[]; stops: StopRow[] }): CaseMap;
```

`TrackRow`, `StopRow` and `MapProblem` keep their current shapes exactly. `MapStop.column`, `MapTrack.firstColumn` / `lastColumn`, `CaseMap.columnCount` and `MapStop.isStation` are **gone** — Task 5 fixes the two callers.

- [ ] **Step 1: Write the Amsterdam helper test**

Create `packages/api/src/amsterdam.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dayKey, monthKey, monthLabel, monthsBetween } from "./amsterdam";

describe("amsterdam calendar", () => {
  it("reads an instant as an Amsterdam calendar day", () => {
    // 22:30 UTC on 31 July is already 1 August in Amsterdam (CEST, +2).
    expect(dayKey(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08-01");
    expect(monthKey(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08");
  });

  it("names a month in Dutch", () => {
    expect(monthLabel("2026-08")).toBe("augustus 2026");
    expect(monthLabel("2026-01")).toBe("januari 2026");
  });

  it("lists every month from newest to oldest, gaps included", () => {
    expect(monthsBetween("2026-04", "2026-08"))
      .toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween("2025-11", "2026-02"))
      .toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test amsterdam`
Expected: FAIL — `Failed to resolve import "./amsterdam"`.

- [ ] **Step 3: Write the helper**

Create `packages/api/src/amsterdam.ts`:

```ts
/**
 * Amsterdam calendar arithmetic. PURE: no I/O, no imports.
 *
 * Extracted from money-series.ts, which has followed this rule since the money
 * work: a month is an Amsterdam question, and UTC-instant arithmetic disagrees
 * with it by the offset — enough to file a boundary stop under the wrong month.
 */

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
});

/** "YYYY-MM-DD" in Amsterdam. */
export function dayKey(d: Date): string {
  return DAY_FMT.format(d);
}

/** "YYYY-MM" in Amsterdam. */
export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

/** "2026-08" → "augustus 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * Every month from `newest` down to `oldest`, inclusive, newest first —
 * INCLUDING the ones with nothing in them. A quiet stretch is a fact about the
 * case and the map has to be able to show it.
 */
export function monthsBetween(oldest: string, newest: string): string[] {
  const out: string[] = [];
  let [y, m] = newest.split("-").map(Number);
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key <= oldest) break;
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test amsterdam`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point money-series at it**

In `packages/api/src/money-series.ts`, delete the local `DAY_FMT`, `dayKey` and `monthKey` definitions and put this at the top of the imports:

```ts
import { dayKey, monthKey } from "./amsterdam";
export { monthKey };
```

The re-export keeps `monthKey`'s public name, so nothing that imports it from `money-series` changes.

Run: `env -u NODE_ENV pnpm --filter @verder/api test money-series`
Expected: PASS. **`money-series.real.test.ts` is the oracle for the money sub-project — if it fails, the extraction is wrong, and the test is never the thing to change.**

- [ ] **Step 6: Write the failing map tests**

Replace `packages/api/src/track-map.test.ts` entirely. Keep the two existing row builders and add these:

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

const on = (iso: string) => new Date(`${iso}T12:00:00+02:00`);
const rowOf = (map: ReturnType<typeof buildTrackMap>, id: string) =>
  map.stops.find((s) => s.id === id)!.row;

/** A spine of four dated stops and one spoor that ran alongside it in August. */
function caseFixture() {
  const tracks = [
    track({ id: "spine", title: "Bewindvoering" }),
    track({ id: "ontruiming", title: "Ontruiming Woonhave",
      status: "ended", parentTrackId: "spine" }),
  ];
  const stops = [
    stop({ id: "s1", trackId: "spine", orderIndex: 100, happenedAt: on("2026-04-16") }),
    stop({ id: "s2", trackId: "spine", orderIndex: 200, happenedAt: on("2026-07-20") }),
    stop({ id: "s3", trackId: "spine", orderIndex: 300, happenedAt: on("2026-08-12") }),
    stop({ id: "s4", trackId: "spine", orderIndex: 400, happenedAt: on("2026-08-28") }),
    stop({ id: "o1", trackId: "ontruiming", orderIndex: 100, happenedAt: on("2026-07-29") }),
    stop({ id: "o2", trackId: "ontruiming", orderIndex: 200, happenedAt: on("2026-08-06") }),
  ];
  return { tracks, stops };
}

describe("buildTrackMap order", () => {
  it("puts the newest stop at the top and the oldest at the bottom", () => {
    const map = buildTrackMap(caseFixture());
    expect(rowOf(map, "s4")).toBe(0);
    expect(rowOf(map, "s1")).toBe(map.rowCount - 1);
  });

  it("interleaves a spoor's stops with the spine by date", () => {
    const map = buildTrackMap(caseFixture());
    // 06-08 is newer than 20-07 and older than 12-08, wherever it sits.
    expect(rowOf(map, "o2")).toBeGreaterThan(rowOf(map, "s3"));
    expect(rowOf(map, "o2")).toBeLessThan(rowOf(map, "s2"));
  });

  it("reads the spine first when two stops share a day", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "o3", trackId: "ontruiming", orderIndex: 300,
      happenedAt: on("2026-08-28") }));
    const map = buildTrackMap(f);
    expect(rowOf(map, "s4")).toBeLessThan(rowOf(map, "o3"));
  });

  it("never renders an expected stop, even if one is in the data", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "future", trackId: "spine", orderIndex: 500,
      state: "expected" }));
    const map = buildTrackMap(f);
    expect(map.stops.map((s) => s.id)).not.toContain("future");
  });
});

describe("buildTrackMap bands", () => {
  it("gives every month in the span a band, newest first", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.bands.map((b) => b.key))
      .toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
    expect(map.bands[0].label).toBe("augustus 2026");
  });

  it("marks a month with nothing in it as empty and gives it no rows", () => {
    const map = buildTrackMap(caseFixture());
    const mei = map.bands.find((b) => b.key === "2026-05")!;
    expect(mei.empty).toBe(true);
    expect(mei.toRow).toBe(mei.fromRow);
  });

  it("covers every row exactly once, in order", () => {
    const map = buildTrackMap(caseFixture());
    let next = 0;
    for (const b of map.bands) {
      expect(b.fromRow).toBe(next);
      next = b.toRow;
    }
    expect(next).toBe(map.rowCount);
  });

  it("puts an undated open stop in a `nu` band above all history", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "live", trackId: "ontruiming", orderIndex: 300,
      state: "open" }));
    const map = buildTrackMap(f);
    expect(map.bands[0].key).toBe("nu");
    expect(rowOf(map, "live")).toBe(0);
  });

  it("omits the `nu` band when nothing is running undated", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.bands.map((b) => b.key)).not.toContain("nu");
  });

  it("gives an undated done stop the position of the one before it on its track", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "s2b", trackId: "spine", orderIndex: 250 }));
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "s2b")!.bandKey).toBe("2026-07");
  });

  it("drops an entirely undated track into a `zonder datum` band at the bottom", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "leeg", title: "Zonder datum", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "u1", trackId: "leeg", orderIndex: 100 }));
    const map = buildTrackMap(f);
    expect(map.bands.at(-1)!.key).toBe("onbekend");
    expect(rowOf(map, "u1")).toBe(map.rowCount - 1);
  });
});

describe("buildTrackMap lanes", () => {
  it("keeps the spine on lane 0", () => {
    const map = buildTrackMap(caseFixture());
    expect(map.tracks.find((t) => t.id === "spine")!.lane).toBe(0);
    expect(map.stops.find((s) => s.id === "s1")!.lane).toBe(0);
  });

  it("lets two sporen that never overlap in time share a lane", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "oud", title: "Oud spoor", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "x1", trackId: "oud", orderIndex: 100,
      happenedAt: on("2026-04-20") }));
    const map = buildTrackMap(f);
    expect(map.tracks.find((t) => t.id === "oud")!.lane)
      .toBe(map.tracks.find((t) => t.id === "ontruiming")!.lane);
    expect(map.laneCount).toBe(2);
  });

  it("gives two sporen that overlap in time different lanes", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "gelijk", title: "Gelijktijdig", parentTrackId: "spine" }));
    f.stops.push(stop({ id: "g1", trackId: "gelijk", orderIndex: 100,
      happenedAt: on("2026-08-01") }));
    const map = buildTrackMap(f);
    expect(map.tracks.find((t) => t.id === "gelijk")!.lane)
      .not.toBe(map.tracks.find((t) => t.id === "ontruiming")!.lane);
  });
});

describe("buildTrackMap edges", () => {
  it("branches from the spine at the spoor's own oldest stop when no origin is recorded", () => {
    const map = buildTrackMap(caseFixture());
    const branch = map.edges.find((e) => e.kind === "branch")!;
    expect(branch.trackId).toBe("ontruiming");
    expect(branch.atStopId).toBeNull();
    expect(branch.fromLane).toBe(0);
    expect(branch.fromRow).toBe(rowOf(map, "o1"));
    expect(branch.toRow).toBe(rowOf(map, "o1"));
  });

  it("branches at the recorded origin stop when there is one", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], branchesAtStopId: "s2" };
    const map = buildTrackMap(f);
    const branch = map.edges.find((e) => e.kind === "branch")!;
    expect(branch.atStopId).toBe("s2");
    expect(branch.fromRow).toBe(rowOf(map, "s2"));
  });

  it("draws a merge back into the spine above the spoor's newest stop", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], mergesAtStopId: "s4" };
    const map = buildTrackMap(f);
    const merge = map.edges.find((e) => e.kind === "merge")!;
    expect(merge.fromRow).toBe(rowOf(map, "o2"));
    expect(merge.toRow).toBe(rowOf(map, "s4"));
    expect(map.tracks.find((t) => t.id === "ontruiming")!.mergesBack).toBe(true);
  });

  it("refuses a merge into a stop older than the spoor itself, and reports it", () => {
    const f = caseFixture();
    // s2 is 20-07; the spoor's newest stop o2 is 06-08. Rejoining before it
    // left is not a track, it is a loop.
    f.tracks[1] = { ...f.tracks[1], mergesAtStopId: "s2" };
    const map = buildTrackMap(f);
    expect(map.edges.filter((e) => e.kind === "merge")).toHaveLength(0);
    expect(map.problems.map((p) => p.kind)).toContain("backwards-merge");
    const t = map.tracks.find((t) => t.id === "ontruiming")!;
    expect(t.droppedMerge).toBe(true);
    expect(t.mergesBack).toBe(false);
  });

  it("rings a stop another track leaves from or lands on", () => {
    const f = caseFixture();
    f.tracks[1] = { ...f.tracks[1], branchesAtStopId: "s2" };
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "s2")!.isJunction).toBe(true);
    expect(map.stops.find((s) => s.id === "s3")!.isJunction).toBe(false);
  });
});

describe("buildTrackMap current stop", () => {
  it("answers with the newest open stop", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "open1", trackId: "ontruiming", orderIndex: 300,
      state: "open", happenedAt: on("2026-08-20") }));
    const map = buildTrackMap(f);
    expect(map.currentStopId).toBe("open1");
  });

  it("prefers an undated open stop, because it is what is running now", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "dated", trackId: "ontruiming", orderIndex: 300,
      state: "open", happenedAt: on("2026-08-20") }));
    f.stops.push(stop({ id: "live", trackId: "ontruiming", orderIndex: 400,
      state: "open" }));
    const map = buildTrackMap(f);
    expect(map.currentStopId).toBe("live");
  });

  it("reports no current stop when nothing is open", () => {
    expect(buildTrackMap(caseFixture()).currentStopId).toBeNull();
  });
});

describe("buildTrackMap problems", () => {
  it("reports a map with no hoofdlijn and draws nothing", () => {
    const map = buildTrackMap({
      tracks: [track({ id: "a", title: "A", parentTrackId: "b" })], stops: [],
    });
    expect(map.problems.map((p) => p.kind)).toEqual(["no-root"]);
    expect(map.stops).toHaveLength(0);
    expect(map.rowCount).toBe(0);
  });

  it("reports a stop belonging to no track at all", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "weg", trackId: "bestaat-niet" }));
    const map = buildTrackMap(f);
    expect(map.problems.map((p) => p.kind)).toContain("orphan-stop");
    expect(map.stops.map((s) => s.id)).not.toContain("weg");
  });

  it("leaves a track whose parents cycle off the map, and says so", () => {
    const f = caseFixture();
    f.tracks.push(track({ id: "p", title: "P", parentTrackId: "q" }));
    f.tracks.push(track({ id: "q", title: "Q", parentTrackId: "p" }));
    f.stops.push(stop({ id: "p1", trackId: "p", happenedAt: on("2026-08-01") }));
    const map = buildTrackMap(f);
    expect(map.problems.map((p) => p.kind)).toContain("ancestry-cycle");
    expect(map.stops.map((s) => s.id)).not.toContain("p1");
    // Totality: the rest of the map still drew.
    expect(rowOf(map, "s4")).toBe(0);
  });

  it("flags a date that contradicts its position on its own track", () => {
    const f = caseFixture();
    f.stops.push(stop({ id: "typo", trackId: "spine", orderIndex: 350,
      happenedAt: on("2026-05-01") }));
    const map = buildTrackMap(f);
    expect(map.stops.find((s) => s.id === "typo")!.datesOutOfOrder).toBe(true);
    // Shown, never corrected: the healthy stop after it stays clean.
    expect(map.stops.find((s) => s.id === "s4")!.datesOutOfOrder).toBe(false);
  });

  it("renders an empty map without throwing", () => {
    const map = buildTrackMap({ tracks: [], stops: [] });
    expect(map.problems.map((p) => p.kind)).toEqual(["no-root"]);
    expect(map.bands).toEqual([]);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test track-map`
Expected: FAIL — `rowOf` reads `undefined`, `map.bands` does not exist.

- [ ] **Step 8: Rewrite `track-map.ts`**

Keep, unchanged: `TrackRow`, `StopRow`, `MapProblem`, the root lookup, the ancestry/reachability walk, and the orphan-stop reporting. Replace everything from `compareStops` onward. The header comment's central law is repealed and must say why:

```ts
/**
 * The /timeline map. PURE: no database, no I/O, no imports from @verder/db.
 * Rows in, a drawable map out — the same discipline as money-series.ts.
 *
 * TOTAL: any input renders. A corrupt map is reported through `problems` and
 * still draws what it can, because a page that throws tells Martin nothing.
 *
 * POSITION IS TIME, newest at the top. This REVERSES the rule this module was
 * built on ("position is a layering, never a time axis"). That rule existed for
 * one reason: an expected stop has no date, so a time axis would have to invent
 * one. Migration 0026 removes every expected stop and the editor no longer
 * offers the state, so the objection is gone and the axis is honest. IF
 * EXPECTED STOPS EVER COME BACK, THIS DECISION COMES BACK WITH THEM.
 *
 * Within a month, stops are evenly spaced and NOT to scale: 22 of Martin's 34
 * stops fall in five weeks, and a true time scale piles them on top of each
 * other. The month band carries the sense of time; even spacing carries the
 * readability; each stop prints its own date.
 */
```

Implement in this order:

1. **Track order.** Depth-first from the root, children sorted by `title` then `id`, producing `trackOrder: Map<string, number>` with the root at 0. This replaces lane as the tie-break in the comparator and breaks the chicken-and-egg — lanes are derived from rows, and rows must not depend on lanes.

2. **Stops per track**, orphans reported, `state === "expected"` skipped after the orphan check (an expected orphan is still a data error), each list sorted by `orderIndex` then `id`.

3. **`datesOutOfOrder`**, per track, exactly the rule that is there today: walk in `orderIndex` order, flag a dated stop whose date precedes the previous dated one, and move `lastDated` on **unconditionally** — making it a running maximum inverts the signal and flags four healthy stops instead of the one typo.

4. **Effective band per stop:**
   - has `happenedAt` → `monthKey(happenedAt)`;
   - `open` and undated → `"nu"`;
   - `done` and undated → the band of the previous dated stop on its track, else of the next dated stop on its track, else `"onbekend"`.

5. **Comparator, top to bottom:** band rank (`nu` = 0, months newest-first, `onbekend` last) → effective time descending → `trackOrder` ascending → `orderIndex` descending → `id` ascending. Total and stable, so the map never reshuffles between two reads of the same data.

6. **Rows** assigned 0..n-1 in that order. **Bands** built from `monthsBetween(oldest, newest)` over the month keys present, with `nu` prepended when non-empty and `onbekend` appended when non-empty; `fromRow`/`toRow` from the row assignment, `empty` when they are equal.

7. **Lanes.** Root is 0. Every other reachable track has a span `[firstRow, lastRow]` from its own stops, or — with no stops — a zero-height span at its branch stop's row, else at row 0. Assign in order of `lastRow` descending (oldest first), then `trackOrder`; each takes the lowest lane ≥ 1 whose occupants do not overlap its span.

8. **Edges.** One `branch` per non-root reachable track: `fromLane` is its parent's lane, `fromRow` is the row of `branchesAtStopId` when that is a drawn stop (`atStopId` set) and otherwise the track's own `lastRow` (`atStopId` null), `toLane`/`toRow` are the track's lane and `lastRow`. A `branchesAtStopId` pointing at a stop on the track itself or one of its descendants is skipped and reported `branch-into-own-subtree` — no longer a drawing hazard, still a data error. One `merge` per track with a drawn `mergesAtStopId`, refused and reported `backwards-merge` when the target's row is `>=` the track's `firstRow`, because that is a spoor claiming to rejoin before it left.

9. **`isJunction`** for every stop a drawn branch or merge actually touches. A refused edge leaves no junction — a ring with no line out of it is the map claiming a connection it did not draw.

10. **`currentStopId`**: the first stop in row order whose `state` is `open`. The row ordering has already broken every tie.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test track-map`
Expected: PASS, all 27 tests.

- [ ] **Step 10: Fix the two remaining readers of `column`**

`MapStop.column` is gone, so the branch does not typecheck until these move with it. A type change and its callers belong in one commit.

`apps/web/src/app/(app)/dashboard/page.tsx:27` sorts a spoor's stops to find its furthest one. Row 0 is the top of the page, so ascending row is newest first:

```tsx
      const own = map.stops.filter((s) => s.trackId === t.id)
        .sort((a, b) => a.row - b.row);
      // The newest stop that is not done yet, or the newest stop there is. Row 0
      // is the top of the page, so ascending row is newest first.
      return { track: t, stop: own.find((s) => s.state !== "done") ?? own[0] };
```

`packages/api/src/routers/tracks.test.ts:112` reads `map.stops.find((s) => s.id === id)!.column`. Change `column` to `row` **and invert whatever comparison the assertion makes** — a bigger column meant later, a bigger row means older.

- [ ] **Step 11: Typecheck the whole repo**

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: PASS. `grep -rn "\.column\|columnCount\|isStation" apps/web/src packages/api/src` should return nothing but the `isStation` uses in `apps/web/src/lib/track-marks*`, which Task 4 removes.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(api): lay the case map out in time, newest first

Replaces the longest-path layering with a reverse-chronological order in
month bands. The 'position is never a time axis' law existed because an
expected stop has no date; 0026 removed them, so the axis is honest now.
Amsterdam month arithmetic moves to its own pure module, shared with
money-series."
```

---

### Task 4: Draw it

**Files:**
- Modify: `apps/web/src/lib/track-marks.ts`, `apps/web/src/lib/track-marks.test.ts`
- Modify: `apps/web/src/components/track-map.tsx` — the rewrite

**Interfaces:**
- Consumes: `CaseMap` from Task 3 — `bands`, `stops` (`row`, `lane`, `bandKey`, `isJunction`, `datesOutOfOrder`), `tracks` (`lane`, `firstRow`, `lastRow`), `edges`, `rowCount`, `laneCount`, `currentStopId`.
- Produces: `TrackMap` (default export shape unchanged: `{ map, selected }`), and `stopMark` with `size` removed.

- [ ] **Step 1: Update the marks test**

In `apps/web/src/lib/track-marks.test.ts`, delete the two `isStation` assertions (lines 26-27) and the `state: "expected"` cases in `stopWhenLabel` (lines 87, 96), and drop `isStation` from the `stop` builder on line 7. Add:

```ts
it("has no dashed mark left — nothing on the map is expected", () => {
  expect(stopMark(stop({ state: "done" })).fill).toBe("solid");
  expect(stopMark(stop({ state: "open" })).fill).toBe("hollow");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter web test track-marks`
Expected: FAIL — `stopMark` still returns a `size`.

- [ ] **Step 3: Trim the marks**

In `apps/web/src/lib/track-marks.ts`, remove `size` from `StopMark` and from `stopMark`'s return, and remove `isStation` from its parameter type. Keep `fill`, `ring` and `flagged`. Keep the `dashed` arm of the `fill` ternary — `stopMark` is a total function over `state` and an `expected` row that somehow reaches it must still draw as something. Update the doc comment: the four marks are now three, and `dashed` is documented as unreachable-by-design.

Leave `stopWhenLabel`, `trackTerminus`, `STOP_STATE_LABEL`, `TRACK_STATUS_LABEL`, `noOpenTracksLine` and `stopHref` untouched.

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u NODE_ENV pnpm --filter web test track-marks`
Expected: PASS.

- [ ] **Step 5: Rewrite the SVG**

Replace `apps/web/src/components/track-map.tsx`. Geometry constants:

```tsx
// Pixels, not facts.
const DATE_W = 64;        // right-aligned date gutter
const LANE_X0 = 84;       // x of lane 0, the spine
const LANE_W = 20;
const ROW_H = 34;
const BAND_H = 30;        // what a band header costs
const EMPTY_BAND_H = 22;
const LABEL_GAP = 18;
const LABEL_W = 380;
const PAD_TOP = 12;
const PAD_BOTTOM = 16;
const R_STOP = 6;
```

Walk the bands once to turn rows into y, so nothing downstream has to know about band headers:

```tsx
  // Rows are slots; bands are headers between them. One pass turns both into y.
  const rowY = new Array<number>(map.rowCount);
  const bandY: number[] = [];
  let cursor = PAD_TOP;
  for (const band of map.bands) {
    bandY.push(cursor + 12);
    cursor += band.empty ? EMPTY_BAND_H : BAND_H;
    for (let r = band.fromRow; r < band.toRow; r++) {
      rowY[r] = cursor + ROW_H / 2;
      cursor += ROW_H;
    }
  }
  const height = cursor + PAD_BOTTOM;
  const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
  const labelX = laneX(map.laneCount) + LABEL_GAP;
  const width = labelX + LABEL_W;
```

Then, in paint order:

1. **Band headers** — a `MUTED` hairline from `x = 0` to `width`, with the label at `x = 0` in 10px uppercase-tracked `MUTED`. An empty band adds `· geen gebeurtenissen` after the label and draws no rows.
2. **Rails** — one vertical line per track from `rowY[t.firstRow]` to `rowY[t.lastRow]`, `INK` at 3px for lane 0 and `RAIL` at 2px for the rest. A spoor's name sits just **below** its bottom end in 10px `MUTED`; the spine gets no gutter name — it is named by the page heading, and a label beside its topmost stop would read as that stop's caption.
3. **Terminus caps** at the **top** of a spoor's rail (its newest end): `done` a double `INK` bar, `ended` a single `MUTED` bar, each with a `<title>` naming it in words. Two different facts the editor makes Martin choose between, so the map may not collapse them into one drawing.
4. **Branch and merge curves** — a cubic between the two lanes at the two rows, `RAIL` 2px, straight to `M x1 y1 C …` using the edge's own `fromLane/fromRow/toLane/toRow`. No lookups: Task 3 already resolved them.
5. **Rows** — for each stop, in this order: the selection band (a `width`-wide rect at 6% black behind the whole row) when `s.id === selected`; a 3px green left edge at `x = 0` when `s.id === map.currentStopId`; the date right-aligned at `x = DATE_W - 8` in 10px `MUTED` (nothing when `happenedAt` is null); the dot at `laneX(s.lane)`; the full title at `labelX` in 12px; and the track name after it in 10px `MUTED` for spoor rows only.

**Do not truncate the title.** The 16-character slice is the single biggest reason the current map is unreadable, and the fixed label column exists precisely so it is not needed.

Keep the accessibility structure exactly as it is: each row is a `<Link href={stopHref(s.id, selected)} aria-label={…}>` around a `<g>`, with a `<title>` inside for the mouse. Everything inside `role="img"` is presentational, so the `aria-label` on the link is the only name a screen reader gets.

New legend under the SVG:

```tsx
      <p className="mt-3 text-xs text-slate-500">
        Nieuwste bovenaan. Gevuld = gebeurd · open = loopt nog · omcirkeld =
        vertrek- of aankomstpunt van een zijspoor ·{" "}
        <span style={{ color: CURRENT }}>groene rand</span> = waar het nu op wacht ·
        dubbele streep = spoor afgerond · enkele streep = spoor geëindigd.
        Binnen een maand staan de haltes op volgorde, niet op schaal.
      </p>
```

- [ ] **Step 6: Look at it**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter web dev
```
Open `http://localhost:3000/timeline`, sign in as `martin@vanderpoel.pro` / `devpass`. Check by eye:
- `Stukken aanleveren` (28-08) is at the top of `augustus 2026`; `Aanmelding bij Verder` (16-04) is the bottom row.
- `mei 2026` shows `geen gebeurtenissen` — no, it holds the KvK aanmaning of 26-05; **`juni 2026` should show only two stops** and the thin stretch April–June must be visible.
- No horizontal scrollbar at 1024px, and none at 390px (iPhone width) beyond the label column.
- Every title is readable in full.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): draw the case map vertically, newest first

One label column at a fixed x, full titles instead of 16-character
stubs, month bands down the page, terminus caps at the top of a spoor.
Monochrome: lane position and the muted track name already identify a
spoor, and six new hues would leave the palette behind."
```

---

### Task 5: The three remaining callers

**Files:**
- Modify: `apps/web/src/app/(app)/timeline/page.tsx`
- Modify: `apps/web/src/components/stop-editor.tsx:48`

**Interfaces:**
- Consumes: `CaseMap` from Task 3.
- Produces: nothing new.

**Already done, do not redo:** the dashboard sort (`dashboard/page.tsx:27`) and the router test (`tracks.test.ts:112`) moved into Task 3, because they are the direct callers of the `column` field it removed and the branch would not typecheck between the two tasks. Leave both alone.

- [ ] **Step 1: Fix the timeline page's detail panel**

In `apps/web/src/app/(app)/timeline/page.tsx`:
- Lines 111-112 print `verwacht <expectedAt>`. No stop is expected any more; delete that branch and keep only the `happenedAt` one.
- `insertPosition` (lines 33-43) exists to slot a new halte in front of the `expected` endpoint at `order_index` 1000000. That endpoint is deleted, so the function always returns `undefined`. Delete it and its call, and let the router append at max+1.
- Line 123's `shown.datesOutOfOrder` block stays — the flag survives with a new meaning.
- The intro paragraph still says the hoofdlijn "loopt naar het einde van de bewindvoering". There is no such stop any more. Replace the `<p>` with:

```tsx
        <p className="mt-1 text-slate-600">
          Het nieuwste staat bovenaan. De hoofdlijn is hoe de bewindvoering zelf
          is gelopen — van de aanmelding bij Verder tot waar het nu staat. Een
          zijspoor begint zodra er iets binnenkomt — een mail, een telefoontje,
          een brief — en komt daarna terug op de hoofdlijn of eindigt op zichzelf.
          Wat nog moet gebeuren staat er niet op: deze kaart laat zien wat er is
          gebeurd.
        </p>
```

- [ ] **Step 2: Drop `verwacht` from the stop editor**

`apps/web/src/components/stop-editor.tsx:48` offers `{ value: "expected", label: "verwacht" }`. Remove that option from the array. Leave the `expectedAt` field and the router's `expected` enum member alone — `buildTrackMap` filters the state defensively (Task 3), so this is the second of two lines of defence rather than a load-bearing one.

- [ ] **Step 3: Typecheck and run everything**

Run: `env -u NODE_ENV pnpm -r typecheck && env -u NODE_ENV pnpm -r test`
Expected: PASS. `grep -rn "\.column\|columnCount\|isStation" apps/web/src packages/api/src` should return nothing.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): drop the future from the timeline page and the editor

The detail panel loses its verwacht branch and the helper that inserted a
halte before the expected endpoint, which has no endpoint left to insert
before; the stop editor stops offering verwacht at all."
```

---

### Task 6: Verify and deploy

**Files:** none — this task changes no code. It changes production, so read every command before running it.

**Interfaces:**
- Consumes: everything above.
- Produces: the feature, live at https://verder.vanderpoel.pro/timeline.

- [ ] **Step 1: Full local build**

Run: `env -u NODE_ENV pnpm -r typecheck && env -u NODE_ENV pnpm -r test && env -u NODE_ENV pnpm --filter web build`
Expected: PASS. `next build` must be run with `env -u NODE_ENV` or it fails on the shell's `NODE_ENV=development`.

- [ ] **Step 2: Open a PR**

```bash
git push -u origin feat/vertical-case-timeline
gh pr create --fill
```

- [ ] **Step 3: Migrate production FIRST, from the homelab host**

```bash
ssh homelab 'cd ~/apps/verder && env -u NODE_ENV pnpm --filter @verder/db migrate'
```
This runs **before any image is rebuilt**. The blast radius is wider than `/timeline`: the dashboard and every `logbook/[id]` page read tracks and stops, so a web image deployed against the old schema 500s on all three.

- [ ] **Step 4: Read the deletions before you sync**

```bash
rsync -av --delete --dry-run --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  ./ homelab:~/apps/verder/
```
Read **every** `deleting` line. Expect exactly the seven files Task 1 removed. **The exclude list is the whole safety mechanism** — a dry run without it printed `deleting secrets/role-passwords`, `deleting secrets/gmail-token.json`, `deleting .env.prod`. rsync does not read `.gitignore`. Add to that list, never trim it. Plain `--dry-run` without `-v`/`--info=del` prints nothing, which reads as "no deletions" and is not.

- [ ] **Step 5: Sync and rebuild**

```bash
rsync -av --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  ./ homelab:~/apps/verder/
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker'
```
`--delete` is required, not optional: Task 1 deletes seven files, and a stale `milestones/page.tsx` importing a router that no longer exists fails the Docker `next build`.

- [ ] **Step 6: Prove the ledger did not move**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm -T worker pnpm --filter worker nightly-verify'
```
Expected: `ok`, and **the chain head UNCHANGED**. Tracks and stops append no ledger events, so a moved head means something in this change wrote evidence it should not have. Compare against the head recorded before Step 3 — capture it first if you have not.

- [ ] **Step 7: Check the index drained**

```bash
ssh homelab "cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder -c \"select entity_type, count(*) from search_chunks where entity_type in ('stop','track') group by 1; select count(*) from search_outbox;\""
```
Expected: no chunk for a deleted id, and `search_outbox` draining to 0 within a couple of minutes — the root rename re-enqueues all 15 spine stops through `tracks_stops_search_outbox_trg`, which is correct and self-clearing.

- [ ] **Step 8: Look at the real thing**

Open https://verder.vanderpoel.pro/timeline. Confirm the spine reads bottom to top as aanmelding → verzoek rechtbank → beschikking → opstart, that `Ontruiming Woonhave` runs alongside it through late July and early August with a `geëindigd` cap at its top, that nothing on the page is in the future, and that `mei 2026` and `juni 2026` look as thin as they were.

- [ ] **Step 9: Update the project notes**

`CLAUDE.md` records the repealed laws as current: "THE LAYOUT IS A LONGEST-PATH LAYERING, NEVER A TIME AXIS", "THE MAIN LINE CARRIES EXACTLY FOUR STOPS", and `SPINE_SEED` being deliberately empty. Rewrite that passage to say what is true now, and say that both were reversed **because the goal stop was deleted**, so the reasoning travels with the change and nobody restores them by accident. Add migration 0026's ordering trap to the list that 0020, 0021, 0022 and 0023 are already on.

- [ ] **Step 10: Commit and merge**

```bash
git add CLAUDE.md
git commit -m "docs: record the vertical timeline and the two laws it repeals"
git push
gh pr merge --squash
```
