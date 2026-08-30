# Files: één plek waar alles terug te vinden is

Date: 2026-08-30
Status: approved design, ready for an implementation plan
Sub-project 10. Replaces the Kluis (`/vault`) as it has stood since sub-project 1.

## Why

The kluis is three lists under each other — Postvak, Opgeborgen, Weggelegd — and
that shape answers exactly one question: *wat moet ik nog sorteren?* Every other
question arrives unanswered.

Two of them arrive constantly. **"Waar is dat ene stuk"** — the beschikking, the
loonstrook of juni, the polis — has no answer but scrolling, because the only
ordering is by date of arrival and the only handle is the title. And **"stuur de
stukken die Verder vraagt"** — the shape of nearly every request from Team
Opstart or Regio 3 — has no answer at all: there is no way to select more than
one document, and no way to hand over anything but one file at a time.

The name says as little as the page does. *Kluis* and *Vault* describe where the
bytes live, not what you came to do.

Scale makes both worse on a known schedule. 51 documents today; the Takeout
archive holds 146.270 messages and the mail rearchitecture will put their
attachments in here. A page that is already hard to use at 51 is unusable at a
thousand.

## The shape, chosen from six

Six directions were drawn as working mockups in the Holodek palette and compared
side by side: one search bar · three panes · bundles · the stream · contact sheet
· ask-driven. Martin chose **three panes (02) with the bundles of 03 as a
first-class branch**.

The reason the pair beats either half: three panes is the only direction that
lets you find something **without already knowing what to ask** — you narrow by
soort, by afzender, by periode until the answer is on screen — and bundles is the
only direction that answers the request as it is actually made, which is never
for a file but always for a *set*.

The other four are not dead, they are unchosen: the stream (04) is what
`/timeline` already does with the same data, and the contact sheet (05) becomes
worth building the day there is a thumbnail pipeline. Ask-driven (06) is the one
to revisit once the LLM on the homelab stops timing out at 120 s.

## What this is not

- **Not a redesign of search.** ⌘K and `/search` stay the fast path for "I know
  a word". Files is the durable path for "I know roughly what kind of thing".
- **No thumbnails.** Direction 05 was not chosen; a render pipeline is not in
  this sub-project.
- **Bundles are not indexed.** No new `search_chunks` entity type — see §7.
- **Downloading appends nothing to the ledger.** Handing the bundle over is a
  log entry Martin makes; producing a zip is not a fact about the case.
- **No new evidence.** Not one ledger event is added by this sub-project. If the
  chain head moves during the deploy, something wrote evidence and that is a bug.

## The name

**Files**, in Martin's words, against a UI that is otherwise entirely Dutch
(Kluis, Postvak, Zoeken, Register, Taken, Geld) and one commit after the app was
deliberately pulled to one language. This is recorded as a decision and not an
oversight: *Bestanden* is the Dutch spelling of the same idea and was offered.
The rail label and the page title both read **Files**; every label inside the
page stays Dutch.

## 1. Scope decisions (approved)

| Question | Decision |
|---|---|
| Does Files take over sorting? | **Yes — it replaces `/vault` entirely.** Postvak becomes a `Te sorteren` branch, Weggelegd a `Weggelegd` branch. |
| What is a bundle? | **Both kinds, per bundle**: a manual stack with its own member list, or a rule-driven one, marked as such on the card. |
| Does a document get a sender? | **Yes, a real field.** `documents.party_id` at ingest, corrections through `document_status_changes.party_id` — exactly how title and soort already work. |
| How is the zip produced? | **Hand-rolled STORE-only writer, no dependency.** |
| Is `doc_type` a controlled vocabulary? | **No.** Free text, grouped and labelled by normalisation. |

### 1.1 Why no zip dependency

Every file in the vault is already compressed — PDF, JPEG, PNG, xlsx — so deflate
buys 0–3% for real CPU in the request path. A store-only zip is a local file
header, the bytes, a central directory and an EOCD record: on the order of 150
lines, and testable by reading the central directory back and by handing the
output to `unzip -t`. The alternative is `archiver` or `yazl`, both fine, both a
new dependency in a request path for one feature of one format. The SheetJS
episode is the standing precedent for keeping that surface small.

The cost is honest and bounded: **no zip64**, so the writer refuses archives over
2 GB or 500 entries rather than emitting a file that silently truncates at 4 GB.
Those two numbers are limits to be MEASURED during implementation against the
real vault, in the manner of `readWorkbook`'s three caps, not guesses to be
shipped.

### 1.2 Why `doc_type` stays free text

An enum needs a migration every time the case produces a new kind of paper, and
this case keeps producing new kinds of paper. The tree therefore groups on
`lower(trim(doc_type))` and labels each branch with the most-used spelling among
its rows, so `Loonstrook` and `loonstrook` are one branch and not two. The meta
form offers the existing values as a `<datalist>`, which is what actually keeps
the vocabulary from drifting — a suggestion Martin can ignore beats a constraint
that blocks him.

## 2. Routes

| Now | After |
|---|---|
| `/vault` | `/files` |
| `/vault/[id]` | `/files/[id]` — today's detail page, moved, plus the sender field |
| — | `POST/GET /api/files/zip` |

`/vault` and `/vault/[id]` keep permanent redirects. The redirect is a safety net
for bookmarks, **not the mechanism**: all 22 in-repo references are updated —
`dashboard`, `money`, `registry/[id]`, `registry/debts/[id]`, `timeline`,
`tasks/[id]`, `registry-list.tsx`, `debt-parties-form.tsx`, `task-list.tsx`,
`retrieved-refs.tsx`, `nav-items.ts`, `nav-icons.tsx`, and the two href builders
that matter most, `search/retrieve.ts` and `search/recent.ts`, with their tests.

A search result whose href 302s is a search result that renders slower and copies
wrong, which is why the builders are updated rather than left to the redirect.

**Route precedence note:** `/api/files/zip` sits beside the existing
`/api/files/[sha256]`. Next resolves a static segment before a dynamic one, so
`zip` never enters the sha256 handler — and even if it did, `zip` is not 64 hex
characters and `documents.bySha` would 404. Both facts are worth a line in the
route file, because the arrangement looks ambiguous and is not.

## 3. Schema — migration 0030

All additive. No table is dropped, no column removed, no grant weakened.

### 3.1 The sender

```
ALTER TABLE documents              ADD COLUMN party_id uuid REFERENCES parties(id);
ALTER TABLE document_status_changes ADD COLUMN party_id uuid REFERENCES parties(id);
```

**THE GRANT TRAP, and it decides the whole design of this field.** Migrations
0001 and 0004 grant `verder_app` and `verder_worker` only `SELECT, INSERT` on
`documents`. There is no UPDATE and there must not be one — that is the
append-only law. So `documents.party_id` can be written **at ingest and never
again**, and every correction has to ride `document_status_changes`, which is the
same table title and soort already travel on and which the meta form already
writes.

`effectiveDocument` resolves it identically to `docType`:

```
effectivePartyId = latest change row's party_id ?? documents.party_id
```

**The inherited property, stated so nobody rediscovers it as a bug:** because the
fallback is `??`, a sender can be overwritten but never cleared — a change row
with `party_id = NULL` reads as "no opinion" and the derived value returns. Title
and soort have carried exactly this property since sub-project 1. Clearing is out
of scope; if it is ever wanted it needs a sentinel, not a NULL.

**Backfill runs inside the migration**, as the `verder` admin role, because no app
role may UPDATE that table:

```
UPDATE documents d SET party_id = p.id
FROM raw_emails r JOIN parties p ON lower(p.email) = lower(r.from_addr)
WHERE d.source = 'email-attachment' AND d.source_ref = r.gmail_message_id
  AND d.party_id IS NULL;
```

Case-insensitive on both sides. Only mail attachments resolve; uploads and scans
stay NULL and land under `Onbekend` until Martin sets one by hand. This is the
same pattern 0024 and 0026 used for data work that no app role is permitted to do.

**Ingest sets it going forward** in `ingestDocument`, from the same lookup, so a
newly arriving attachment needs no backfill.

### 3.2 Bundles

```
CREATE TABLE bundles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  note       text,
  kind       text NOT NULL,                      -- 'manual' | 'rule'
  rule       jsonb,                              -- NULL for manual
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bundles_kind_ck CHECK (kind IN ('manual','rule')),
  CONSTRAINT bundles_rule_ck CHECK ((kind = 'rule') = (rule IS NOT NULL))
);

CREATE TABLE bundle_documents (
  bundle_id   uuid NOT NULL REFERENCES bundles(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bundle_document_uq UNIQUE (bundle_id, document_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bundles, bundle_documents
  TO verder_app, verder_worker;
```

**THE LAW THAT MAKES DELETE LAWFUL HERE.** A bundle is not evidence. Creating,
renaming or deleting one appends NO `ledger_events` row, exactly as `tracks`,
`stops`, `debts` and `debt_parties` do not — it is a **view onto** evidence, never
a claim about the case. That is precisely why DELETE can be granted here while it
stays revoked on every evidence table. The rule generalises and holds the line
from the debt slice: recording an observation is the app's to do; asserting a
fact about the case is Martin's, ledgered.

A `rule` bundle holds **no** `bundle_documents` rows — its membership is computed.
The constraint is enforced in the router rather than in SQL, because a
cross-table check needs a trigger and a trigger is a worse thing to own than a
guard with a test.

### 3.3 The shared effective-status expression

`COALESCE((SELECT c.status FROM document_status_changes c …), documents.status)`
is currently written out in four places — `routers/documents.ts` (twice),
`routers/dashboard.ts`, `track-evidence.ts`, `ops/seed-documents.ts` — plus
`docmeta-sweep.ts`. This sub-project adds two more uses (the tree and the table),
so it is extracted once to `packages/api/src/effective-status.ts` and imported by
all of them; the worker already depends on `@verder/api`.

Six copies of one expression is how a definition starts drifting, and this one
carries the `IS DISTINCT FROM 'discarded'` subtlety that a `<>` rewrite silently
breaks. Extraction is in scope; nothing else in those files is touched.

## 4. The three panes

### 4.1 Left — de boom

Branches, in order:

- **Bundels** — every bundle by name with its count, then `Nieuwe bundel`. This
  is where the two directions actually fuse: selecting the **Bundels** branch
  itself replaces the table with direction 03's card grid — stacked paper, count,
  the rule in words where there is one, a `.zip` button per card. Selecting one
  bundle below it puts that bundle's documents in the ordinary table, so
  everything you can do to a branch you can do to a bundle.
- **Soort** — grouped on the normalised effective `doc_type`; `Zonder soort` last.
- **Van wie** — grouped on the effective party; `Onbekend` last.
- **Periode** — year, expanding to months, from `received_at` in
  **Amsterdam calendar months** (`date_trunc('month', received_at AT TIME ZONE
  'Europe/Amsterdam')`). Month membership is an Amsterdam question — the money
  sub-project paid for that lesson and `packages/api/src/amsterdam.ts` already
  holds the JS half.
- **Bron** — mail / scan / upload.
- **Status** — Te sorteren · Opgeborgen · Weggelegd. This is what replaces the
  vault's three panels.

Every count comes from a grouped query against the database, never from measuring
the page that was just rendered — the rule `documents.counts` established when
"Postvak — 100 te sorteren" was what a vault of 100 and a vault of 1000 both
said. The branch queries run in parallel, as the vault page already does with its
four reads.

Discarded documents are excluded from every branch except `Weggelegd`, through
the shared expression from §3.3.

### 4.2 Middle — de tabel

Columns: **Naam · Soort · Van · Datum · Grootte**, sortable, with a checkbox
column. Capped at 100 rows like the vault, and **the truncation is said out
loud** — a list that simply stops is indistinguishable from a document that was
never filed, which is the one thing this page may never be.

Selection: click, shift-click for a range, ⌘A for everything in the branch.
Selection lives in client state, not the URL: a 60-item selection in a query
string is a URL nobody can share anyway.

### 4.3 Right — het voorbeeld

The selected row's preview (compact — the full `DocumentPreview` stays on
`/files/[id]`), its facts, and **what it hangs off**: the log entry, the debt, the
stop, the task. Those links exist in four tables today and are surfaced nowhere
near the document itself.

### 4.4 State

Tree branch, sort, direction and the previewed row live **in the URL** and are
rendered on the server, exactly as `/search` does it, so a link Martin sends
himself reproduces the view. Only the checkbox selection is client state, and it
reaches the zip route as a form POST.

## 5. Bundels

### 5.1 Manual

Members are rows in `bundle_documents`. Filled from the table's selection ("voeg
toe aan bundel") or one at a time from `/files/[id]`. What you sent last week
stays what you sent last week.

### 5.2 Rule-driven

A rule is the same vocabulary the tree filters on:

```ts
{ docType?: string, partyId?: uuid, source?: DocSource,
  status?: DocStatus, from?: Date, to?: Date }
```

Stored as `jsonb`, validated with zod **on write and again on read**. Reading
through a schema is not belt-and-braces: the row is hand-editable in psql, and a
rule bundle whose JSON went bad must render as a broken bundle with a readable
message, never as a page that throws.

A rule bundle excludes discarded documents by default (`IS DISTINCT FROM
'discarded'`, never `<>` — `NULL <> 'discarded'` is NULL). The one exception is a
rule that asks for them by name, `status: 'discarded'`, which is how "laat me
zien wat ik heb weggelegd" is spelled; nothing else can pull a discarded document
into a rule bundle. Its card is marked with the rule in words
("volgt een regel: soort = loonstrook") so it is never mistaken for a stack
somebody curated.

### 5.3 What is deliberately absent

No nesting, no sharing, no ordering within a bundle, no per-bundle note templates.
A bundle is a name, a kind and a set.

## 6. De zip

`GET /api/files/zip?bundle=<id>` for a bundle — a plain link, which is what a
bundle card wants — and `POST /api/files/zip` with document ids for an ad-hoc
selection, submitted as an ordinary `<form>` with hidden inputs. A form POST
streams natively, shows the browser's own download progress and needs no
JavaScript; a `fetch` → blob → `createObjectURL` dance buys nothing here and
buffers the whole archive in the tab.

Auth is `serverCaller()` and `protectedProcedure`, the way `/api/files/[sha256]`
already does it.

### 6.1 The archive

STORE only, no compression. Entry names are the **effective** title (a rename must
not be undone by the archive, the same reason the single-file route uses it),
sanitised, given an extension from the mime, and deduplicated with ` (2)` — two
documents titled `Beschikking.pdf` is a normal Tuesday.

### 6.2 The inhoudsopgave

The first entry is `inhoudsopgave.txt`, in Dutch, listing per file: titel, soort,
afzender, datum, grootte, **sha256**. The receiver knows what they were given, and
every line ties back to the ledger. This is the instinct `/registry/export`
already has: a document Martin may hand to Verder is written in the language of
the person reading it.

Discarded documents that were explicitly selected are included and **named as
discarded in the inhoudsopgave** — the selection was deliberate, and a silent
inclusion is the lie, not the inclusion.

### 6.3 The guards

- Zero entries → refused with a message, never an empty archive.
- More than 500 entries, or more than 2 GB total → refused, because there is no
  zip64. Both numbers to be measured against the real vault before they ship.
- **Every file's bytes are verified present before one byte is streamed.** A
  missing file returns 409 listing exactly what is missing. Once the response has
  begun there is no way to report a failure, and an archive that is quietly one
  document short is worse than no archive at all — the same discipline
  `nightly-verify` applies to the vault.

## 7. What is deliberately left alone

- **`search_chunks` gains no `bundle` entity type.** `indexEntity`'s exhaustive
  default throws on an unknown type and a retired kind cannot be cleaned by
  `reindex --prune` — migration 0023 paid for that lesson with 2875 stuck rows.
  A bundle name in ⌘K does not earn that risk.
- **`renderDocument` does not learn about the sender.** Adding a field to a
  chunk's body means every document re-embeds, and `document_status_changes`
  already re-enqueues on write. Not in this slice.
- **The nightly verify, the ledger, the grants on evidence tables**: untouched.
  The chain head must be identical before and after the deploy.

## 8. Tests

**Pure, no database:**

- the zip writer — central directory read back, `unzip -t` on the output, the
  dedup rule, the sanitiser, the three guards;
- the URL-state helpers (branch, sort, preview) — parse and build round-trip;
- `doc_type` normalisation and label selection.

**Against the database:**

- the bundles router: manual add/remove, rule evaluation, discarded excluded from
  a rule and included when explicitly selected, a corrupt `rule` JSON rendering
  as a broken bundle;
- the tree counts, including `Zonder soort` and `Onbekend`, and Amsterdam month
  boundaries;
- `effectiveDocument` party resolution, **with a test that pins the
  cannot-be-cleared property** so it stays a decision;
- the zip route: 409 before streaming when bytes are missing, 401 unauthenticated.

Fixture parties keep the `<name> Testfixture ${crypto.randomUUID()}` convention —
the debt slice showed what real names in fixtures do to a shared dev database.

## 9. Deploy

The standing order, unchanged since 0020, and wrong in the other direction every
time it is guessed:

1. `rsync` with the full exclude list from CLAUDE.md, `--dry-run --info=del`
   first, every `deleting` line read;
2. `pnpm --filter @verder/db migrate` **from the homelab host**, with
   `DATABASE_URL` sourced from `.env.prod` (`docs/deploy.md` §7.1);
3. rebuild web + worker.

Adding a nullable column is safe for the running images; new code against an old
database is what 500s. Afterwards: `nightly-verify` must report the **same chain
head** and the same event count as before.

## 10. For a later slice

- Clearing a sender (needs a sentinel, see §3.1).
- Thumbnails, and with them direction 05 as a view mode.
- Ask-driven assembly (direction 06) once the homelab GPU stops timing out at
  120 s — the VRAM finding in CLAUDE.md is the blocker, not the model.
- Recording a handover: which bundle went to whom and when. That one **is**
  evidence and belongs in the logbook, not in `bundles`.
