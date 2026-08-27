# The case as a project map — Design Spec

**Date:** 2026-08-23
**Status:** Approved design, pending implementation plan
**Sub-project:** 7 of the verder platform. Supersedes the structure (not the tables) of `2026-08-22-timeline-tracks-design.md`.

## Purpose

Turn `/timeline` from a picture of the case into a **project overview**: every
important moment in the traject, in order, on the storyline it belongs to, with
its source, the party involved, the documents and the task it advances.

The tables built in sub-project 6 (`tracks`, `stops`) are the right ones. What is
wrong is the *shape* the data was given, and the fact that almost nothing is
linked to evidence. This spec fixes both.

## What is wrong today

Observed on production, 2026-08-22/23:

| Symptom | Cause |
|---|---|
| WSNP renders as the second row, spanning the whole map | Its track branches at `Start` and merges at the goal, so its longest path covers every column. WSNP is a late sub-step, not a peer of the main line. |
| Main line carries the case's errands, not its phases | The spine was seeded with ten stations. A trunk shows where the line goes; the work belongs on branches. |
| A stop shows a title and a date and nothing else | Six log entries exist against fifty ingested emails. `resolveStopEvidence` can serve source, party, documents and the mail itself — but only through `stops.entry_id`, and there is almost nothing to point at. |
| `stops.kind` cannot express "fysieke post" | The enum mixes channel (`mail`, `call`, `meeting`) with moment-type (`process`, `document`). Physical post fits neither. |
| Three separate tracks for one crisis | `Ontruiming Woonhave`, `Moratorium` and `Schuldhulpverlening Almere` are one storyline as Martin tells it: one eviction threat, two routes tried at once, closed. |

## The model

Four rules. Everything below follows from them.

1. **The main line is phase gates.** A stop on the root track marks a moment the
   case changed phase. Nothing else may sit there.
2. **A track is a storyline** — a named piece of work with an owner and an
   outcome. It branches at the gate that opened it, and either *merges* at the
   gate it made possible or *ends* because it was handled and closed. `ended` is
   a clean outcome and must never read as failure.
3. **A stop is an important moment**, whatever the channel: an email, a letter,
   a phone call, a meeting, a decision. It carries a date, a source, a party and
   its evidence.
4. **A task is a branch that comes back**: a stop where it was assigned, a stop
   where it was fulfilled, merging into the storyline that asked for it. While
   the task is open the fulfilment stop is `expected`, so the map states what is
   still owed without anyone writing it down twice.

### Why a branch per task is affordable

`buildTrackMap` assigns each track the **lowest lane whose occupants do not
overlap its column span**. Task branches that do not overlap in time therefore
share one lane. Thirty sequential tasks cost a handful of rows, not thirty. This
was measured before the rule was adopted.

## The main line

| # | Stop | Date | Source | State |
|---|---|---|---|---|
| 1 | Aanmelding bewindvoering | 2026-04-16 | e-mail | done |
| 2 | Start bewindvoering | 2026-07-14 | beschikking rechtbank | done |
| 3 | Onboarding voltooid | — | — | expected |
| 4 | Nog onbekend | — | — | expected |
| 5 | Start schuldhulpverlening | — | — | expected |
| 6 | Schone lei | — | — | expected |
| 7 | Einde bewindvoering | — | — | expected (goal) |

`Start bewindvoering` is dated at the **beschikking** (14 July), not at Team
Opstart's first mail (27 July), because that is when the bewind legally began.
The note on the stop records that distinction rather than hiding it.

Stop 4 exists because Martin does not yet know what follows onboarding. An
`expected` stop with an honest title is the app saying so; inventing a plausible
next phase would be the app claiming something nobody measured.

### What happens to the four stops already on the spine

Migrations 0023/0024 left `Start`, `Aanvraag bewindvoering`, `bewindvoering` and
`Einde bewindvoering` on the root. The new spine has room for two of them:

| Existing root stop | Becomes |
|---|---|
| `Start` (undated) | renamed **Aanmelding bewindvoering**, date filled 2026-04-16 |
| `bewindvoering` (14-07, `open`) | renamed **Start bewindvoering**, state corrected to `done` |
| `Aanvraag bewindvoering` (24-04) | **retired** — the same fact already sits on the Aanvraag track as *Verzoek onderbewindstelling ingediend* |
| `Einde bewindvoering` | unchanged, still the goal |

`Onboarding voltooid`, `Nog onbekend`, `Start schuldhulpverlening` and
`Schone lei` are inserted.

A rename may carry a `state` and a `happened_at` correction, applied **only if
the stop still holds the value the migration gave it**. A hand edit therefore
always wins, and the correction is a one-time repair of a value this spec
supersedes rather than a standing claim on Martin's field.

### Retirement, and why it is a delete

`GRANT SELECT, INSERT, UPDATE ON tracks, stops TO verder_app, verder_worker` —
the running app can never delete a stop, and that stays true. The owner role
`verder`, which is what a structural backfill runs as, *can*. For a row that
duplicates a fact already on the map, that is the honest fix: renaming it to
something untrue to keep it alive would be worse than removing a display row
that was never evidence.

It is guarded three ways, and the run **fails loudly** rather than proceeding if
any guard trips:

1. The stop is named explicitly in a `STOP_RETIREMENTS` list. Never a pattern,
   never a heuristic — an enumerated row with a stated reason.
2. It carries no `entry_id`, `task_id` or `document_id`. A stop with evidence is
   not a duplicate display row and must be re-homed by hand.
3. No track branches or merges at it. Retirement therefore runs **after** branch
   and merge rewiring, not before, or it would delete the row a track still
   points at.

## The storylines

| Track | Branches at | Outcome |
|---|---|---|
| **Aanvraag bewindvoering** | Aanmelding bewindvoering | merges at *Start bewindvoering* · `done` |
| **Onboarding** | Start bewindvoering | merges at *Onboarding voltooid* · `open` |
| ⤷ Taak: opstartstukken | in Onboarding | merges · fulfilled 2026-07-31 |
| ⤷ Taak: stukken bijzondere bijstand | in Onboarding | **open** — this is what waits on Martin |
| **Dreigende ontruiming** | Start bewindvoering | `ended` — averted 2026-08-06 |
| **Schuldeisers buiten het dossier** | Aanmelding bewindvoering | `open` |
| **Schuldhulpverlening** | Start schuldhulpverlening | `expected` |
| ⤷ **WSNP** | in Schuldhulpverlening | merges at *Schone lei* |

### Consolidations

- `Ontruiming Woonhave` + `Moratorium` + `Schuldhulpverlening Almere` become one
  track, **Dreigende ontruiming**. One crisis, two routes attempted in parallel,
  resolved by André Bruinsma, closed. Splitting it into three made the map claim
  three storylines where the case had one.
- `Bankrekening en leefgeld` folds into **Onboarding**. The account takeover, the
  leefgeldrekening, the pincode letter and the card are all things Team Opstart
  did during onboarding.
- **WSNP** stops being a top-level track and becomes a sub-track of
  Schuldhulpverlening. Its six `wsnp_stage` stops move with it. `deriveTimeline`
  reads stops by `stage IS NOT NULL` across all tracks, so the strip and the
  18-month countdown keep working untouched — this was checked, not assumed.

André Bruinsma returns later, on the Schuldhulpverlening track. That is a new
storyline, not a reopening of the eviction one.

## Source, party and documents per stop

**No schema change.** `log_entries.channel` already covers every source Martin
named: `call · meeting · email · whatsapp · voicemail · letter · other`. Physical
post is `letter`.

So a stop gets its source by pointing at a log entry:

- *"Post met pincode"* → a manual log entry, channel `letter`, and
  `stops.entry_id` pointing at it.
- *"E-mail van Team Opstart"* → the approved suggestion for that email.

`resolveStopEvidence` then returns, per stop and already batched: the entry with
its channel and direction, the task with its effective status, the documents, and
the email itself. The attachment list hangs off the email through
`documents.source_ref`, so *"alle gevraagde documenten geleverd (lijst met
links)"* needs nothing stored — it is derived.

`stops.kind` keeps its current values and its current meaning for stops that have
no entry. Where an entry exists, **its channel wins** for display. The muddle in
the enum is therefore contained rather than migrated: no new value, no rewrite of
existing rows.

### The consequence, stated plainly

A stop can only show a source, a party and its documents once the underlying
email is an approved log entry. Today: 6 entries, 50 emails, 24 pending
suggestions and 13 `needs-manual`. **The map cannot be rich until the queue is
worked**, and per the project's golden rule that approval is Martin's, not the
model's.

## The three layers

The work is ordered, and the order is not negotiable — each layer needs the one
below it.

1. **Evidence.** Work the suggestion queue so the emails become log entries with
   channel, direction, parties and attachments. Claude prepares and explains;
   Martin approves. Physical post and phone calls get manual entries.
2. **Narrative.** Restructure the map to the model above, with stops pointing at
   those entries.
3. **Live.** New mail produces a *suggested stop* in the queue, alongside the
   suggested entry it already produces. Martin approves, edits or discards. The
   map stays his words.

Layer 3 is deliberately last and is specified separately; it is not part of the
restructure.

## Authorship: who owns what

The seed owns **structure**; Martin owns **content**.

| The seed writes | Martin owns |
|---|---|
| which tracks exist, their parent, branch and merge points | every title |
| which stop sits on which track, and in what order | every note |
| a null evidence link, once the evidence exists | `state`, `kind`, `happened_at` |

`case-history.ts` already enforces this: on an existing stop it writes only
`track_id`, `order_index` and still-null links. A backfill that reverted a
hand-edited state would be worse than no backfill.

**Restructuring is rename-and-move, and a delete only as a named exception.**
`STOP_RENAMES` and `TRACK_RENAMES` run first, because every other guard keys on
the title; a late rename would leave the old row and insert a second one beside
it. Stop lookup is map-wide by title, so a stop can be recognised and moved
rather than duplicated — which makes stop titles globally unique, an invariant
the tests assert. Retirement is the only delete, enumerated and triple-guarded as
above.

The order within a run is therefore fixed and load-bearing:

```
renames → tasks → stops (insert/move) → tracks (create/rewire)
        → stop placement → retirements → stranded-on-spine check
```

`strandedOnSpine` in the result is the proof the trunk stayed bare: anything left
on the root that the seed does not name is a stop it forgot to re-home, and it
would render as a station on a line that is supposed to show only phase gates.

## Alternatives considered

| Approach | Why not |
|---|---|
| **B — seed once, then UI only** | The map becomes unreproducible, and `verify.test.ts` truncates evidence tables whose cascade takes `stops` and then `tracks` with them. A dev database could never get the map back. |
| **C — phases as a schema concept** | A `phase` column or table would be a second half-used vocabulary beside `wsnp_stage`. The root track's stop list already *is* the phase list; convention plus a test is enough. |
| **Auto-derived map** | Fastest, but the model would decide what counts as an important moment and write it in Martin's dossier in its own words. Rejected against the project's founding rule. |

## Testing

Extends `apps/worker/src/ops/case-history.test.ts`, which is pure and needs no
database:

- The main line holds only phase gates — the seed's spine list is exactly the
  seven above, and no storyline stop shares a title with one.
- Every track branches and merges at a stop that exists, **on its own parent**
  (nested tracks are now legal, so the assertion is "on the parent", not "on the
  root").
- Every `open` stop is work waiting on Martin. An open stop that waits on someone
  else steals the map's headline, which is what happened with the complaint about
  the blocked account.
- Every task branch has both a request stop and a fulfilment stop, and the
  fulfilment stop is `expected` exactly when the task is not done.
- Stop titles are unique map-wide; renames target a title the seed uses and
  vacate one it does not.
- Dated stops on one track run forward with `order_index`.
- Every retirement names a row no seeded track branches or merges at, and no
  seeded stop claims its title.

Layout is verified against `buildTrackMap` with `problems: []` and the headline
resolving to the open task in Onboarding.

## Out of scope

- Stop suggestions from mail (layer 3) — own spec.
- Any change to `ledger_events`, `/verify`, or the append-only rules. This
  sub-project appends **no** evidence: tracks and stops are not evidence, and the
  event count must not move. A moved chain head means something wrote evidence
  that should not have.
- The `stops.kind` enum. Its confusion is contained by preferring the entry's
  channel, not fixed by a migration.
- Filling the queue itself is layer 1 work, tracked separately from the code
  change.
