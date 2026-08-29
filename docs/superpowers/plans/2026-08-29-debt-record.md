# Debt Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a debt a real record — the demanding party, the intermediaries collecting for them, their contact persons, the documents, and whether Verder has been told — and put the three creditors Martin already has into it.

**Architecture:** Four additive schema changes turn `debts` from a single-party row into a small graph: `debt_parties` carries typed edges (eiser / incasso / deurwaarder / gemachtigde), `parties.parent_party_id` makes a contact person belong to an organisation, `debt_documents` mirrors `entry_documents`, and two nullable columns record whether Verder knows. An idempotent seed writes the three known debts; the case map turns them into three episodes.

**Tech Stack:** TypeScript, Next 15 App Router, tRPC, Drizzle + Postgres 17, vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-debt-record-design.md`

## Global Constraints

- Run every build and test with `env -u NODE_ENV` — the shell exports `NODE_ENV=development`, which breaks `next build`.
- Dev database: `docker compose up -d postgres`. Dev login `martin@vanderpoel.pro` / **`devpassdevpass`** (NOT the `devpass` some older notes say).
- Branch: `feat/debt-record`.
- **Copy matches the file it is in.** The registry pages are English ("Claimed", "started as", "From your logbook"); the timeline and map are Dutch. Do not impose one on the other.
- `debts` is NOT an evidence table: `SELECT, INSERT, UPDATE`, no ledger event. `registry_decisions` IS evidence: `SELECT, INSERT` only, ledgered, `created_by`. **Nothing in this plan may weaken `registry_decisions` or add a ledger event to a debt.**
- The ledger chain is not a gate for this work. `nightly-verify` stays a health check; expect +3 `party.created` events from the three new creditors and treat a green run as sufficient.
- Every pure module stays pure: no DB, no I/O, no React, unit-testable without a database.
- **`stops` gets NO `debt_id` column in this slice.** A "verwerkt als vordering" stop links to the debt's document where there is one. Adding the column means teaching `track-evidence.ts` a fourth link type, which is slice 2's problem — do not start it here.

---

### Task 1: Migration 0027 — the schema

**Files:**
- Create: `packages/db/drizzle/0027_debt_record.sql`
- Modify: `packages/db/src/schema.ts` — `debtPartyRoleEnum`, `debtParties`, `debtDocuments`, two columns on `debts`, one on `parties`
- Modify: `packages/db/drizzle/meta/_journal.json` + a new `meta/0027_snapshot.json` (generated, see Step 2)
- Test: `packages/db/src/debt-record-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  schema.debtPartyRoleEnum   // "eiser" | "incasso" | "deurwaarder" | "gemachtigde"
  schema.debtParties         // { debtId, partyId, role, note, createdAt }
  schema.debtDocuments       // { debtId, documentId }
  schema.debts.reportedToVerderAt     // Date | null
  schema.debts.reportedViaEntryId     // string | null
  schema.debts.claimedCents           // number | NULL  (was NOT NULL)
  schema.parties.parentPartyId        // string | null
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/debt-record-schema.test.ts`. Follow the connection setup in `packages/db/src/registry-schema.test.ts` (same `createDb`, same `beforeAll`).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

let db: Db; let close: () => Promise<void>;
beforeAll(() => {
  const c = createDb(process.env.DATABASE_URL
    ?? "postgres://verder:verder@localhost:5432/verder");
  db = c.db; close = () => c.pool.end();
});
afterAll(() => close());

async function aDebt(claimedCents: number | null) {
  const [d] = await db.insert(schema.debts)
    .values({ creditorName: "Testschuldeiser", claimedCents }).returning();
  return d;
}

describe("debt record", () => {
  it("records an amount the notice never stated", async () => {
    // The KvK aanmaning names an invoice number and no total. `0` would assert
    // they claim nothing, which is false; NULL says the notice did not say.
    const d = await aDebt(null);
    expect(d.claimedCents).toBeNull();
  });

  it("carries a creditor and the intermediary collecting for them", async () => {
    const d = await aDebt(262315);
    const [eiser] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "PLM Investments II B.V." }).returning();
    const [incasso] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Trust and Law" }).returning();
    await db.insert(schema.debtParties).values([
      { debtId: d.id, partyId: eiser.id, role: "eiser" },
      { debtId: d.id, partyId: incasso.id, role: "incasso" },
    ]);
    const links = await db.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(links.map((l) => l.role).sort()).toEqual(["eiser", "incasso"]);
  });

  it("refuses the same party in the same role twice on one debt", async () => {
    const d = await aDebt(100);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Dubbel" }).returning();
    await db.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "eiser" });
    await expect(db.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "eiser" }))
      .rejects.toThrow(/debt_party_uq/);
  });

  it("lets one party act in two roles on one debt", async () => {
    // A deurwaarder that is also the claimant is a real thing; the unique index
    // is on (debt, party, role) and must not collapse it to (debt, party).
    const d = await aDebt(100);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Beide rollen" }).returning();
    await db.insert(schema.debtParties).values([
      { debtId: d.id, partyId: p.id, role: "eiser" },
      { debtId: d.id, partyId: p.id, role: "deurwaarder" },
    ]);
    const links = await db.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(links).toHaveLength(2);
  });

  it("hangs a document on the debt itself, not only on a decision", async () => {
    const d = await aDebt(100);
    const [doc] = await db.insert(schema.documents).values({
      sha256: `test-${d.id}`, title: "Informatieblad vordering.pdf",
      mime: "application/pdf", sizeBytes: 1, source: "upload",
      receivedAt: new Date(),
    }).returning();
    await db.insert(schema.debtDocuments)
      .values({ debtId: d.id, documentId: doc.id });
    const links = await db.select().from(schema.debtDocuments)
      .where(eq(schema.debtDocuments.debtId, d.id));
    expect(links).toHaveLength(1);
  });

  it("records whether Verder knows, and NULL means not yet", async () => {
    const d = await aDebt(114161);
    expect(d.reportedToVerderAt).toBeNull();
    await db.update(schema.debts)
      .set({ reportedToVerderAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(schema.debts.id, d.id));
    const [after] = await db.select().from(schema.debts)
      .where(eq(schema.debts.id, d.id));
    expect(after.reportedToVerderAt).not.toBeNull();
  });

  it("makes a contact person belong to an organisation", async () => {
    const [org] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Incassokantoor" }).returning();
    const [person] = await db.insert(schema.parties).values({
      kind: "person", name: "J. de Vries", parentPartyId: org.id,
    }).returning();
    expect(person.parentPartyId).toBe(org.id);
  });

  it("refuses a party that is its own parent", async () => {
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Ouroboros" }).returning();
    await expect(db.update(schema.parties)
      .set({ parentPartyId: p.id }).where(eq(schema.parties.id, p.id)))
      .rejects.toThrow(/parties_no_self_parent_ck/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose up -d postgres && env -u NODE_ENV pnpm --filter @verder/db test debt-record-schema`
Expected: FAIL — `schema.debtParties` is undefined.

- [ ] **Step 3: Add the schema declarations**

In `packages/db/src/schema.ts`, beside the existing `debts` table:

```ts
export const debtPartyRoleEnum = pgEnum("debt_party_role",
  ["eiser", "incasso", "deurwaarder", "gemachtigde"]);

// The edge `debts` never had. `eiser` is who the money is owed to; the other
// three are who is acting for them. Not constrained to one eiser per debt: a
// notice naming two claimants is a real thing, and refusing to record it would
// lose the notice rather than the confusion.
export const debtParties = pgTable("debt_parties", {
  debtId: uuid("debt_id").notNull().references(() => debts.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  role: debtPartyRoleEnum("role").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("debt_party_uq").on(t.debtId, t.partyId, t.role)]);

// Mirrors entry_documents. Until now a document could only hang off a DECISION,
// so the sommation that arrived before any decision had nowhere to go.
export const debtDocuments = pgTable("debt_documents", {
  debtId: uuid("debt_id").notNull().references(() => debts.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
}, (t) => [unique("debt_document_uq").on(t.debtId, t.documentId)]);
```

On `debts`, change `claimedCents` to nullable and add the two reporting columns:

```ts
  claimedCents: integer("claimed_cents"),
  // Whether Verder knows. NOT a status: it is orthogonal to
  // identified→acknowledged→disputed→…, since a debt can be disputed and
  // reported, or acknowledged and not. The entry link means "Verder knows" is
  // always answerable with "here is the message that told them".
  reportedToVerderAt: timestamp("reported_to_verder_at", { withTimezone: true }),
  reportedViaEntryId: uuid("reported_via_entry_id").references(() => logEntries.id),
```

On `parties`, add the parent link:

```ts
  // A contact person is a `person` whose parent is the `organization`. Reusing
  // parties rather than a contacts table has a payoff: pollGmail builds its
  // relevance filter from parties.email, so recording a contact person's
  // address makes their mail start being ingested.
  parentPartyId: uuid("parent_party_id"),
```

`parentPartyId` is declared WITHOUT `.references()` — a self-reference in a Drizzle table callback needs an explicit type annotation and the FK is added in SQL below. Add `unique` to the `drizzle-orm/pg-core` import if it is not there already.

- [ ] **Step 4: Write the migration**

Create `packages/db/drizzle/0027_debt_record.sql`:

```sql
-- A debt gets a real record: who is demanding, who is collecting for them,
-- who to talk to there, what paperwork came with it, and whether Verder knows.
--
-- All additive. Nothing is dropped, no grant is weakened. `debts` stays a
-- non-evidence table (SELECT, INSERT, UPDATE, no ledger event);
-- `registry_decisions` stays evidence and is untouched.
CREATE TYPE "debt_party_role" AS ENUM ('eiser', 'incasso', 'deurwaarder', 'gemachtigde');
--> statement-breakpoint

CREATE TABLE "debt_parties" (
  "debt_id"    uuid NOT NULL REFERENCES "debts"("id"),
  "party_id"   uuid NOT NULL REFERENCES "parties"("id"),
  "role"       "debt_party_role" NOT NULL,
  "note"       text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "debt_party_uq" UNIQUE ("debt_id", "party_id", "role")
);
--> statement-breakpoint

CREATE TABLE "debt_documents" (
  "debt_id"     uuid NOT NULL REFERENCES "debts"("id"),
  "document_id" uuid NOT NULL REFERENCES "documents"("id"),
  CONSTRAINT "debt_document_uq" UNIQUE ("debt_id", "document_id")
);
--> statement-breakpoint

-- One level is the intent: organisation → person. The CHECK refuses a
-- self-reference; a deeper cycle is not enforced here, and the editor offers
-- only organisations as parents.
ALTER TABLE "parties" ADD COLUMN "parent_party_id" uuid REFERENCES "parties"("id");
--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_no_self_parent_ck"
  CHECK ("parent_party_id" IS NULL OR "parent_party_id" <> "id");
--> statement-breakpoint

ALTER TABLE "debts" ADD COLUMN "reported_to_verder_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN "reported_via_entry_id" uuid REFERENCES "log_entries"("id");
--> statement-breakpoint

-- Required by the data: the KvK aanmaning names an invoice number and no total.
-- `0` would assert that they claim nothing, which is false.
ALTER TABLE "debts" ALTER COLUMN "claimed_cents" DROP NOT NULL;
--> statement-breakpoint

-- DELETE is granted on these two link tables and NOWHERE ELSE, deliberately.
-- They carry no ledger event and are not evidence; they are links on an
-- editable fact table. A party linked to the wrong debt has to be removable,
-- and a registry whose mistakes are permanent is worse than the rule it would
-- uphold. registry_decisions keeps SELECT, INSERT and nothing more.
GRANT SELECT, INSERT, UPDATE, DELETE ON "debt_parties", "debt_documents"
  TO verder_app, verder_worker;
```

- [ ] **Step 5: Register it with drizzle**

**A hand-written `.sql` that drizzle does not know about never runs.** Every existing migration has a `meta/_journal.json` entry and a snapshot.

```bash
env -u NODE_ENV pnpm --filter @verder/db generate
```

Drizzle sees the schema change and writes `0027_<random-name>.sql`, a journal entry, and `meta/0027_snapshot.json`. Then: replace the generated `.sql`'s contents with the migration above **in full**, `git mv` it to `packages/db/drizzle/0027_debt_record.sql`, and edit the journal entry's `"tag"` to `"0027_debt_record"`. Leave the snapshot as generated.

Verify: `grep -c 0027_debt_record packages/db/drizzle/meta/_journal.json` prints `1`.

- [ ] **Step 6: Apply and run the tests**

Run: `env -u NODE_ENV pnpm --filter @verder/db migrate && env -u NODE_ENV pnpm --filter @verder/db test`
Expected: PASS, including the 8 new tests.

- [ ] **Step 7: Prove the grants are what the spec says**

Add to `packages/db/src/debt-record-schema.test.ts`, following the role-connection pattern in `packages/db/src/search-grants.test.ts` (it opens a second connection as `verder_app` using the password from `secrets/role-passwords` or the `APP_DB_URL` env var — copy that setup exactly):

```ts
  it("lets the app role unlink a party, and still refuses to delete evidence", async () => {
    // The one place DELETE is granted. registry_decisions must stay untouchable.
    const d = await aDebt(100);
    const [p] = await appDb.insert(schema.parties)
      .values({ kind: "organization", name: "Verkeerd gekoppeld" }).returning();
    await appDb.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "incasso" });
    await appDb.delete(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(await appDb.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id))).toHaveLength(0);

    await expect(appDb.delete(schema.registryDecisions))
      .rejects.toThrow(/permission denied/);
  });
```

Run: `env -u NODE_ENV pnpm --filter @verder/db test debt-record-schema`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): give a debt its parties, documents and reporting state

debts had exactly one party, so 'Trust and Law collecting for PLM
Investments' — the shape of nearly every debt notice — could only live in
a note. debt_parties carries typed edges, parties.parent_party_id makes a
contact person belong to an organisation, debt_documents mirrors
entry_documents, and claimed_cents becomes nullable because a notice does
not always state a total."
```

---

### Task 2: The registry API

**Files:**
- Modify: `packages/api/src/routers/registry.ts` — `debtFields`, `debts.get`, new link procedures
- Test: `packages/api/src/routers/registry.test.ts`

**Interfaces:**
- Consumes: `schema.debtParties`, `schema.debtDocuments`, `schema.debts.reportedToVerderAt`, `schema.parties.parentPartyId` from Task 1.
- Produces:
  ```ts
  registry.debts.get   // + parties: { partyId, name, organization, role, note }[]
                       // + debtDocuments: { id, title, mime }[]
                       // + reportedToVerderAt, reportedViaEntryId
  registry.debts.linkParty   ({ debtId, partyId, role, note? })  -> void
  registry.debts.unlinkParty ({ debtId, partyId, role })         -> void
  registry.debts.linkDocument   ({ debtId, documentId })         -> void
  registry.debts.unlinkDocument ({ debtId, documentId })         -> void
  registry.debts.setReported ({ debtId, reportedAt: Date | null, entryId?: string | null }) -> void
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/routers/registry.test.ts`, matching its existing caller setup:

```ts
describe("debt parties and documents", () => {
  it("returns the creditor and the intermediary with their roles", async () => {
    const debt = await caller.registry.debts.create({
      creditorName: "PLM Investments II B.V.", claimedCents: 262315,
    });
    const eiser = await caller.parties.create({
      kind: "organization", name: "PLM Investments II B.V.",
    });
    const incasso = await caller.parties.create({
      kind: "organization", name: "Trust and Law Incassoservices",
    });
    await caller.registry.debts.linkParty({
      debtId: debt.id, partyId: eiser.id, role: "eiser",
    });
    await caller.registry.debts.linkParty({
      debtId: debt.id, partyId: incasso.id, role: "incasso",
      note: "Kenmerk 26TNL-001031",
    });

    const got = await caller.registry.debts.get({ id: debt.id });
    expect(got.parties.map((p) => [p.role, p.name])).toEqual(
      expect.arrayContaining([
        ["eiser", "PLM Investments II B.V."],
        ["incasso", "Trust and Law Incassoservices"],
      ]));
  });

  it("unlinks a party that was linked to the wrong debt", async () => {
    const debt = await caller.registry.debts.create({
      creditorName: "Verkeerd", claimedCents: 100,
    });
    const p = await caller.parties.create({ kind: "organization", name: "Fout" });
    await caller.registry.debts.linkParty({
      debtId: debt.id, partyId: p.id, role: "incasso",
    });
    await caller.registry.debts.unlinkParty({
      debtId: debt.id, partyId: p.id, role: "incasso",
    });
    expect((await caller.registry.debts.get({ id: debt.id })).parties).toEqual([]);
  });

  it("accepts a debt whose notice stated no total", async () => {
    const debt = await caller.registry.debts.create({
      creditorName: "Kamer van Koophandel", claimedCents: null,
    });
    expect((await caller.registry.debts.get({ id: debt.id })).claimedCents).toBeNull();
  });

  it("records that Verder was told, and lets it be taken back", async () => {
    const debt = await caller.registry.debts.create({
      creditorName: "Het CAK", claimedCents: 114161,
    });
    expect((await caller.registry.debts.get({ id: debt.id })).reportedToVerderAt)
      .toBeNull();
    await caller.registry.debts.setReported({
      debtId: debt.id, reportedAt: new Date("2026-09-01T10:00:00Z"),
    });
    expect((await caller.registry.debts.get({ id: debt.id })).reportedToVerderAt)
      .not.toBeNull();
    // Reversible: marking it by mistake must not be permanent.
    await caller.registry.debts.setReported({ debtId: debt.id, reportedAt: null });
    expect((await caller.registry.debts.get({ id: debt.id })).reportedToVerderAt)
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test registry`
Expected: FAIL — `linkParty` is not a function.

- [ ] **Step 3: Implement**

In `packages/api/src/routers/registry.ts`:

1. `debtFields.claimedCents` becomes `z.number().int().nullish()`.
2. Add to `debtsRouter`:

```ts
  linkParty: protectedProcedure.input(z.object({
    debtId: z.string().uuid(), partyId: z.string().uuid(),
    role: z.enum(["eiser", "incasso", "deurwaarder", "gemachtigde"]),
    note: z.string().nullish(),
  })).mutation(async ({ ctx, input }) => {
    // onConflictDoNothing: linking twice is a no-op, not an error. The user
    // clicked a button; a unique-violation stack trace is not an answer.
    await ctx.db.insert(schema.debtParties).values({
      debtId: input.debtId, partyId: input.partyId,
      role: input.role, note: input.note ?? null,
    }).onConflictDoNothing();
  }),

  unlinkParty: protectedProcedure.input(z.object({
    debtId: z.string().uuid(), partyId: z.string().uuid(),
    role: z.enum(["eiser", "incasso", "deurwaarder", "gemachtigde"]),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(schema.debtParties).where(and(
      eq(schema.debtParties.debtId, input.debtId),
      eq(schema.debtParties.partyId, input.partyId),
      eq(schema.debtParties.role, input.role)));
  }),

  linkDocument: protectedProcedure.input(z.object({
    debtId: z.string().uuid(), documentId: z.string().uuid(),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.insert(schema.debtDocuments)
      .values(input).onConflictDoNothing();
  }),

  unlinkDocument: protectedProcedure.input(z.object({
    debtId: z.string().uuid(), documentId: z.string().uuid(),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(schema.debtDocuments).where(and(
      eq(schema.debtDocuments.debtId, input.debtId),
      eq(schema.debtDocuments.documentId, input.documentId)));
  }),

  // Reversible on purpose: marking a debt reported by mistake must not be a
  // one-way door, and `reported` is a fact about the world rather than a
  // ledgered decision.
  setReported: protectedProcedure.input(z.object({
    debtId: z.string().uuid(),
    reportedAt: z.coerce.date().nullable(),
    entryId: z.string().uuid().nullish(),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.update(schema.debts).set({
      reportedToVerderAt: input.reportedAt,
      reportedViaEntryId: input.reportedAt === null ? null : (input.entryId ?? null),
    }).where(eq(schema.debts.id, input.debtId));
  }),
```

3. In `debts.get`, after the existing `decisions` lookup, add the parties and the debt's own documents:

```ts
      const parties = await ctx.db.select({
        partyId: schema.parties.id, name: schema.parties.name,
        organization: schema.parties.organization,
        role: schema.debtParties.role, note: schema.debtParties.note,
      }).from(schema.debtParties)
        .innerJoin(schema.parties, eq(schema.parties.id, schema.debtParties.partyId))
        .where(eq(schema.debtParties.debtId, debt.id))
        .orderBy(asc(schema.debtParties.role), asc(schema.parties.name));

      const ownDocs = await ctx.db.select({ doc: schema.documents })
        .from(schema.debtDocuments)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.debtDocuments.documentId))
        .where(eq(schema.debtDocuments.debtId, debt.id))
        .then((rows) => rows.map((r) => r.doc));
```

and add `parties` and `debtDocuments: ownDocs` to the returned object. Keep the existing `documents` field exactly as it is — it means "documents reachable from decisions and logbook entries" and other callers read it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): expose a debt's parties, documents and reporting state"
```

---

### Task 3: The three debts Martin already has

**Files:**
- Create: `apps/worker/src/ops/case-debts.ts`
- Create: `apps/worker/src/ops/case-debts.test.ts`
- Modify: `apps/worker/src/ops/case-history.ts` — call `applyCaseDebts` at the end, extend `CaseHistoryResult`

**Interfaces:**
- Consumes: `schema.debtParties`, `schema.debtDocuments` from Task 1.
- Produces:
  ```ts
  export interface DebtSeed {
    creditorName: string;                    // what the notice literally said
    claimedCents: number | null;
    principalCents?: number;
    references?: string;
    origin?: string;
    parties: { name: string; organization?: string; email?: string;
               role: "eiser" | "incasso" | "deurwaarder" | "gemachtigde" }[];
    doc?: string;                            // vault filename, linked when present
  }
  export const DEBT_SEED: DebtSeed[];
  export async function applyCaseDebts(db: Db): Promise<{
    debts: string[]; parties: string[];
    debtParties: string[]; debtDocLinks: string[];
  }>;
  ```

**A trap this task must not fall into:** `case-history.ts` dedups `PARTY_SEED` by EMAIL (`where(eq(schema.parties.email, p.email))`). All three new creditors — Kamer van Koophandel, PLM Investments II B.V., Het CAK — have **no email**, and `eq(email, NULL)` is never true, so an email-keyed guard would insert a duplicate on every single run. `applyCaseDebts` must dedup a party on `name` (case-insensitive), and must reuse the existing Trust and Law and Stam rows rather than creating second ones.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/ops/case-debts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEBT_SEED } from "./case-debts";

describe("case debts seed", () => {
  it("names exactly one eiser for every debt", () => {
    // The eiser is who the money is owed to. A debt with none is a debt with no
    // creditor; a debt with two is almost always the intermediary miscoded.
    for (const d of DEBT_SEED) {
      const eisers = d.parties.filter((p) => p.role === "eiser");
      expect(eisers, `${d.creditorName}`).toHaveLength(1);
    }
  });

  it("gives the two intermediated debts an intermediary", () => {
    const byName = new Map(DEBT_SEED.map((d) => [d.creditorName, d]));
    expect(byName.get("PLM Investments II B.V.")!.parties
      .find((p) => p.role === "incasso")?.name).toBe("Trust and Law Incassoservices");
    expect(byName.get("Het CAK")!.parties
      .find((p) => p.role === "deurwaarder")?.name).toBe("Stam Gerechtsdeurwaarders");
  });

  it("leaves the KvK amount unknown rather than calling it zero", () => {
    const kvk = DEBT_SEED.find((d) => d.creditorName === "Kamer van Koophandel")!;
    expect(kvk.claimedCents).toBeNull();
  });

  it("records the amounts and references that the notices actually state", () => {
    const plm = DEBT_SEED.find((d) => d.creditorName === "PLM Investments II B.V.")!;
    expect(plm.claimedCents).toBe(262315);
    expect(plm.principalCents).toBe(219789);
    expect(plm.references).toBe("26TNL-001031");
    const cak = DEBT_SEED.find((d) => d.creditorName === "Het CAK")!;
    expect(cak.claimedCents).toBe(114161);
  });

  it("reuses the intermediary parties the case already has, by exact name", () => {
    // Trust and Law and Stam are already in `parties` from PARTY_SEED. A name
    // that does not match theirs creates a second row for the same firm.
    const names = DEBT_SEED.flatMap((d) => d.parties.map((p) => p.name));
    expect(names).toContain("Trust and Law Incassoservices");
    expect(names).toContain("Stam Gerechtsdeurwaarders");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter worker test case-debts`
Expected: FAIL — cannot resolve `./case-debts`.

- [ ] **Step 3: Write the seed**

Create `apps/worker/src/ops/case-debts.ts`. The header comment states why it is a separate file and how it dedups:

```ts
/**
 * The three creditors that have written to Martin and are in no dossier.
 *
 * A separate file from case-history.ts because that file is already 850 lines
 * and this is a different subject; the same run because it is the same case and
 * wants the same idempotency discipline.
 *
 * PARTIES ARE DEDUPED BY NAME, not by email. case-history's PARTY_SEED keys on
 * email, which works there because every party in it has one. None of these
 * three creditors does — `eq(email, NULL)` is never true, so an email-keyed
 * guard would insert a fresh Kamer van Koophandel on every run, forever.
 *
 * Nothing here appends a ledger event except the party creation path, which is
 * case-history's existing one. Debts and both link tables are not evidence.
 */
```

Then the seed itself. These are facts about a real person's case — use these values verbatim:

```ts
export const DEBT_SEED: DebtSeed[] = [
  {
    creditorName: "Kamer van Koophandel",
    // The notice states an invoice number and a KVK number and NO total. NULL
    // says the notice did not say; 0 would say they claim nothing.
    claimedCents: null,
    references: "factuur 260194200, KVK 77463102",
    origin: "Aanmaning op OpsMate — een onderneming die op 22 april 2026 al was " +
      "uitgeschreven bij de KvK.",
    parties: [
      { name: "Kamer van Koophandel", organization: "KvK", role: "eiser" },
    ],
  },
  {
    creditorName: "PLM Investments II B.V.",
    claimedCents: 262315,
    principalCents: 219789,
    references: "26TNL-001031",
    origin: "Vordering gecedeerd door Qred. De hoofdsom van € 2.197,89 staat op " +
      "naam van OpsMate; het verschil is rente en kosten.",
    parties: [
      { name: "PLM Investments II B.V.", organization: "PLM Investments",
        role: "eiser" },
      { name: "Trust and Law Incassoservices", organization: "Trust and Law",
        email: "info@collections.trustandlaw.nl", role: "incasso" },
    ],
    doc: "Informatieblad vordering (nieuw).pdf",
  },
  {
    creditorName: "Het CAK",
    claimedCents: 114161,
    references: "3805606, 3900757",
    origin: "Er ligt al een vonnis. De sommatie spreekt over het voorkomen van " +
      "verdere uitvoering van de veroordeling.",
    parties: [
      { name: "Het CAK", organization: "CAK", role: "eiser" },
      { name: "Stam Gerechtsdeurwaarders", organization: "Stam",
        email: "info@stamdeurwaarders.nl", role: "deurwaarder" },
    ],
  },
];
```

`Trust and Law Incassoservices` and `Stam Gerechtsdeurwaarders` are the EXACT names already in `parties` from `PARTY_SEED`. A character out of place there creates a second row for the same firm, which is the whole failure this seed's name-based dedup exists to avoid.

`applyCaseDebts(db)`:
1. For each seed party: find by `lower(name) = lower(seed.name)`; if absent, insert it **through the same ledgered path `case-history` uses for `PARTY_SEED`** (`appendLedgerEvent` with `party.created`) so a party is recorded the one way this project records parties. Collect the id.
2. Find the debt by `creditorName`; insert when absent. Never update an existing debt's amounts — Martin may have corrected them.
3. Link each party with its role via `onConflictDoNothing`.
4. If `doc` is set and a document with that title exists, link it via `debt_documents` with `onConflictDoNothing`. If it does not exist, skip silently — the same "fill it in on a later run" rule `writeStop` uses, so this is safe to run before or after a Gmail backfill.
5. Leave `reportedToVerderAt` alone: NULL is the answer, and a later hand-set value must survive a re-run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter worker test case-debts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the run and prove idempotence**

In `apps/worker/src/ops/case-history.ts`, add `debts: string[]`, `debtParties: string[]` and `debtDocLinks: string[]` to `CaseHistoryResult` — the same four names `applyCaseDebts` returns, minus `parties`, which merges into the existing `parties` array. Call `applyCaseDebts(db)` at the end of `applyCaseHistory` and merge its result.

Then, against the dev database:

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter worker case-history
env -u NODE_ENV pnpm --filter worker case-history
```

Expected: the FIRST run reports 3 debts, 3 new parties and 4 party links; the SECOND reports empty arrays for all of them. Confirm with psql that `select count(*) from parties where name = 'Kamer van Koophandel'` is `1`, not `2` — that is the email-dedup trap, and it only shows on the second run.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): record the three creditors nobody has told Verder about

Deduped by NAME, not by email: none of the three has an address, and
eq(email, NULL) is never true — an email-keyed guard would insert a fresh
Kamer van Koophandel on every run."
```

---

### Task 4: Three episodes on the map

**Files:**
- Modify: `apps/worker/src/ops/case-history.ts` — `SPINE_SEED` (+3 triggers), `TRACK_SEED` (−1, +3), `TRACK_RENAMES` (+1)
- Modify: `packages/db/src/seed-case-map.ts` — `SPINE_SEED` grows to 10
- Modify: `apps/worker/src/ops/case-history.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3. Stops do NOT link to debts in this slice.
- Produces: a 10-stop hoofdlijn and three debt spoors.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/ops/case-history.test.ts`:

```ts
  it("puts each debt notice on the line and its handling on a spoor", () => {
    // The episode rule: the notice is the trigger and belongs on the hoofdlijn;
    // what was done about it hangs off. Three notices, three spoors.
    const spine = new Set(SPINE_SEED.map((s) => s.title));
    for (const notice of ["KvK — aanmaning op OpsMate",
      "Trust and Law — PLM Investments, € 2.623,15",
      "Stam — Het CAK, € 1.141,61, er ligt een vonnis"]) {
      expect(spine, notice).toContain(notice);
    }
    for (const spoor of ["Vordering KvK", "Vordering PLM Investments",
      "Vonnis Het CAK"]) {
      const t = TRACK_SEED.find((x) => x.title === spoor);
      expect(t, spoor).toBeDefined();
      expect(t!.stops).toHaveLength(2);
    }
    // The spoor that lumped them together is gone.
    expect(TRACK_SEED.map((t) => t.title))
      .not.toContain("Schuldeisers buiten het dossier");
  });

  it("dates the registry entry, not the notice, on a verwerkt-stop", () => {
    // The notice is older than the record. Back-dating the record to the
    // notice's day would be the app inventing a fact; leaving it undated would
    // drop it into the `onbekend` band, away from the episode it belongs to.
    for (const t of TRACK_SEED.filter((x) => x.title.startsWith("Vordering ")
      || x.title === "Vonnis Het CAK")) {
      const verwerkt = t.stops.find((s) => s.title.includes("verwerkt als vordering"));
      expect(verwerkt, t.title).toBeDefined();
      expect(verwerkt!.happenedAt?.toISOString().slice(0, 10)).toBe("2026-08-29");
      expect(verwerkt!.state).toBe("done");
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter worker test case-history`
Expected: FAIL — the three notices are not in `SPINE_SEED`.

- [ ] **Step 3: Restructure the seed**

Move the three notice stops from the `Schuldeisers buiten het dossier` entry into `SPINE_SEED`, keeping every `title`, `kind`, `happenedAt`, `note` and `task` byte-identical and renumbering `orderIndex` so the ten spine stops stay in date order:

| ix | stop | datum |
| --- | --- | --- |
| 100 | Aanmelding bij Verder | 2026-04-16 |
| 200 | KvK — aanmaning op OpsMate | 2026-05-26 |
| 300 | Trust and Law — PLM Investments, € 2.623,15 | 2026-06-11 |
| 400 | Stam — Het CAK, € 1.141,61, er ligt een vonnis | 2026-07-14 |
| 500 | Beschikking: onder bewind gesteld | 2026-07-14 |
| 600 | Dossier naar Team Opstart | 2026-07-20 |
| 700 | Team Opstart vraagt de opstartstukken | 2026-07-27 |
| 800 | Deurwaarder zegt de ontruiming aan | 2026-07-29 |
| 900 | Rekening overgenomen zonder aankondiging | 2026-08-05 |
| 1000 | Stukken opgevraagd door Regio 3 | 2026-08-12 |

The three notice stops keep `state: "open"`? **No — they become `done`**: the notice arriving is a thing that happened. What is still outstanding moves to the spoor's second stop. Update the `waitsOnMartin` set in the open-stop law test accordingly.

Delete the `Schuldeisers buiten het dossier` entry from `TRACK_SEED` and add three:

- `Vordering KvK` — `branchesAt: "KvK — aanmaning op OpsMate"`, status `open`.
- `Vordering PLM Investments` — `branchesAt: "Trust and Law — PLM Investments, € 2.623,15"`, status `open`.
- `Vonnis Het CAK` — `branchesAt: "Stam — Het CAK, € 1.141,61, er ligt een vonnis"`, status `open`.

Each with two stops. Titles are prefixed with the creditor because **stop titles are unique across the WHOLE map** — `stopAnywhere` has no track scope and `case-history.test.ts` asserts it:

```
100  "KvK — verwerkt als vordering"        done, at("2026-08-29")
200  "KvK — melden bij Verder"             open, task: "KvK-aanmaning OpsMate melden bij de bewindvoerder"
```

and the same shape for `PLM — …` and `CAK — …`, each second stop carrying the existing task title from `TASK_SEED`. Give each `verwerkt`-stop a note saying the notice is older and the record was made retrospectively on 29 August.

Add to `TRACK_RENAMES`, carrying the status (a repurposed row keeps the old subject's status and nothing else overwrites it):

```ts
  { from: "Schuldeisers buiten het dossier", to: "Vordering KvK", status: "open" },
```

- [ ] **Step 4: Keep the two spine seeds in step**

`packages/db/src/seed-case-map.ts`'s `SPINE_SEED` must gain the same three titles at the same `orderIndex` with the same dates. The existing drift test compares title, `orderIndex` and `happenedAt` element-for-element and will fail if they diverge.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_ENV pnpm --filter worker test && env -u NODE_ENV pnpm --filter @verder/db test`
Expected: PASS.

- [ ] **Step 6: Look at the map**

```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "update tracks set branches_at_stop_id=null, merges_at_stop_id=null; delete from stops; delete from tracks;"
env -u NODE_ENV pnpm --filter @verder/db seed-map
env -u NODE_ENV pnpm --filter worker case-history
docker compose exec -T postgres psql -U verder -d verder -c \
  "select t.title, count(s.id) from tracks t left join stops s on s.track_id=t.id group by t.title order by 2 desc;"
```

Expected: the root `Bewindvoering` with 10 stops, and `Vordering KvK` / `Vordering PLM Investments` / `Vonnis Het CAK` with 2 each. No track with 0 stops.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): give each debt notice its own episode

Schuldeisers buiten het dossier lumped three unrelated matters together
by what they had in common rather than by what happened. Each notice is
now a trigger on the hoofdlijn with its own spoor: verwerkt als vordering,
then melden bij Verder."
```

---

### Task 5: The registry screens

**Files:**
- Modify: `apps/web/src/app/(app)/registry/debts/[id]/page.tsx`
- Modify: `apps/web/src/components/registry-list.tsx` — `formatEuro` handles null; the debts list gains eiser/intermediair and a not-reported marker
- Create: `apps/web/src/components/debt-parties-form.tsx` — link/unlink a party by role, link/unlink a document, set reported
- Modify: `apps/web/src/components/party-form.tsx` (or wherever parties are edited) — `parentPartyId`, offering organisations only
- Test: `apps/web/src/components/registry-list.test.ts`

**Interfaces:**
- Consumes: `registry.debts.get`'s `parties` / `debtDocuments` / `reportedToVerderAt`, and the four link mutations plus `setReported`, from Task 2.
- Produces: nothing later tasks read.

**Copy on these screens is ENGLISH**, matching the file. Do not translate the surrounding page.

- [ ] **Step 1: Write the failing test**

`formatEuro` is the one piece of pure logic here and it is the one that can lie. Add to `apps/web/src/components/registry-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatEuro } from "./registry-list";

describe("formatEuro", () => {
  it("says an unknown amount is unknown, never € 0,00", () => {
    // The KvK aanmaning states no total. Rendering nothing as zero would put a
    // number in front of Martin that no creditor ever claimed.
    expect(formatEuro(null)).toBe("amount unknown");
  });

  it("still formats a real amount", () => {
    expect(formatEuro(262315)).toContain("2.623,15");
  });

  it("formats a genuine zero as zero", () => {
    expect(formatEuro(0)).toContain("0,00");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter web test registry-list`
Expected: FAIL — `formatEuro(null)` returns `"€ 0,00"` or throws.

- [ ] **Step 3: Implement**

1. `formatEuro(cents: number | null): string` returns `"amount unknown"` for `null`.
2. `debts/[id]/page.tsx`: `feesCents` already guards `principalCents === null`; add the same guard for `claimedCents`, so the fees line is computed only when both are numbers. Render a **Parties** section (role, name, organisation, note) and a **Documents** section from `debtDocuments`, and a line stating whether Verder has been told with its date and a link to the entry when there is one.
3. `debt-parties-form.tsx` is a client component: a party picker plus a role select to add a link, an × to remove one, a document picker from `documents.list`, and a control to set or clear "reported to Verder". Follow the shape of `item-facts-form.tsx` for the mutation-plus-`router.refresh()` pattern.
4. The party editor gains a `parentPartyId` select listing only parties whose `kind` is `organization`, plus an explicit "no parent organisation" option.

- [ ] **Step 4: Run the tests and the build**

Run: `env -u NODE_ENV pnpm --filter web test && env -u NODE_ENV pnpm -r typecheck && env -u NODE_ENV pnpm --filter web build`
Expected: PASS.

- [ ] **Step 5: Look at it**

`env -u NODE_ENV pnpm --filter web dev`, sign in as `martin@vanderpoel.pro` / `devpassdevpass`, open `/registry`. Confirm the three debts list with their eiser and intermediary, that the KvK debt reads `amount unknown` rather than `€ 0,00`, and that each detail page shows the parties, the documents and the not-reported state.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): show a debt's parties, paperwork and whether Verder knows"
```

---

### Task 6: Fold debt episodes away on /timeline

**Files:**
- Modify: `apps/web/src/app/(app)/timeline/page.tsx` — read `?schuldeisers=` from `searchParams`, filter before `buildTrackMap`'s output reaches the component
- Modify: `apps/web/src/lib/track-marks.ts` — a pure helper deciding which tracks are debt episodes
- Test: `apps/web/src/lib/track-marks.test.ts`

**Interfaces:**
- Consumes: `tracks.map()`'s `CaseMap`.
- Produces: `hideDebtEpisodes(map, hidden)` — pure, returns a `CaseMap` with the debt tracks and their stops removed.

**Why this exists:** Martin chose one-episode-per-notice knowing the trunk grows with every creditor. This gives the case back without giving up the rule.

- [ ] **Step 1: Write the failing test**

```ts
describe("hideDebtEpisodes", () => {
  const map = {
    tracks: [
      { id: "root", title: "Bewindvoering", parentTrackId: null },
      { id: "kvk", title: "Vordering KvK", parentTrackId: "root" },
      { id: "ontr", title: "Ontruiming Woonhave", parentTrackId: "root" },
    ],
    stops: [
      { id: "s1", trackId: "root", title: "Aanmelding bij Verder" },
      { id: "s2", trackId: "kvk", title: "KvK — verwerkt als vordering" },
      { id: "s3", trackId: "ontr", title: "Woonhave akkoord" },
    ],
  } as never;

  it("keeps everything when nothing is hidden", () => {
    expect(hideDebtEpisodes(map, false).tracks).toHaveLength(3);
  });

  it("drops the debt spoor and its stops when hidden", () => {
    const out = hideDebtEpisodes(map, true);
    expect(out.tracks.map((t) => t.id)).toEqual(["root", "ontr"]);
    expect(out.stops.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("never hides the hoofdlijn, whatever it is called", () => {
    // A root track is the case itself and can never be an episode.
    const odd = { ...map, tracks: [{ id: "root", title: "Vordering KvK",
      parentTrackId: null }] } as never;
    expect(hideDebtEpisodes(odd, true).tracks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter web test track-marks`
Expected: FAIL — `hideDebtEpisodes` is not exported.

- [ ] **Step 3: Implement**

A debt episode is a NON-ROOT track whose title starts with `"Vordering "` or `"Vonnis "`. That is a naming convention, not a schema fact, and the helper's comment must say so — slice 2 will need it to hold for every debt it creates.

`timeline/page.tsx` reads `?schuldeisers=verborgen` from `searchParams`, applies the helper before rendering, and shows a link toggling it. Default is shown. The heading says how many are hidden so nothing disappears silently.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_ENV pnpm --filter web test && env -u NODE_ENV pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): let the map fold schuldeisersmeldingen away"
```

---

### Task 7: Ship it

**Files:** none — this changes production.

- [ ] **Step 1: Full local build**

Run: `env -u NODE_ENV pnpm -r typecheck && env -u NODE_ENV pnpm -r test && env -u NODE_ENV pnpm --filter web build`
Expected: PASS.

- [ ] **Step 2: rsync FIRST**

The migration file has to exist on the host before it can run, and rsync only writes files — the running containers keep the old images, so the migration still lands before any new code.

```bash
rsync -av --delete --dry-run --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' --exclude '.superpowers' \
  ./ homelab:~/apps/verder/
```

Read every `deleting` line before running it for real without `--dry-run`. **The exclude list is the whole safety mechanism** — a dry run without it prints `deleting secrets/role-passwords` and `deleting .env.prod`. Add to it, never trim it.

- [ ] **Step 3: Migrate from the host**

```bash
ssh homelab 'cd ~/apps/verder && set -a && . ./.env.prod && set +a && \
  DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  env -u NODE_ENV pnpm --filter @verder/db migrate'
```

The `DATABASE_URL` is required: the bare command falls back to the dev default and dies on `28P01 auth_failed`.

- [ ] **Step 4: Rebuild and seed**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker'
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm -T worker pnpm --filter worker case-history'
```

Expect 3 debts, 3 parties, 4 party links, 1 track rename, 3 notice stops moved. Run it a SECOND time and expect every list empty — that is the email-dedup trap's only tell.

- [ ] **Step 5: Check the result**

```bash
ssh homelab "cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder -c \"select d.creditor_name, d.claimed_cents, d.reported_to_verder_at, string_agg(p.name || ' (' || dp.role || ')', ', ') from debts d left join debt_parties dp on dp.debt_id=d.id left join parties p on p.id=dp.party_id group by d.id, d.creditor_name, d.claimed_cents, d.reported_to_verder_at;\""
```

Expected: three rows; KvK with a NULL amount; PLM with Trust and Law as `incasso`; Het CAK with Stam as `deurwaarder`; all three `reported_to_verder_at` NULL. Then open `/registry` and `/timeline` and look.

`nightly-verify` should stay green (129 events, +3 from the new creditors). It is a health check here, not a gate.

- [ ] **Step 6: Update the project notes and merge**

Add to `CLAUDE.md`: migration 0027 and what it adds; that `debts` is not evidence and creating one appends nothing, which is why intake may be automatic while decisions stay Martin's; the name-not-email dedup trap; and that stop titles for debt episodes are creditor-prefixed because map-wide uniqueness is enforced.

```bash
git add CLAUDE.md && git commit -m "docs: record the debt record and its traps"
git switch main && git merge --ff-only feat/debt-record && git push origin main
```
