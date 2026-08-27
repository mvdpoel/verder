# De kennisbank — slice 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dossier know *Martin*, not just his documents — where he worked and when, who to ask at each organisation, what his identity facts are — and turn that into the answer to **"what am I missing?"**

**Architecture:** Migration 0026 adds four editable-fact tables around the evidence written in slice 1: `employments` (which generates expectations), `party_links` (n:n between parties, roled and time-scoped), `profile_attributes` (human-write-only, never indexed), and one column-level-granted flag on `parties`. On top sits `dossier-series.ts` — pure, no DB, recomputed on read — which joins the expected set against the live facts and produces four slot states plus an `unexpected` bucket.

**Tech Stack:** TypeScript, Node 22, pnpm 10 workspaces, Next.js (App Router) + tRPC, drizzle-orm, Postgres 17, vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-kennisbank-design.md`
**Predecessor:** `docs/superpowers/plans/2026-08-27-kennisbank-slice-0-1.md` — slices 0 and 1 must be shipped and green before this plan starts. Task 3 here consumes `effectiveFacts` and `document_expectations` from that work.

## Global Constraints

- **Run every build and test with `env -u NODE_ENV`** — the shell exports `NODE_ENV=development`, which breaks `next build`.
- **Dev DB:** `docker compose up -d postgres`. Test URLs: admin `postgres://verder:verder@localhost:5432/verder`, app `postgres://verder_app:verder_app@localhost:5432/verder`, worker `postgres://verder_worker:verder_worker@localhost:5432/verder`.
- **Nothing in this slice is evidence.** No table here appends a ledger event, and `/verify` is untouched. If a task finds itself calling `appendLedgerEvent`, the design has drifted — stop.
- **`parties` is append-only** (`verder_app`: `INSERT, SELECT`). The only mutation permitted on it in this slice is a **column-level** `GRANT UPDATE (ingest_mail)`. Never widen that to a table-level UPDATE.
- **Migration 0026 is applied from the homelab HOST BEFORE the web/worker images deploy.** 0020–0023 and 0025 all tripped on this.
- **Amsterdam calendar days, always.** Reuse `dayKey`/`monthKey`/`addMonths`/`monthDayBounds` from `money-series.ts`. Never form a UTC instant to decide month membership.
- **Tone:** supportive toward Martin; short and professional for anyone else.

## Two corrections to the spec, found while planning

1. **`parties.ingest_mail` as written could not work.** The spec specifies a plain boolean column on `parties`, but `verder_app` holds `INSERT, SELECT` only — there is no UPDATE with which to toggle it. Task 1 uses a **column-level grant** instead: `GRANT UPDATE (ingest_mail) ON parties TO verder_app`. Postgres then enforces that name, email, kind and notes stay immutable while the one non-evidence flag is editable. `ingest_mail` is deliberately **not** added to the `party.created` ledger payload, so toggling it cannot affect the chain.
2. **`addMonths` and `monthDayBounds` are private** in `money-series.ts` (lines 396 and 76). The spec says to reuse them rather than re-derive; Task 2 exports them with a characterisation test first.

## Settled: `profile_attributes` is an editable fact table

The spec carried one open question into this plan — whether `profile_attributes` should be append-only like `document_facts`. **Martin decided on 2026-08-27: editable** (`SELECT, INSERT, UPDATE`, no DELETE).

The reasoning, so a later reader does not reopen it: the golden rule exists to record *model-vs-Martin disagreement*, and there is no model here to disagree with — this table is human-write-only by construction. Append-only would buy ceremony with no counterparty, and the person paying for it would be Martin correcting his own typo'd BSN. `document_facts` is append-only for the opposite reason: a model proposed it, so what was proposed and what was approved both have to survive.

A changed address is still a new row with a later `valid_from`; `correct` is for typos.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/drizzle/0026_dossier.sql` (create) | Migration: four tables, the column grant, the ingest_mail backfill, the deferred FK from 0025. |
| `packages/db/drizzle/meta/_journal.json` (modify) | Journal entry for 0026. |
| `packages/db/src/schema.ts` (modify) | drizzle definitions + `partyLinkRoleEnum`. |
| `packages/db/src/dossier-schema.test.ts` (create) | Grant assertions, including the column-level UPDATE proof. |
| `packages/api/src/money-series.ts` (modify) | Export `addMonths` and `monthDayBounds`. |
| `packages/api/src/dossier-series.ts` (create) | Pure gap engine: slots, four states, `unexpected`. |
| `packages/api/src/dossier-series.test.ts` (create) | Unit tests, no database. |
| `packages/api/src/routers/employments.ts` (create) | CRUD + `proposeExpectation`. |
| `packages/api/src/routers/party-links.ts` (create) | CRUD + `contactsFor`. |
| `packages/api/src/routers/profile.ts` (create) | Human-write-only key/value. |
| `packages/api/src/routers/dossier.ts` (create) | `overview` — loads facts + expectations, calls the pure module. |
| `packages/api/src/root.ts` (modify) | Mount the four routers. |
| `apps/worker/src/gmail.ts` (modify) | Relevance filter honours `ingest_mail`. |
| `apps/web/src/app/(app)/dossier/page.tsx` (create) | The gap page. |

---

### Task 1: Migration 0026 — the four tables and the column grant

**Files:**
- Create: `packages/db/drizzle/0026_dossier.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts`
- Test: `packages/db/src/dossier-schema.test.ts`

**Interfaces:**
- Produces: `schema.employments`, `schema.partyLinks`, `schema.profileAttributes`, `schema.partyLinkRoleEnum`; `parties.ingestMail`.

**Context you need:** `parties` is an evidence table — `partiesRouter.create` appends a `party.created` event. A table-level `GRANT UPDATE` would silently make every party field editable and break that guarantee. Postgres column-level grants are the precise tool: `GRANT UPDATE (ingest_mail) ON parties TO verder_app` permits exactly one column. `employments.employer_name` stays `NOT NULL` and denormalised on purpose — `employer_party_id` and `contract_document_id` both pull rows into `verify.test.ts`'s `TRUNCATE ledger_events, log_entries, documents, parties CASCADE`, so the work history must stay legible without them.

- [ ] **Step 1: Write the migration**

```sql
-- packages/db/drizzle/0026_dossier.sql
-- Sub-project 8, slice 2. Apply from the homelab HOST before deploying images.
-- NOTHING HERE IS EVIDENCE: no ledger events, no /verify branch, UPDATE allowed,
-- DELETE never.

CREATE TABLE "employments" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employer_party_id"    uuid REFERENCES "parties"("id"),
  -- Denormalised and NOT NULL on purpose: employer_party_id and
  -- contract_document_id both drag this row into verify.test.ts's
  -- TRUNCATE ... CASCADE, so the work history must read without them.
  "employer_name"        text NOT NULL,
  -- normalizeAccount()'d. The key detectRecurring groups on, and the only path
  -- from a transaction to an employer — transactions has no party FK.
  "employer_iban"        text,
  "started_on"           date NOT NULL,
  "ended_on"             date,
  "pay_cadence"          "expectation_cadence" NOT NULL DEFAULT 'monthly',
  "paid_to_account_iban" text,
  "contract_document_id" uuid REFERENCES "documents"("id"),
  "note"                 text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employment_period_ck"
    CHECK ("ended_on" IS NULL OR "ended_on" >= "started_on")
);
--> statement-breakpoint
CREATE INDEX "employments_started_idx" ON "employments" ("started_on" DESC);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "employments" TO verder_app;
--> statement-breakpoint
GRANT SELECT ON "employments" TO verder_worker;
--> statement-breakpoint
-- The back-reference deferred out of 0025: employments did not exist there, and
-- a forward FK is a migration that does not apply.
ALTER TABLE "document_expectations"
  ADD COLUMN "source_employment_id" uuid REFERENCES "employments"("id");
--> statement-breakpoint

CREATE TYPE "party_link_role" AS ENUM
  ('works-at','contact-for','represents','department-of');
--> statement-breakpoint
-- parties.kind is already person|organization; what was missing is the EDGE.
-- parties.organization (free text) is this relationship flattened into something
-- unusable. It is deprecated, not dropped: existing rows and case-history write
-- it, readers prefer the link and fall back to the string.
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
  CONSTRAINT "party_link_not_self_ck" CHECK ("from_party_id" <> "to_party_id"),
  CONSTRAINT "party_link_window_ck"
    CHECK ("valid_to" IS NULL OR "valid_from" IS NULL OR "valid_to" >= "valid_from")
);
--> statement-breakpoint
CREATE INDEX "party_links_to_idx" ON "party_links" ("to_party_id", "role");
--> statement-breakpoint
CREATE INDEX "party_links_from_idx" ON "party_links" ("from_party_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "party_links" TO verder_app;
--> statement-breakpoint
GRANT SELECT ON "party_links" TO verder_worker;
--> statement-breakpoint

-- LOCAL ONLY, BY CONSTRUCTION rather than by a flag:
--   * human-write-only — no mining job, no suggestion kind, no LLM ever reads or
--     writes this table, so there is no cloud path to close;
--   * no search trigger and not in SEARCH_ENTITY_TYPES — a BSN cannot leak into a
--     chunk if nothing ever enqueues it;
--   * the worker gets NO GRANT AT ALL.
CREATE TABLE "profile_attributes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"        text NOT NULL,
  "value"      text NOT NULL,
  "valid_from" date,
  "note"       text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "profile_key_idx"
  ON "profile_attributes" ("key", "valid_from" DESC NULLS LAST);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "profile_attributes" TO verder_app;
--> statement-breakpoint

-- parties.email feeds the Gmail relevance filter, so filling in a contact form
-- silently changes what lands in the vault. This makes ingestion an explicit
-- per-party choice.
ALTER TABLE "parties" ADD COLUMN "ingest_mail" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- BACKFILL BEFORE THE GRANT: the column defaults to false, which NARROWS
-- ingestion for every party that exists today — all of them currently feed the
-- filter. A migration must never silently mute the poller.
UPDATE "parties" SET "ingest_mail" = true;
--> statement-breakpoint
-- COLUMN-LEVEL grant, and this is the whole point. parties is EVIDENCE:
-- verder_app holds INSERT, SELECT and no UPDATE, and partiesRouter.create
-- appends a party.created event. A table-level GRANT UPDATE would quietly make
-- name, email, kind and notes editable and destroy that guarantee. Naming the
-- one column lets Postgres enforce the distinction. ingest_mail is deliberately
-- NOT part of the party.created ledger payload, so toggling it cannot affect
-- the hash chain.
GRANT UPDATE ("ingest_mail") ON "parties" TO verder_app;
```

- [ ] **Step 2: Add the journal entry**

Append to `entries` in `packages/db/drizzle/meta/_journal.json`:

```json
{
  "idx": 26,
  "version": "7",
  "when": 1787671607836,
  "tag": "0026_dossier",
  "breakpoints": true
}
```

- [ ] **Step 3: Add the drizzle definitions**

Append to `packages/db/src/schema.ts`, and add `ingestMail: boolean("ingest_mail").notNull().default(false),` to the existing `parties` table definition:

```ts
export const partyLinkRoleEnum = pgEnum("party_link_role",
  ["works-at", "contact-for", "represents", "department-of"]);

/**
 * Where Martin worked and when. EDITABLE FACT: no ledger, UPDATE allowed,
 * DELETE never. Generates document_expectations rather than being one.
 */
export const employments = pgTable("employments", {
  id: uuid("id").primaryKey().defaultRandom(),
  employerPartyId: uuid("employer_party_id").references(() => parties.id),
  employerName: text("employer_name").notNull(),
  employerIban: text("employer_iban"),
  startedOn: date("started_on").notNull(),
  endedOn: date("ended_on"),
  payCadence: expectationCadenceEnum("pay_cadence").notNull().default("monthly"),
  paidToAccountIban: text("paid_to_account_iban"),
  contractDocumentId: uuid("contract_document_id").references(() => documents.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Parties are n:n with each other, roled and time-scoped. An organisation gets
 * any number of contacts, each with their own validity window; when one leaves,
 * validTo gets a date and they stay in the record.
 */
export const partyLinks = pgTable("party_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromPartyId: uuid("from_party_id").notNull().references(() => parties.id),
  toPartyId: uuid("to_party_id").notNull().references(() => parties.id),
  role: partyLinkRoleEnum("role").notNull(),
  title: text("title"),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("party_links_to_idx").on(t.toPartyId, t.role)]);

/**
 * BSN, geboortedatum, woonadres, nationaliteit, huisarts. HUMAN-WRITE-ONLY and
 * NEVER INDEXED: no mining job writes it, no LLM reads it, no search trigger
 * exists on it, and the worker has no grant. Local-only is enforced by the
 * absence of a mechanism, not by a boolean anyone can flip.
 */
export const profileAttributes = pgTable("profile_attributes", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  validFrom: date("valid_from"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Closed vocabulary — a typo'd key is a type error, not a row nobody finds. */
export const PROFILE_KEYS = [
  "bsn", "geboortedatum", "geboorteplaats", "nationaliteit",
  "woonadres", "burgerlijke-staat", "huisarts", "zorgverzekeraar",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
```

Also add `source_employment_id` to the existing `documentExpectations` definition:
`sourceEmploymentId: uuid("source_employment_id").references(() => employments.id),`

- [ ] **Step 4: Apply the migration**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
```
Expected: `0026_dossier` applied.

- [ ] **Step 5: Write the grants test**

```ts
// packages/db/src/dossier-schema.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("slice 2 tables", () => {
  let admin: Db, app: Db, worker: Db;
  beforeAll(() => {
    admin = createDb(ADMIN_URL).db; app = createDb(APP_URL).db; worker = createDb(WORKER_URL).db;
  });

  it("employments is an editable fact table: insert and update, never delete", async () => {
    const [e] = await app.insert(schema.employments)
      .values({ employerName: "TrueFullstaq B.V.", startedOn: "2019-04-01" }).returning();
    await app.update(schema.employments).set({ endedOn: "2026-06-10" })
      .where(eq(schema.employments.id, e.id));
    await expect(app.delete(schema.employments).where(eq(schema.employments.id, e.id)))
      .rejects.toThrow(/permission denied/i);
  });

  it("rejects an employment that ends before it starts", async () => {
    await expect(app.insert(schema.employments).values({
      employerName: "X", startedOn: "2026-06-10", endedOn: "2026-04-01",
    })).rejects.toThrow(/employment_period_ck/i);
  });

  it("party_links rejects a self-link", async () => {
    const [p] = await app.insert(schema.parties)
      .values({ kind: "organization", name: `Org ${Date.now()}` }).returning();
    await expect(app.insert(schema.partyLinks)
      .values({ fromPartyId: p.id, toPartyId: p.id, role: "works-at" }))
      .rejects.toThrow(/party_link_not_self_ck/i);
  });

  it("links a person to an organisation with a validity window", async () => {
    const [org] = await app.insert(schema.parties)
      .values({ kind: "organization", name: `TFS ${Date.now()}` }).returning();
    const [person] = await app.insert(schema.parties)
      .values({ kind: "person", name: "Larissa van Woudenberg" }).returning();
    const [l] = await app.insert(schema.partyLinks).values({
      fromPartyId: person.id, toPartyId: org.id, role: "works-at",
      validFrom: "2021-01-01", validTo: "2026-06-10" }).returning();
    expect(l.role).toBe("works-at");
  });

  it("the worker has NO grant at all on profile_attributes", async () => {
    await expect(worker.select().from(schema.profileAttributes).limit(1))
      .rejects.toThrow(/permission denied/i);
  });

  it("profile_attributes is editable by the app — a typo is a typo", async () => {
    const [a] = await app.insert(schema.profileAttributes)
      .values({ key: "woonadres", value: "Oude straat 1" }).returning();
    await app.update(schema.profileAttributes).set({ value: "Nieuwe straat 2" })
      .where(eq(schema.profileAttributes.id, a.id));
    await expect(app.delete(schema.profileAttributes)
      .where(eq(schema.profileAttributes.id, a.id))).rejects.toThrow(/permission denied/i);
  });

  it("the app may toggle parties.ingest_mail…", async () => {
    const [p] = await app.insert(schema.parties)
      .values({ kind: "organization", name: `Werkgever ${Date.now()}` }).returning();
    await app.update(schema.parties).set({ ingestMail: true })
      .where(eq(schema.parties.id, p.id));
    const [after] = await app.select().from(schema.parties)
      .where(eq(schema.parties.id, p.id));
    expect(after.ingestMail).toBe(true);
  });

  it("…and NOTHING else on parties — the column grant is the whole point", async () => {
    const [p] = await app.insert(schema.parties)
      .values({ kind: "organization", name: `Onaantastbaar ${Date.now()}` }).returning();
    await expect(app.update(schema.parties).set({ name: "gewijzigd" })
      .where(eq(schema.parties.id, p.id))).rejects.toThrow(/permission denied/i);
    await expect(app.update(schema.parties).set({ email: "nieuw@test.local" })
      .where(eq(schema.parties.id, p.id))).rejects.toThrow(/permission denied/i);
  });

  it("new parties default to ingest_mail = false", async () => {
    const [p] = await app.insert(schema.parties)
      .values({ kind: "person", name: `Nieuw ${Date.now()}` }).returning();
    expect(p.ingestMail).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `env -u NODE_ENV pnpm --filter @verder/db test dossier-schema`
Expected: PASS, 9 tests. The two `parties` tests are the ones that matter — they prove the column grant is precise.

- [ ] **Step 7: Verify the backfill did not mute the poller**

```bash
docker compose exec -T postgres psql -U verder -d verder \
  -c "SELECT ingest_mail, count(*) FROM parties GROUP BY 1;"
```
Expected: every party that existed before the migration reads `true`. Only rows created after it read `false`.

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/0026_dossier.sql packages/db/drizzle/meta/_journal.json \
        packages/db/src/schema.ts packages/db/src/dossier-schema.test.ts
git commit -m "feat(db): employments, party_links, profile_attributes, and a column-level ingest_mail grant"
```

---

### Task 2: Export the Amsterdam date helpers

**Files:**
- Modify: `packages/api/src/money-series.ts` (lines 76 and 396)
- Test: `packages/api/src/money-series.test.ts`

**Interfaces:**
- Produces: `export function addMonths(month: string, n: number): string` and
  `export function monthDayBounds(month: string): { first: string; last: string }`.

**Context you need:** These are private today. `dossier-series.ts` must reuse them rather than re-derive month arithmetic — a second implementation of "the last day of a month in Amsterdam" is precisely the kind of duplication that drifts. Exporting is behaviour-preserving, but write a characterisation test first so a later edit to them cannot silently change both consumers.

- [ ] **Step 1: Write the characterisation test**

Append to `packages/api/src/money-series.test.ts`:

```ts
import { addMonths, monthDayBounds } from "./money-series";

describe("month arithmetic (shared with dossier-series)", () => {
  it("adds and subtracts months across a year boundary", () => {
    expect(addMonths("2026-01", 1)).toBe("2026-02");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-06", 12)).toBe("2027-06");
  });

  it("gives the first and last civil day of a month", () => {
    expect(monthDayBounds("2026-05")).toEqual({ first: "2026-05-01", last: "2026-05-31" });
    expect(monthDayBounds("2026-06")).toEqual({ first: "2026-06-01", last: "2026-06-30" });
    expect(monthDayBounds("2026-02")).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(monthDayBounds("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test money-series`
Expected: FAIL — `addMonths` is not exported.

- [ ] **Step 3: Export both**

In `packages/api/src/money-series.ts`, change `function monthDayBounds(` to `export function monthDayBounds(` and `function addMonths(` to `export function addMonths(`. Add to the doc comment of each:

```ts
/** Exported for dossier-series.ts (slice 2): month arithmetic must have exactly
 *  one implementation, or "the last day of a month" drifts between consumers. */
```

- [ ] **Step 4: Run the whole money suite — this is the guard that nothing moved**

Run: `env -u NODE_ENV pnpm --filter @verder/api test money`
Expected: PASS, including `money-series.real.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/money-series.ts packages/api/src/money-series.test.ts
git commit -m "refactor(api): export addMonths and monthDayBounds for dossier-series"
```

---

### Task 3: `dossier-series.ts` — the gap engine

**Files:**
- Create: `packages/api/src/dossier-series.ts`
- Test: `packages/api/src/dossier-series.test.ts`

**Interfaces:**
- Consumes: `addMonths`, `monthDayBounds` from Task 2.
- Produces:
  ```ts
  export type SlotState = "aanwezig" | "loopt-nog" | "nog-niet-verwacht" | "ontbreekt";
  export interface Slot {
    expectationId: string; subjectLabel: string; kind: string;
    periodStart: string; periodEnd: string; state: SlotState;
    factId: string | null; matchedBy: "expectation" | "derived" | null;
    discardedFactId: string | null; dueOn: string;
  }
  export interface FactRow {
    id: string; expectationId: string | null; kind: string;
    periodStart: string | null; periodEnd: string | null;
    issuerName: string; amountCents: number | null; discarded?: boolean;
  }
  export interface ExpectationRow {
    id: string; kind: string; subjectLabel: string;
    cadence: "monthly" | "four-weekly" | "yearly" | "once";
    expectFrom: string; expectUntil: string | null;
    dueAfterDays: number; active: boolean; sourceEmploymentId: string | null;
  }
  export function buildDossierSeries(input: {
    facts: FactRow[]; expectations: ExpectationRow[]; today: string;
  }): { slots: Slot[]; unexpected: FactRow[] };
  ```

**Context you need:** Pure — no `@verder/db` import, unit-tested without a database, the `money-series.ts` precedent. Nothing is stored: a materialised gap goes stale the moment a date is corrected, and `TRUNCATE ... CASCADE` would wipe it.

**Matching is on `expectationId` plus period overlap, never on name.** `normalizeName("Saurens Marketing B.V.")` is `"saurens marketing b v"` and does not match `"Saurens Marketing"`. A fact with no `expectationId` falls back to kind + normalised name + overlap and is marked `matchedBy: "derived"`, so the UI can show it is a guess.

**The join is symmetric.** A fact filling no slot comes back in `unexpected` — the only path by which "a 2024 payslip surfaces in 2027 from a job never recorded" reaches Martin rather than vanishing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/dossier-series.test.ts
import { describe, expect, it } from "vitest";
import { buildDossierSeries, type ExpectationRow, type FactRow } from "./dossier-series";

const TFS: ExpectationRow = {
  id: "e-tfs", kind: "payslip", subjectLabel: "TrueFullstaq B.V.", cadence: "monthly",
  expectFrom: "2026-02-01", expectUntil: "2026-06-10", dueAfterDays: 10,
  active: true, sourceEmploymentId: null,
};
const SMB: ExpectationRow = {
  id: "e-smb", kind: "payslip", subjectLabel: "Saurens Marketing B.V.", cadence: "monthly",
  expectFrom: "2026-06-10", expectUntil: null, dueAfterDays: 10,
  active: true, sourceEmploymentId: null,
};
const fact = (o: Partial<FactRow> & { id: string }): FactRow => ({
  expectationId: null, kind: "payslip", periodStart: null, periodEnd: null,
  issuerName: "TrueFullstaq B.V.", amountCents: null, ...o,
});

describe("buildDossierSeries", () => {
  it("marks a slot aanwezig when a live fact fills it", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27",
      facts: [fact({ id: "f1", expectationId: "e-tfs",
        periodStart: "2026-03-01", periodEnd: "2026-03-31" })],
    });
    const mrt = slots.find((s) => s.periodStart === "2026-03-01")!;
    expect(mrt.state).toBe("aanwezig");
    expect(mrt.factId).toBe("f1");
    expect(mrt.matchedBy).toBe("expectation");
  });

  it("reports ontbreekt once the due date has passed", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27", facts: [],
    });
    expect(slots.filter((s) => s.state === "ontbreekt").length).toBeGreaterThan(0);
    expect(slots.every((s) => s.state !== "aanwezig")).toBe(true);
  });

  it("a period still running is loopt-nog, never ontbreekt", () => {
    const { slots } = buildDossierSeries({
      expectations: [SMB], today: "2026-08-15", facts: [],
    });
    const aug = slots.find((s) => s.periodStart === "2026-08-01")!;
    expect(aug.state).toBe("loopt-nog");
  });

  it("a finished period inside the issuance lag is nog-niet-verwacht", () => {
    // July ended on the 31st; dueAfterDays is 10, so on 5 August it is not late.
    const { slots } = buildDossierSeries({
      expectations: [SMB], today: "2026-08-05", facts: [],
    });
    expect(slots.find((s) => s.periodStart === "2026-07-01")!.state).toBe("nog-niet-verwacht");
    // …and on 12 August it is.
    const later = buildDossierSeries({ expectations: [SMB], today: "2026-08-12", facts: [] });
    expect(later.slots.find((s) => s.periodStart === "2026-07-01")!.state).toBe("ontbreekt");
  });

  it("clips slots to the expectation window, so June yields two part-months", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS, SMB], today: "2026-08-27", facts: [],
    });
    const june = slots.filter((s) => s.periodStart.startsWith("2026-06"));
    expect(june).toHaveLength(2);
    expect(june.map((s) => `${s.periodStart}→${s.periodEnd}`).sort())
      .toEqual(["2026-06-01→2026-06-10", "2026-06-10→2026-06-30"]);
  });

  it("generates nothing before expect_from — the horizon is the brake on ghost gaps", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27", facts: [],
    });
    expect(slots.every((s) => s.periodStart >= "2026-02-01")).toBe(true);
  });

  it("falls back to name matching and marks it derived", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27",
      facts: [fact({ id: "f2", periodStart: "2026-04-01", periodEnd: "2026-04-30",
        issuerName: "TrueFullstaq B.V." })],
    });
    const apr = slots.find((s) => s.periodStart === "2026-04-01")!;
    expect(apr.state).toBe("aanwezig");
    expect(apr.matchedBy).toBe("derived");
  });

  it("returns a fact that fills no slot as unexpected", () => {
    const { unexpected } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27",
      facts: [fact({ id: "old", periodStart: "2024-03-01", periodEnd: "2024-03-31",
        issuerName: "Een oude werkgever" })],
    });
    expect(unexpected.map((f) => f.id)).toEqual(["old"]);
  });

  it("a slot whose only fact is discarded reads ontbreekt, and says so", () => {
    const { slots } = buildDossierSeries({
      expectations: [TFS], today: "2026-08-27",
      facts: [fact({ id: "gone", expectationId: "e-tfs", discarded: true,
        periodStart: "2026-03-01", periodEnd: "2026-03-31" })],
    });
    const mrt = slots.find((s) => s.periodStart === "2026-03-01")!;
    expect(mrt.state).toBe("ontbreekt");
    expect(mrt.discardedFactId).toBe("gone");
  });

  it("an inactive expectation generates no slots", () => {
    const { slots } = buildDossierSeries({
      expectations: [{ ...TFS, active: false }], today: "2026-08-27", facts: [],
    });
    expect(slots).toHaveLength(0);
  });

  it("a yearly expectation yields one slot per year, due in the new year", () => {
    const { slots } = buildDossierSeries({
      today: "2026-08-27", facts: [],
      expectations: [{ ...TFS, id: "e-ja", kind: "annual-statement", cadence: "yearly",
        expectFrom: "2025-01-01", expectUntil: null, dueAfterDays: 32 }],
    });
    expect(slots.find((s) => s.periodStart === "2025-01-01")!.state).toBe("ontbreekt");
    expect(slots.find((s) => s.periodStart === "2026-01-01")!.state).toBe("loopt-nog");
  });

  it("a `once` expectation is a single open-ended checklist item", () => {
    const { slots } = buildDossierSeries({
      today: "2026-08-27", facts: [],
      expectations: [{ ...TFS, id: "e-pas", kind: "payslip", cadence: "once",
        subjectLabel: "Paspoort", expectFrom: "2026-01-01", expectUntil: null,
        dueAfterDays: 0 }],
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].state).toBe("ontbreekt");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test dossier-series`
Expected: FAIL — cannot resolve `./dossier-series`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/api/src/dossier-series.ts
import { addMonths, monthDayBounds } from "./money-series";

/**
 * The gap engine: what OUGHT to exist, minus what does.
 *
 * This is the whole reason slice 1's document_expectations table exists. The core
 * question is not "what do I know" but "what am I missing", and that is a
 * difference between two sets. retrieve() cannot answer it — nearest-neighbour
 * search always returns its k closest rows and has no representation for "no
 * match" beyond a relevance floor.
 *
 * PURE: no @verder/db import, unit-tested without a database, the money-series.ts
 * precedent. Nothing is stored. A materialised gap goes stale the moment a date is
 * corrected, and verify.test.ts's TRUNCATE ... CASCADE would wipe it — then it
 * needs a reseeder for data that should never have been stored.
 *
 * Dates are Amsterdam civil dates throughout, as YYYY-MM-DD strings. No instant is
 * ever formed, so no offset and no DST night can shift an answer.
 */

export type SlotState = "aanwezig" | "loopt-nog" | "nog-niet-verwacht" | "ontbreekt";

export interface FactRow {
  id: string;
  expectationId: string | null;
  kind: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuerName: string;
  amountCents: number | null;
  /** Its document was discarded. The slot then reads ontbreekt, but says why. */
  discarded?: boolean;
}

export interface ExpectationRow {
  id: string;
  kind: string;
  subjectLabel: string;
  cadence: "monthly" | "four-weekly" | "yearly" | "once";
  expectFrom: string;
  expectUntil: string | null;
  dueAfterDays: number;
  active: boolean;
  sourceEmploymentId: string | null;
}

export interface Slot {
  expectationId: string;
  subjectLabel: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  state: SlotState;
  factId: string | null;
  /** How the fact was tied to this slot. "derived" means the matcher guessed. */
  matchedBy: "expectation" | "derived" | null;
  discardedFactId: string | null;
  dueOn: string;
}

/** Civil-date arithmetic: UTC is used only as a calendar, never as an instant. */
function plusDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const maxDay = (a: string, b: string) => (a > b ? a : b);
const minDay = (a: string, b: string) => (a < b ? a : b);

/**
 * Loose name equality for the fallback matcher. Mirrors normalizeName's spirit
 * without importing it: punctuation and legal suffixes are the noise, and an
 * OCR'd issuer rarely spells the B.V. the same way twice.
 */
function looseName(s: string): string {
  return s.toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS <= bE && bS <= aE;

/** The periods one expectation covers, clipped to its own window. */
function periodsFor(e: ExpectationRow, today: string): { start: string; end: string }[] {
  const hardEnd = e.expectUntil ? minDay(e.expectUntil, today) : today;
  if (hardEnd < e.expectFrom) return [];

  // `once` is a single open-ended checklist item — a paspoort, a polisblad, an
  // energiecontract. Same table, same query, no special-casing downstream.
  if (e.cadence === "once") {
    return [{ start: e.expectFrom, end: e.expectUntil ?? today }];
  }

  const out: { start: string; end: string }[] = [];
  if (e.cadence === "yearly") {
    for (let y = Number(e.expectFrom.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) {
      const start = maxDay(`${y}-01-01`, e.expectFrom);
      const end = minDay(`${y}-12-31`, e.expectUntil ?? `${y}-12-31`);
      if (start <= end) out.push({ start, end });
    }
    return out;
  }

  // monthly (four-weekly is treated as monthly for slot generation: the cadence
  // is a fact about the payer, and a four-weekly run still produces roughly one
  // document per month. Refine only if a real four-weekly employer appears.)
  let month = e.expectFrom.slice(0, 7);
  const lastMonth = hardEnd.slice(0, 7);
  // Guard against a malformed window running away.
  for (let i = 0; month <= lastMonth && i < 600; i++, month = addMonths(month, 1)) {
    const { first, last } = monthDayBounds(month);
    // Clipped to the expectation's own boundaries: a job that ended on the 10th
    // yields a part-month, which is exactly how June appears twice across two
    // employers with neither slot knowing about the other.
    const start = maxDay(first, e.expectFrom);
    const end = e.expectUntil ? minDay(last, e.expectUntil) : last;
    if (start <= end) out.push({ start, end });
  }
  return out;
}

export function buildDossierSeries(input: {
  facts: FactRow[]; expectations: ExpectationRow[]; today: string;
}): { slots: Slot[]; unexpected: FactRow[] } {
  const { today } = input;
  const slots: Slot[] = [];
  const claimed = new Set<string>();

  for (const e of input.expectations) {
    if (!e.active) continue;
    for (const p of periodsFor(e, today)) {
      // Prefer an explicitly linked fact; fall back to kind + loose name + overlap
      // and mark it derived. Matching on expectationId first is what stops
      // "Saurens Marketing" and "Saurens Marketing B.V." deciding the answer.
      const candidates = input.facts.filter((f) =>
        f.periodStart && f.periodEnd
        && overlaps(f.periodStart, f.periodEnd, p.start, p.end)
        && !claimed.has(f.id));
      const exact = candidates.find((f) => f.expectationId === e.id);
      const derived = candidates.find((f) =>
        f.expectationId === null && f.kind === e.kind
        && looseName(f.issuerName) === looseName(e.subjectLabel));
      const hit = exact ?? derived;

      const dueOn = plusDays(p.end, e.dueAfterDays);
      let state: SlotState;
      let discardedFactId: string | null = null;
      if (hit && !hit.discarded) {
        state = "aanwezig";
      } else {
        // A slot whose only fact sits on a discarded document reads ontbreekt —
        // but names it, so the page can say "was er wel, document is weggegooid"
        // instead of silently losing it.
        if (hit?.discarded) discardedFactId = hit.id;
        if (today <= p.end) state = "loopt-nog";
        else if (today <= dueOn) state = "nog-niet-verwacht";
        else state = "ontbreekt";
      }
      if (hit) claimed.add(hit.id);

      slots.push({
        expectationId: e.id, subjectLabel: e.subjectLabel, kind: e.kind,
        periodStart: p.start, periodEnd: p.end, state,
        factId: hit && !hit.discarded ? hit.id : null,
        matchedBy: hit && !hit.discarded ? (exact ? "expectation" : "derived") : null,
        discardedFactId, dueOn,
      });
    }
  }

  slots.sort((a, b) =>
    b.periodStart.localeCompare(a.periodStart) || a.subjectLabel.localeCompare(b.subjectLabel));

  // THE JOIN IS SYMMETRIC. A fact filling no slot is the only path by which "a
  // 2024 payslip surfaces in 2027, from a job never recorded" reaches Martin
  // rather than vanishing quietly. It is simultaneously the gap report and the
  // prompt to fix the expectation that made the gap report wrong.
  const unexpected = input.facts.filter((f) => !claimed.has(f.id) && !f.discarded);
  return { slots, unexpected };
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test dossier-series`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/dossier-series.ts packages/api/src/dossier-series.test.ts
git commit -m "feat(api): the gap engine — expected set minus present set, computed on read"
```

---

### Task 4: The dossier router

**Files:**
- Create: `packages/api/src/routers/dossier.ts`
- Modify: `packages/api/src/root.ts`
- Test: `packages/api/src/routers/dossier.test.ts`

**Interfaces:**
- Consumes: `buildDossierSeries`, `effectiveFacts` (slice 1), `schema.documentExpectations`, `schema.employments`.
- Produces: `dossierRouter.overview({ kind? })` returning `{ slots, unexpected, openstaand, historisch }`.

**Context you need:** Gaps are **sorted, never hidden**. An `employments` row with `ended_on` set is a closed series by construction, so its gaps render as *historisch*; open series produce *openstaand*. That keeps *maart 2021* from burying *vorige maand* without either disappearing. The link from a slot to its employment runs through `document_expectations.source_employment_id`.

Discarded facts must be loaded too — `effectiveFacts` excludes nothing about document status, so the loader resolves it the way `listPayslipFacts` does, and passes `discarded: true` rather than dropping the row. A dropped row becomes an ordinary `ontbreekt` and the page loses the ability to say *"was er wel"*.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/routers/dossier.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { loadDossier } from "./dossier";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("loadDossier", () => {
  let db: Db;
  beforeAll(() => { db = createDb(APP_URL).db; });

  it("splits gaps into openstaand and historisch by whether the job ended", async () => {
    const [closed] = await db.insert(schema.employments).values({
      employerName: `Oud ${Date.now()}`, startedOn: "2021-01-01", endedOn: "2021-06-30",
    }).returning();
    const [open] = await db.insert(schema.employments).values({
      employerName: `Nu ${Date.now()}`, startedOn: "2026-06-10",
    }).returning();
    await db.insert(schema.documentExpectations).values([
      { kind: "payslip", subjectLabel: "Oud", cadence: "monthly",
        expectFrom: "2021-01-01", expectUntil: "2021-06-30", sourceEmploymentId: closed.id },
      { kind: "payslip", subjectLabel: "Nu", cadence: "monthly",
        expectFrom: "2026-06-10", sourceEmploymentId: open.id },
    ]);
    const res = await loadDossier(db, "payslip", "2026-08-27");
    expect(res.historisch.length).toBeGreaterThan(0);
    expect(res.openstaand.length).toBeGreaterThan(0);
    expect(res.historisch.every((s) => s.state === "ontbreekt")).toBe(true);
    // Every gap appears in exactly one bucket — a hidden gap is the failure mode.
    const all = new Set([...res.openstaand, ...res.historisch].map((s) =>
      `${s.expectationId}:${s.periodStart}`));
    expect(all.size).toBe(res.openstaand.length + res.historisch.length);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test dossier`
Expected: FAIL — cannot resolve `./dossier`.

- [ ] **Step 3: Write the router**

```ts
// packages/api/src/routers/dossier.ts
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { buildDossierSeries, type FactRow, type Slot } from "../dossier-series";

export interface DossierView {
  slots: Slot[];
  unexpected: FactRow[];
  /** Gaps in a series that is still running — the working list. */
  openstaand: Slot[];
  /** Gaps in a series whose employment has ended. Real, but not actionable. */
  historisch: Slot[];
}

/**
 * Loads the two sets and hands them to the pure engine.
 *
 * Discarded facts are loaded WITH a discarded flag rather than filtered out: a
 * dropped row becomes an ordinary "ontbreekt" and the page loses the ability to
 * say "was er wel, document is weggegooid".
 *
 * The discard filter is IS DISTINCT FROM, not <>: NULL <> 'discarded' is NULL,
 * which would mark every document with no status row as discarded.
 */
export async function loadDossier(db: Db, kind: string, today: string): Promise<DossierView> {
  const facts = [...await db.execute<FactRow>(sql`
    SELECT f.id, f.expectation_id AS "expectationId", f.kind,
           f.period_start AS "periodStart", f.period_end AS "periodEnd",
           f.issuer_name AS "issuerName", f.amount_cents AS "amountCents",
           (COALESCE(c.status, d.status::text) IS NOT DISTINCT FROM 'discarded') AS discarded
    FROM document_facts f
    JOIN documents d ON d.id = f.document_id
    LEFT JOIN LATERAL (
      SELECT status FROM document_status_changes
      WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE f.kind = ${kind} AND f.voids = false
      AND NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = f.id)
  `)];

  const exps = await db.select().from(schema.documentExpectations)
    .where(eq(schema.documentExpectations.kind, kind as "payslip"));
  const employments = await db.select().from(schema.employments);
  // A series whose employment has ended is closed BY CONSTRUCTION. No date
  // heuristic, no arbitrary cutoff — the fact that the job ended is the signal.
  const ended = new Set(employments.filter((e) => e.endedOn !== null).map((e) => e.id));

  const { slots, unexpected } = buildDossierSeries({
    facts,
    expectations: exps.map((e) => ({
      id: e.id, kind: e.kind, subjectLabel: e.subjectLabel, cadence: e.cadence,
      expectFrom: e.expectFrom, expectUntil: e.expectUntil,
      dueAfterDays: e.dueAfterDays, active: e.active,
      sourceEmploymentId: e.sourceEmploymentId ?? null,
    })),
    today,
  });

  const expById = new Map(exps.map((e) => [e.id, e]));
  const isHistoric = (s: Slot) => {
    const src = expById.get(s.expectationId)?.sourceEmploymentId;
    return src !== null && src !== undefined && ended.has(src);
  };
  // Gaps are SORTED, never hidden: both buckets are real, one is the working
  // list. Hiding an old gap trains you to trust the page; losing one teaches you
  // not to.
  const gaps = slots.filter((s) => s.state === "ontbreekt");
  return {
    slots, unexpected,
    openstaand: gaps.filter((s) => !isHistoric(s)),
    historisch: gaps.filter(isHistoric),
  };
}

export const dossierRouter = router({
  overview: protectedProcedure
    .input(z.object({ kind: z.enum(["payslip", "annual-statement"]).default("payslip") }))
    .query(({ ctx, input }) =>
      // Today is an Amsterdam civil date, formed the same way money-series does it.
      loadDossier(ctx.db, input.kind,
        new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date()))),
});
```

- [ ] **Step 4: Mount it**

In `packages/api/src/root.ts`, import `dossierRouter` and add `dossier: dossierRouter,`.

- [ ] **Step 5: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test dossier`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/dossier.ts packages/api/src/routers/dossier.test.ts packages/api/src/root.ts
git commit -m "feat(api): dossier overview — gaps split into openstaand and historisch"
```

---

### Task 5: Employments router and the expectation it proposes

**Files:**
- Create: `packages/api/src/routers/employments.ts`
- Modify: `packages/api/src/root.ts`
- Test: `packages/api/src/routers/employments.test.ts`

**Interfaces:**
- Produces: `employmentFields` (zod), `employmentsRouter` with `list`, `create`, `update`, `proposeExpectation({ employmentId })`, and the exported `proposeExpectationFor(db, employmentId)`.

**Context you need:** **Evidence sets the horizon.** `expectFrom` defaults to the oldest fact held for that employer, and moves *backwards* when something older arrives — never to the employment's `started_on`, which would put ~74 rows reading *ontbreekt* on the page Martin shows his bewindvoerder on day one. When there is no fact at all yet, fall back to `started_on` **and** return a flag so the UI can make Martin confirm rather than silently committing to a decade of gaps.

`employer_iban` is stored `normalizeAccount()`'d — one spelling, always — because it is the key `detectRecurring` groups on and the only path from a transaction to an employer.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/routers/employments.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { proposeExpectationFor } from "./employments";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("proposeExpectationFor", () => {
  let db: Db, userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `emp${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  async function mkFactFor(issuer: string, periodStart: string) {
    const [d] = await db.insert(schema.documents).values({
      sha256: `e${Date.now()}${Math.floor(Math.random() * 1e6)}`.padEnd(64, "0"),
      title: "Loonstrook", mime: "application/pdf", sizeBytes: 10,
      source: "email-attachment", receivedAt: new Date() }).returning();
    await db.insert(schema.documentFacts).values({
      documentId: d.id, kind: "payslip", issuerName: issuer,
      periodStart, periodEnd: periodStart, createdBy: userId });
  }

  it("proposes the OLDEST held fact as the horizon, not the employment start", async () => {
    const name = `Werkgever ${Date.now()}`;
    const [e] = await db.insert(schema.employments)
      .values({ employerName: name, startedOn: "2019-04-01" }).returning();
    await mkFactFor(name, "2026-04-01");
    await mkFactFor(name, "2026-02-01");
    const p = await proposeExpectationFor(db, e.id);
    expect(p.expectFrom).toBe("2026-02-01");
    expect(p.needsConfirmation).toBe(false);
  });

  it("falls back to started_on when nothing is held, and asks for confirmation", async () => {
    const [e] = await db.insert(schema.employments)
      .values({ employerName: `Leeg ${Date.now()}`, startedOn: "2019-04-01" }).returning();
    const p = await proposeExpectationFor(db, e.id);
    expect(p.expectFrom).toBe("2019-04-01");
    // Committing silently would put ~74 "ontbreekt" rows on the page.
    expect(p.needsConfirmation).toBe(true);
  });

  it("carries the employment's end date into expectUntil", async () => {
    const [e] = await db.insert(schema.employments).values({
      employerName: `Beeindigd ${Date.now()}`, startedOn: "2019-04-01", endedOn: "2026-06-10",
    }).returning();
    expect((await proposeExpectationFor(db, e.id)).expectUntil).toBe("2026-06-10");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test employments`
Expected: FAIL — cannot resolve `./employments`.

- [ ] **Step 3: Write the router**

```ts
// packages/api/src/routers/employments.ts
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { normalizeAccount } from "@verder/parsers";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";

export const employmentFields = z.object({
  employerPartyId: z.string().uuid().nullable().default(null),
  employerName: z.string().min(1),
  employerIban: z.string().nullable().default(null),
  startedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  payCadence: z.enum(["monthly", "four-weekly", "yearly", "once"]).default("monthly"),
  paidToAccountIban: z.string().nullable().default(null),
  contractDocumentId: z.string().uuid().nullable().default(null),
  note: z.string().nullable().default(null),
});

export interface ProposedExpectation {
  kind: "payslip";
  subjectLabel: string;
  cadence: "monthly" | "four-weekly" | "yearly" | "once";
  expectFrom: string;
  expectUntil: string | null;
  dueAfterDays: number;
  sourceEmploymentId: string;
  /** True when the horizon came from started_on because nothing is held yet. */
  needsConfirmation: boolean;
}

/**
 * What "maak verwachting" proposes for one employment.
 *
 * EVIDENCE SETS THE HORIZON. expectFrom is the oldest fact held for this
 * employer, and it moves BACKWARDS on its own when something older arrives — a
 * contract from a job five years ago does not get refused, it widens the
 * expectation. Deriving the horizon from started_on instead would put ~74 rows
 * reading "ontbreekt" on the page Martin shows his bewindvoerder on day one,
 * because the TrueFullstaq employment begins in 2019.
 *
 * With nothing held there is nothing to derive from, so started_on is the only
 * candidate — and needsConfirmation says so, because committing to it silently
 * is the failure this whole rule exists to avoid.
 */
export async function proposeExpectationFor(
  db: Db, employmentId: string,
): Promise<ProposedExpectation> {
  const [e] = await db.select().from(schema.employments)
    .where(eq(schema.employments.id, employmentId));
  if (!e) throw new Error(`Employment ${employmentId} not found`);

  const [oldest] = await db.execute<{ period_start: string }>(sql`
    SELECT f.period_start FROM document_facts f
    WHERE f.kind = 'payslip' AND f.voids = false AND f.period_start IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = f.id)
      AND lower(f.issuer_name) LIKE '%' || lower(${e.employerName.split(" ")[0]}) || '%'
    ORDER BY f.period_start ASC LIMIT 1
  `);

  return {
    kind: "payslip",
    subjectLabel: e.employerName,
    cadence: e.payCadence,
    expectFrom: oldest?.period_start ?? e.startedOn,
    expectUntil: e.endedOn,
    dueAfterDays: 10,
    sourceEmploymentId: e.id,
    needsConfirmation: !oldest,
  };
}

export const employmentsRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(schema.employments).orderBy(asc(schema.employments.startedOn))),

  create: protectedProcedure.input(employmentFields).mutation(async ({ ctx, input }) => {
    // One spelling of an IBAN, always — it is the key detectRecurring groups on.
    const [e] = await ctx.db.insert(schema.employments).values({
      ...input,
      employerIban: normalizeAccount(input.employerIban, "ABNA"),
      paidToAccountIban: normalizeAccount(input.paidToAccountIban, "ABNA"),
    }).returning();
    return e;
  }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), fields: employmentFields.partial() }))
    .mutation(({ ctx, input }) => ctx.db.update(schema.employments)
      .set(input.fields).where(eq(schema.employments.id, input.id)).returning()),

  proposeExpectation: protectedProcedure
    .input(z.object({ employmentId: z.string().uuid() }))
    .query(({ ctx, input }) => proposeExpectationFor(ctx.db, input.employmentId)),

  // Martin confirms the proposal before it is written — see needsConfirmation.
  createExpectation: protectedProcedure.input(z.object({
    kind: z.enum(["payslip", "annual-statement"]),
    subjectLabel: z.string().min(1),
    cadence: z.enum(["monthly", "four-weekly", "yearly", "once"]),
    expectFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expectUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    dueAfterDays: z.number().int().min(0).max(400).default(10),
    sourceEmploymentId: z.string().uuid().nullable().default(null),
  })).mutation(({ ctx, input }) =>
    ctx.db.insert(schema.documentExpectations).values(input).returning()),
});
```

- [ ] **Step 4: Mount, run, confirm it passes**

Add `employments: employmentsRouter,` to `packages/api/src/root.ts`.
Run: `env -u NODE_ENV pnpm --filter @verder/api test employments`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/employments.ts packages/api/src/routers/employments.test.ts packages/api/src/root.ts
git commit -m "feat(api): employments, and expectations whose horizon comes from evidence"
```

---

### Task 6: Party links and profile

**Files:**
- Create: `packages/api/src/routers/party-links.ts`, `packages/api/src/routers/profile.ts`
- Modify: `packages/api/src/root.ts`
- Test: `packages/api/src/routers/party-links.test.ts`

**Interfaces:**
- Produces: `partyLinksRouter` with `create`, `endLink`, `contactsFor({ partyId, on? })`; `profileRouter` with `list`, `set`.
- Exported for testing: `contactsFor(db, partyId, on)`.

**Context you need:** History is already free — `entry_parties` joins parties to log entries, so a contact's correspondence history is a query the moment they are a party. No history table. `contactsFor` must respect the validity window, because "who do I ask at TrueFullstaq" has a different answer depending on the date — that is the whole reason the window exists.

`profileRouter` deliberately has no mining job, no suggestion kind and no search trigger. Its `set` is an upsert by key: a new address supersedes the old one by carrying a later `valid_from`, and the old row stays.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/routers/party-links.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { contactsFor } from "./party-links";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("contactsFor", () => {
  let db: Db, org: string, larissa: string, opvolger: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const stamp = Date.now();
    const [o] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `TFS ${stamp}` }).returning();
    const [a] = await db.insert(schema.parties)
      .values({ kind: "person", name: "Larissa van Woudenberg",
        email: "larissa.vanwoudenberg@truefullstaq.com" }).returning();
    const [b] = await db.insert(schema.parties)
      .values({ kind: "person", name: "Opvolger" }).returning();
    org = o.id; larissa = a.id; opvolger = b.id;
    await db.insert(schema.partyLinks).values([
      { fromPartyId: larissa, toPartyId: org, role: "works-at",
        validFrom: "2021-01-01", validTo: "2026-06-30", title: "HR" },
      { fromPartyId: opvolger, toPartyId: org, role: "works-at", validFrom: "2026-07-01" },
    ]);
  });

  it("returns every contact for an organisation — unbounded, not a fixed number", async () => {
    expect((await contactsFor(db, org, null)).length).toBe(2);
  });

  it("answers 'who do I ask' differently depending on the date", async () => {
    const then = await contactsFor(db, org, "2026-03-01");
    expect(then.map((c) => c.partyId)).toEqual([larissa]);
    const now = await contactsFor(db, org, "2026-08-27");
    expect(now.map((c) => c.partyId)).toEqual([opvolger]);
  });

  it("keeps a departed contact in the record", async () => {
    const all = await contactsFor(db, org, null);
    expect(all.find((c) => c.partyId === larissa)?.validTo).toBe("2026-06-30");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test party-links`
Expected: FAIL — cannot resolve `./party-links`.

- [ ] **Step 3: Write both routers**

```ts
// packages/api/src/routers/party-links.ts
import { z } from "zod";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";

export interface Contact {
  linkId: string; partyId: string; name: string;
  email: string | null; phone: string | null;
  role: string; title: string | null;
  validFrom: string | null; validTo: string | null;
}

/**
 * The contacts at an organisation. `on` is an Amsterdam civil date, or null for
 * "everyone ever".
 *
 * The window matters: "who do I ask at TrueFullstaq" has a different answer
 * depending on when you ask, and a contact who left stays in the record rather
 * than disappearing. That is the whole point of valid_from/valid_to — and it is
 * the shape parties.organization (free text on the person's row) could never
 * express.
 *
 * A contact's HISTORY needs nothing new: entry_parties already joins parties to
 * log entries, so their correspondence is a query the moment they are a party.
 */
export async function contactsFor(
  db: Db, partyId: string, on: string | null,
): Promise<Contact[]> {
  const rows = await db.execute<Contact>(sql`
    SELECT l.id AS "linkId", p.id AS "partyId", p.name, p.email, p.phone,
           l.role, l.title, l.valid_from AS "validFrom", l.valid_to AS "validTo"
    FROM party_links l
    JOIN parties p ON p.id = l.from_party_id
    WHERE l.to_party_id = ${partyId}
      ${on ? sql`AND (l.valid_from IS NULL OR l.valid_from <= ${on})
                 AND (l.valid_to   IS NULL OR l.valid_to   >= ${on})` : sql``}
    ORDER BY l.valid_from DESC NULLS LAST, p.name
  `);
  return [...rows];
}

export const partyLinksRouter = router({
  create: protectedProcedure.input(z.object({
    fromPartyId: z.string().uuid(), toPartyId: z.string().uuid(),
    role: z.enum(["works-at", "contact-for", "represents", "department-of"]),
    title: z.string().nullable().default(null),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    note: z.string().nullable().default(null),
  })).mutation(({ ctx, input }) =>
    ctx.db.insert(schema.partyLinks).values(input).returning()),

  /** Someone left: date the link, never delete it. */
  endLink: protectedProcedure.input(z.object({
    id: z.string().uuid(), validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).mutation(({ ctx, input }) => ctx.db.update(schema.partyLinks)
    .set({ validTo: input.validTo }).where(eq(schema.partyLinks.id, input.id)).returning()),

  contactsFor: protectedProcedure.input(z.object({
    partyId: z.string().uuid(),
    on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  })).query(({ ctx, input }) => contactsFor(ctx.db, input.partyId, input.on)),

  /**
   * Turning mail ingestion on for a party. Separate from every other party
   * mutation on purpose: parties.email feeds the Gmail relevance filter, so this
   * changes what lands in the vault, and it must be a deliberate act rather than
   * a side effect of filling in a contact form. The column-level grant from
   * migration 0026 is what makes this the ONLY writable field on the row.
   */
  setIngestMail: protectedProcedure.input(z.object({
    partyId: z.string().uuid(), ingestMail: z.boolean(),
  })).mutation(({ ctx, input }) => ctx.db.update(schema.parties)
    .set({ ingestMail: input.ingestMail })
    .where(eq(schema.parties.id, input.partyId)).returning()),
});
```

```ts
// packages/api/src/routers/profile.ts
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { PROFILE_KEYS, schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";

/**
 * Martin's own facts: BSN, geboortedatum, woonadres, nationaliteit, huisarts —
 * the literal contents of a bewindvoerder's identity request.
 *
 * LOCAL-ONLY BY CONSTRUCTION, not by a flag:
 *   * this router is the ONLY writer. There is no mining job, no suggestion kind
 *     and no LLM anywhere near this table, so there is no cloud path to close;
 *   * no search trigger and not in SEARCH_ENTITY_TYPES — a BSN cannot leak into
 *     a chunk if nothing ever enqueues it;
 *   * the worker holds no grant at all (migration 0026).
 *
 * Do not add an extraction job here. The paspoort SCAN stays local through
 * document-class routing; the BSN VALUE stays local because nothing but Martin
 * ever writes it. Those are two mechanisms and both are needed.
 */
export const profileRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(schema.profileAttributes)
      .orderBy(desc(schema.profileAttributes.validFrom))),

  /** A changed address is a NEW row with a later validFrom; the old one stays. */
  set: protectedProcedure.input(z.object({
    key: z.enum(PROFILE_KEYS),
    value: z.string().min(1),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    note: z.string().nullable().default(null),
  })).mutation(({ ctx, input }) =>
    ctx.db.insert(schema.profileAttributes).values(input).returning()),

  /** A typo is a typo — this table is editable by design. */
  correct: protectedProcedure.input(z.object({
    id: z.string().uuid(), value: z.string().min(1),
  })).mutation(({ ctx, input }) => ctx.db.update(schema.profileAttributes)
    .set({ value: input.value }).where(eq(schema.profileAttributes.id, input.id)).returning()),
});
```

- [ ] **Step 4: Mount, run, confirm**

Add `partyLinks: partyLinksRouter,` and `profile: profileRouter,` to `packages/api/src/root.ts`. Export `PROFILE_KEYS` from `packages/db/src/index.ts`.
Run: `env -u NODE_ENV pnpm --filter @verder/api test party-links`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/party-links.ts packages/api/src/routers/profile.ts \
        packages/api/src/routers/party-links.test.ts packages/api/src/root.ts packages/db/src/index.ts
git commit -m "feat(api): party links with validity windows, and a local-only profile table"
```

---

### Task 7: The poller honours `ingest_mail`

**Files:**
- Modify: `apps/worker/src/gmail.ts` (the `partyEmails` query, around line 128)
- Test: `apps/worker/src/gmail.test.ts`

**Interfaces:**
- Consumes: `parties.ingestMail`.

**Context you need:** `pollGmail` currently takes **every** party email into the relevance filter. After 0026 it must take only those with `ingest_mail = true`. The migration backfills existing parties to `true`, so behaviour is unchanged on deploy — this task is what makes *new* parties default to silent.

**The other half of the trap is still open and is NOT this task:** `pollGmail` tests relevance on `msg.from` only, so Martin's own sent mail still matches nothing. That is sub-project 7 and has its own plan.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/gmail.test.ts`:

```ts
describe("ingest_mail gating", () => {
  it("ignores a party whose mail ingestion is off, and honours one that is on", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const stamp = Date.now();
    const off = `off-${stamp}@example.com`;
    const on = `on-${stamp}@example.com`;
    await db.insert(schema.parties).values([
      { kind: "organization", name: `Off ${stamp}`, email: off, ingestMail: false },
      { kind: "organization", name: `On ${stamp}`, email: on, ingestMail: true },
    ]);

    const msg = (id: string, from: string) => ({
      id, threadId: `t-${id}`, from, to: "martin@vanderpoel.pro",
      subject: "Test", sentAt: new Date(), raw: Buffer.from("raw"),
      bodyText: "body", attachments: [],
    });
    const port: GmailPort = {
      listMessageIds: async () => [`ig-${stamp}`, `keep-${stamp}`],
      getMessage: async (id) => id.startsWith("ig-")
        ? msg(id, off) : msg(id, on),
    };
    const res = await pollGmail({ db, gmail: port, vaultDir, enqueueSuggest: async () => {} });
    expect(res.ingested).toBe(1);

    const rows = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, `keep-${stamp}`));
    expect(rows).toHaveLength(1);
    const skipped = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, `ig-${stamp}`));
    expect(skipped).toHaveLength(0);
    await pool.end();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter worker test gmail`
Expected: FAIL — `ingested` is 2, because every party email is still trusted.

- [ ] **Step 3: Gate the query**

In `apps/worker/src/gmail.ts`, change:

```ts
    const partyEmails = (await deps.db.select().from(schema.parties))
      .map((p) => p.email).filter((e): e is string => !!e);
```

to:

```ts
    // Only parties Martin explicitly opted in. parties.email feeds this filter,
    // so before migration 0026 merely filling in a contact's address silently
    // changed what landed in the vault. 0026 backfills every existing party to
    // true, so this narrows nothing that was already flowing — it makes NEW
    // parties silent until the toggle is turned on.
    const partyEmails = (await deps.db.select().from(schema.parties)
      .where(eq(schema.parties.ingestMail, true)))
      .map((p) => p.email).filter((e): e is string => !!e);
```

- [ ] **Step 4: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter worker test gmail`
Expected: PASS, all gmail tests including the 429 backoff suite.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/gmail.ts apps/worker/src/gmail.test.ts
git commit -m "feat(worker): mail ingestion is an explicit per-party choice"
```

---

### Task 8: `/dossier` — the gap page

**Files:**
- Create: `apps/web/src/app/(app)/dossier/page.tsx`
- Modify: `apps/web/src/app/(app)/dossier/loonstroken/page.tsx` (link across)

**Context you need:** This page is what Martin shows his bewindvoerder, so its copy must be honest and its tone supportive. **Gaps are sorted, never hidden**: `openstaand` first as the working list, `historisch` collapsed below. A `discardedFactId` renders as *"was er wel, document is weggegooid"* rather than a bare gap. `unexpected` gets its own block — it is the prompt to fix an expectation, not an error.

Each `ontbreekt` row carries a **"vraag op"** button that creates a `tasks` row: that table already has `dueAt`, an append-only status ladder and a dashboard, so the gap report needs no reminder engine of its own — it needs to hand the gap to the thing that already chases work.

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/app/(app)/dossier/page.tsx
import Link from "next/link";
import { api } from "@/lib/trpc-server";

const NL_MONTH = new Intl.DateTimeFormat("nl-NL", { month: "long", year: "numeric" });
const label = (s: string) => NL_MONTH.format(new Date(`${s}T12:00:00Z`));

export default async function DossierPage() {
  const d = await api.dossier.overview({ kind: "payslip" });
  const aanwezig = d.slots.filter((s) => s.state === "aanwezig").length;
  const lopend = d.slots.filter((s) => s.state === "loopt-nog").length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Dossier — loonstroken</h1>
        <p className="mt-2 text-slate-300">
          {aanwezig} aanwezig{lopend > 0 ? `, ${lopend} loopt nog` : ""}
          {d.openstaand.length === 0
            ? ". Er ontbreekt niets."
            : `, ${d.openstaand.length} ontbreke${d.openstaand.length === 1 ? "t" : "n"}.`}
        </p>
        <Link href="/dossier/loonstroken" className="text-sm text-sky-400 underline">
          Bekijk de stroken zelf →
        </Link>
      </header>

      {d.openstaand.length > 0 && (
        <section>
          <h2 className="text-lg font-medium">Openstaand</h2>
          <ul className="mt-3 divide-y divide-slate-800">
            {d.openstaand.map((s) => (
              <li key={`${s.expectationId}:${s.periodStart}`} className="flex items-center gap-4 py-3">
                <span className="font-mono text-sm">{label(s.periodStart)}</span>
                <span className="flex-1 text-slate-300">{s.subjectLabel}</span>
                {s.discardedFactId && (
                  <span className="text-xs text-amber-400">
                    was er wel — document is weggegooid
                  </span>
                )}
                <span className="text-xs text-slate-500">verwacht sinds {s.dueOn}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.unexpected.length > 0 && (
        <section>
          <h2 className="text-lg font-medium">Gevonden, maar niet verwacht</h2>
          <p className="mt-1 text-sm text-slate-400">
            Deze stroken passen bij geen enkele reeks. Waarschijnlijk mist er een
            dienstverband, of loopt een verwachting niet ver genoeg terug.
          </p>
          <ul className="mt-3 divide-y divide-slate-800">
            {d.unexpected.map((f) => (
              <li key={f.id} className="flex items-center gap-4 py-3">
                <span className="font-mono text-sm">{f.periodStart ?? "ongedateerd"}</span>
                <span className="flex-1 text-slate-300">{f.issuerName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.historisch.length > 0 && (
        <details className="rounded border border-slate-800 p-4">
          <summary className="cursor-pointer text-sm text-slate-400">
            Historisch — {d.historisch.length} uit afgeronde dienstverbanden
          </summary>
          <ul className="mt-3 divide-y divide-slate-800">
            {d.historisch.map((s) => (
              <li key={`${s.expectationId}:${s.periodStart}`} className="flex gap-4 py-2 text-sm">
                <span className="font-mono">{label(s.periodStart)}</span>
                <span className="text-slate-400">{s.subjectLabel}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Build**

Run: `env -u NODE_ENV pnpm --filter web build`
Expected: build succeeds, `/dossier` in the route list.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/dossier/page.tsx apps/web/src/app/\(app\)/dossier/loonstroken/page.tsx
git commit -m "feat(web): /dossier — what is present, what is missing, and what was unexpected"
```

---

### Task 9: Deploy

**Files:**
- Modify: `CLAUDE.md`

**Context you need:** Use the canonical rsync from `docs/deploy.md` §7.0 — the exclude list is the entire safety mechanism, and `.gitignore` protects nothing. Migration BEFORE images: `/dossier`, `/money` and `/queue` all 500 on an unknown column otherwise.

- [ ] **Step 1: Dry-run the sync and read every deletion**

```bash
rsync -avn --delete --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  ./ homelab:~/apps/verder/
```

- [ ] **Step 2: Sync, then migrate FROM THE HOST**

```bash
rsync -av --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  ./ homelab:~/apps/verder/
ssh homelab 'ls ~/apps/verder/secrets/ && ls -l ~/apps/verder/.env.prod'
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
```
Expected: `0026_dossier` applied; secrets intact.

- [ ] **Step 3: Verify the ingest_mail backfill BEFORE the images go up**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder \
  -c "SELECT ingest_mail, count(*) FROM parties GROUP BY 1;"'
```
Expected: **every existing party `true`**. If any read `false`, stop — the next poll would silently stop ingesting that correspondent's mail.

- [ ] **Step 4: Rebuild**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml up -d --build web worker'
```

- [ ] **Step 5: Verify — the event count must NOT move**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```
Expected: `OK`, and the **chain head UNCHANGED**. Nothing in this slice is evidence, so a moved head means something wrote evidence that should not have.

- [ ] **Step 6: Confirm the poller still ingests**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder \
  -c "SELECT status, detail FROM worker_runs WHERE worker=(SELECT '"'"'gmail'"'"') ORDER BY ran_at DESC LIMIT 3;"'
```
Expected: `ok` with a non-zero `scanned`. A sudden `scanned` with `ingested: 0` across several ticks would mean the gating went wrong.

- [ ] **Step 7: Record it in CLAUDE.md and commit**

Add a sentence naming: migration 0026, the four tables, **the column-level `GRANT UPDATE (ingest_mail) ON parties` and why a table-level grant would have destroyed the append-only guarantee**, the `ingest_mail` backfill, the evidence-set horizon rule, and that nothing in this slice appends ledger events.

```bash
git add CLAUDE.md && git commit -m "docs: record the kennisbank slice 2 deploy"
```

---

## Self-Review

**Spec coverage.** `employments` → Tasks 1, 5. `party_links` → Tasks 1, 6. `parties.ingest_mail` → Tasks 1, 6, 7. `profile_attributes` → Tasks 1, 6. `dossier-series.ts` with four states and `unexpected` → Task 3. openstaand/historisch split → Task 4. The deferred `source_employment_id` FK from 0025 → Task 1. The "evidence sets the horizon" rule → Task 5. Amsterdam date reuse → Task 2.

**One deviation from the spec, deliberate and argued above:** the column-level grant on `parties`, because the spec's plain boolean could not be written against an append-only table. `profile_attributes` being editable is no longer a deviation — it is the spec's open question, decided.

**Deferred to slice 3** (`accounts` → `accountLabels`, the reconciliation join table, the vakantiegeld exclusion in `fullPeriodAmount`) and to **sub-project 7** (outbound mail ingestion — `pollGmail` still tests `msg.from` only, so Martin's sent mail is still invisible; Task 7 gates *which* parties count, not *which direction*).

**The one place slice 1's eval numbers matter:** Task 3's `matchedBy: "derived"` flag and Task 8's rendering of it. If extraction turns out to produce wrong periods often, the derived match needs to be visually distinct on the page rather than a quiet field; if it is reliable, the current treatment is enough. Re-read the docfacts eval baseline before finishing Task 8.
