# De vorderingen: één dossier per schuldeiser

Date: 2026-08-29
Status: approved, ready for an implementation plan
Slice 1 of two. Slice 2 (intake from any channel) gets its own spec and is
sketched under Non-goals.

## Why

Three creditors have written to Martin this spring and none of them is in the
registry. They live on the case map as three stops on a spoor called
`Schuldeisers buiten het dossier`, and that is wrong twice over.

It is wrong as a MAP: a spoor is one episode, and these are three unrelated
episodes lumped together by what they have in common rather than by what
happened. And it is wrong as a RECORD: the `debts` table holds zero rows, so
everything known about these claims — who is demanding, who is collecting for
them, what the reference numbers are, that there is already a vonnis — exists
only as prose in a stop's note.

The gap that makes the record impossible is small and specific: **`debts` has
exactly one party.** Trust and Law collecting for PLM Investments, Stam acting
for Het CAK — the shape of nearly every debt notice — cannot be written down.

What Martin asked for: keep a record of every debt whatever the channel, with
its status, the demanding party, the intermediaries, their contact persons, and
the documents; and know for each one whether Verder has been told.

## What this is not

**The handover to Verder is out of scope, deliberately.** Martin: "instead of
spamming them with hundreds of emails we'll find a way to hand that over smart,
not a decision for now." This slice records WHETHER Verder knows. It does not
decide how they are told.

## The approval question, settled

Martin asked for incoming notices to be processed automatically rather than
queued for approval. That reads like a conflict with the project law — AI output
is suggestion-only, nothing enters the ledger without his approval — and it is
not one.

**`debts` is not an evidence table.** Migration 0008 grants
`SELECT, INSERT, UPDATE` on `debts`, `financial_items` and `transactions`, and
creating a debt row appends NO `ledger_events` row. Only `registry_decisions` is
evidence — insert-only, ledgered, with a `created_by`.

So the line falls exactly where it already fell. Recording *"this party claims
you owe X"* is an OBSERVATION about the world, the same kind of fact as
`document.ingested`, and the app may record it unasked. **Accepting, disputing
or settling that claim is Martin's judgement**, stays a `registry_decision`,
stays ledgered, and stays his. Nothing in this slice weakens that, and slice 2
must not either.

## 1. Schema — migration 0027

All additive. No table is dropped, no column is removed, no grant is weakened.

### 1.1 `debt_parties` — the missing relationship

```sql
CREATE TYPE debt_party_role AS ENUM ('eiser', 'incasso', 'deurwaarder', 'gemachtigde');

CREATE TABLE debt_parties (
  debt_id    uuid NOT NULL REFERENCES debts(id),
  party_id   uuid NOT NULL REFERENCES parties(id),
  role       debt_party_role NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debt_party_uq UNIQUE (debt_id, party_id, role)
);
```

`eiser` is who the money is owed to; the other three are who is acting for them.
A debt has exactly one `eiser` in practice but the table does not enforce it — a
notice that names two claimants is a real thing and refusing to record it would
lose the notice rather than the confusion.

`debts.creditor_party_id` and `debts.creditor_name` STAY. `creditor_name` is
what the notice literally said, which is often not a party the app knows; the
`eiser` link is the resolved fact. Keeping both is what lets a mis-resolution be
seen rather than hidden.

### 1.2 `parties.parent_party_id` — contact persons

```sql
ALTER TABLE parties ADD COLUMN parent_party_id uuid REFERENCES parties(id);
ALTER TABLE parties ADD CONSTRAINT parties_no_self_parent_ck
  CHECK (parent_party_id IS NULL OR parent_party_id <> id);
```

A contact person is a `person` party whose parent is the `organization` party.
Reusing `parties` rather than adding a contacts table has a payoff worth naming:
**`pollGmail` builds its relevance filter from `parties.email`**, so recording a
contact person's address makes their mail start being ingested — the same
mechanism that fixed the Stam blind spot in the case-history work.

One level is the intent (organisation → person). The CHECK refuses a
self-reference; a deeper cycle is not enforced in the database, and the editor
offers only organisations as parents.

### 1.3 `debt_documents` — the paperwork of the claim

```sql
CREATE TABLE debt_documents (
  debt_id     uuid NOT NULL REFERENCES debts(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  CONSTRAINT debt_document_uq UNIQUE (debt_id, document_id)
);
```

Mirrors `entry_documents`. Today a document can only hang off a *decision*
(`registry_decisions.document_id`), so the sommation that arrived before any
decision was taken has nowhere to go.

### 1.4 Does Verder know?

```sql
ALTER TABLE debts ADD COLUMN reported_to_verder_at timestamptz;
ALTER TABLE debts ADD COLUMN reported_via_entry_id uuid REFERENCES log_entries(id);
```

Nullable, and NULL is the honest default: for all three known debts nobody has
told Verder, and for the Stam vonnis that is the single most important fact in
the registry.

**Not a status.** It is orthogonal to `identified → acknowledged → disputed →
in-settlement → settled`: a debt can be disputed and reported, or acknowledged
and not. Folding it into the status machine would make two independent facts
share one field.

`reported_via_entry_id` points at the logbook entry that did the telling, so the
claim "Verder knows" is always answerable with "here is the message".

### 1.5 `claimed_cents` becomes nullable

```sql
ALTER TABLE debts ALTER COLUMN claimed_cents DROP NOT NULL;
```

Required by the data. The KvK aanmaning names an invoice number and a KVK
number and no total. Writing `0` would assert that they claim nothing, which is
false; `NULL` says "the notice did not state a total", which is true. Slice 2
will meet this constantly.

Consequences that must move with it: `debtFields.claimedCents` in
`packages/api/src/routers/registry.ts` becomes `.nullish()`, and every place
that formats or sums a claimed amount must render an unknown as such rather than
as `€ 0,00`.

### 1.6 Grants

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON debt_parties, debt_documents
  TO verder_app, verder_worker;
```

**DELETE is granted here and only here, and that is a deliberate exception.**
These two tables are link tables on an editable fact table: they carry no ledger
event and they are not evidence. A party linked to the wrong debt has to be
removable, and the alternative — a registry whose mistakes are permanent — is
worse than the rule it would uphold. The evidence tables are untouched:
`registry_decisions` keeps `SELECT, INSERT` and nothing else, and `debts` itself
keeps `SELECT, INSERT, UPDATE`.

## 2. The backfill — the three that exist

Idempotent, in a new `apps/worker/src/ops/case-debts.ts` exporting `DEBT_SEED`
and `applyCaseDebts(db)`, called from `applyCaseHistory` at the end.
A separate file because `case-history.ts` is already 850 lines and this is a
different subject; the same script because it is the same case, wants the same
idempotency discipline, and has to link to stops and tasks that file creates.

Three parties are new and must be created as `eiser`: **Kamer van Koophandel**,
**PLM Investments II B.V.**, **Het CAK**. Trust and Law and Stam already exist
and are linked as intermediaries.

| debt | eiser | intermediair | geëist | hoofdsom | kenmerk |
| --- | --- | --- | --- | --- | --- |
| KvK — aanmaning op OpsMate | Kamer van Koophandel | — | *onbekend* | — | factuur 260194200, KVK 77463102 |
| PLM Investments | PLM Investments II B.V. | Trust and Law (`incasso`) | € 2.623,15 | € 2.197,89 | 26TNL-001031 |
| Het CAK | Het CAK | Stam (`deurwaarder`) | € 1.141,61 | — | 3805606, 3900757 |

All three: `reported_to_verder_at = NULL`. No `registry_decisions` row, so all
three read `identified` — a claim that has been made, not one Martin has
accepted.

`origin` carries what is known about where the claim came from: the KvK invoice
is on a company deregistered on 22 April; the PLM claim was ceded by Qred and
its hoofdsom is on OpsMate; the CAK claim already has a vonnis.

`debt_documents` links `Informatieblad vordering (nieuw).pdf` to the PLM debt
when that document is in the vault — the same "fill it in on a later run" rule
`writeStop` already uses for `document_id`, so the backfill is safe to run
before or after a Gmail backfill.

Ledger impact: +3 `party.created` events from the existing party-creation path,
and nothing else — debts and both link tables append nothing. Noted for
completeness, not as a gate: the chain is not a requirement this project is
designing around at this stage.

## 3. The map — three episodes

`Schuldeisers buiten het dossier` is dissolved. Each notice becomes a trigger on
the hoofdlijn with its own spoor, per the episode rule.

```
hoofdlijn  26-5  KvK — aanmaning op OpsMate                    → spoor
           11-6  Trust and Law — PLM Investments, € 2.623,15   → spoor
           14-7  Stam — Het CAK, € 1.141,61, er ligt een vonnis → spoor
```

The three spoors are titled `Vordering KvK`, `Vordering PLM Investments` and
`Vonnis Het CAK`. Each carries two stops:

1. `<schuldeiser> — verwerkt als vordering` — `done`, linked to the debt's
   document where there is one. **Dated 2026-08-29, the day the registry entry
   was actually made** — a literal in the seed, not `new Date()`, so a re-run
   and a test both get the same answer. Its note says the notice itself is
   older and that the record was made retrospectively. It is NOT dated to the
   notice's own day: nothing was recorded then, and back-dating it would be the
   app inventing a fact. It is not left undated either — this spoor has no other
   dated stop to inherit a position from, so an undated stop would fall into the
   `onbekend` band at the bottom of the map, away from the episode it belongs to.
2. `<schuldeiser> — melden bij Verder` — `open` and undated, linked to the
   existing task (`… melden bij de bewindvoerder`). It inherits its position
   from the stop above it. The episode closes when Verder is told, which is
   slice 2's business.

Both stops are work waiting on Martin, which keeps the project law
`case-history.test.ts` enforces.

The hoofdlijn grows from 7 stops to 10.

**THE CONSTRAINT THIS CREATES, and it will bite in slice 2:** stop titles are
unique across the WHOLE map — `stopAnywhere` looks a stop up by title with no
track scope, and `case-history.test.ts` asserts it. So "verwerkt als vordering"
cannot be reused; every debt episode's stops must be prefixed with the
creditor's short name. Fifty debts means a hundred uniquely-titled stops, and
slice 2 needs a naming convention that cannot collide.

`Schuldeisers buiten het dossier` empties and is renamed to **`Vordering KvK`**,
carrying `status: open` in the same UPDATE — the trap the episode restructure
already recorded, where a repurposed row keeps the old subject's status because
nothing else ever overwrites it. `Vordering PLM Investments` and `Vonnis Het CAK`
are new tracks. Which of the three reuses the row is arbitrary and only needs to
be decided once; naming it here is what stops two runs choosing differently.

### 3.1 Folding debt episodes away

`/timeline` gains one control: **"schuldeisersmeldingen tonen/verbergen"**,
default SHOWN. Hidden, the debt triggers and their spoors drop out of
`buildTrackMap`'s input and the map is the bewindvoering story alone.

This exists because Martin chose one-episode-per-notice with the density
trade-off named, and at fifty debts the trunk becomes a list of aanmaningen. The
filter keeps his rule intact and gives the map back when he wants to read the
case. Selection lives in the URL like `?stop=`, so a view stays linkable.

## 4. Registry UI

- `/registry/debts/[id]` shows the parties by role, the linked documents, and
  the "Verder weet ervan" state with its date and a link to the entry that told
  them. Adding and removing a party link and a document link happens here.
- `/registry` lists debts with the eiser, the intermediary, the amount (or
  `bedrag onbekend`), the status, and a marker for not-yet-reported.
- The party editor gains `parent_party_id`, offering organisations only.

Copy MATCHES THE FILE IT IS IN. The registry pages are written in English
("Claimed", "started as", "From your logbook — contact with this creditor"); the
timeline and the map are Dutch. Do not impose one on the other — a page that
switches language mid-screen reads worse than either choice. Either way it
reports rather than judges: an unreported debt is "not reported to Verder yet",
never a warning.

## 5. Testing

- `debt-parties.test.ts` (DB): the role enum, the uniqueness constraint, the self-parent CHECK, and that DELETE is permitted for `verder_app` on the two link tables and still refused on `registry_decisions`.
- `case-debts.test.ts` (pure): `DEBT_SEED` names an `eiser` for every debt; every intermediary role is one of the three; stop titles are unique across the whole map INCLUDING the debt episodes; every `open` stop is work waiting on Martin.
- A second `applyCaseDebts` run creates nothing and appends no ledger event — the same idempotence proof the case-history work used, and the one that catches a seed drifting from a migration.
- `registry` router tests for a debt with `claimed_cents IS NULL`, so an unknown amount cannot render as `€ 0,00`.

## 6. Deploy

Same ordering as every migration since 0020, with one difference at the end.

1. rsync the checkout (the migration file must exist on the host before it can run).
2. `DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" pnpm --filter @verder/db migrate` from the HOST, before any image is rebuilt.
3. Rebuild web + worker.
4. Run `pnpm --filter worker case-history`.
5. Check the result on `/registry` and `/timeline`: three debts with their eiser and intermediair, three episodes on the map. `nightly-verify` should stay green (it will read 129 events, +3 from the new parties); it is a health check here, not a gate.

## A note on where this data ends up living

`debt_parties` and `parties.parent_party_id` are the graph-shaped part of this
case: claimant → intermediary → contact person is a small graph, and so is the
document trail hanging off it. This slice models it as plain relations in
Postgres because that is where every other fact in the app lives and because the
shape is small enough that the join costs nothing.

Nothing here is built to be a graph store, and nothing here forecloses one: the
edges are explicit rows with a typed role rather than columns on `debts`, so
moving them into a graph or a vector-adjacent store later is a migration of one
table, not a change of meaning. Worth knowing while the storage question is
still open; not worth building for yet.

## Non-goals

- **Slice 2, intake from any channel:** one extractor that turns a debt notice into a debt record however it arrived. Email has a path already; scanned post rides `nas-scan`; a call is a log entry. The work is making the extractor read document text and log entries rather than only mail, creating the task when the notice demands an action, and writing the episode onto the map. It depends on everything in this spec.
- **The handover to Verder.** Recorded, not designed.
- No change to the `debt_status` machine or to `registry_decisions`.
- No new AI prompt. The backfill is hand-written from what the case already knows; extraction is slice 2.
