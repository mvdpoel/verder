# The case as a project map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `tracks`/`stops` from a picture of the case into a project
overview: a bare main line of phase gates, one track per storyline, and one
branch per open task, with every stop showing the source behind it.

**Architecture:** No schema change and no migration. The skeleton (root track,
seven spine gates, WSNP stage stations) is `ensureCaseMap` in `@verder/db`; the
case itself is the `case-history` backfill, whose seed data moves to its own
module. The backfill gains three mechanisms: **nested tracks** (a track may hang
under another track, branching and merging on its *parent*), **one-time
corrections** (a `state`/`happened_at` repair applied only while the row still
holds the value a migration gave it), and **enumerated retirement** (the only
delete, triple-guarded, owner-role only). The web change is one pure function:
where a stop points at a log entry, the entry's channel is what the page calls
its source.

**Tech Stack:** TypeScript, drizzle-orm, Postgres 17, vitest, Next 15 (RSC),
pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-23-case-project-map-design.md`

## Global Constraints

- **No ledger events.** `tracks` and `stops` are not evidence. The chain head
  must be byte-identical before and after the production run; a moved head means
  something wrote evidence that should not have. The only writes that *do* append
  are the ones `case-history` already made: `party.created` per genuinely new
  party and `task.status` per task that is not plain open.
- **No schema change, no migration.** Migrations 0023 and 0024 are applied and
  immutable. Everything here is data, and data belongs in the backfill.
- **Structure is the seed's, content is Martin's.** On a stop that already
  exists the script writes only `track_id`, `order_index` and still-null evidence
  links. It never writes `state`, `kind`, `note` or `happened_at` — with exactly
  one exception, `STOP_CORRECTIONS`, which fires only while the row still holds
  the value a migration gave it.
- **Restructuring is rename-and-move.** `STOP_RENAMES`/`TRACK_RENAMES` run
  *first*, before anything that keys on a title — including `ensureCaseMap`.
- **Retirement is the only delete**, enumerated with a reason, triple-guarded,
  and it fails loudly rather than proceeding when a guard trips.
- **Stop titles are unique map-wide**, and track titles are unique map-wide.
  Both lookups are by title with no track scope.
- **Every `open` stop is work waiting on Martin.** The map's headline is the
  furthest-right open stop, and an open stop that waits on somebody else steals
  it.
- **Dutch, in Martin's register**, for every title, note and label that reaches
  the screen. Supportive toward Martin; `ended`/`geëindigd` never reads as
  failure.
- Run builds and tests with `env -u NODE_ENV` — the shell exports
  `NODE_ENV=development`, which breaks `next build`.

## Decisions taken on top of the spec

Four points where the spec and the code's own invariants disagreed. Each was put
to Martin on 2026-08-23 and answered:

1. **Spine gate #6 is `Schone lei verkregen`, not `Schone lei`.** WSNP already
   owns a stage station titled *Schone lei*, seeded by both migration 0023 and
   `ensureCaseMap`, and stop lookup is map-wide by title — two rows under one
   title would drag one row back and forth on every run. Renaming WSNP's station
   instead is not available: its old title would be re-created by the seed on the
   next run, which is exactly the rename the tests forbid.
2. **WSNP hangs under Schuldhulpverlening and merges into its parent's last
   stop.** "Every track branches and merges on its own parent" is the spec's own
   test; a child of Schuldhulpverlening merging into a root stop would break it.
3. **Emptied tracks are retired too.** Consolidation empties three track rows,
   and an empty track still draws as a stub rail. Track retirement gets the same
   discipline as stop retirement.
4. **One branch per not-done task, plus the one done branch the spec draws.**
   Fourteen task branches. Two exclusions, enumerated in the seed with reasons:
   a task on a closed storyline gets no live branch off a closed line.

One addition the spec's storyline table omits: **Schuldregeling stays a
storyline**, branching at *Start bewindvoering* and merging at the spine gate
*Start schuldhulpverlening*. It holds the live work — the financial picture, the
huurachterstand, the creditors — that has to be finished *before* a
schuldhulpverlening traject can start, and dropping it would move that work
nowhere. The spec's `Schuldhulpverlening` track is the future traject that
begins at that gate.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/seed-case-map.ts` (modify) | The SKELETON. Exports `SPINE_STOPS` — the one spelling of the main line — plus the root track and WSNP's stage stations. Idempotent. |
| `packages/db/src/seed-case-map.test.ts` (create) | Pure assertions on `SPINE_STOPS`: unique, ascending, seven gates, no collision with the WSNP station titles. |
| `apps/worker/src/ops/case-history-seed.ts` (create) | ALL seed data and its types. No database calls, no I/O. This is where the case is written down. |
| `apps/worker/src/ops/case-history.ts` (modify) | The apply logic and the CLI entry point only. Nested tracks, corrections, retirements, the stranded-on-spine guard. |
| `apps/worker/src/ops/case-history.test.ts` (modify) | Structural checks on the seed. Pure, no database. |
| `apps/worker/src/ops/case-history-layout.test.ts` (create) | Feeds the seed through `buildTrackMap` and asserts the map draws: `problems: []`, and the headline lands on the open task in Onboarding. |
| `apps/web/src/lib/track-marks.ts` (modify) | `stopSourceLabel` — where a stop points at an entry, the entry's channel wins. Pure. |
| `apps/web/src/lib/track-marks.test.ts` (modify) | Its unit tests. |
| `apps/web/src/app/(app)/timeline/page.tsx` (modify) | Renders the source label in the stop panel. |
| `docs/deploy.md`, `CLAUDE.md` (modify) | The run order, and why it runs from the host. |

---

### Task 1: The spine skeleton

The main line becomes seven phase gates, and there is exactly ONE spelling of
them: an exported constant that `ensureCaseMap` loops over and the backfill's
stranded-on-spine guard reads. Today the list is duplicated between
`seed-case-map.ts` and `case-history.ts`'s `SPINE_ANCHORS`, which is how the two
drift.

**Files:**
- Modify: `packages/db/src/seed-case-map.ts:29-55` (titles + `SPINE_SEED`), `:103-141` (the anchor writes)
- Create: `packages/db/src/seed-case-map.test.ts`

**Interfaces:**
- Produces: `SPINE_STOPS: readonly { title: string; orderIndex: number; state: "done"|"open"|"expected" }[]` and `WSNP_STATION_TITLES: readonly string[]`, both exported from `@verder/db`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/seed-case-map.test.ts`:

```ts
// The main line, as questions about the constant rather than about a database.
// It is the one spelling of the spine — case-history reads it for its
// stranded-on-spine guard and its tests — so a drift here is a drift everywhere.
import { describe, expect, it } from "vitest";
import { SPINE_STOPS, WSNP_STATION_TITLES } from "./seed-case-map";

describe("SPINE_STOPS", () => {
  it("is the seven phase gates, in order", () => {
    expect(SPINE_STOPS.map((s) => s.title)).toEqual([
      "Aanmelding bewindvoering",
      "Start bewindvoering",
      "Onboarding voltooid",
      "Nog onbekend",
      "Start schuldhulpverlening",
      "Schone lei verkregen",
      "Einde bewindvoering",
    ]);
  });

  it("runs strictly forward, so a gate never has to be renumbered", () => {
    const orders = SPINE_STOPS.map((s) => s.orderIndex);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("dates nothing and claims nothing about the future", () => {
    // Only the two gates the mailbox proves are `done`; the rest are expected,
    // because the app does not assert a phase it has no evidence for.
    expect(SPINE_STOPS.filter((s) => s.state === "done").map((s) => s.title))
      .toEqual(["Aanmelding bewindvoering", "Start bewindvoering"]);
  });

  it("never collides with a WSNP station title", () => {
    // Stop lookup is map-wide by title. "Schone lei" is WSNP's clean-slate
    // station, which is why the spine's gate is "Schone lei verkregen".
    for (const s of SPINE_STOPS) expect(WSNP_STATION_TITLES).not.toContain(s.title);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter @verder/db exec vitest run src/seed-case-map.test.ts`
Expected: FAIL — `SPINE_STOPS` and `WSNP_STATION_TITLES` are not exported.

- [ ] **Step 3: Rewrite the spine in `seed-case-map.ts`**

Replace the `START_TITLE` / `GOAL_TITLE` / `GOAL_ORDER` / `SPINE_SEED` block
(lines 32–55) with:

```ts
/**
 * The MAIN LINE, and the only spelling of it.
 *
 * A stop on the root track marks a moment the case changed PHASE. Nothing else
 * may sit there: a metro map's trunk shows where the line goes, not every
 * errand run along it, and everything that happened is work that belongs on a
 * spoor. `applyCaseHistory` reads this list to prove the trunk stayed bare.
 *
 * `Start bewindvoering` is dated at the BESCHIKKING (14 July), not at Team
 * Opstart's first mail (27 July): that is when the bewind legally began. The
 * date itself is a one-time correction in the backfill, not a value here —
 * this module seeds structure and refuses to invent facts.
 *
 * `Nog onbekend` is deliberate. Martin does not yet know what follows the
 * onboarding, and an expected stop with an honest title is the app saying so.
 * Inventing a plausible next phase would be the app claiming something nobody
 * measured.
 *
 * `Schone lei verkregen`, NOT `Schone lei`: WSNP already owns a station under
 * that exact title and stop lookup is map-wide, so two rows would fight over
 * one row on every run.
 */
export const SPINE_STOPS = [
  { title: "Aanmelding bewindvoering", orderIndex: 0, state: "done" },
  { title: "Start bewindvoering", orderIndex: 200, state: "done" },
  { title: "Onboarding voltooid", orderIndex: 300, state: "expected" },
  { title: "Nog onbekend", orderIndex: 400, state: "expected" },
  { title: "Start schuldhulpverlening", orderIndex: 500, state: "expected" },
  { title: "Schone lei verkregen", orderIndex: 600, state: "expected" },
  // Room for everything between the gates, so nothing ever needs a renumber.
  { title: "Einde bewindvoering", orderIndex: 1_000_000, state: "expected" },
] as const satisfies readonly { title: string; orderIndex: number;
  state: (typeof schema.stopStateEnum.enumValues)[number] }[];

const START_TITLE = SPINE_STOPS[0].title;
const GOAL_TITLE = SPINE_STOPS[SPINE_STOPS.length - 1].title;
```

`ROOT_TITLE` stays `"Einde bewindvoering"` (the root track is named for its
goal, and the goal gate shares that title — that is unchanged).

Below `WSNP_STAGE_SEED`, add:

```ts
/** The six station titles, exported so no other seed may collide with them. */
export const WSNP_STATION_TITLES: readonly string[] =
  WSNP_STAGE_SEED.map((s) => s.title);
```

- [ ] **Step 4: Make `ensureCaseMap` seed the whole spine from that list**

Replace the three separate anchor blocks (the `start`, `goal` and `SPINE_SEED`
loops, lines 110–141) with one loop, keeping `start` and `goal` for WSNP's
wiring:

```ts
  // Every gate from ONE list, guarded on title so a database that already has
  // them is left alone. No dates: a now() here would render as
  // "Aanmelding bewindvoering · vandaag", a claim about when Martin's case began
  // that nobody measured.
  const byTitle = new Map<string, typeof schema.stops.$inferSelect>();
  for (const gate of SPINE_STOPS) {
    let row = await stopOnRoot(gate.title);
    if (!row) {
      [row] = await db.insert(schema.stops).values({
        trackId: root.id, orderIndex: gate.orderIndex, title: gate.title,
        kind: "process", state: gate.state,
      }).returning();
      created.spineStops.push(gate.title);
    }
    byTitle.set(gate.title, row);
  }
  const start = byTitle.get(START_TITLE)!;
  const goal = byTitle.get(GOAL_TITLE)!;
```

Drop `created.startStop` / `created.goalStop` from `EnsureCaseMapResult` and its
initialiser — `spineStops` now reports all seven, and two booleans that meant
"the first and last of that list" are a second vocabulary for the same fact.
`verify.test.ts:43` calls `ensureCaseMap(db)` and ignores its result, so nothing
else has to change for that.

Update the doc comment above `ensureCaseMap` to say it is the ONE spelling of
the spine and that migrations 0023/0024 are historical: they seeded `Start`,
`Aanvraag bewindvoering` and `bewindvoering`, and the backfill renames and
retires those.

Widen the package's export, or nothing outside `@verder/db` can read the list —
`packages/db/src/index.ts:3` currently exports `ensureCaseMap` alone:

```ts
export {
  ensureCaseMap, SPINE_STOPS, WSNP_STATION_TITLES, type EnsureCaseMapResult,
} from "./seed-case-map";
```

- [ ] **Step 5: Run the test and the packages that import the result**

Run: `env -u NODE_ENV pnpm --filter @verder/db exec vitest run src/seed-case-map.test.ts`
Expected: PASS (4 tests).

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: FAIL only in `apps/worker/src/ops/case-history.ts`, on the
`SPINE_ANCHORS` array that still names `"Start"` — Task 6 replaces it. If any
other file breaks, fix it here.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/seed-case-map.ts packages/db/src/seed-case-map.test.ts
git commit -m "feat(db): the main line is seven phase gates, spelled once"
```

---

### Task 2: Split the seed out of the script

`case-history.ts` is 856 lines and this plan roughly doubles its data. Data and
apply logic are two responsibilities, and the tests only ever want the data.
**No behaviour change in this task** — a pure move, so the diff that follows is
readable.

**Files:**
- Create: `apps/worker/src/ops/case-history-seed.ts`
- Modify: `apps/worker/src/ops/case-history.ts`, `apps/worker/src/ops/case-history.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `case-history-seed.ts` exports every one of `StopSeed`, `TrackSeed`, `TaskSeed`, `PARTY_SEED`, `SPINE_DATES`, `STOP_RENAMES`, `TRACK_RENAMES`, `SPINE_SEED`, `TRACK_SEED`, `TASK_SEED`, and the `at()` helper. `case-history.ts` keeps `CaseHistoryResult` and `applyCaseHistory`.

- [ ] **Step 1: Move the data**

Cut everything from the `// --- the source material ---` banner (line 38) down to
the end of `TASK_SEED` (line 567) into the new file. Give it this header:

```ts
// The case as it actually ran, written down.
//
// PURE DATA. No database, no I/O, no imports from the apply side — which is
// what lets case-history.test.ts ask every structural question about the map
// without a Postgres anywhere near it.
//
// STRUCTURE IS THIS FILE'S, CONTENT IS MARTIN'S. On a stop that already exists
// the script writes only its track, its position and any still-null evidence
// link. Titles, notes, dates and states are his, and a backfill that reverted
// his edits every time it ran would be worse than no backfill.
import { schema } from "@verder/db";
```

Keep the `at()` helper with the data and export it (the tests will want it).

- [ ] **Step 2: Re-point the imports**

In `case-history.ts`, replace the moved block with:

```ts
import {
  PARTY_SEED, SPINE_DATES, SPINE_SEED, STOP_RENAMES, TASK_SEED, TRACK_RENAMES,
  TRACK_SEED, type StopSeed,
} from "./case-history-seed";
```

In `case-history.test.ts`, change the import path from `"./case-history"` to
`"./case-history-seed"`.

- [ ] **Step 3: Run the tests — they must be untouched and green**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: PASS, the same 12 tests as before the move.

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: the same single failure from Task 1 and nothing new.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "refactor(worker): case-history's seed moves to its own module"
```

---

### Task 3: Nested tracks

A track may hang under another track. Its branch and merge points resolve on its
**parent**, not on the root, and an existing track's parent is rewired like its
branch points already are. Tracks are processed in seed order and each track's
stops are written immediately after it, so a child's branch point exists by the
time the child is created.

**Files:**
- Modify: `apps/worker/src/ops/case-history-seed.ts` (the `TrackSeed` interface)
- Modify: `apps/worker/src/ops/case-history.ts` (the track loop, ~lines 777–813)
- Modify: `apps/worker/src/ops/case-history.test.ts`

**Interfaces:**
- Produces: `TrackSeed.parent?: string` and `TrackSeed.forTask?: string`; `CaseHistoryResult.reparented: string[]`.

- [ ] **Step 1: Write the failing tests**

Replace the existing test `"branches and merges every track at a stop that is
actually on the root"` in `case-history.test.ts` with:

```ts
  /** Every stop title the seed puts on a given track. */
  const stopsOf = (title: string) =>
    TRACK_SEED.find((t) => t.title === title)?.stops.map((s) => s.title) ?? [];

  /** The stop titles a track may branch or merge at: its parent's. */
  const parentStops = (t: TrackSeed) =>
    t.parent ? stopsOf(t.parent) : SPINE_STOPS.map((s) => s.title);

  it("declares every parent before the track that hangs under it", () => {
    // The apply loop creates tracks in seed order and writes each track's stops
    // straight after it, so a child's branch point exists by the time the child
    // is created. A parent declared later would throw mid-run in production.
    const seen = new Set<string>();
    for (const t of TRACK_SEED) {
      if (t.parent) expect(seen, `"${t.title}" hangs under "${t.parent}"`).toContain(t.parent);
      seen.add(t.title);
    }
  });

  it("branches and merges every track on its OWN parent", () => {
    for (const t of TRACK_SEED) {
      const allowed = parentStops(t);
      expect(allowed, `${t.title} branches at "${t.branchesAt}"`).toContain(t.branchesAt);
      if (t.mergesAt) {
        expect(allowed, `${t.title} merges at "${t.mergesAt}"`).toContain(t.mergesAt);
      }
    }
  });

  it("never merges a track back before it left", () => {
    // buildTrackMap refuses a merge that would close a loop and reports it as a
    // problem instead of drawing it. Better never to ship one.
    const orderOn = (parent: string | undefined, title: string) => {
      const list = parent
        ? TRACK_SEED.find((t) => t.title === parent)!.stops
        : SPINE_STOPS.map((s) => ({ title: s.title, orderIndex: s.orderIndex }));
      return list.find((s) => s.title === title)!.orderIndex;
    };
    for (const t of TRACK_SEED) {
      if (!t.mergesAt) continue;
      expect(orderOn(t.parent, t.mergesAt),
        `${t.title} merges at "${t.mergesAt}", at or before "${t.branchesAt}"`)
        .toBeGreaterThan(orderOn(t.parent, t.branchesAt));
    }
  });

  it("keeps track titles unique across the whole map", () => {
    // Track lookup is map-wide by title too, because a track whose PARENT moves
    // cannot be found by (title, parent) any more.
    const titles = TRACK_SEED.map((t) => t.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
    expect(titles).not.toContain("Einde bewindvoering"); // the root's own title
  });
```

Add the imports it needs: `SPINE_STOPS` from `@verder/db`, and `type TrackSeed`
from `./case-history-seed`.

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: FAIL — `TrackSeed` has no `parent`, and `SPINE_STOPS` does not contain
`"Aanvraag bewindvoering"`, which the current seed branches at.

- [ ] **Step 3: Extend `TrackSeed`**

In `case-history-seed.ts`:

```ts
export interface TrackSeed {
  title: string;
  status: TrackStatus;
  note: string;
  /**
   * Title of the track this one hangs under. Absent = the main line.
   *
   * A parent MUST be declared earlier in TRACK_SEED: the apply loop writes each
   * track's stops straight after creating it, which is the only reason a child
   * can branch at a stop on its parent.
   */
  parent?: string;
  /** Title of the stop ON THE PARENT this track leaves from. */
  branchesAt: string;
  /** Title of the stop ON THE PARENT it rejoins, if it rejoins at all. */
  mergesAt?: string;
  /**
   * The task this track is the branch of. A task is a branch that comes back:
   * it leaves at the stop where the work was asked for and carries the single
   * stop where it is fulfilled — `expected` while the work is still owed, so
   * the map states what is outstanding without anyone writing it down twice.
   */
  forTask?: string;
  stops: StopSeed[];
}
```

- [ ] **Step 4: Rewrite the track loop**

In `case-history.ts`, replace the two loops at lines 777–813 with one. Add
`trackAnywhere` next to `stopAnywhere`:

```ts
  /**
   * Find a track by title ANYWHERE, not under the parent the seed gives it.
   *
   * The same reason `stopAnywhere` exists: this restructure MOVES tracks —
   * WSNP stops being a peer of the main line and becomes a sub-track of
   * Schuldhulpverlening — and a lookup scoped to (title, parent) cannot
   * recognise the row it is about to reparent. It would insert a second WSNP,
   * and `tracks` has no DELETE to clean up after that.
   */
  const trackAnywhere = async (title: string) => {
    const [t] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, title))
      .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
    return t;
  };

  // Tracks in SEED ORDER, each followed immediately by its own stops. A child's
  // branch point is a stop on its parent, so the parent's stops must be on the
  // map before the child is created — which is exactly what this ordering
  // buys, and why the test asserts parents come first.
  const trackByTitle = new Map<string, typeof schema.tracks.$inferSelect>();
  for (const seed of TRACK_SEED) {
    const parent = seed.parent ? trackByTitle.get(seed.parent) : root;
    if (!parent) throw new Error(
      `track "${seed.title}" hangs under "${seed.parent}", which the seed has not created yet`);

    const branch = await stopOn(parent.id, seed.branchesAt);
    if (!branch) throw new Error(
      `track "${seed.title}" branches at "${seed.branchesAt}", which is not on "${parent.title}"`);
    const merge = seed.mergesAt ? await stopOn(parent.id, seed.mergesAt) : undefined;
    if (seed.mergesAt && !merge) throw new Error(
      `track "${seed.title}" merges at "${seed.mergesAt}", which is not on "${parent.title}"`);

    let track = await trackAnywhere(seed.title);
    if (!track) {
      [track] = await db.insert(schema.tracks).values({
        title: seed.title, status: seed.status, parentTrackId: parent.id,
        branchesAtStopId: branch.id, mergesAtStopId: merge?.id ?? null,
        note: seed.note,
      }).returning();
      out.tracks.push(seed.title);
    } else {
      // Geometry is the seed's; status and note are Martin's and are never
      // written back over.
      const patch: Record<string, unknown> = {};
      if (track.parentTrackId !== parent.id) patch.parentTrackId = parent.id;
      if (track.branchesAtStopId !== branch.id) patch.branchesAtStopId = branch.id;
      if (track.mergesAtStopId !== (merge?.id ?? null)) patch.mergesAtStopId = merge?.id ?? null;
      if (Object.keys(patch).length) {
        await db.update(schema.tracks).set(patch).where(eq(schema.tracks.id, track.id));
        if (patch.parentTrackId) out.reparented.push(`${seed.title} → ${parent.title}`);
        else out.rewired.push(seed.title);
      }
      track = { ...track, ...patch } as typeof track;
    }
    trackByTitle.set(seed.title, track);

    for (const stop of seed.stops) await writeStop(track.id, stop);
  }
```

Add `reparented: string[]` to `CaseHistoryResult` and to the initialiser at
line 596, with the comment `/** Tracks the seed moved under a different parent. */`.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: the three new structural tests PASS; the branch/merge test still FAILS
because the current seed branches at `"Aanvraag bewindvoering"`, a root stop this
plan retires. That is Task 6's content. Leave it red and say so in the commit.

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "feat(worker): tracks may hang under tracks, and branch on their parent

The seed's branch and merge points resolve on the parent track; a track whose
parent moves is found map-wide by title and rewired rather than duplicated.
The content that uses it lands two commits from here, so the seed's own
branch/merge assertion is red until then."
```

---

### Task 4: Renames first, and one-time corrections

Two mechanisms, one commit, because they are the same rule: a backfill may
repair a value a *migration* wrote, and may never touch a value *Martin* wrote.

The ordering bug this fixes is real and would be silent: `ensureCaseMap` now
seeds `Aanmelding bewindvoering`, and production holds that same station under
its old name `Start`. Seeding before renaming inserts a second row and then
renames the first one onto its title — two stations, one fact, and `stops` has
no DELETE.

**Files:**
- Modify: `apps/worker/src/ops/case-history.ts:677-696` (move the renames above `ensureCaseMap`), `:758-767` (`SPINE_DATES` → `STOP_CORRECTIONS`)
- Modify: `apps/worker/src/ops/case-history-seed.ts`
- Modify: `apps/worker/src/ops/case-history.test.ts`

**Interfaces:**
- Produces: `StopCorrection` and `STOP_CORRECTIONS` replace `SPINE_DATES`; `CaseHistoryResult.corrected: string[]` replaces `spineDated`.

- [ ] **Step 1: Write the failing tests**

Replace the `"dates only the two anchors 0024 deliberately left undated"` test
with:

```ts
  it("corrects only values a migration wrote, and says what it expects to find", () => {
    // A correction fires ONLY while the row still holds the value the migration
    // gave it, so a hand edit always wins. Without the expectation there is no
    // way to tell "0024 left this undated" from "Martin cleared it on purpose".
    for (const c of STOP_CORRECTIONS) {
      expect(Object.keys(c.expect).length, `correction "${c.title}" expects nothing`)
        .toBeGreaterThan(0);
      expect(Object.keys(c.set).length, `correction "${c.title}" sets nothing`)
        .toBeGreaterThan(0);
      expect(c.reason, `correction "${c.title}" has no reason`).toBeTruthy();
      // Never a field the correction is also asked to leave alone.
      for (const key of Object.keys(c.set)) {
        if (key === "note") continue;
        expect(c.expect, `correction "${c.title}" sets ${key} without expecting it`)
          .toHaveProperty(key);
      }
    }
  });

  it("corrects a stop the map actually has, under the name it will have", () => {
    // Corrections run AFTER the renames, so they key on the new title.
    const known = new Set([
      ...SPINE_STOPS.map((s) => s.title),
      ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.title)),
    ]);
    for (const c of STOP_CORRECTIONS) expect(known, `correction "${c.title}"`).toContain(c.title);
  });

  it("renames onto a title the seed uses, and away from one it does not", () => {
    // A rename whose target nothing claims strands the row under a name nothing
    // adopts. A rename whose SOURCE the seed re-creates is worse: the next run
    // renames the fresh row too, and there are then two rows for one fact.
    const seedTitles = new Set([
      ...SPINE_STOPS.map((s) => s.title),
      ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.title)),
      ...WSNP_STATION_TITLES,
    ]);
    for (const r of STOP_RENAMES) {
      expect(seedTitles, `rename target "${r.to}"`).toContain(r.to);
      expect(seedTitles, `rename source "${r.from}"`).not.toContain(r.from);
    }
    const trackTitles = new Set(TRACK_SEED.map((t) => t.title));
    for (const r of TRACK_RENAMES) {
      expect(trackTitles, `rename target "${r.to}"`).toContain(r.to);
      expect(trackTitles, `rename source "${r.from}"`).not.toContain(r.from);
    }
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: FAIL — `STOP_CORRECTIONS` is not exported.

- [ ] **Step 3: Replace `SPINE_DATES` with `STOP_CORRECTIONS`**

In `case-history-seed.ts`, delete `SPINE_DATES` and add:

```ts
/**
 * A one-time repair of a value a MIGRATION wrote, never of a value Martin wrote.
 *
 * The whole seed is otherwise forbidden from touching `state`, `kind`, `note`
 * and `happened_at` — those are the fields the editor lets him change. A
 * correction is the single exception, and it earns it by stating what it
 * expects to find: it fires only while the row still holds the value the
 * migration gave it, so a hand edit always wins and a second run is a no-op.
 */
export interface StopCorrection {
  /** The title AFTER the renames — corrections run behind them. */
  title: string;
  reason: string;
  /** Every field here must match the row exactly, or nothing is written. */
  expect: { state?: StopState; happenedAt?: Date | null };
  set: { state?: StopState; happenedAt?: Date; note?: string };
}

export const STOP_CORRECTIONS: StopCorrection[] = [
  {
    title: "Aanmelding bewindvoering",
    reason: "0023 seeded the Start anchor undated. The mailbox dates it: the " +
      "aanmelding at Verder and its confirmation, both 16-04-2026.",
    expect: { happenedAt: null },
    set: { happenedAt: at("2026-04-16"),
      note: "De aanmelding bij Verder, met een bevestiging binnen een dag." },
  },
  {
    title: "Start bewindvoering",
    reason: "0024 left this `open` — the period he was in. It is a phase GATE " +
      "now: the moment the bewind began, which is done and dated.",
    expect: { state: "open" },
    set: { state: "done" },
  },
  {
    title: "Start bewindvoering",
    reason: "Dated at the BESCHIKKING, not at Team Opstart's first mail of " +
      "27-07: 14 July is when the bewind legally began.",
    expect: { happenedAt: null },
    set: { happenedAt: at("2026-07-14"),
      note: "Vanaf de beschikking van de rechtbank, zaak NLTZ2612548IVB. " +
        "Team Opstart meldde zich pas op 27 juli — dit is de datum waarop het " +
        "bewind juridisch begon." },
  },
  {
    title: "KvK — aanmaning op OpsMate",
    reason: "The mail ARRIVING is a fact and is done; what is still open is " +
      "reporting it, and that now lives on its own task branch.",
    expect: { state: "open" },
    set: { state: "done" },
  },
  {
    title: "Trust and Law — PLM Investments, € 2.623,15",
    reason: "Same: the arrival is done, the melding is the task.",
    expect: { state: "open" },
    set: { state: "done" },
  },
  {
    title: "Stam — Het CAK, € 1.141,61, er ligt een vonnis",
    reason: "Same: the arrival is done, the melding is the task.",
    expect: { state: "open" },
    set: { state: "done" },
  },
];
```

Note the third correction's `happenedAt: null` expectation: production already
carries 14-07 from the previous run, so it is a no-op there and fills the date in
on a fresh database.

- [ ] **Step 4: Move the renames above `ensureCaseMap` and apply the corrections**

In `case-history.ts`, cut the two rename loops (lines 687–696) and paste them
**above** the `await ensureCaseMap(db)` call at line 678, with this comment:

```ts
  // RENAMES BEFORE THE SKELETON, not just before the guards.
  //
  // ensureCaseMap now seeds the NEW spine, and production holds those same
  // stations under their old names — `Start` is `Aanmelding bewindvoering`.
  // Seeding first would find no `Aanmelding bewindvoering`, insert one, and
  // then this loop would rename `Start` onto the same title: two stations for
  // one fact, and `stops` has no DELETE to undo it.
  //
  // Renames are map-wide by title and need no root, so they are safe to run
  // before there is a map at all — on an empty database they simply match
  // nothing.
```

Replace the `SPINE_DATES` loop (lines 758–767) with, placed directly after the
`root` lookup:

```ts
  // Corrections, before any track is wired: they repair the value a migration
  // wrote and are the ONLY place this script writes state, date or note onto a
  // stop that already exists.
  for (const c of STOP_CORRECTIONS) {
    const [row] = await db.select().from(schema.stops)
      .where(eq(schema.stops.title, c.title))
      .orderBy(asc(schema.stops.createdAt), asc(schema.stops.id)).limit(1);
    if (!row) continue;
    const holds =
      (c.expect.state === undefined || row.state === c.expect.state) &&
      (c.expect.happenedAt === undefined
        || (c.expect.happenedAt === null
          ? row.happenedAt === null
          : row.happenedAt?.getTime() === c.expect.happenedAt.getTime()));
    if (!holds) continue;
    const patch: Record<string, unknown> = {};
    if (c.set.state !== undefined) patch.state = c.set.state;
    if (c.set.happenedAt !== undefined) patch.happenedAt = c.set.happenedAt;
    // A note Martin has already written is his; a correction only fills a gap.
    if (c.set.note !== undefined && !row.note) patch.note = c.set.note;
    await db.update(schema.stops).set(patch).where(eq(schema.stops.id, row.id));
    out.corrected.push(`${c.title}: ${Object.keys(patch).join(", ")}`);
  }
```

Rename `spineDated` to `corrected` in `CaseHistoryResult` and its initialiser.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: the correction and rename tests PASS. The branch/merge test is still
red (Task 6).

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "feat(worker): renames run before the skeleton, and corrections state what they expect"
```

---

### Task 5: Retirement — the only delete

A row that duplicates a fact already on the map is removed rather than renamed
to something untrue. It is enumerated with a reason, guarded three ways for
stops and three ways for tracks, and it **fails loudly** rather than proceeding
when a guard trips.

`GRANT SELECT, INSERT, UPDATE ON tracks, stops TO verder_app, verder_worker` —
the running app can never do this, and that stays true. The owner role `verder`
can, which is why the production run moves to the host.

**Files:**
- Modify: `apps/worker/src/ops/case-history-seed.ts`, `apps/worker/src/ops/case-history.ts`, `apps/worker/src/ops/case-history.test.ts`

**Interfaces:**
- Produces: `STOP_RETIREMENTS`, `TRACK_RETIREMENTS` (`{ title: string; reason: string }[]`); `CaseHistoryResult.retiredStops` / `.retiredTracks: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
  it("retires only rows the seed does not claim, and nothing points at", () => {
    const stopTitles = new Set([
      ...SPINE_STOPS.map((s) => s.title),
      ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.title)),
      ...WSNP_STATION_TITLES,
    ]);
    for (const r of STOP_RETIREMENTS) {
      expect(r.reason, `retirement "${r.title}" has no reason`).toBeTruthy();
      // Retiring a title the seed re-creates is an infinite loop with a delete
      // in it: the seed inserts it, the retirement removes it, every run.
      expect(stopTitles, `retirement "${r.title}"`).not.toContain(r.title);
      // Nothing may still branch or merge at it. Retirement runs AFTER the
      // rewiring, so this is a statement about the seed's final geometry.
      for (const t of TRACK_SEED) {
        expect(t.branchesAt, `${t.title} branches at retired "${r.title}"`).not.toBe(r.title);
        expect(t.mergesAt ?? "", `${t.title} merges at retired "${r.title}"`).not.toBe(r.title);
      }
    }
    const trackTitles = new Set(TRACK_SEED.map((t) => t.title));
    for (const r of TRACK_RETIREMENTS) {
      expect(r.reason, `retirement "${r.title}" has no reason`).toBeTruthy();
      expect(trackTitles, `retirement "${r.title}"`).not.toContain(r.title);
      for (const t of TRACK_SEED) {
        expect(t.parent ?? "", `${t.title} hangs under retired "${r.title}"`).not.toBe(r.title);
      }
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: FAIL — `STOP_RETIREMENTS` is not exported.

- [ ] **Step 3: Write the lists**

In `case-history-seed.ts`:

```ts
/**
 * Rows that duplicate a fact already on the map. THE ONLY DELETE in this
 * script, and the reason it exists at all: renaming a row to something untrue
 * to keep it alive would be worse than removing a display row that was never
 * evidence.
 *
 * Never a pattern, never a heuristic — an enumerated row with a stated reason,
 * and three guards in the apply step that make the run FAIL rather than proceed.
 * `tracks` and `stops` are not evidence, so nothing here touches the ledger.
 */
export const STOP_RETIREMENTS = [
  { title: "Aanvraag bewindvoering",
    reason: "0024 put the application on the main line. The main line carries " +
      "phase GATES now, and this exact fact already sits on the Aanvraag track " +
      "as `Verzoek onderbewindstelling ingediend`, dated the same day and with " +
      "the plan van aanpak attached to it." },
] as const satisfies readonly { title: string; reason: string }[];

/**
 * Tracks the consolidation empties. A track with no stops still draws — a short
 * named stub one column right of where it branched — so leaving them behind
 * would put three rails on the map that mean nothing.
 */
export const TRACK_RETIREMENTS = [
  { title: "Moratorium",
    reason: "Absorbed into `Dreigende ontruiming`. One eviction threat, two " +
      "routes tried at once; three tracks made the map claim three storylines " +
      "where the case had one." },
  { title: "Schuldhulpverlening Almere",
    reason: "Absorbed into `Dreigende ontruiming` for the same reason — the " +
      "crisis dossier was opened and closed inside that one storyline." },
  { title: "Bankrekening en leefgeld",
    reason: "Folded into `Onboarding`. The account takeover, the leefgeld, the " +
      "pincode letter and the card are all things Team Opstart did during the " +
      "onboarding." },
] as const satisfies readonly { title: string; reason: string }[];
```

- [ ] **Step 4: Apply them, after the wiring and before the stranded check**

In `case-history.ts`, add to the imports `or` from `drizzle-orm`, and insert
after the track loop:

```ts
  // --- retirement ------------------------------------------------------------
  // AFTER the rewiring, never before: the side tracks used to branch at the
  // stop being retired, and deleting a row a track still points at would fail
  // on the foreign key — or, worse, succeed and orphan the track.
  if (STOP_RETIREMENTS.length || TRACK_RETIREMENTS.length) {
    const [{ ok }] = (await db.execute(sql`
      SELECT has_table_privilege(current_user, 'stops', 'DELETE')
         AND has_table_privilege(current_user, 'tracks', 'DELETE') AS ok`))
      .rows as [{ ok: boolean }];
    if (!ok) throw new Error(
      "this run has retirements to make and no DELETE on tracks/stops. The app " +
      "roles deliberately do not have it. Run it from the homelab HOST as the " +
      "owner role instead:\n" +
      "  DATABASE_URL=postgres://verder:<pw>@localhost:5432/verder \\\n" +
      "    pnpm --filter worker case-history");
  }

  for (const r of STOP_RETIREMENTS) {
    const [row] = await db.select().from(schema.stops)
      .where(eq(schema.stops.title, r.title))
      .orderBy(asc(schema.stops.createdAt), asc(schema.stops.id)).limit(1);
    if (!row) continue; // already retired: this is what idempotent looks like
    // A stop with evidence is not a duplicate display row. Re-home it by hand.
    if (row.entryId || row.taskId || row.documentId) throw new Error(
      `refusing to retire "${r.title}": it points at evidence (entry/task/document)`);
    const wired = await db.select({ title: schema.tracks.title }).from(schema.tracks)
      .where(or(eq(schema.tracks.branchesAtStopId, row.id),
        eq(schema.tracks.mergesAtStopId, row.id)));
    if (wired.length) throw new Error(
      `refusing to retire "${r.title}": ${wired.map((t) => `"${t.title}"`).join(", ")} ` +
      "still branch or merge at it");
    await db.delete(schema.stops).where(eq(schema.stops.id, row.id));
    out.retiredStops.push(r.title);
  }

  for (const r of TRACK_RETIREMENTS) {
    const row = await trackAnywhere(r.title);
    if (!row) continue;
    if (row.parentTrackId === null) throw new Error(
      `refusing to retire "${r.title}": it is the main line`);
    const [{ n: stopCount }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM stops WHERE track_id = ${row.id}`))
      .rows as [{ n: number }];
    if (stopCount > 0) throw new Error(
      `refusing to retire "${r.title}": ${stopCount} halte(s) are still on it — ` +
      "the seed was supposed to move them first");
    const [{ n: childCount }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM tracks WHERE parent_track_id = ${row.id}`))
      .rows as [{ n: number }];
    if (childCount > 0) throw new Error(
      `refusing to retire "${r.title}": ${childCount} spoor(en) still hang under it`);
    await db.delete(schema.tracks).where(eq(schema.tracks.id, row.id));
    out.retiredTracks.push(r.title);
  }
```

Add `retiredStops: string[]` and `retiredTracks: string[]` to
`CaseHistoryResult` and its initialiser.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history.test.ts`
Expected: the retirement test PASSES. The branch/merge test is still red.

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "feat(worker): enumerated, triple-guarded retirement of duplicate rows"
```

---

### Task 6: The new map

The content. Seven storylines, three consolidated into one, WSNP reparented, the
main line bare. **No task branches yet** — Task 7 — so this task ends with a map
that draws and a headline that is still the old one.

**Files:**
- Modify: `apps/worker/src/ops/case-history-seed.ts` (`SPINE_SEED`, `TRACK_RENAMES`, `TRACK_SEED`)
- Modify: `apps/worker/src/ops/case-history.ts` (`SPINE_ANCHORS`)
- Create: `apps/worker/src/ops/case-history-layout.test.ts`

**Interfaces:**
- Consumes: `SPINE_STOPS` (Task 1), `TrackSeed.parent` (Task 3).
- Produces: the final `TRACK_SEED`.

- [ ] **Step 1: Write the failing layout test**

Create `apps/worker/src/ops/case-history-layout.test.ts`:

```ts
/**
 * Does the seed DRAW?
 *
 * Every other test here asks a question about the seed. This one asks the only
 * question that matters to the page: fed through buildTrackMap — the same pure
 * layout the router uses — does it produce a map with no problems, and does the
 * headline land where Martin needs it?
 *
 * No database: the seed is turned into rows with synthetic ids, which is all
 * buildTrackMap ever wanted.
 */
import { describe, expect, it } from "vitest";
import { SPINE_STOPS } from "@verder/db";
import { buildTrackMap, type StopRow, type TrackRow } from "@verder/api/src/track-map";
import { TRACK_SEED } from "./case-history-seed";

const ROOT_ID = "root";
const stopId = (track: string, title: string) => `${track}::${title}`;

function rows(): { tracks: TrackRow[]; stops: StopRow[] } {
  const tracks: TrackRow[] = [{
    id: ROOT_ID, title: "Einde bewindvoering", status: "open",
    parentTrackId: null, branchesAtStopId: null, mergesAtStopId: null, note: null,
  }];
  const stops: StopRow[] = SPINE_STOPS.map((s) => ({
    id: stopId(ROOT_ID, s.title), trackId: ROOT_ID, orderIndex: s.orderIndex,
    title: s.title, kind: "process", state: s.state, happenedAt: null,
    expectedAt: null, stage: null, entryId: null, taskId: null,
    documentId: null, note: null,
  }));
  const idOfTrack = new Map<string, string>();
  for (const t of TRACK_SEED) {
    const parentId = t.parent ? idOfTrack.get(t.parent)! : ROOT_ID;
    idOfTrack.set(t.title, t.title);
    tracks.push({
      id: t.title, title: t.title, status: t.status, parentTrackId: parentId,
      branchesAtStopId: stopId(parentId, t.branchesAt),
      mergesAtStopId: t.mergesAt ? stopId(parentId, t.mergesAt) : null,
      note: t.note,
    });
    for (const s of t.stops) {
      stops.push({
        id: stopId(t.title, s.title), trackId: t.title, orderIndex: s.orderIndex,
        title: s.title, kind: s.kind, state: s.state,
        happenedAt: s.happenedAt ?? null, expectedAt: null, stage: null,
        entryId: null, taskId: null, documentId: null, note: s.note ?? null,
      });
    }
  }
  return { tracks, stops };
}

describe("the seeded map", () => {
  it("draws without a single problem", () => {
    // A silently flat map is the worst failure this layout has: a refused
    // branch leaves everything downstream at column 0 and the whole thing still
    // looks like an answer.
    expect(buildTrackMap(rows()).problems).toEqual([]);
  });

  it("keeps the main line bare — seven phase gates and nothing else", () => {
    const map = buildTrackMap(rows());
    const spine = map.stops.filter((s) => s.trackId === ROOT_ID).map((s) => s.title);
    expect(spine.sort()).toEqual(SPINE_STOPS.map((s) => s.title).sort());
  });

  it("gives every storyline its own lane span and never stacks them at column 0", () => {
    const map = buildTrackMap(rows());
    for (const t of map.tracks) {
      if (t.parentTrackId === null) continue;
      expect(t.firstColumn, `${t.title} starts at column 0`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/case-history-layout.test.ts`
Expected: FAIL — the current seed branches at `"Aanvraag bewindvoering"`, which
is not a spine gate, so `stopId` points at a stop that does not exist and the
branch is dropped.

- [ ] **Step 3: Write the storylines**

In `case-history-seed.ts`:

`SPINE_SEED` is deleted entirely — the spine is `SPINE_STOPS` in `@verder/db`
and the backfill puts nothing of its own on the trunk. Remove its import and its
uses in `case-history.ts` (the `spineStops` result field goes with it, and
`wantedDocs` loses its `SPINE_SEED` loop).

`TRACK_RENAMES` becomes:

```ts
export const TRACK_RENAMES = [
  // Absorbed the account and leefgeld stops as well: everything Team Opstart
  // did to get the dossier running is one storyline, and "Opstart en stukken"
  // stopped describing it once the bank takeover moved in.
  { from: "Opstart en stukken", to: "Onboarding" },
  // One crisis, not three. The eviction threat, the moratorium prepared beside
  // it and the gemeente's crisis dossier are one storyline as the case ran.
  { from: "Ontruiming Woonhave", to: "Dreigende ontruiming" },
] as const;
```

`STOP_RENAMES` keeps its two existing entries (they still matter for a database
restored from a dump that carries migration 0023's copied key events) and gains
the two spine renames:

```ts
  // The main line's first station. 0023 called it `Start`, which named the
  // drawing rather than the case; it is the aanmelding, and it has a date.
  { from: "Start", to: "Aanmelding bewindvoering" },
  // 0024 called this `bewindvoering` — the period he is in. As a phase GATE it
  // is the moment that period began.
  { from: "bewindvoering", to: "Start bewindvoering" },
```

`TRACK_SEED` becomes the seven storylines below, **in this order** (parents
first). Everything not called out as new or moved keeps its existing
`orderIndex`, `kind`, `state`, `happenedAt`, `note`, `doc` and `task` exactly as
it is today — this is a re-homing, not a rewrite.

| # | Track | parent | status | branchesAt | mergesAt |
|---|---|---|---|---|---|
| 1 | `Aanvraag bewindvoering` | — | done | Aanmelding bewindvoering | Start bewindvoering |
| 2 | `Onboarding` | — | open | Start bewindvoering | Onboarding voltooid |
| 3 | `Dreigende ontruiming` | — | ended | Start bewindvoering | — |
| 4 | `Schuldeisers buiten het dossier` | — | open | Aanmelding bewindvoering | — |
| 5 | `Schuldregeling` | — | open | Start bewindvoering | Start schuldhulpverlening |
| 6 | `Schuldhulpverlening` | — | open | Start schuldhulpverlening | Schone lei verkregen |
| 7 | `WSNP` | Schuldhulpverlening | open | Toegelaten tot de schuldregeling | Schulden geregeld |

**1 · Aanvraag bewindvoering** — its nine stops are unchanged. Only `branchesAt`
and `mergesAt` move (they pointed at the retired root stop and at
`bewindvoering`).

**2 · Onboarding** — the six stops of `Opstart en stukken` plus the four of
`Bankrekening en leefgeld`, re-ordered by date, plus one new stop and one new
terminal:

| order | title | date | kind | state | task |
|---|---|---|---|---|---|
| 100 | Team Opstart vraagt de opstartstukken | 27-07 | mail | done | — |
| 200 | Heen en weer over de bestandsformaten | 31-07 | mail | done | Bankafschriften in een leesbaar formaat aanleveren |
| 300 | Loonstroken juli en mei ontbreken nog *(new)* | 03-08 | mail | done | — |
| 400 | Rekening overgenomen zonder aankondiging | 05-08 | process | done | — |
| 500 | Klacht over de bejegening | 06-08 | mail | done | Reactie op de klacht over de geblokkeerde rekening |
| 600 | Stukken opgevraagd door Regio 3 | 12-08 | mail | done | — |
| 700 | Betaalpas per spoedpost verstuurd | 18-08 | process | done | — |
| 800 | Leefgeld loopt: € 50 per week | 18-08 | process | done | Betaalpas leefgeldrekening activeren |
| 900 | Alles geleverd wat Verder heeft gevraagd *(new)* | — | document | expected | — |

The new stop 300 carries the note: *"Op 30-07 aan Team Opstart toegezegd dat de
loonstrook van juli volgt; op 03-08 bleek ook die van mei te ontbreken in het
moratoriumpakket."* Stop 900 is the storyline's own terminus — the point every
task branch on this storyline rejoins — with the note *"Zodra alles wat Verder
heeft opgevraagd geleverd is, is de opstart klaar."*

Three stops that were on `Opstart en stukken` are **not** listed here: `Opstart
van het dossier afgerond`, `Stukken aanleveren` and `Aanvragen ingediend bij de
gemeente` move onto task branches in Task 7. Until then, list them at 350, 850
and 875 so the map stays whole between the two commits.

**3 · Dreigende ontruiming** — the four stops of `Ontruiming Woonhave`, the four
of `Moratorium` and the two of `Schuldhulpverlening Almere`, re-ordered by date.
Every field except `orderIndex` is unchanged:

| order | title | date |
|---|---|---|
| 100 | Deurwaarder zegt de ontruiming aan | 29-07 |
| 200 | Verder verzoekt de deurwaarder om opschorting | 30-07 |
| 300 | Spoedverzoek: stukken vóór maandag | 31-07 |
| 400 | Moratoriumpakket aangeleverd | 03-08 |
| 500 | Aanvullende stukken aan André | 04-08 |
| 600 | Toegelaten tot de schuldhulpverlening | 04-08 |
| 700 | Minnelijk voorstel via de deurwaarder | 04-08 |
| 800 | Woonhave akkoord — ontruiming geannuleerd | 06-08 |
| 900 | Niet ingediend — niet meer nodig | 06-08 |
| 1000 | Dossier gesloten — positief beëindigd | 06-08 |

Its `note` is rewritten to cover all three, and must not read as failure:

> "De ontruiming die is afgewend. Eén dreiging, twee routes tegelijk: een
> minnelijk voorstel via de deurwaarder en een moratorium dat klaarlag voor de
> rechtbank. Het akkoord van 6 augustus maakte het moratorium overbodig en het
> crisisdossier bij de gemeente werd positief afgesloten. Geëindigd — en dat is
> een goede afloop."

**4 · Schuldeisers buiten het dossier** — its three stops keep their titles,
dates, docs and tasks. They become `done` through `STOP_CORRECTIONS` (Task 4),
and the seed declares `state: "done"` so a fresh database creates them that way.
One new terminal:

| order | title | state |
|---|---|---|
| 400 | Alles gemeld en in het schuldenoverzicht *(new)* | expected |

**5 · Schuldregeling** — keeps stop 100 (`Verder Almere wacht op de aanmelding`,
06-08) and stop 600 (`Minnelijke schuldregeling voorgesteld`, expected — its
terminus). Stops 200–500 move onto task branches in Task 7; until then leave
them where they are.

**6 · Schuldhulpverlening** *(new track, all stops new)* — the traject that has
not begun. Everything `expected`, therefore undated:

| order | title | kind |
|---|---|---|
| 100 | Aanmelding bij de gemeente | process |
| 200 | Toegelaten tot de schuldregeling | process |
| 300 | Schulden geregeld | process |

`note`: *"Het traject bij de gemeente, zodra het financiële beeld compleet is.
Eerst een minnelijke regeling met alle schuldeisers; lukt dat niet, dan de WSNP."*

**7 · WSNP** — `stops: []`. Its six stage stations belong to `ensureCaseMap`,
and a seed that listed them would fight that skeleton for them. Only its
geometry changes: parent `Schuldhulpverlening`, branching at *Toegelaten tot de
schuldregeling*, merging at *Schulden geregeld*. Its `note` is unchanged.

- [ ] **Step 4: Fix the stranded-on-spine guard**

In `case-history.ts`, replace the `SPINE_ANCHORS` array (lines 819–820) with:

```ts
  // The trunk carries PHASE GATES and nothing else. Anything else still on the
  // root is a stop this seed forgot to re-home, and it would render as a
  // station on a line that is supposed to show only where the case is going.
  const gates = SPINE_STOPS.map((s) => s.title);
```

and use `gates` in the filter below it. Import `SPINE_STOPS` from `@verder/db`.

- [ ] **Step 5: Run every test in the file and the layout test**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/`
Expected: PASS — all of `case-history.test.ts` (the branch/merge test finally
goes green) and all three layout tests.

Run: `env -u NODE_ENV pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "feat(worker): the main line is bare and the storylines are seven

One eviction crisis instead of three tracks, the bank takeover folded into the
onboarding, WSNP under Schuldhulpverlening where it belongs, and a Schuldregeling
that runs to the gate it opens."
```

---

### Task 7: A branch per open task

A task is a branch that comes back. It leaves the storyline at the stop where
the work was asked for and carries the single stop where it is fulfilled —
`expected` while the work is still owed, so the map states what is outstanding
without anyone writing it down twice.

Fourteen branches: one per not-done task whose storyline is still running, plus
the one done branch the spec draws. Lane packing gives task branches that do not
overlap in column the same lane, so this costs a handful of rows and not
fourteen.

**Files:**
- Modify: `apps/worker/src/ops/case-history-seed.ts`, `apps/worker/src/ops/case-history.test.ts`, `apps/worker/src/ops/case-history-layout.test.ts`

**Interfaces:**
- Consumes: `TrackSeed.forTask` (Task 3).
- Produces: `TASKS_WITHOUT_BRANCH: readonly { title: string; reason: string }[]`.

- [ ] **Step 1: Write the failing tests**

In `case-history.test.ts`:

```ts
  const branches = () => TRACK_SEED.filter((t) => t.forTask);

  it("gives every task branch a request point and exactly one fulfilment stop", () => {
    const taskTitles = new Set(TASK_SEED.map((t) => t.title));
    for (const b of branches()) {
      expect(taskTitles, `branch "${b.title}"`).toContain(b.forTask!);
      // The request point is the stop it LEAVES from — the moment the work was
      // asked for — and the fulfilment is the one stop it carries.
      expect(b.stops, `branch "${b.title}" carries ${b.stops.length} stops`).toHaveLength(1);
      expect(b.stops[0].task, `branch "${b.title}" fulfilment`).toBe(b.forTask);
      expect(b.parent, `branch "${b.title}" hangs on nothing`).toBeTruthy();
    }
  });

  it("marks a fulfilment done exactly when its task is done", () => {
    const statusOf = (title: string) =>
      TASK_SEED.find((t) => t.title === title)?.status;
    for (const b of branches()) {
      const done = b.stops[0].state === "done";
      expect(done, `branch "${b.title}"`).toBe(statusOf(b.forTask!) === "done");
    }
  });

  it("accounts for every task that is not closed", () => {
    // Either it has a branch, or the seed says in words why it does not. A
    // silent omission is how outstanding work disappears off the map.
    const closed = new Set(["done", "dropped"]);
    const live = TASK_SEED.filter((t) => !t.status || !closed.has(t.status))
      .map((t) => t.title);
    const covered = new Set([
      ...branches().map((b) => b.forTask!),
      ...TASKS_WITHOUT_BRANCH.map((t) => t.title),
    ]);
    for (const title of live) expect(covered, `task "${title}"`).toContain(title);
    for (const t of TASKS_WITHOUT_BRANCH) expect(t.reason).toBeTruthy();
  });
```

Update the existing `"leaves exactly one open stop as the furthest-right
candidate on its lane"` test's `waitsOnMartin` set to the final list:

```ts
    const waitsOnMartin = new Set([
      "Stukken aanleveren",
      "Loonstrook juli 2026 nagestuurd",
      "Loonstrook mei 2026 opgevraagd bij TrueFullstaq",
      "KvK-aanmaning gemeld bij de bewindvoerder",
      "Vordering Trust and Law gemeld bij de bewindvoerder",
      "Vonnis Stam gemeld bij de bewindvoerder",
      "Financieel beeld compleet, vaste lasten stabiel",
      "Alle schuldeisers aangeschreven met de beschikking",
    ]);
```

In `case-history-layout.test.ts`, add:

```ts
  it("puts the headline on the stukken that wait on Martin", () => {
    const map = buildTrackMap(rows());
    const current = map.stops.find((s) => s.id === map.currentStopId);
    expect(current?.title).toBe("Stukken aanleveren");
  });

  it("stays readable: task branches share lanes when they do not overlap", () => {
    // The rule that makes a branch per task affordable. If this ever exceeds
    // the track count the packing has stopped working.
    const map = buildTrackMap(rows());
    expect(map.laneCount).toBeLessThan(map.tracks.length);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/`
Expected: FAIL — `TASKS_WITHOUT_BRANCH` is not exported and no track has
`forTask`.

- [ ] **Step 3: Write the branches**

Every branch is a `TrackSeed` with `forTask`, `status: "open"` (or `"done"` for
the one fulfilled branch), a `parent`, a `branchesAt` on that parent, a
`mergesAt` on that parent's terminus, and exactly one stop at `orderIndex: 100`.
The moved stops keep every field they have today except `orderIndex`.

Add them to `TRACK_SEED` **after** their parent storylines, in this order:

| Branch title | parent | branchesAt | mergesAt | fulfilment stop | kind | state | source |
|---|---|---|---|---|---|---|---|
| `Taak: opstartstukken` | Onboarding | Team Opstart vraagt de opstartstukken | Alles geleverd wat Verder heeft gevraagd | Opstart van het dossier afgerond (31-07) | document | done | moved |
| `Taak: loonstrook juli` | Onboarding | Loonstroken juli en mei ontbreken nog | idem | Loonstrook juli 2026 nagestuurd | document | open | new |
| `Taak: loonstrook mei` | Onboarding | Loonstroken juli en mei ontbreken nog | idem | Loonstrook mei 2026 opgevraagd bij TrueFullstaq | document | open | new |
| `Taak: reactie op de klacht` | Onboarding | Klacht over de bejegening | idem | Antwoord op de klacht | mail | expected | new |
| `Taak: stukken bijzondere bijstand` | Onboarding | Stukken opgevraagd door Regio 3 | idem | Stukken aanleveren | document | open | moved |
| `Taak: aanvraag bijzondere bijstand` | Onboarding | Stukken opgevraagd door Regio 3 | idem | Aanvragen ingediend bij de gemeente | process | expected | moved |
| `Taak: individuele inkomenstoeslag` | Onboarding | Stukken opgevraagd door Regio 3 | idem | Aanvraag individuele inkomenstoeslag ingediend | process | expected | new |
| `Taak: KvK-aanmaning melden` | Schuldeisers buiten het dossier | KvK — aanmaning op OpsMate | Alles gemeld en in het schuldenoverzicht | KvK-aanmaning gemeld bij de bewindvoerder | mail | open | new |
| `Taak: vordering Trust and Law melden` | Schuldeisers buiten het dossier | Trust and Law — PLM Investments, € 2.623,15 | idem | Vordering Trust and Law gemeld bij de bewindvoerder | mail | open | new |
| `Taak: vonnis Stam melden` | Schuldeisers buiten het dossier | Stam — Het CAK, € 1.141,61, er ligt een vonnis | idem | Vonnis Stam gemeld bij de bewindvoerder | mail | open | new |
| `Taak: financieel beeld` | Schuldregeling | Verder Almere wacht op de aanmelding | Minnelijke schuldregeling voorgesteld | Financieel beeld compleet, vaste lasten stabiel | process | open | moved |
| `Taak: betalingsregeling huurachterstand` | Schuldregeling | Verder Almere wacht op de aanmelding | idem | Betalingsregeling huurachterstand | process | expected | moved |
| `Taak: schuldeisers aanschrijven` | Schuldregeling | Verder Almere wacht op de aanmelding | idem | Alle schuldeisers aangeschreven met de beschikking | process | open | moved+renamed |
| `Taak: nieuwe aanmelding schuldhulpverlening` | Schuldregeling | Verder Almere wacht op de aanmelding | idem | Nieuwe aanmelding schuldhulpverlening | process | expected | moved |

The `task` field on each fulfilment stop is the branch's `forTask`. The four
storyline stops that carried those task links (Onboarding 350/850/875,
Schuldregeling 200–500) are removed from their storyline's stop list — they are
these fulfilment stops, and `writeStop` moves the existing rows by title.

Two renames are needed for the moved-and-renamed row; add them to
`STOP_RENAMES`:

```ts
  // It is a task's fulfilment now, and a fulfilment is named for the thing that
  // will have happened, not for the state it is in.
  { from: "Schuldeisers aangeschreven met de beschikking",
    to: "Alle schuldeisers aangeschreven met de beschikking" },
```

A branch's `note` may be the empty string, and for most of the fourteen it
should be: the detail is already on the task the fulfilment stop points at, and
`resolveStopEvidence` puts it on the page. Write one only where the branch says
something the task does not — for `Taak: stukken bijzondere bijstand`, *"Het
meeste ligt er al; nieuw zijn alleen de jaaropgaven van de afgelopen vijf
jaar."*

Then the exclusions:

```ts
/**
 * Tasks that are not done and deliberately get NO branch on the map.
 *
 * A live branch off a closed storyline would draw the crisis as still running.
 * Both of these still exist on /tasks, where an open task belongs; what they do
 * not get is a rail on a line that ended.
 */
export const TASKS_WITHOUT_BRANCH = [
  { title: "Lopende huur blijft betaald",
    reason: "A standing condition under a closed akkoord, not a deliverable. " +
      "It hangs off `Dreigende ontruiming`, which is geëindigd, and drawing a " +
      "live branch there would reopen a crisis that is over." },
  { title: "Ontruimingsdatum controleren: 18 of 19 augustus",
    reason: "A bookkeeping correction on the same closed storyline. Worth " +
      "setting straight in the dossier; not worth a rail on the map." },
] as const satisfies readonly { title: string; reason: string }[];
```

- [ ] **Step 4: Run the whole worker suite**

Run: `env -u NODE_ENV pnpm --filter worker exec vitest run src/ops/`
Expected: PASS — every structural test and all five layout tests, including the
headline landing on `Stukken aanleveren`.

If `problems` is not empty, read what it says: a `backwards-merge` means a
branch's `mergesAt` sits at or before its `branchesAt` on the parent, and a
`branch-into-own-subtree` means a branch point that belongs to the branch itself.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ops/
git commit -m "feat(worker): every open task is a branch that comes back

Fourteen task branches, each leaving the storyline where the work was asked for
and carrying the one stop where it is fulfilled — expected while it is still
owed, so the map says what is outstanding without writing it down twice."
```

---

### Task 8: The source of a stop

`stops.kind` mixes channel (`mail`, `call`, `meeting`) with moment-type
(`process`, `document`), and physical post fits neither. No migration fixes
that: where a stop points at a log entry, **the entry's channel wins**, and
`log_entries.channel` already covers everything Martin named — `call · meeting ·
email · whatsapp · voicemail · letter · other`.

**Files:**
- Modify: `apps/web/src/lib/track-marks.ts`, `apps/web/src/lib/track-marks.test.ts`
- Modify: `apps/web/src/app/(app)/timeline/page.tsx:105-120`

**Interfaces:**
- Produces: `stopSourceLabel(stop: { kind: string }, evidence: { entry: { channel: string; direction: string } | null } | null): string`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/track-marks.test.ts`:

```ts
describe("stopSourceLabel", () => {
  it("prefers the entry's channel over the stop's kind", () => {
    // `kind` cannot say "fysieke post" — the enum mixes channel with
    // moment-type. The entry can, so where there is one it wins.
    expect(stopSourceLabel({ kind: "document" },
      { entry: { channel: "letter", direction: "inbound" } }))
      .toBe("brief · ontvangen");
  });

  it("says which way it went", () => {
    expect(stopSourceLabel({ kind: "mail" },
      { entry: { channel: "email", direction: "outbound" } }))
      .toBe("e-mail · verstuurd");
    expect(stopSourceLabel({ kind: "mail" },
      { entry: { channel: "call", direction: "internal" } }))
      .toBe("telefoon");
  });

  it("falls back to the stop's own kind when nothing is linked", () => {
    expect(stopSourceLabel({ kind: "meeting" }, null)).toBe("gesprek");
    expect(stopSourceLabel({ kind: "process" }, { entry: null })).toBe("stap in het traject");
  });

  it("never renders a raw enum value at Martin", () => {
    expect(stopSourceLabel({ kind: "wat-dan-ook" }, null)).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter web exec vitest run src/lib/track-marks.test.ts`
Expected: FAIL with "stopSourceLabel is not defined".

- [ ] **Step 3: Write it**

Append to `apps/web/src/lib/track-marks.ts`:

```ts
/**
 * What a halte says it came from.
 *
 * `stops.kind` mixes the channel (mail, call, meeting) with the type of moment
 * (process, document), and it cannot say "fysieke post" at all. Rather than
 * migrate that muddle, it is CONTAINED: where a stop points at a log entry, the
 * entry's channel wins — and `log_entries.channel` already covers every source
 * Martin named, physical post included. `kind` keeps its meaning for a stop
 * that has nothing behind it yet, which is exactly what an expected halte is.
 *
 * An unknown value renders as nothing rather than as itself: a raw enum on the
 * page is the app talking to itself.
 */
const CHANNEL_LABEL: Record<string, string> = {
  call: "telefoon", meeting: "gesprek", email: "e-mail", whatsapp: "WhatsApp",
  voicemail: "voicemail", letter: "brief", other: "",
};

const KIND_LABEL: Record<string, string> = {
  process: "stap in het traject", mail: "e-mail", call: "telefoon",
  meeting: "gesprek", document: "document", other: "",
};

const DIRECTION_LABEL: Record<string, string> = {
  inbound: "ontvangen", outbound: "verstuurd", internal: "",
};

export function stopSourceLabel(
  stop: { kind: string },
  evidence: { entry: { channel: string; direction: string } | null } | null,
): string {
  const entry = evidence?.entry;
  if (!entry) return KIND_LABEL[stop.kind] ?? "";
  const channel = CHANNEL_LABEL[entry.channel] ?? "";
  const direction = DIRECTION_LABEL[entry.direction] ?? "";
  return channel && direction ? `${channel} · ${direction}` : channel || direction;
}
```

Add `stopSourceLabel` to the test file's import from `./track-marks`.

- [ ] **Step 4: Run the test**

Run: `env -u NODE_ENV pnpm --filter web exec vitest run src/lib/track-marks.test.ts`
Expected: PASS.

- [ ] **Step 5: Render it**

In `apps/web/src/app/(app)/timeline/page.tsx`, import `stopSourceLabel` and add
the source to the panel's subtitle line, between the track and the state:

```tsx
            <span className="text-sm text-slate-500">
              {shownTrack?.title}
              {sourceLabel && ` · ${sourceLabel}`}
              {" · "}{STOP_STATE_LABEL[shown.state] ?? shown.state}
              {shown.happenedAt
                ? ` · ${new Date(shown.happenedAt).toLocaleDateString("nl-NL")}`
                : shown.expectedAt
                  ? ` · verwacht ${new Date(shown.expectedAt).toLocaleDateString("nl-NL")}`
                  : ""}
            </span>
```

with, above the `return`:

```tsx
  // The channel comes from the entry when there is one; `kind` is what a halte
  // with nothing behind it yet can say about itself.
  const sourceLabel = shown ? stopSourceLabel(shown, shownEvidence ?? null) : "";
```

- [ ] **Step 6: Build the web app and check the page renders**

Run: `env -u NODE_ENV pnpm --filter web build`
Expected: PASS.

Run: `docker compose up -d postgres && env -u NODE_ENV pnpm --filter web dev`, open
`http://localhost:3000/timeline`, click a stop.
Expected: the subtitle reads e.g. `Onboarding · e-mail · ontvangen · gebeurd · 12-08-2026`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): a halte's source comes from its entry's channel

The kind enum cannot say 'fysieke post'. log_entries.channel can, so where a
stop points at an entry that is what the page calls its source; kind keeps its
meaning for a halte with nothing behind it yet."
```

---

### Task 9: Run it, and write down how

**Files:**
- Modify: `docs/deploy.md` (the "Reconstructing the case history" section), `CLAUDE.md`

- [ ] **Step 1: Run the whole suite and both builds**

```bash
env -u NODE_ENV pnpm -r typecheck
env -u NODE_ENV pnpm -r test
env -u NODE_ENV pnpm --filter web build
```
Expected: PASS. `packages/api`'s router tests need `docker compose up -d postgres`.

- [ ] **Step 2: Run it against the dev database and read the result**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
env -u NODE_ENV pnpm --filter worker case-history
```

Expected in the JSON: `strandedOnSpine: []`, `retiredStops: ["Aanvraag
bewindvoering"]` (or `[]` on a database that never had it), `retiredTracks` the
three consolidated ones (or `[]`), and `reparented` naming WSNP. Run it a second
time: everything must come back empty except `missingDocs`. **That second run
returning zeros is the test that this is idempotent** — a non-empty `moved` or
`renamed` on run two means a rename is fighting the seed.

- [ ] **Step 3: Rewrite the deploy section**

In `docs/deploy.md`, replace the body of "Reconstructing the case history from
the mailbox" with the new shape. It must state:

- The map is now **phase gates on the trunk, storylines on the branches, and one
  branch per open task**. `strandedOnSpine` is the guard that the trunk stayed
  bare, and it must come back empty.
- **It runs from the HOST, not from the worker container.** The restructure
  retires rows, `GRANT SELECT, INSERT, UPDATE ON tracks, stops TO verder_app,
  verder_worker` gives the app roles no DELETE, and the script refuses to start
  the retirement without it rather than half-finishing:

```bash
# 1. rsync (WITH --delete AND --exclude 'nightly.log') and rebuild web + worker.
#    No migration: nothing schema-side moved.
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml up -d --build web worker'
# 2. the restructure, from the HOST as the owner role — it deletes rows, and
#    the app roles deliberately cannot.
ssh homelab 'cd ~/apps/verder && DATABASE_URL="$(grep ^ADMIN_DATABASE_URL .env.prod \
  | cut -d= -f2-)" pnpm --filter worker case-history'
# 3. read the result: strandedOnSpine [], retiredStops/retiredTracks as expected,
#    then check the ledger did not move.
```

- The **ledger footprint is zero**. Everything that appends — the four parties,
  the twenty-two task statuses — was appended by the first run. This one writes
  tracks and stops only, so the event count and the chain head must be
  **unchanged**. Record the head before and after and compare. A moved head is
  the signal to stop and find out what wrote evidence.
- Renaming a track re-enqueues every one of its stops (`tracks_stops_search_outbox_trg`),
  so expect a burst in `search_outbox`; it drains on its own within a minute.
- Afterwards: `nightly-verify` on the unchanged event and file counts, and
  `/timeline` opening with the headline on *Stukken aanleveren*.

- [ ] **Step 4: Update CLAUDE.md**

Add a paragraph to the sub-project 6 section (or open sub-project 7) recording,
in the same register as the rest of that file: the trunk is seven phase gates
spelled once in `SPINE_STOPS`; `Schone lei verkregen` is deliberately not
`Schone lei` because WSNP owns that title and stop lookup is map-wide; renames
run **before** `ensureCaseMap` and why; corrections state what they expect to
find so a hand edit always wins; retirement is the only delete and needs the
owner role, so the run moved from the worker container to the host; WSNP hangs
under Schuldhulpverlening and the strip still works because `deriveTimeline`
reads `stage IS NOT NULL` across all tracks; and one branch per open task, with
`TASKS_WITHOUT_BRANCH` naming the two exclusions.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: the case as a project map, and why it runs from the host"
```

---

## What this plan does NOT do

- **Layer 1 — working the queue.** 6 log entries against 50 ingested emails, 24
  pending suggestions and 13 `needs-manual`. Until those are approved there is
  almost nothing for `stops.entry_id` to point at, so most stops will still show
  no source. That approval is Martin's, by the project's founding rule, and it is
  tracked separately from this code change. Task 8 is what makes the source
  visible the moment an entry exists.
- **Layer 3 — suggested stops from new mail.** Its own spec.
- **The `stops.kind` enum.** Contained by preferring the entry's channel, not
  migrated.
- **Any change to `ledger_events`, `/verify`, or the append-only rules.**
