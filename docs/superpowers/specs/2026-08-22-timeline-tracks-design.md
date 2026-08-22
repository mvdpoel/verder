# Timeline Tracks — the case as a metro map

**Date:** 2026-08-22
**Status:** Approved design, pending implementation plan
**Sub-project:** 6 of the verder platform
**Replaces:** the curated key-events timeline (sub-project 3's `timeline_events`, shipped 2026-08-19) and the milestone model behind the WSNP strip
**Builds on:** sub-project 1 (logbook + vault), sub-project 3 (tasks + milestones), sub-project 4 (search)

## Purpose

One page that answers the question Martin actually opens this app to answer: **where does the case stand, and what is waiting on me right now?**

The case is not a list. It is a main line running toward one goal — *Einde bewindvoering* — with side tracks that branch off it when something arrives (a mail, a call, someone at the door, a letter he scanned), run a number of stops, and then either **merge back** into the main line because they were a prerequisite for the goal, or simply **end**. That is a metro map, and it is the shape Martin drew on paper before any of this was modelled.

Today the app has three flat lists that each tell part of that story — key events, milestones, tasks — and none of them can express "this ran off the main line and came back". This sub-project replaces the narrative layer with one uniform structure: **tracks made of stops**, where the main line is simply the track with no parent.

## Evidence behind these decisions

Martin's own account of his case, given 2026-08-22. Each item forced a decision; none of it may be re-derived.

| Observed | Consequence for the design |
|---|---|
| The main line's goal is **Einde bewindvoering**. Everything on it is a step toward that. | The root track is a goal, not a chronology. Its last stop is the goal itself. |
| "I applied for WSNP at Verder" opened a side track: back and forth with **Demi Willemse**, an intake at the **Gemeentehuis Almere**, documents requested, filing at court, a request for additional explanation, the court approved. It **merged back** into the main line, because it was a prerequisite for the goal. | A track needs an explicit merge point, not just an end. Merge-back is what distinguishes a prerequisite from a detour. |
| The **eviction warning** was handled, generated a few tasks, all now done — and it does **not** merge back. | A track may simply end. `merges_at_stop_id` is nullable, and a track that ends is a first-class outcome, not an unfinished one. |
| A track can be triggered by **anything**: an email, a phone call, someone at the door, a physical letter he scanned. | The trigger is not a mail thread and not a task. Any stop on any track can be a branch point. |
| **Now:** Verder's *Team Opstart* requested documents by mail, Martin delivered them, there was back-and-forth about the **format of the bank statements**, the request was fulfilled — and Team Opstart has since requested more documents so Verder can apply for **bijzondere bijstand** to pay for their own services. This open request is the live state of the case. | The map must open on *now*, not on the beginning. The current open stop is the page's answer, not a detail buried in the middle of a diagram. |
| Martin's reason for building this: to serve VerderGroep "as good and quick as they have never seen before". | Features that add curation work he must remember to do are working against the point. Whatever can be derived is derived; a future agent proposes, he approves. |

Production state at design time: **1 `timeline_events` row, 0 `milestones`, 0 `tasks`, 6 `log_entries`, 18 `documents`.** The migration is therefore nearly free, and this is the cheapest this change will ever be — the same argument that made 0022 additive and unbackfilled.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| What a side track is | A chain of **stops** triggered by an event of any kind, which either merges back into its parent or ends. |
| What a stop is | **Its own record** — title, order, state, optional date — with optional links to a logbook entry, a task or a document. A stop may exist before anything in the ledger corresponds to it. |
| Narrative layers | **One.** `timeline_events` is replaced entirely; the main line is just the track with no parent. |
| Milestones | The six WSNP stages **become their own track**, merging back into the main line — WSNP is a procedure inside the goal of ending bewindvoering, not the same road. |
| Structure | **Tracks with ordered stops.** Tracks nest to any depth; a merge is a pointer at a stop on the parent. |
| Third level (email + its files) | **Derived from existing links**, never stored. |
| Where the arithmetic lives | A pure `track-map.ts` over the two tables. No layout state, no cached geometry. |
| Authoring | **By hand, in this sub-project.** Agent proposals and a procedure library come later and need no model change. |

## Data model

### Two new tables

```
tracks
  id                    uuid pk
  title                 text not null
  status                track_status not null default 'open'   -- open | done | ended
  parent_track_id       uuid references tracks(id)             -- NULL = the main line
  branches_at_stop_id   uuid references stops(id)              -- NULL iff parent_track_id is NULL
  merges_at_stop_id     uuid references stops(id)              -- NULL = it just ends
  note                  text
  created_at            timestamptz not null default now()

stops
  id                    uuid pk
  track_id              uuid not null references tracks(id)
  order_index           integer not null
  title                 text not null
  kind                  timeline_event_kind not null default 'other'
  state                 stop_state not null default 'done'     -- done | open | expected
  happened_at           timestamptz                            -- NULL for a stop that has not happened
  expected_at           timestamptz
  stage                 wsnp_stage                             -- NULL, or a named station
  entry_id              uuid references log_entries(id)
  task_id               uuid references tasks(id)
  document_id           uuid references documents(id)
  note                  text
  created_at            timestamptz not null default now()
```

Two new enums (`track_status`, `stop_state`); `timeline_event_kind` and `wsnp_stage` are reused as they are.

`tracks.branches_at_stop_id` and `stops.track_id` reference each other. Both directions are nullable on one side, so the cycle resolves: create both tables, then add the `tracks → stops` foreign keys.

### What the database enforces

- **Exactly one root track**, ever. A unique index on a constant expression, filtered to `parent_track_id IS NULL`: `CREATE UNIQUE INDEX tracks_single_root ON tracks ((true)) WHERE parent_track_id IS NULL;` A second root is a corrupt map, not a second opinion.
- `branches_at_stop_id IS NULL` if and only if `parent_track_id IS NULL`, as a check constraint. A branch with no parent, or a parent with no branch point, cannot be drawn.
- `order_index` carries **no** unique constraint. Uniqueness would make reordering a deferred-constraint problem for no gain; ties break on `happened_at`, then `id`, so the order is total and stable either way.

Ancestry cycles (a track that ends up its own parent) are refused in application code. Postgres cannot express that cheaply, and the derivation must survive one anyway — see Error handling.

### What is not enforced, on purpose

Nothing stops a stop from having no links at all. That is the point of Martin's choice: *"Ingediend bij rechtbank"* can sit on the map before any evidence of it exists, and *"Uitspraak"* can sit there before it has happened.

### Nothing here is evidence

Tracks and stops are **curated display aids**, exactly as `timeline_events` and `milestones` are today, and they inherit that status rather than changing it. They append no `ledger_events`, and `/verify` and the hash chain are untouched by this sub-project.

The evidence stays where it already is: `log_entries` (append-only, ledgered), `documents` (append-only, ledgered), and `tasks`, whose status changes are ledgered through `task_status_changes`. **A stop asserts nothing; it points.**

### Anti-drift

A stop never *copies* a fact from what it links to. `title` and `note` are Martin's words; the date, the party, the channel and the attachments are read live from the linked entry, task or document at render time. A stop whose link is empty renders visibly as *"verwacht — nog niets achter deze halte"*.

The consequence is the one that matters: a stop can be **ahead of** reality, which is what makes an expected stop useful, but it can never quietly **contradict** it.

### Migration

`0023_timeline_tracks` — additive, plus a data migration:

1. Create the enums and both tables with their constraints.
2. Insert the root track **Einde bewindvoering** *and its two anchor stops*: a start stop, and the goal stop *Einde bewindvoering* itself with `state: expected`. A track cannot branch from or merge into a stop that does not exist, so the root's anchors must be written before any child track is.
3. Insert the **WSNP** track as a child of the root, branching at the start anchor and merging at the goal anchor.
4. Give the WSNP track its stops: every existing `milestones` row becomes one, carrying `stage`, `happened_at`, `expected_at`, `note`, `entry_id`, `document_id`, and `done → state` (`done` when done, otherwise `open`). For any of the six `wsnp_stage` values with **no** milestone row, insert one synthetic stop with `state: expected`, so the strip is complete without duplicating a stage Martin has already recorded.
5. Copy every `timeline_events` row into `stops` on the root track, ordered by `happened_at`, placed between the two anchors, carrying `kind`, `note`, `entry_id` and `document_id` across. `state` is `done` when `happened_at` is in the past and `expected` when it is in the future.

`timeline_events` and `milestones` are **left in place, unread**. Dropping them belongs in a later migration once the map has proven itself; nothing in this project deletes a table in the same change that stops reading it.

The seed for Martin's real tracks — *WSNP-aanvraag* (merges back), *Ontruiming* (ended), *Team Opstart* (open) — carries **titles and order only**. Dates are left empty for him to fill. Inventing when things happened in his case would be exactly the kind of assertion this app refuses to make.

## Derivation rules

All of the following lives in a pure `packages/api/src/track-map.ts` — no I/O, no `@verder/db` import — taking tracks and stops in and returning a drawable map out, so every rule below is unit-testable without a database. It is **total**: any input renders without throwing.

### Position: layering, not a time axis

A metro map is deliberately not to scale, and here that is the honest choice rather than a stylistic one: an expected stop has no date, and placing it on a time axis would mean inventing one.

Columns come from a **longest-path layering** over a DAG whose edges are:

- `stop → next stop on the same track` (by `order_index`),
- `branches_at_stop_id → the child track's first stop`,
- `the child track's last stop → merges_at_stop_id`.

`column(stop)` is the length of the longest path reaching it, computed in topological order. This guarantees two things structurally rather than by convention: **a branch never draws backwards**, and **a merge always lands to the right of everything it waited for**.

Dates are labels on the stop. They are never geometry.

### Lanes

The root track is lane 0. Every other track is assigned the lowest free lane whose occupants do not overlap its column span (`branch column … merge or final column`), walking tracks in depth-first order and breaking ties on title then id. Two tracks that do not overlap in time share a lane, so the map stays compact instead of growing one row per track forever.

### The current stop

The map opens focused on **now**: the open stop with the highest column, ties broken on lane then id. It is the page's answer to "what is waiting on me", and today it is Team Opstart's bijzondere-bijstand request.

### Out-of-order dates are reported, never corrected

Within a track, a dated stop whose `happened_at` precedes the previous dated stop's is flagged. The map still draws in structural order and shows the flag. It usually means a stop is on the wrong track — a real signal, and silently reordering would destroy it.

### The third level, derived

For each stop, the evidence hanging off it is resolved, never stored:

- `entry_id` → the entry, plus its documents via `entry_documents`.
- `task_id` → the task and its **effective status** (latest `task_status_changes` row by ledger seq, the same rule `effectiveStatus` already uses for the registry).
- `document_id` → the document.
- **The email:** a linked document with `source = 'email-attachment'` carries the Gmail message id in `source_ref`, which resolves to a `raw_emails` row — and that row's other attachments are the rest of the files on that mail. An entry with `source = 'gmail-watch'` resolves the same way through its documents.

Resolution is defensive throughout: a `source_ref` matching nothing yields **no email link**, never an error. A discarded document is excluded here for the same reason it is excluded everywhere else, through `effectiveDocument`.

All of it is **batched** — one query per link type across the whole map, never one per stop. The registry's N+1 was found in production code twice; this starts batched.

## Screens

### `/timeline` — the map

Inline SVG, no chart library. The web app has no runtime dependency beyond Next and React and this keeps it that way, the same commitment `money-chart.tsx` already makes.

- **Marks, each visually distinct:** filled circle = a stop that happened; hollow = open; dashed = expected. A stop carrying a `stage` draws as a large named station. A stop that is another track's branch or merge point draws as a junction.
- **Lines:** each track is a horizontal line in its lane, labelled at the left. A branch is a curve from the parent's stop down into the child's lane; a merge is a curve back up into the merge stop. A track that ends draws a terminus cap carrying its status — *afgerond* or *geëindigd*, which are different facts.
- **Selection lives in the URL** (`/timeline?stop=<id>`), so a view is linkable and survives a reload rather than hiding in client state — the same rule `?cat=` follows on `/money`.
- **The stop card** shows the title, the date if there is one, the linked entry, the task with its effective status, and the email with its attachments — as **real links**, keyboard-reachable, not hover-only. The money chart already learned this: month labels are `<a>` elements precisely so the chart is navigable without a mouse.
- **Empty state:** a map with only its seeded root and WSNP track says so plainly and offers to add the first track, rather than rendering an empty grid.

### Authoring

A track editor (title, which stop it branches from, which stop it merges into or none, status) and a stop editor (title, kind, state, dates, links, position), following the shape of the existing `milestone-editor.tsx` rather than inventing a second editing idiom.

### Dashboard

The WSNP strip becomes **where you are now**: the current stop of each open track, with the main line's next station. The 18-month settlement countdown keeps its rule exactly — earliest done `wsnp-start` stop + 547 days — and only changes where it reads that stop from.

### Search

`track` and `stop` replace `milestone` and `timeline_event` as indexed entity kinds. `search_chunks.entity_type` is `text`, so no migration is needed — but the index must be rebuilt with `pnpm --filter worker reindex` after deploy, and `search-kinds.ts` needs the two new labels and colours.

## Error handling

The derivation is total. Every one of these renders something honest rather than throwing:

- **No root track** — an empty map with the empty state, never a crash.
- **A merge pointing backwards** (a track branching at stop 5 and merging at stop 3) would be a cycle. The offending merge edge is dropped, the track renders as ending, and the map reports the contradiction. A cycle is never drawn as a loop.
- **An ancestry cycle** among tracks is refused at write time and, if one is ever present in the data, broken at read time by ignoring the edge that closes it.
- **A stop linking to a row that no longer resolves** (a discarded document, a deleted-by-migration reference) renders as a stop with no evidence, plus a note — never a broken link and never a silent omission.
- **A track with no stops** renders as a labelled stub at its branch point. It is a real state: a track opens the moment something arrives, before anyone has written down what happens next.

## Testing

- **Pure module** (`track-map.test.ts`): a branch always lands right of its branch point; a merge always lands right of every stop it waited for; lane packing reuses a lane for non-overlapping tracks and never for overlapping ones; the out-of-order date flag; the current-stop rule; empty input; no root; a backwards merge dropped and reported; an ancestry cycle survived.
- **Migration**: the existing `timeline_events` row lands as a stop on the root track with its links intact, between the anchors; a stage that already has a milestone row is **not** duplicated by a synthetic stop; all six stages are present exactly once; the root is unique and a second root is refused by the index.
- **Router**: track and stop CRUD; the evidence resolution batched (asserted by query count, not by eye); a discarded document excluded; a `source_ref` matching no email yielding no link rather than an error.
- **Web**: the pure helpers extracted to `apps/web/src/lib` and tested without React, following `money-marks.ts` — most of all the mark-kind decisions (filled/hollow/dashed/station/junction) and the selection URL round-trip.
- **Countdown**: the existing `wsnp-timeline` assertions are re-pointed at stops and must produce identical answers. A rebuilt countdown that returns a different number of days is a bug in the rebuild.

## Out of scope for this sub-project

The agent proposing tracks and stops from incoming mail; the knowledge base of official laws, policies and procedures that would pre-fill a track's remaining stops; any automatic inference of which track an incoming mail belongs to; a printable VerderGroep-facing export of the map; the visual design system (explicitly a later stage — this sub-project delivers structure, data model and a basic, correct visualisation); dropping the `timeline_events` and `milestones` tables.

Both deferred AI features fit this model without changing it: a proposal is a stop with `state: expected` awaiting Martin's approval, which is what the project law already requires of every AI output.

## Tone

Toward Martin: the map reports, it never judges. A track that ended without merging back is not a failure — the eviction warning was handled, and *geëindigd* is a clean outcome. The map's job is to make the current stop obvious, because that is the one he needs in order to answer VerderGroep quickly, which is the reason this app exists at all.
