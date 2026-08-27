# De kennisbank — what the system knows about Martin — Design Spec

**Date:** 2026-08-27
**Status:** Approved design, pending implementation plan
**Sub-project:** 8 of the verder platform. Builds on the search layer of
`2026-08-20-knowledge-base-design.md` (sub-project 4) without changing it, and on the
parties/documents tables of `2026-08-18-logbook-vault-design.md`.

## Purpose

Today the system knows what *arrived*: emails, documents, transactions. It does not
know what is *true about Martin* — where he worked, over which period, on what
contract, which papers cover which months, what his BSN is, who to ask at a former
employer.

This sub-project builds that layer. The immediate use case is real and current:
VerderGroep asked for recent salary slips. Five TrueFullstaq loonstroken arrived by
mail from a former colleague; June and July from Saurens Marketing B.V. are already
in the vault. The system must be able to answer **"give me the last 6 payslips"** with
a complete, ordered set spanning both employers — and, when it cannot, to say exactly
which periods are missing.

## The one thing that shapes everything

The core question is not *"what do I know"*. It is **"what am I missing"**, and that is
by definition a difference between two sets: what ought to exist, and what does.

`retrieve()` (sub-project 4) cannot answer it and no amount of tuning will change that.
It caps at 50 candidates per branch, always sorts by relevance, collapses to the best
chunk per entity, and a document's `occurred_at` is its *arrival* date rather than the
period it covers. Nearest-neighbour search always returns its k closest rows — it has no
representation for "no match", which is why sub-project 4 needed a measured relevance
floor (`SEMANTIC_MAX_DISTANCE = 0.45`) just to be able to say *no*. Saying *"maart
ontbreekt"* is a further step it cannot take at all.

So: the expected set is generated from structured rows, the present set is read from
structured rows, and the gap is a `FULL OUTER JOIN` between them, computed on read.

## The model

### `document_facts` — **EVIDENCE** (migration 0025)

What a vault document *says*: kind, period, issuer, one amount. Suggested by a model,
approved by Martin, exactly like a registry item.

`document_facts.expectation_id` points at `document_expectations`, so within migration
0025 the expectations table is created **first**.

```sql
CREATE TYPE "document_fact_kind" AS ENUM ('payslip','annual-statement');
ALTER TYPE "suggestion_kind" ADD VALUE 'document-fact';

CREATE TABLE "document_facts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id"    uuid NOT NULL REFERENCES "documents"("id"),
  "kind"           "document_fact_kind" NOT NULL,
  "expectation_id" uuid REFERENCES "document_expectations"("id"),
  "period_start"   date,
  "period_end"     date,
  "issuer_name"    text NOT NULL,
  "issuer_party_id" uuid REFERENCES "parties"("id"),
  "amount_cents"   integer,
  "details"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "supersedes_id"  uuid REFERENCES "document_facts"("id"),
  "voids"          boolean NOT NULL DEFAULT false,
  "source_suggestion_id" uuid REFERENCES "suggestions"("id"),
  "created_by"     uuid NOT NULL REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fact_period_ck" CHECK ("period_end" IS NULL OR "period_start" IS NULL
                                     OR "period_end" >= "period_start"),
  CONSTRAINT "fact_void_ck"   CHECK ("voids" = false OR "supersedes_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "fact_supersedes_uq" ON "document_facts" ("supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;
CREATE INDEX "fact_kind_period_idx" ON "document_facts" ("kind", "period_start" DESC NULLS LAST);
CREATE INDEX "fact_document_idx" ON "document_facts" ("document_id");

GRANT SELECT, INSERT ON "document_facts" TO verder_app;
GRANT SELECT           ON "document_facts" TO verder_worker;

CREATE TRIGGER "document_facts_search_outbox_trg"
AFTER INSERT OR UPDATE ON "document_facts"
FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'document_id');
```

**The grant is the most load-bearing line in this spec.** The worker gets `SELECT` only
— `renderDocument` folds facts into the document's chunk — and deliberately no `INSERT`.
`suggestDocFacts` runs in the same process as the LLM, and `created_by NOT NULL` is not a
barrier to it (`case-history.ts` already looks a user up by email). Without the grant the
miner *physically cannot* write a fact; it can only write a `suggestions` row. Law 2
enforced as a privilege rather than as a convention.

`amount_cents` for a payslip is **netto, always, never anything else**. `details` carries
bruto, cumulatives and the rest.

**Correction is supersession.** A mis-read amount is fixed by inserting a new row whose
`supersedes_id` points at the old one; a withdrawal sets `voids = true`. Readers resolve
the live set with `NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = f.id)`.
This is structurally the same trap as `effectiveDocument`: a reader that forgets the
subquery sees superseded facts and reports them as current. Name it in the table comment.

**Ledger:** `eventType "document.fact"`, `entityType "document_fact"`, `entityId` = the
fact row — the child-row convention of `task.status` and `registry.decision`, not the
`document.updated` one. `supersedesId`, `voids` and `expectationId` are **inside** the
hashed payload, so a withdrawal cannot be silently undone and no
`resolveDocumentUpdatedHashes`-style consumption logic is needed.

**Verification, two branches, both required:**

1. A `document.fact` branch in `makeLedgerRecompute`, alongside `task.status`, with
   `"missing-document-fact-row".padEnd(64,"0")` for a vanished row. Falling through to
   `return e.payloadHash` makes tampering invisible — the sub-project 2 lesson. Test the
   dispatch line directly.
2. **New:** `/verify` walks events → rows and never rows → events. Add a reverse count to
   `runFullVerification`: `document_facts` with no matching `document.fact` event. One
   query, and the only thing that can see a fact written around the approval queue. Say in
   the UI what `/verify` proves — that a recorded fact was not altered. Not that Martin
   approved it, and not that it matches the PDF.

**`details` as JSONB inside a hashed payload is new here.** `taskStatusPayload` and
`registryDecisionPayload` are entirely scalar. Rule: strings and integer cents only,
never floats, plus a round-trip test (insert → driver read → recompute hash). Otherwise
`/verify` goes red one day on a row nobody touched.

**Blast radius:** `document_id` references `documents`, so `verify.test.ts`'s
`TRUNCATE ledger_events, log_entries, documents, parties CASCADE` wipes this table. That
is correct — a fact about a vanished document should go — and there is no seed, so no
`ensureCaseMap`-style reseeder is needed. State it in the table comment.

### `document_expectations` — **EDITABLE FACT** (migration 0025, no ledger)

What *ought* to exist.

```sql
CREATE TYPE "expectation_cadence" AS ENUM ('monthly','four-weekly','yearly','once');

CREATE TABLE "document_expectations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"            "document_fact_kind" NOT NULL,
  "subject_label"   text NOT NULL,
  "cadence"         "expectation_cadence" NOT NULL,
  "expect_from"     date NOT NULL,
  "expect_until"    date,
  "due_after_days"  integer NOT NULL DEFAULT 10,
  -- source_employment_id is added in migration 0026, WITH employments. It cannot
  -- exist in 0025: employments does not yet exist there, and a forward FK is a
  -- migration that does not apply.
  "active"          boolean NOT NULL DEFAULT true,
  "note"            text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expectation_window_ck" CHECK ("expect_until" IS NULL OR "expect_until" >= "expect_from")
);
GRANT SELECT, INSERT, UPDATE ON "document_expectations" TO verder_app;
GRANT SELECT ON "document_expectations" TO verder_worker;
```

This small table is what makes the gap analysis honest:

- **`expect_from` is the horizon, and evidence sets it.** It defaults to the oldest fact
  held for that series and moves *backwards* when something older arrives. A contract from
  a job five years ago does not get refused — it *creates* the expectation and widens it.
  There is no global cutoff and no intake horizon: everything is taken in and processed.
  Deriving the horizon from the employment start instead would put ~74 rows reading
  *ontbreekt* on the page Martin shows his bewindvoerder on day one, because the
  TrueFullstaq employment begins in 2019.
- **`due_after_days` is the issuance lag.** Paper trails money: on 30 July the salary has
  arrived and the loonstrook has not. A jaaropgave over 2026 must not read *ontbreekt*
  from 1 January 2026 onward.
- **`cadence = 'once'`** makes paspoort, polisblad and energiecontract expressible in the
  same table and the same query as a monthly loonstrook.
- **A new document family is one additive `ALTER TYPE ... ADD VALUE` plus N rows.** No new
  table, no new query, no new search entity type.

No FK to `parties` or `documents`, so it sits outside the truncate blast radius.

### `employments` — **EDITABLE FACT** (migration 0026, no ledger)

Migration 0026 also adds the back-reference deferred out of 0025:

```sql
ALTER TABLE "document_expectations"
  ADD COLUMN "source_employment_id" uuid REFERENCES "employments"("id");
```

```sql
CREATE TABLE "employments" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employer_party_id"    uuid REFERENCES "parties"("id"),
  "employer_name"        text NOT NULL,
  "employer_iban"        text,
  "started_on"           date NOT NULL,
  "ended_on"             date,
  "pay_cadence"          "expectation_cadence" NOT NULL DEFAULT 'monthly',
  "paid_to_account_iban" text,
  "contract_document_id" uuid REFERENCES "documents"("id"),
  "note"                 text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employment_period_ck" CHECK ("ended_on" IS NULL OR "ended_on" >= "started_on")
);
GRANT SELECT, INSERT, UPDATE ON "employments" TO verder_app;
```

`employer_name` stays denormalised and `NOT NULL` deliberately: `employer_party_id` and
`contract_document_id` both pull rows into `verify.test.ts`'s `TRUNCATE ... CASCADE`, so
the work history must remain legible without them.

`employer_iban` is the join that earns its keep — it is the key `detectRecurring` groups
on, and the only path from a transaction to an employer, because `transactions` has no
party FK. Store it `normalizeAccount()`'d.

An employment carries one button: *maak verwachting* → writes one `document_expectations`
row with an `expect_from` Martin confirms.

### `party_links` — **EDITABLE FACT** (migration 0026, no ledger)

Parties are n:n with each other, roled and time-scoped.

```sql
CREATE TYPE "party_link_role" AS ENUM ('works-at','contact-for','represents','department-of');

CREATE TABLE "party_links" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_party_id" uuid NOT NULL REFERENCES "parties"("id"),
  "to_party_id"   uuid NOT NULL REFERENCES "parties"("id"),
  "role"          "party_link_role" NOT NULL,
  "title"         text,
  "valid_from"    date,
  "valid_to"      date,
  "note"          text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "party_link_not_self_ck" CHECK ("from_party_id" <> "to_party_id")
);
CREATE INDEX "party_links_to_idx" ON "party_links" ("to_party_id", "role");
GRANT SELECT, INSERT, UPDATE ON "party_links" TO verder_app;
```

`parties.kind` is already `person | organization`; what is missing is the edge between
them. `parties.organization` is a free-text column — an employer name as a *string* on a
person's row — which is exactly this relationship flattened into something unusable.

An organisation gets any number of contacts, each with their own email, phone and validity
window. Larissa `works-at` TrueFullstaq from → to; when she leaves, `valid_to` gets a date
and she stays in the record. The same table expresses VerderGroep → Team Opstart via
`department-of`, a shape the case already has and currently cannot represent.

**`parties.organization` is deprecated, not dropped.** Existing rows and `case-history`
write it. New person parties with a link stop writing it; readers prefer the link and fall
back to the string. Dropping it is separate cleanup.

**Two things need nothing new.** History is already free — `entry_parties` joins parties to
log entries, so a contact's full correspondence history is a query the moment they are a
party. And roles are already n:n in the direction that matters: `creditor_party_id`,
`provider_party_id`, `assignee_party_id` and `owner_party_id` all point *at* parties, so
one party is already simultaneously a creditor and a provider. The only missing role was
employer, and `employments.employer_party_id` supplies it. A generic `party_roles` table is
explicitly rejected: it would be a second spelling of roles the FKs already carry.

### `parties.ingest_mail` — **EDITABLE FACT** (migration 0026)

```sql
ALTER TABLE "parties" ADD COLUMN "ingest_mail" boolean NOT NULL DEFAULT false;
```

`parties.email` feeds the Gmail relevance filter, so creating a contact silently changes
what lands in the vault. That is useful — loonstroken arrive by mail, and it is precisely
why a Stam sommation sat unseen for five weeks — and it is also how unrelated business mail
arrives and how the account-wide 429 gets another chance. Ingestion becomes an explicit
per-party toggle, default off, with a button that says what it turns on. `pollGmail`'s
party-email lookup filters on it.

**Migration ordering note:** this column defaults to `false`, so applying it *narrows*
ingestion for every existing party. Backfill `ingest_mail = true` for all parties that
exist at migration time, in the same migration — the current behaviour is that they all
feed the filter, and a migration must not silently mute the poller.

### `accounts` — **EDITABLE FACT** (migration 0027, no ledger)

```sql
CREATE TYPE "account_kind" AS ENUM ('beheer','leefgeld','prive','spaar','zakelijk');
CREATE TABLE "accounts" (
  "iban" text PRIMARY KEY,
  "label" text NOT NULL, "kind" "account_kind" NOT NULL, "holder" text,
  "opened_on" date, "closed_on" date, "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON "accounts" TO verder_app;
```

Fills a seam left open on purpose. `money.ts` currently builds `accountLabels[iban] = iban`
with the comment *"There is no table naming accounts, and inventing one would be an
assertion this sub-project is not allowed to make"*. One query and `/money` says
"leefgeldrekening" instead of `NL02REVO…`. No arithmetic changes; an account with no row
still shows its IBAN, so `money.test.ts` stays green. `iban` is the `normalizeAccount()`
spelling, one spelling always.

### `profile_attributes` — **EDITABLE FACT** (migration 0026, no ledger, never indexed)

BSN, geboortedatum, geboorteplaats, nationaliteit, woonadres, huisarts, burgerlijke staat
— the literal contents of a bewindvoerder's identity request. No cadence, no cost, often
no document.

```sql
CREATE TABLE "profile_attributes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"        text NOT NULL,
  "value"      text NOT NULL,
  "valid_from" date,
  "note"       text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "profile_key_idx" ON "profile_attributes" ("key", "valid_from" DESC NULLS LAST);
GRANT SELECT, INSERT, UPDATE ON "profile_attributes" TO verder_app;
```

**Local-only is true by construction, not by a flag.**

- **Human-write-only.** No mining job, no suggestion kind, no LLM ever reads or writes this
  table — Martin types these. There is no cloud path to close because none exists. The
  enforcement is the absence of a mechanism, not a boolean anyone can flip.
- **No search trigger, and not in `SEARCH_ENTITY_TYPES`.** A BSN cannot leak into a chunk if
  nothing ever enqueues it.
- The worker gets **no grant at all** on this table.

`key` is validated against a closed tuple in TypeScript (the `SEARCH_ENTITY_TYPES` pattern),
so a typo'd key is a type error rather than a second row nobody finds. `valid_from` keeps
the previous address when it changes.

Note the two mechanisms are separate and both are needed: the *paspoort scan* stays local
via document-class routing (below); the *BSN value* stays local because nothing but Martin
ever writes it.

### `dossier-series.ts` — **DERIVED**, nothing stored

Pure, no `@verder/db` import, unit-tested without a database — the `money-series.ts`
precedent. Recomputed on every read. No `expected_documents` materialisation, no rollup,
no cache: a stored gap is a second thing that must stay in sync, which is the
`search_chunks.status` trap in a new place, and `TRUNCATE ... CASCADE` would wipe it.

### Deliberately deferred

`document_fact_transactions` — reconciling a payslip against the bank credits that paid it.
A `reconciles_transaction_id` column is the wrong cardinality: a split payment, a correction
run and a separately paid bonus are all one payslip against several bank rows. When it
comes, it comes as a join table with `SELECT, INSERT`, its own `document.fact.reconciled`
event on the link row, and its own verification branch. Do not now add a column already
known to be wrong.

## Waar wat woont

The rule: **something is a column if a query filters on it, sorts on it, or compares a
*set* with it.** Everything else is `details`.

| Store | Holds | Why |
|---|---|---|
| Structured SQL | `document_facts`, `document_expectations`, `employments`, `party_links`, `accounts`, `profile_attributes` | Only SQL has `NOT EXISTS`, `ORDER BY period_start` and a `LIMIT` that means what it says. Every set-question lives here. |
| pgvector / `search_chunks` | unchanged — **no tenth entity type** | Facts fold into their *document's* chunk via three `field()` lines in `renderDocument` ("Periode", "Werkgever", "Netto"). A tenth `SEARCH_ENTITY_TYPES` value costs eight files plus permanent pension debt — `reindex --prune` walks that tuple and can never clean a retired kind, and 2875 poisoned outbox rows was the measured price — for a record with no page of its own. |
| The vault | untouched | `documents.sha256` stays the identity of the bytes. `document_facts` copies *nothing* — not title, status, mime or date — only `document_id`, and the reader joins live, batched. The pointer law `track-evidence.ts` already follows. |
| `document_texts` | the extraction input | The facts prompt eats the same string the index holds, preserving the sub-project 4 invariant. |
| No fourth store | — | Every relationship this dossier needs is a foreign key or a column. |

**The trigger that must not be forgotten** is `document_facts_search_outbox_trg`. Without it,
approving a fact changes a document's rendered body while nothing re-enqueues it — exactly
the bug migration 0017 documents for `document_status_changes`.

**Two coverage universes that must never merge:** `coverageForMonths` (bank statements, feeds
`lastCompleteMonth` and therefore the projection base) and dossier coverage (do I have the
loonstrook). If a payslip could ever mark a month `complete`, `/money` would project income
from a document instead of from a bank.

## De loonstrook-vraag

Today 2026-08-27. Five TrueFullstaq stroken from a former colleague plus June and July from
Saurens are in the vault; VerderGroep asked for recent salary slips.

**Two expectation rows**, typed by Martin or created by the button on `employments`:

| kind | subject_label | cadence | expect_from | expect_until | due_after_days |
|---|---|---|---|---|---|
| payslip | TrueFullstaq B.V. | monthly | 2026-02-01 | 2026-06-10 | 10 |
| payslip | Saurens Marketing B.V. | monthly | 2026-06-10 | *null* | 10 |

**Query A — the ordered set** (`documentFacts.list({ kind: 'payslip', limit: 6 })`):

```sql
WITH effective AS (
  SELECT f.* FROM document_facts f
  WHERE f.kind = 'payslip'
    AND f.voids = false
    AND NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = f.id)
)
SELECT e.id, e.expectation_id, e.document_id, e.period_start, e.period_end,
       e.issuer_name, e.amount_cents, e.details, d.sha256,
       COALESCE(c.title, d.title) AS title
FROM effective e
JOIN documents d ON d.id = e.document_id
LEFT JOIN LATERAL (
  SELECT status, title FROM document_status_changes
  WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
) c ON true
WHERE COALESCE(c.status, d.status) IS DISTINCT FROM 'discarded'
ORDER BY e.period_start DESC NULLS LAST, e.issuer_name
LIMIT 6;
```

Three load-bearing details, all copied from code that already exists: the discard filter is
`IS DISTINCT FROM`, not `<>` (`NULL <> 'discarded'` is NULL); it sits **before** the
`LIMIT 6`, so a discarded document can never eat one of the six slots; and `NULLS LAST`,
because a fact without a period does not belong at the top.

The employer is **not** in the `WHERE`. The set is *kind + period*, so an employer change is
an `ORDER BY` — where in `money-series.ts` the same change cost a measured
`INCOME_CONTINUATION_TOLERANCE_NUM/_DEN = 1/2` heuristic.

| periode | werkgever | netto |
|---|---|---|
| 2026-07-01 → 07-31 | Saurens Marketing B.V. | € 3.556,42 |
| 2026-06-10 → 06-30 | Saurens Marketing B.V. | € 2.487,71 |
| 2026-06-01 → 06-10 | TrueFullstaq B.V. | € 1.118,65 |
| 2026-05-01 → 05-31 | TrueFullstaq B.V. | € 2.660,68 |
| 2026-04-01 → 04-30 | TrueFullstaq B.V. | € 648,00 |
| 2026-03-01 → 03-31 | TrueFullstaq B.V. | … |

June appears twice with the correct part-month boundaries, and nothing in the query knows
about June.

**Query B — the expectations**, a plain `SELECT ... WHERE kind='payslip' AND active`. A pure
function then decides:

```ts
export type SlotState = "aanwezig" | "loopt-nog" | "nog-niet-verwacht" | "ontbreekt";
export function buildDossierSeries(input: {
  facts: FactRow[]; expectations: ExpectationRow[]; today: string;
}): { slots: Slot[]; unexpected: FactRow[] }
```

Per expectation: walk `expect_from … min(expect_until ?? today, today)` in **Amsterdam
calendar days**, reusing `addMonths` / `monthDayBounds` from `money-series.ts` rather than
deriving them again. Each step is a slot, clipped to the expectation's boundaries — so June
yields two slots.

**Matching is on `fact.expectation_id` plus period overlap, never on name.**
`normalizeName("Saurens Marketing B.V.")` is `"saurens marketing b v"` and does not match
`"Saurens Marketing"`. The link is recorded when Martin approves; the matcher only *proposes*
the series. A fact with no `expectation_id` falls back to kind + normalised name + overlap and
is marked *derived*, so the UI can show that it is a guess.

| state | meaning |
|---|---|
| `aanwezig` | a live fact fills the slot and its document is not discarded |
| `loopt-nog` | `today <= periodEnd` — the period is still running |
| `nog-niet-verwacht` | period over, `today <= periodEnd + due_after_days` |
| `ontbreekt` | due date passed and nothing fills it — **this is the answer** |

The join is **symmetric**. A fact filling no slot at all comes back as `unexpected`. That is
the only path by which "a 2024 payslip surfaces in 2027, from a job never recorded" reaches
Martin instead of vanishing quietly — it is simultaneously the gap report and the prompt to
fix the expectation that made the gap report wrong.

A slot whose only fact sits on a discarded document is `ontbreekt` **with `discardedFactId`
attached**, so the page says *"was er wel, document is weggegooid"* rather than silently
losing it.

**Gaps are sorted, never hidden.** An `employments` row with `ended_on` set is a closed
series by construction, so its gaps render as *historisch*; open series produce *openstaand*.
That keeps *maart 2021* from burying *vorige maand*, without either disappearing.

**Today's answer:**

> **Loonstroken — 6 aanwezig, 1 loopt nog.**
> augustus 2026 (Saurens Marketing) — de periode loopt nog t/m 31-08.
> Geen ontbrekende stroken sinds 1 februari 2026.

Had the colleague sent only three, it would read *ontbreekt: maart, april (TrueFullstaq)*
with a per-row "vraag op" button writing a `tasks` row. That table already has `dueAt`, an
append-only ladder and a dashboard: the gap report needs no reminder engine, it needs to hand
a gap to the thing that already chases work.

Jaaropgaven fall out of the same code with `cadence='yearly'` and `due_after_days` to
1 February. 2026 expects two — one per employer — and both read `nog-niet-verwacht` until
early 2027. That is the "a year can hold more than one employer" case with no special-casing,
because the expected set is generated per *series*, not per year.

## Extraction: local first, cloud vision as measured fallback

### Why vision at all

`extractDocumentText` runs a PDF through `pdf-parse` and only rasterizes + OCRs if that
returns under `MIN_PDF_TEXT_CHARS`. A Dutch loonstrook is a dense multi-column form with a
cumulatieven block; `pdf-parse` returns a flat character stream **with the layout destroyed**,
so "Netto" and its amount can end up unrelated in the string. The text-only path does not
merely make extraction harder — it discards the structure the facts need, before any model
sees the document.

And when it does fall through to OCR, `tesseract.js` at 200 DPI with `nld+eng` is the weakest
link in the chain, and it shipped silently broken once: the ESM/CJS interop bug at
`extract.ts:36-50` meant nine scanned letters extracted zero characters while the backfill
reported zero failures.

A vision model reading the rendered page skips both failure modes. `rasterizePdf` already
produces exactly the PNGs such a call needs.

### The routing rule

`LlmPort` is a one-method interface (`chatJson`) injected via `deps` everywhere, so an OpenAI
implementation is one file with no call-site changes. Vision needs a second method
(`chatJsonVision(prompt, images)`), because the interface is text-only today.

**Local stays the default.** High-volume text jobs — entry, task and registry mining — do not
change. Cloud vision is reachable only from document-fact extraction, and only as a fallback.

**Class routing, and its trap:** a document's class is not known until something has read it.
So the gate keys only on what is known *before* the model runs — an already-approved
`docType`, the filename, the sender — and **an unclassified document is local-only**. Cloud is
opt-in per class, never the default for an unknown. Otherwise the first paspoort scan with a
generic filename goes straight out the door, which is the exact case the routing exists to
prevent.

| class | route |
|---|---|
| loonstrook, jaaropgave, bank statement, invoice | local text → cloud vision on escalation |
| identity (paspoort, ID, BSN-bearing), medical | **local only**, never escalates |
| unclassified | **local only** |

### Escalation triggers are measured, not self-reported

Asking a model for a confidence score yields a number that tracks fluency, not correctness.
Confidence here is **routing, never approval**: it decides which model runs, and never whether
Martin reviews. Escalate on:

- Zod parse failure, or a required field returning null (no period, no amount).
- `extractor === "ocr-pdf"`, or a suspiciously low char count — the *text* is weak, so skip the
  text attempt and go to vision directly. Known before any model runs.
- **Internal arithmetic.** A loonstrook where bruto − inhoudingen ≠ netto was mis-read. A fact,
  not a vibe.
- **Bank reconciliation.** A payslip's netto should appear as a credit in `transactions` from
  that employer's IBAN within a few days; `money-series` already knows those credits. A reading
  that does not reconcile is the strongest available "not confident" signal in this system, and
  it costs one query.

### The ladder

1. Local reads it → validators green → normal `pending` suggestion.
2. Validators red → cloud vision retry → green → `pending`, marked escalated.
3. Both fail, **or the two models disagree** → `needs-manual` showing **both readings side by
   side** so Martin arbitrates rather than retypes.

Case 3 is the interesting one: two independent readings that differ is exactly where his
judgement is worth most, and it is cheap to render.

### Recording the chain

`suggestions.model` and `promptVersion` are single columns presupposing one call. Keep their
meaning strict — they name the call that produced `proposed` — and carry the full trail in
`proposed.attempts[]` (model, promptVersion, result, which validators failed). This makes the
golden-rule record *richer* rather than ambiguous, and lets a later question be answered from
data: *how often did local get it right unaided?* — which is the number that says whether cloud
is still earning its keep.

**Secrets:** the OpenAI key lives in `~/apps/verder/.env.prod` at 600 alongside the Gmail
secrets, never committed. A key in the local macOS keychain does not reach a worker running in
Docker on the homelab.

**Possible middle rung, to be measured and not assumed:** a local vision model on the RX 9070
as attempt two, before cloud. Worth an eval column; not worth building on faith.

## Wat we NIET bouwen

- **No EAV / claims / subjects model.** One payslip becomes ~8 suggestions under a
  claim-per-fact model, so seven stroken are 56 rows in a queue that is 18 lines of React with
  no grouping. The unit of approval must be the document, because that is what Martin reads.
- **No table per life-domain** (verzekering, energie, water, telecom). `financial_items` already
  has `category` with `insurance`/`energy`/`telecom`/`housing`, `provider_party_id`,
  `contract_start`/`contract_end`, `notice_period`, `cancellation_method` and
  `discovered_via: 'manual'`, and its status ladder *starts* at `identified` — literally "I know
  this exists and I have nothing yet". `registry-mine` already fills it from incasso's. Four of
  the seven domains need **no new code**.
- **No generic `party_roles` table.** The FK columns already carry roles; employer is supplied by
  `employments.employer_party_id`.
- **No tenth `SEARCH_ENTITY_TYPES` value.**
- **No income table, and nothing touches `/money`'s arithmetic.** `money-series.real.test.ts`
  must pass unchanged, with facts present and absent. A payslip's netto *is* the bank credit;
  adding it to `inCents` counts the same euro twice — the third time this repo meets that shape.
- **No `confidence` column and no auto-approval at any threshold.** A stored number invites
  treating an unapproved fact as three-quarters true. Escalation signals are computed and
  discarded, not persisted as a score.
- **No `reconciles_transaction_id` column** — wrong cardinality. Join table or nothing.
- **No materialised gaps.** A stored gap goes stale the moment a date is corrected, and
  `TRUNCATE ... CASCADE` would wipe it — then it needs a reseeder for data that should never
  have been stored.
- **No broad enum on day one.** `payslip` and `annual-statement`. `ALTER TYPE ... ADD VALUE` is
  cheap; a broad enum is a promise about extraction quality nobody has measured.
- **No agentic loop.** Every LLM call here stays single-shot, JSON-mode, Zod-validated. The
  agentic triage loop is sub-project 10 and has its own spec.
- **No eval gate in CI.** Same house style as the existing four: report, do not block.

## De plakken

### Plak 0 — close the extraction gap. No migration. Ship first and alone.

`suggest.docmeta` is enqueued by exactly one caller: `nas.scan` (`index.ts:74`).
`gmail.poll` enqueues only `suggest.entry`, and `documents.registerUpload` enqueues nothing.
**The five TrueFullstaq stroken arrived as mail attachments, so without this slice there is no
text to extract facts from and everything downstream is dead on arrival.**

Independently valuable: every mailed and uploaded document becomes findable by its content
instead of its filename — precisely the lesson migration 0019 already recorded ("18 documents
indexed, 0 `document_texts` rows"), now true again for two of the three ingest paths.

Why separate: it touches the `gmail.poll` path, the one component that has caused an
account-wide 429 lockout that does not self-heal, and it puts OCR plus a 120 s LLM call inline
in ingest. The first run inherits the backlog including the 16-file moratorium package, on a GPU
where evals already abort under production contention. Run the backfill with LLM jobs paused,
let the queue drain at cron pace, and watch `worker_runs` for docmeta timeouts for a full day.
This costs no extra calendar time — slice 1 must do it anyway — but it makes the change
reversible without a migration, and a red `/verify` during slice 1 can then never be confused
with an ingest regression.

### Plak 1 — facts exist, payslips are in order. Migration 0025.

**Ships:** `/dossier/loonstroken`, newest first, both employers, with the period each strook
covers. A page Martin can paste into a mail to VerderGroep tomorrow. No gap analysis yet.

**Contains:** migration 0025 (enum, `document_facts`, `document_expectations`, evidence grants,
indexes, `ALTER TYPE suggestion_kind ADD VALUE 'document-fact'`, search trigger) — **from the
homelab HOST before the images**, because 0020, 0021, 0022 and 0023 all tripped on exactly this;
`buildDocFactsPrompt` + `DOCFACTS_PROMPT_VERSION = "docfacts-v1"` in `prompts.ts`, keeping that
file the single index of every prompt; a deterministic gate before the 20 s call (the
`already-have.ts` precedent: mine only when the effective `docType` is in the vocabulary or a
cheap regex on `Loonstrook|Jaaropgave|Cumulatief|Periode\s+\d+` hits); `suggestDocFacts` with
exactly `suggestDocMeta`'s failure contract (a parse error becomes `needs-manual` with degraded
`proposed`, never a lost document, never throws); `routers/document-facts.ts` exporting
`factFields` which `suggestions.approveDocumentFact` imports (the `itemFields`/`taskFields` rule,
so manual creation and approval cannot drift); the `document.fact` branch in
`makeLedgerRecompute` plus the orphan count; `effectiveFacts` called from `renderRow`'s
`document` case alongside `effectiveDocument`, deterministically sorted on `(period_start, id)`.

**How we know it works:**

1. **Yes, this deserves an eval.** `run-docfacts-eval.ts` on the `run-registry-eval.ts` template:
   real post-OCR text with the noise in it (the eval must eat what production eats), the same Zod
   shape production validates, `period_start`/`period_end`/`amount_cents` scored exactly as
   integers and dates, `issuer_name` reference-only because it is free text, one PASS/FAIL line
   per sample, closing with `n/N with model=… prompt=docfacts-v1`, no non-zero exit.
   **With negatives**: an undated letter, a jaaropgave that must not read as a loonstrook, a
   strook with no cumulative where `null` is expected. The retrieval eval's negatives were 0/3 on
   first run and were the only thing that found a real defect. Baseline in CLAUDE.md as a **range
   over three completed runs** with the flaky sample named — never a single number.
   Report local and cloud columns side by side; that comparison is what justifies cloud, or
   retires it.
2. **`/verify` green** with the new branch *and* the orphan count, plus a direct test on the
   dispatch line itself.
3. **The real seven stroken** produce exactly the six-row list above and zero `ontbreekt` — an
   integration test on real OCR text, because that is the only measurement that counts.
4. **`money-series.real.test.ts` and `money-series.test.ts` pass unchanged**, with facts present
   and absent. That is an acceptance criterion, not a test to adjust.

The eval cannot catch one thing, and it belongs in the comment: a well-formed but wrong period on
a document kind it has never seen. That is precisely the error that looks most authoritative on
the gap page and that Martin forwards to his bewindvoerder. Approval-before-fact damps it; it
does not remove it.

### Plak 2 — the dossier knows Martin. Migration 0026.

`employments`, `party_links`, `parties.ingest_mail` (with the backfill), `profile_attributes`,
`dossier-series.ts` with the four states and `unexpected`, and the openstaand/historisch split.
The identity question becomes answerable; "who do I ask at TrueFullstaq" becomes a query rather
than a guess.

### Plak 3 — reconciliation and labels. Migration 0027.

`accounts` → `accountLabels`; the reconciliation join table as a **disclosure**, never a silent
correction (the `incidentalRows` style, because "a cent amount on its own is not a disclosure");
and last and most carefully guarded, excluding an evidence-identified vakantiegeld from the top
band in `fullPeriodAmount`. That closes the gap deliberately left open at `money-series.ts:266-285`
in the only way that file accepts — the fix is *evidential*, not amount-shaped, so it can never
touch a real part-month, which is exactly why the obvious fallback was rejected on measurement.

## Decided 2026-08-27: `profile_attributes` stays an editable fact table

The one question this spec left open — whether the append-only treatment given to `document_facts`
should extend to `profile_attributes` — is settled: it does not.

The two tables differ in the thing that matters. `document_facts` holds a *model's reading* that
Martin approved, so what was proposed, what was approved and any later correction all have to
survive independently; that is the golden rule, and append-only is how it is enforced.
`profile_attributes` is human-write-only by construction — no mining job, no suggestion kind, no
LLM anywhere near it — so there is no disagreement to record. Append-only there would buy ceremony
with no counterparty, and the person paying for it would be Martin fixing his own typo'd BSN on a
tired evening.

Grants are therefore `SELECT, INSERT, UPDATE` for `verder_app`, no DELETE, and no grant at all for
the worker. A changed address is still a new row with a later `valid_from` — the old one stays —
while `correct` exists for typos. `/verify` says nothing about this table, which is honest: it
could never have proved a hand-typed value right anyway.
