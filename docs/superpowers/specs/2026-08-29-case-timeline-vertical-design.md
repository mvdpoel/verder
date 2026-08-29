# De zaak, verticaal — redraw of the case map

Date: 2026-08-29
Status: approved, ready for an implementation plan
Supersedes the layout half of `2026-08-23-case-project-map-design.md`. The data
model (`tracks` + `stops`, append-no-ledger, evidence by reference) is unchanged.

## Why

`/timeline` draws the case as a horizontal metro map: `buildTrackMap` lays stops
out by longest path over a DAG, ~12 columns wide and 6 lanes tall, with every
label truncated to 16 characters under its dot. It is a graph drawing, not a
story, and it is unreadable — which is what Martin reported.

Two decisions drive this redraw, and they are load-bearing on each other:

1. **Vertical, newest at the top, oldest at the bottom.**
2. **History and the current situation only — no expected future stops.**

The current module's central law says, in capitals, that position is a layering
and never a time axis, "because an expected stop has no date and a time axis
would mean inventing one". Decision 2 removes that objection entirely: with no
expected stops left, every stop is `done` or `open` and nearly all are dated. A
real chronological axis becomes honest. **The law is repealed for this reason
and no other** — if expected stops ever return to the map, the time axis has to
be reconsidered with them.

## What the map must say

The case reads, bottom to top, as the story Martin told: he applied at Verder
Groep for bewindvoering, the court was asked to approve it, approval came in and
onboarding started — with the threatened eviction and the other side matters
running alongside as sporen.

## 1. Data — migration 0026

`stops` and `tracks` carry `SELECT, INSERT, UPDATE` and no DELETE for the app
and worker roles. **That grant does not change.** The migration runs as the
`verder` admin role, which is the only thing in this system permitted to remove
a row from either table, and this is the only migration that does so.

### 1.1 Fifteen stops deleted

| reason | stops |
| --- | --- |
| state `expected` (12) | WSNP ×6 (`Aanvraag`, `Toegelaten`, `Intake`, `Start WSNP`, `Regeling`, `Schone lei`), Schuldregeling ix 300–600 ×4, Opstart ix 600 `Aanvragen ingediend bij de gemeente`, root ix 1000000 `Einde bewindvoering` |
| pre-history (1) | root ix 0 `Start` — undated, and the map now begins at the aanmelding |
| duplicated by a spine stop (2) | root ix 100 `Aanvraag bewindvoering` (24-04, same event as `Verzoek onderbewindstelling ingediend`); root ix 200 `bewindvoering` (14-07, same event as `Beschikking: onder bewind gesteld`) |

49 − 15 = **34 stops remain.**

### 1.2 The spine

The 9 stops of `Aanvraag bewindvoering` and the 6 surviving stops of `Opstart en
stukken` move onto the root track (`UPDATE stops SET track_id`, which the grants
already allow), renumbered in date order:

| ix | stop | datum |
| --- | --- | --- |
| 100 | Aanmelding bij Verder | 2026-04-16 |
| 200 | Intakegesprek bewindvoering | 2026-04-22 |
| 300 | Ondernemingen uitgeschreven bij de KvK | 2026-04-24 |
| 400 | Verzoek onderbewindstelling ingediend | 2026-04-24 |
| 500 | Poststukken ingeleverd | 2026-04-29 |
| 600 | Rechtbank vraagt een verklaring | 2026-06-01 |
| 700 | Verklaring ontstaan schulden aangeleverd | 2026-06-09 |
| 800 | Beschikking: onder bewind gesteld | 2026-07-14 |
| 900 | Dossier naar Team Opstart | 2026-07-20 |
| 1000 | Team Opstart vraagt de opstartstukken | 2026-07-27 |
| 1100 | Heen en weer over de bestandsformaten | 2026-07-31 |
| 1200 | Opstart van het dossier afgerond | 2026-07-31 |
| 1300 | Stukken opgevraagd door Regio 3 | 2026-08-12 |
| 1400 | Regio 3 vraagt de laatste drie loonstroken | 2026-08-25 |
| 1500 | Stukken aanleveren | 2026-08-28 |

Gaps of 100 are kept so the editor can insert without renumbering, the same
reason migration 0023's seed left gaps.

**This reverses the bare-trunk rule** recorded in CLAUDE.md ("a metro map's
trunk shows where the line goes, not every errand run along it"). That rule was
correct for a horizontal map aimed at a goal. With `Einde bewindvoering` deleted
the root has nothing to aim at, so the trunk is no longer a destination — it is
the spine of the story so far, and it must carry that story. `SPINE_SEED` in
`case-history.ts` stops being empty.

### 1.3 Tracks

- Root renamed `Einde bewindvoering` → **`Bewindvoering`**. Its goal no longer exists, so its old name describes nothing on the map.
- `Aanvraag bewindvoering`, `Opstart en stukken` and `WSNP` are deleted — the first two are empty after the move, the third after its six expected stops go.
- 10 − 3 = **7 tracks remain**: the spine plus Ontruiming Woonhave, Moratorium, Schuldhulpverlening Almere, Bankrekening en leefgeld, Schuldregeling, Schuldeisers buiten het dossier.

### 1.4 Pointers, in this order

`branches_at_stop_id` and `merges_at_stop_id` are foreign keys into `stops`, so
they must be rewritten **before** the deletes or the deletes are refused.

Every surviving spoor gets `branches_at_stop_id = NULL` and, where it pointed at
a deleted stop, `merges_at_stop_id = NULL`. **Not rewired to a nearest
preceding spine stop.** The branch curve's geometry is date-driven now (§2.4),
so the pointer is semantic only — it means "this spoor came out of *that*
event". Guessing one would be the app inventing a fact about Martin's case,
which is the thing this project refuses to do everywhere else. NULL says "no
recorded origin", which is true, and the editor lets him set one when he knows.

### 1.5 Search chunks

The migration deletes the `search_chunks` and `search_outbox` rows for every
deleted stop and track id. `reindex --prune` cannot do this: it walks live
entities of each type in `SEARCH_ENTITY_TYPES` and never visits an id that no
longer exists. This is the same shape of trap migration 0023 documented for the
retired `milestone` and `timeline_event` kinds, one level down.

Renaming the root re-enqueues its stops through `tracks_stops_search_outbox_trg`
(`renderStop` writes the track title into each stop's chunk). That is correct
and drains on its own.

### 1.6 The seeds must move in the same commit

`ensureCaseMap` (`packages/db/src/seed-case-map.ts`) and `SPINE_SEED` /
`STOP_RENAMES` / `TRACK_RENAMES` in `apps/worker/src/ops/case-history.ts` are
idempotent-by-title. **If they are not rewritten to the new shape, the next run
of either silently re-inserts every stop this migration deletes.** `verify.test.ts`
truncates `ledger_events, log_entries, documents, parties CASCADE` — which
cascades through `stops.entry_id` / `document_id` and wipes `stops` and `tracks`
— and then calls `ensureCaseMap`, so a drift between the migration and the seed
surfaces there rather than in production.

`strandedOnSpine` in the `case-history` result is kept and inverted in meaning:
it still reports stops on the root that the seed does not name, but the seed now
names fifteen of them.

### 1.7 `milestones`

The table holds **0 rows in production** (measured 2026-08-29). It is dropped.

## 2. Layout — `packages/api/src/track-map.ts`

Stays pure: rows in, a drawable map out, no database and no I/O, unit-tested
without a database. Stays TOTAL: any input renders, a corrupt map is reported
through `problems` and still draws what it can.

The DAG machinery goes — `longestPathColumns`, the Kahn ordering, the
reachability walk behind the merge refusal, and the column-span lane packing,
roughly 150 lines. Time is the axis now, so position no longer has to be derived
from graph structure.

### 2.1 Output shape

```ts
interface CaseMap {
  bands: MapBand[];      // top to bottom; `nu` first, then months, newest first
  stops: MapStop[];      // each with { row, lane }
  tracks: MapTrack[];    // each with { lane, firstRow, lastRow, terminus }
  edges: MapEdge[];      // branch | merge only — rails come from tracks
  rowCount: number;
  laneCount: number;
  currentStopId: string | null;
  problems: MapProblem[];
}
interface MapBand { key: string; label: string; fromRow: number; toRow: number; empty: boolean }
```

`row` is a slot index, not a pixel and not a date. The renderer turns rows and
bands into y.

### 2.2 Vertical order

0. Stops with state `expected` are filtered out defensively before anything below. The migration removes the ones that exist; this keeps one added later from reappearing on the map.
1. **A `nu` band at the top**, holding every `open` stop with no date. It is omitted entirely when there are none — an empty `nu` band would read as a claim that nothing is running. This is the "current situation" half of the request. An undated open stop is *not* today's date — placing it at `now` would invent one — so it gets its own band above all dated history. Today it holds exactly one: *Financieel beeld compleet, vaste lasten stabiel*.
2. **Month bands, newest first**: `augustus 2026`, `juli 2026`, `juni 2026`, `mei 2026`, `april 2026`. Every month inside the span gets a band **even when it holds nothing**, rendered as a short rule reading `geen gebeurtenissen`. That is what makes a quiet stretch visible: April–June is nearly empty and must look it.
3. **Inside a band, stops are evenly spaced, newest first.** Not proportional to the date: 22 of the 34 stops fall in the five weeks from 27-07 to 28-08, and a true time scale collapses them into an unreadable pile. The month band carries the sense of time; even spacing carries the readability. Each stop still prints its own date.

Months are Amsterdam calendar months, the same rule `money-series.ts` follows —
an instant-based month would put a boundary stop in the wrong band by the
offset.

**The comparator is total and stable**, so the map never reshuffles between
reads: effective date desc → lane asc (the spine reads first on a shared day) →
`order_index` desc → id.

An undated `done` stop takes the position of the previous dated stop on its own
track and draws with no date label. None exist after §1; the rule exists so one
can never fall off the map.

### 2.3 Lanes

The spine is lane 0. Sporen take lanes 1..n, assigned oldest-origin first
(bottom-up), each taking the lowest lane whose occupants do not overlap its row
span — so two sporen that never ran at the same time share a lane. Ordering
within that pass is by first row, then title, then id, so lane assignment never
depends on the order rows came out of the database.

### 2.4 Branches, merges, problems

A spoor's branch curve leaves the spine at the row of **the spoor's own oldest
stop**, unless `branches_at_stop_id` is set, in which case it leaves at that
stop's row. A merge draws from the spoor's newest stop back into the spine.

`problems` keeps `no-root`, `orphan-stop`, `ancestry-cycle` (parent pointers can
still cycle) and `backwards-merge` — the last redefined as a date comparison
rather than a reachability walk: a merge target older than the spoor's newest
stop is refused and reported. `branch-into-own-subtree` is still reported as a
data error but is no longer a drawing hazard, because branch geometry no longer
feeds a layering that a cycle could flatten.

`datesOutOfOrder` is redefined. Geometry now sorts by date, so the old meaning
is unreachable; the flag becomes **a stop whose date disagrees with its
`order_index` on its own track**. It is shown, never corrected — it usually
means the stop is on the wrong spoor, and silently sorting it away destroys the
signal.

`currentStopId` is the first `open` stop in top-to-bottom order — the newest
thing waiting on Martin — tie-broken spine-first. The project law that every
`open` stop is work waiting on Martin, asserted by `case-history.test.ts`, is
unchanged and is what makes this reading correct.

The station size drops: no surviving stop carries a `stage`. The `stops.stage`
column stays (no enum surgery) but `isStation` and the large-station mark leave
the drawing.

## 3. Drawing — `apps/web/src/components/track-map.tsx`

Inline SVG, no chart library, as today. This file draws and decides nothing;
marks stay in `@/lib/track-marks`, positions stay in `buildTrackMap`.

```
                     nu ─────────────────────────────────────────
              │ │ ○   Financieel beeld compleet, vaste lasten stabiel
              │ │                                    Schuldregeling
        augustus 2026 ─────────────────────────────────────────
   28-08      ● │     Stukken aanleveren
   25-08      ● │     Regio 3 vraagt de laatste drie loonstroken
   18-08      │ │ ●   Leefgeld loopt: € 50 per week
   06-08      │ │ ● ╪ Woonhave akkoord — ontruiming geannuleerd
         juli 2026 ─────────────────────────────────────────
   31-07      ● │     Opstart van het dossier afgerond
   29-07      │ │ ●   Deurwaarder zegt de ontruiming aan
   14-07      ● │     Beschikking: onder bewind gesteld
```

- **One label column at a fixed x**, left-aligned, reading straight down the page. This is the single biggest legibility fix: labels stop being 16-character stubs scattered under dots and become **full titles**. The spoor's name follows in muted grey on spoor rows only — the spine is named by the page heading.
- Dates right-aligned in a 64px gutter at the left.
- Rails between them, 20px per lane. Spine 3px `INK`, sporen 2px `RAIL`.
- **Monochrome.** No per-track hues: six new colours would be a departure from a palette that is otherwise ink, grey, one green and one red, and lane position plus the muted track name already identify a spoor.
- The terminus cap moves to the **top** of a spoor's rail (its newest end); the branch curve enters at the **bottom**. `afgerond` stays a double ink bar and `geëindigd` a single muted bar — two different facts the editor makes Martin choose between, so the map may not collapse them.
- Current stop: green ring on the dot and a green left edge on the row. Selected stop: a full-width row band, not the circle halo — the right idiom for a list.
- Roughly 615px wide: **no horizontal scroll**, readable on a phone.
- Accessibility is unchanged in kind: the `<title>` is the mouse tooltip and the `aria-label` on the link is what a screen reader gets, because everything inside `role="img"` is presentational.
- The legend loses `gestippeld = verwacht` and the not-to-scale caveat, and gains: within a month, stops are in order, not to scale.

## 4. What is removed

Deleted files: `apps/web/src/components/wsnp-timeline.tsx`,
`apps/web/src/components/milestone-editor.tsx`,
`apps/web/src/app/(app)/milestones/`, `packages/api/src/routers/milestones.ts`,
`packages/api/src/wsnp-timeline.ts` and both their test files.

Also removed: the `milestonesRouter` mount in `root.ts`, the `/milestones` nav
link, and the `WsnpTimeline` block plus its `milestones.timeline()` call on the
dashboard.

`retrieved-refs.tsx` maps a search hit of entity type `milestone` to
`/milestones`; that branch is dead once the route is gone and must be removed
with it, or a stale chunk links to a 404.

All six WSNP stages are future by definition — the WSNP has not been applied for
— so a six-dot strip of empty stages and an 18-month countdown with no clock is
exactly the invented future this redraw removes. The dashboard's case block
already reads `tracks.map()` and stays; only the `WsnpTimeline` block and its
`milestones.timeline()` call come out. The case block gains the top of the new
timeline: the `nu` band and the newest few rows.

## 5. Testing

- `track-map.test.ts` is rewritten against the new algorithm: the `nu` band, month banding including an empty month, reverse-chronological order, every tie-break in the comparator, lane packing on row spans, each `problems` kind, and totality on corrupt input.
- `track-marks.test.ts` loses the `expected`/station cases and gains the top-cap terminus.
- `case-history.test.ts` gets the new 15-stop `SPINE_SEED`, keeps map-wide stop-title uniqueness, and keeps the assertion that every `open` stop is work waiting on Martin.
- `seed-case-map.ts` is exercised by `verify.test.ts` as today (§1.6).
- No `wsnp-timeline` tests remain.

## 6. Deploy

1. `pnpm --filter @verder/db migrate` **from the homelab host, before any image is rebuilt.** The blast radius is wider than `/timeline`: the dashboard and every `logbook/[id]` page read tracks and stops.
2. `rsync -av --delete` with the full exclude list from CLAUDE.md, `--dry-run --info=del` first, reading every `deleting` line. Four files are deleted in this change, so `--delete` is required or the Docker `next build` fails on a stale file importing a router that no longer exists.
3. Rebuild web + worker.
4. `nightly-verify` must report the ledger chain head **UNCHANGED**. Tracks and stops append no ledger events; a moved head means something wrote evidence it should not have.
5. `search.drain` should go green with the re-enqueued stop chunks and no retained rows.

## Non-goals

- No new colour system, no chart library, no animation.
- No change to how a stop points at its evidence (`entry_id`, `task_id`, `document_id`, and the mail/attachment level derived from `documents.source_ref`).
- No ledger events. Tracks and stops are not evidence, and this change must not make them any.
- The `expected` value stays in the `stop_state` enum — removing it means recreating the type for no gain. The stop editor stops offering it, and the map filters it defensively, so a future expected stop can neither be created by accident nor reappear on the map if one is.
