# De kennisbank — slices 0 and 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "give me the last 6 payslips, across both employers" an answerable question — by extracting text from every ingested document, then recording what each document *says* as approved, append-only evidence.

**Architecture:** Slice 0 closes an ingest gap with no schema change: a bounded worker sweep enqueues `suggest.docmeta` for any document that has no `document_texts` row, so mailed and uploaded attachments stop landing in the vault as blobs. Slice 1 adds `document_facts` (append-only evidence, ledger-backed, model-proposes/Martin-approves) and `document_expectations` (editable, no ledger), a validator-driven local→cloud extraction ladder, a tRPC router, the `/dossier/loonstroken` page and a golden-rule eval.

**Tech Stack:** TypeScript, Node 22, pnpm 10 workspaces, Next.js (App Router) + tRPC, drizzle-orm, Postgres 17 + pgvector, pg-boss, vitest, Ollama (qwen3.5:9b), OpenAI (vision fallback only).

**Spec:** `docs/superpowers/specs/2026-08-27-kennisbank-design.md`

## Global Constraints

- **Run every build and test with `env -u NODE_ENV`** — the shell exports `NODE_ENV=development`, which breaks `next build`.
- **Dev DB must be up:** `docker compose up -d postgres`. Roles: `verder` (admin, migrations), `verder_app`, `verder_worker`. Test connection strings follow `packages/api/src/task-decide.test.ts`: admin `postgres://verder:verder@localhost:5432/verder`, app `postgres://verder_app:verder_app@localhost:5432/verder`.
- **Worker tests need poppler:** `brew install poppler` (`pdftoppm` on PATH).
- **Evidence tables are append-only, enforced by Postgres grants.** `document_facts` gets `GRANT SELECT, INSERT` for `verder_app` and `GRANT SELECT` only for `verder_worker`. Never add UPDATE or DELETE. Never grant the worker INSERT.
- **Every evidence mutation appends a `ledger_events` row in the SAME transaction**, via `appendLedgerEvent(tx, …)` from `packages/api/src/ledger.ts`.
- **AI output is suggestion-only.** Nothing enters `document_facts` except through `suggestions.approveDocumentFact`.
- **Ledger payload shapes are frozen once written.** `documentFactPayload` carries the "never change this shape" comment, like `taskStatusPayload`.
- **`details` JSONB in a hashed payload: strings and integer cents only. Never floats.**
- **Migration 0025 is applied from the homelab HOST BEFORE the web/worker images deploy.** 0020, 0021, 0022 and 0023 all tripped on this.
- **Tone in user-facing Dutch copy:** supportive toward Martin; short and professional for anyone else.

---

## File Structure

**Slice 0 — no schema change**

| File | Responsibility |
|---|---|
| `apps/worker/src/docmeta-sweep.ts` (create) | `pendingDocMeta(db, limit)` — documents with no `document_texts` row, discarded excluded. Pure query, no side effects. |
| `apps/worker/src/docmeta-sweep.test.ts` (create) | Tests for the query, including the discarded and converged cases. |
| `apps/worker/src/index.ts` (modify) | Register the `docmeta.sweep` queue, schedule and worker. |

**Slice 1**

| File | Responsibility |
|---|---|
| `packages/db/drizzle/0025_document_facts.sql` (create) | The migration: enums, both tables, grants, indexes, search trigger. |
| `packages/db/drizzle/meta/_journal.json` (modify) | Journal entry for 0025. |
| `packages/db/src/schema.ts` (modify) | drizzle definitions for `documentFacts`, `documentExpectations`, the two new enums. |
| `packages/db/src/document-facts-schema.test.ts` (create) | Grant assertions: app can INSERT, cannot UPDATE/DELETE; worker cannot INSERT. |
| `packages/api/src/document-fact-decide.ts` (create) | `documentFactPayload`, `insertDocumentFact`, `effectiveFacts`. The evidence write path. |
| `packages/api/src/document-fact-decide.test.ts` (create) | Insert + ledger in one transaction; supersession resolution. |
| `packages/api/src/docfact-validate.ts` (create) | Pure validators. No DB, no LLM. |
| `packages/api/src/docfact-validate.test.ts` (create) | Unit tests, no database. |
| `packages/api/src/verification.ts` (modify) | `documentFactPayloadHash`, the `document.fact` dispatch branch, the orphan count. |
| `packages/api/src/verification.test.ts` or `routers/verify.test.ts` (modify) | Direct test of the dispatch line and the orphan count. |
| `packages/api/src/search/render.ts` (modify) | `renderDocument` folds approved facts into the document chunk. |
| `packages/api/src/search/index-entity.ts` (modify) | Load facts for the `document` case. |
| `packages/api/src/routers/document-facts.ts` (create) | `factFields` schema + `list` + manual `create`. |
| `packages/api/src/routers/suggestions.ts` (modify) | `approveDocumentFact`, importing `factFields`. |
| `packages/api/src/root.ts` (modify) | Mount the router. |
| `apps/worker/src/prompts.ts` (modify) | `DOCFACTS_PROMPT_VERSION`, `buildDocFactsPrompt`. |
| `apps/worker/src/docfacts-gate.ts` (create) | Pure deterministic gate: is this document worth an LLM call? |
| `apps/worker/src/docfacts.ts` (create) | `suggestDocFacts` — the miner and the escalation ladder. |
| `apps/worker/src/openai.ts` (create) | `realVisionPort()` — the only file that talks to OpenAI. |
| `apps/worker/src/index.ts` (modify) | Enqueue `suggest.docfacts` after docmeta. |
| `apps/worker/src/eval/run-docfacts-eval.ts` + `samples-docfacts.json` (create) | Golden-rule eval with negatives. |
| `apps/web/src/app/(app)/dossier/loonstroken/page.tsx` (create) | The page. |

---

## Slice 0 — close the extraction gap

### Task 1: `pendingDocMeta` — find documents with no extracted text

**Files:**
- Create: `apps/worker/src/docmeta-sweep.ts`
- Test: `apps/worker/src/docmeta-sweep.test.ts`

**Interfaces:**
- Consumes: `schema.documents`, `schema.documentTexts`, `schema.documentStatusChanges` from `@verder/db`.
- Produces: `pendingDocMeta(db: Db, limit: number): Promise<string[]>` — document ids, oldest first.

**Context you need:** `document_texts` has `documentId` as its primary key and is written by `storeDocumentText` for *every* extraction attempt, including ones that produce no text (extractor `"none"`). That is what makes this sweep converge: a document that cannot be read gets a row anyway and is never picked up again. A document's effective status lives in `document_status_changes`, not in `documents.status` — see `effectiveDocument` in `packages/api/src/routers/documents.ts`. Discarded documents must be excluded.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/docmeta-sweep.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { eq } from "drizzle-orm";
import { pendingDocMeta } from "./docmeta-sweep";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

async function mkDoc(db: Db, title: string, sha: string) {
  const [d] = await db.insert(schema.documents).values({
    sha256: sha, title, mime: "application/pdf", sizeBytes: 1234,
    source: "email-attachment", receivedAt: new Date(),
  }).returning();
  return d;
}
const sha = (n: string) => n.padEnd(64, "0");

describe("pendingDocMeta", () => {
  let db: Db;
  beforeAll(() => { db = createDb(APP_URL).db; });

  it("returns a document that has no document_texts row", async () => {
    const d = await mkDoc(db, "Loonstrook mei", sha(`a${Date.now()}`));
    expect(await pendingDocMeta(db, 50)).toContain(d.id);
  });

  it("does not return a document once its text has been stored", async () => {
    const d = await mkDoc(db, "Loonstrook juni", sha(`b${Date.now()}`));
    await db.insert(schema.documentTexts).values({
      documentId: d.id, sha256: d.sha256, text: "", charCount: 0,
      extractor: "none", truncated: false,
    });
    expect(await pendingDocMeta(db, 50)).not.toContain(d.id);
  });

  it("does not return a discarded document", async () => {
    const d = await mkDoc(db, "image.png", sha(`c${Date.now()}`));
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: d.id, status: "discarded" });
    expect(await pendingDocMeta(db, 50)).not.toContain(d.id);
  });

  it("honours the limit", async () => {
    expect((await pendingDocMeta(db, 2)).length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter worker test docmeta-sweep`
Expected: FAIL — `Failed to resolve import "./docmeta-sweep"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/worker/src/docmeta-sweep.ts
import { sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";

/**
 * Documents whose text has never been extracted.
 *
 * THE GAP THIS CLOSES: suggest.docmeta was enqueued by exactly one caller —
 * nas.scan. gmail.poll enqueued only suggest.entry, and documents.registerUpload
 * enqueued nothing, so every mailed attachment and every upload sat in the vault
 * findable by its filename alone. Migration 0019 recorded this lesson once
 * already ("18 documents indexed, 0 document_texts rows"); it was still true for
 * two of the three ingest paths.
 *
 * A SWEEP rather than an enqueue at each ingest site: the web app has no pg-boss
 * connection (the worker owns the queue), so registerUpload cannot enqueue
 * directly. A sweep covers all three paths with one mechanism, is idempotent,
 * and repairs the existing backlog on its own — the same outbox-repair shape
 * pollGmail already uses for suggestQueuedAt.
 *
 * CONVERGENCE: storeDocumentText writes a row for EVERY attempt, including
 * extractor "none". So a document that genuinely cannot be read gets a row and
 * is never selected again — this cannot loop.
 *
 * Discarded documents are excluded via the effective status (document_status_changes
 * wins over documents.status, which reads "inbox" forever). IS DISTINCT FROM, not
 * <>: NULL <> 'discarded' is NULL and would drop every document with no status row.
 */
export async function pendingDocMeta(db: Db, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT d.id
    FROM ${schema.documents} d
    LEFT JOIN ${schema.documentTexts} t ON t.document_id = d.id
    LEFT JOIN LATERAL (
      SELECT status FROM ${schema.documentStatusChanges}
      WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE t.document_id IS NULL
      AND COALESCE(c.status, d.status::text) IS DISTINCT FROM 'discarded'
    ORDER BY d.created_at ASC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => r.id);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter worker test docmeta-sweep`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/docmeta-sweep.ts apps/worker/src/docmeta-sweep.test.ts
git commit -m "feat(worker): find documents whose text was never extracted"
```

---

### Task 2: Wire the `docmeta.sweep` cron

**Files:**
- Modify: `apps/worker/src/index.ts` (after the `nas.scan` block, around line 74)

**Interfaces:**
- Consumes: `pendingDocMeta` from Task 1; the existing `suggest.docmeta` queue and `recordRun`.
- Produces: nothing importable — this is wiring.

**Context you need:** The batch limit is deliberate. The first run inherits the whole backlog, including the 16-file moratorium package, and each document costs an OCR pass plus a 120 s LLM call on a GPU where evals already abort under production contention. Five per minute drains the backlog in under an hour without starving the other jobs.

- [ ] **Step 1: Add the queue, schedule and worker**

```ts
// apps/worker/src/index.ts — after the nas.scan block
import { pendingDocMeta } from "./docmeta-sweep";

// Extraction-coverage sweep: gmail.poll and documents.registerUpload cannot
// enqueue docmeta themselves (the web app holds no pg-boss connection), so the
// backlog is swept instead. Bounded per tick: each document costs an OCR pass
// and a 120 s LLM call, and the GPU is shared with the evals.
const DOCMETA_SWEEP_BATCH = 5;
await boss.createQueue("docmeta.sweep");
await boss.schedule("docmeta.sweep", "* * * * *");
await boss.work("docmeta.sweep", async () => {
  const ids = await pendingDocMeta(db, DOCMETA_SWEEP_BATCH);
  for (const documentId of ids) await boss.send("suggest.docmeta", { documentId });
  await recordRun(db, "docmeta-sweep", "ok", { enqueued: ids.length });
});
```

- [ ] **Step 2: Typecheck**

Run: `env -u NODE_ENV pnpm --filter worker typecheck`
Expected: no errors.

- [ ] **Step 3: Run the whole worker suite for regressions**

Run: `env -u NODE_ENV pnpm --filter worker test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat(worker): sweep documents with no extracted text into suggest.docmeta"
```

---

## Slice 1 — facts exist, payslips are in order

### Task 3: Migration 0025 and the drizzle schema

**Files:**
- Create: `packages/db/drizzle/0025_document_facts.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/document-facts-schema.test.ts`

**Interfaces:**
- Produces: `schema.documentFacts`, `schema.documentExpectations`, `schema.documentFactKindEnum`, `schema.expectationCadenceEnum`.

**Context you need:** Within this migration `document_expectations` must be created BEFORE `document_facts`, because `document_facts.expectation_id` references it. `source_employment_id` is deliberately absent — `employments` does not exist until 0026, and a forward FK is a migration that does not apply. `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in some Postgres versions; drizzle runs each statement separately at the `--> statement-breakpoint` markers, which is why the enum change gets its own statement.

- [ ] **Step 1: Write the migration**

```sql
-- packages/db/drizzle/0025_document_facts.sql
-- Sub-project 8, slice 1. Apply from the homelab HOST before deploying images.
CREATE TYPE "document_fact_kind" AS ENUM ('payslip','annual-statement');
--> statement-breakpoint
CREATE TYPE "expectation_cadence" AS ENUM ('monthly','four-weekly','yearly','once');
--> statement-breakpoint
ALTER TYPE "suggestion_kind" ADD VALUE 'document-fact';
--> statement-breakpoint
-- Created FIRST: document_facts.expectation_id references it.
-- EDITABLE FACT, no ledger: this table says what OUGHT to exist, which is a
-- planning decision Martin revises, not evidence about the world.
-- No FK to parties or documents, deliberately: that keeps it outside the
-- TRUNCATE ... CASCADE in verify.test.ts.
CREATE TABLE "document_expectations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"            "document_fact_kind" NOT NULL,
  "subject_label"   text NOT NULL,
  "cadence"         "expectation_cadence" NOT NULL,
  -- THE HORIZON. Evidence sets it: it defaults to the oldest fact held for this
  -- series and moves BACKWARDS when something older arrives. Deriving it from an
  -- employment start would put ~74 rows reading "ontbreekt" on the page Martin
  -- shows his bewindvoerder on day one.
  "expect_from"     date NOT NULL,
  "expect_until"    date,
  -- The issuance lag: paper trails money. A jaaropgave over 2026 must not read
  -- "ontbreekt" from 1 January 2026 onward.
  "due_after_days"  integer NOT NULL DEFAULT 10,
  "active"          boolean NOT NULL DEFAULT true,
  "note"            text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expectation_window_ck"
    CHECK ("expect_until" IS NULL OR "expect_until" >= "expect_from")
);
--> statement-breakpoint
-- EVIDENCE. Append-only, enforced by the grants below, ledger-backed via
-- document.fact. A correction is a NEW row whose supersedes_id points at the old
-- one — never an UPDATE. Readers must resolve the live set with the NOT EXISTS
-- subquery in effectiveFacts(); a reader that forgets it sees superseded facts and
-- reports them as current. Structurally the same trap as effectiveDocument.
--
-- BLAST RADIUS: document_id references documents, so verify.test.ts's
-- TRUNCATE ledger_events, log_entries, documents, parties CASCADE wipes this
-- table. That is correct — a fact about a vanished document should go — and
-- there is no seed here, so no ensureCaseMap-style reseeder is needed.
CREATE TABLE "document_facts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id"    uuid NOT NULL REFERENCES "documents"("id"),
  "kind"           "document_fact_kind" NOT NULL,
  "expectation_id" uuid REFERENCES "document_expectations"("id"),
  "period_start"   date,
  "period_end"     date,
  "issuer_name"    text NOT NULL,
  "issuer_party_id" uuid REFERENCES "parties"("id"),
  -- For a payslip this is NETTO, always, never anything else. Bruto and the
  -- cumulatives live in details.
  "amount_cents"   integer,
  -- Strings and integer cents ONLY. Never floats: this value is inside a hashed
  -- ledger payload, and a float that round-trips differently through the driver
  -- turns /verify red on a row nobody touched.
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
--> statement-breakpoint
-- One row may supersede at most one predecessor, so a supersession chain is linear.
CREATE UNIQUE INDEX "fact_supersedes_uq" ON "document_facts" ("supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "fact_kind_period_idx"
  ON "document_facts" ("kind", "period_start" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "fact_document_idx" ON "document_facts" ("document_id");
--> statement-breakpoint
-- LAW 2 AS A PRIVILEGE, NOT A CONVENTION. suggestDocFacts runs in the same
-- process as the LLM and created_by is no barrier to it (case-history.ts already
-- looks a user up by email). Without INSERT the miner physically cannot write a
-- fact — only a suggestions row. The worker keeps SELECT because renderDocument
-- folds facts into the document chunk.
GRANT SELECT, INSERT ON "document_facts" TO verder_app;
--> statement-breakpoint
GRANT SELECT ON "document_facts" TO verder_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_expectations" TO verder_app;
--> statement-breakpoint
GRANT SELECT ON "document_expectations" TO verder_worker;
--> statement-breakpoint
-- Approving a fact changes the document's rendered body. Without this trigger
-- nothing re-enqueues it and the chunk keeps the pre-approval text — exactly the
-- bug 0017 describes for document_status_changes.
CREATE TRIGGER "document_facts_search_outbox_trg"
AFTER INSERT OR UPDATE ON "document_facts"
FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'document_id');
```

- [ ] **Step 2: Add the journal entry**

Append to the `entries` array in `packages/db/drizzle/meta/_journal.json`, after the `0024_case_map_spine` entry:

```json
{
  "idx": 25,
  "version": "7",
  "when": 1787585207836,
  "tag": "0025_document_facts",
  "breakpoints": true
}
```

- [ ] **Step 3: Add the drizzle schema definitions**

Append to `packages/db/src/schema.ts`, after the tracks/stops block:

```ts
// --- de kennisbank (sub-project 8) ---
export const documentFactKindEnum = pgEnum("document_fact_kind", ["payslip", "annual-statement"]);
export const expectationCadenceEnum = pgEnum("expectation_cadence",
  ["monthly", "four-weekly", "yearly", "once"]);

/**
 * What OUGHT to exist. EDITABLE FACT: no ledger, UPDATE allowed, DELETE never.
 * Deliberately holds no FK to parties or documents, which keeps it outside the
 * TRUNCATE ... CASCADE in verify.test.ts.
 */
export const documentExpectations = pgTable("document_expectations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: documentFactKindEnum("kind").notNull(),
  subjectLabel: text("subject_label").notNull(),
  cadence: expectationCadenceEnum("cadence").notNull(),
  expectFrom: date("expect_from").notNull(),
  expectUntil: date("expect_until"),
  dueAfterDays: integer("due_after_days").notNull().default(10),
  active: boolean("active").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What a vault document SAYS. EVIDENCE: append-only by grant, one document.fact
 * ledger event per row, correction by supersession. Readers MUST resolve the live
 * set through effectiveFacts() — a reader that forgets the NOT EXISTS subquery
 * reports superseded facts as current.
 */
export const documentFacts = pgTable("document_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  kind: documentFactKindEnum("kind").notNull(),
  expectationId: uuid("expectation_id").references(() => documentExpectations.id),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  issuerName: text("issuer_name").notNull(),
  issuerPartyId: uuid("issuer_party_id").references(() => parties.id),
  /** Payslip: NETTO, always. Bruto and cumulatives live in details. */
  amountCents: integer("amount_cents"),
  /** Strings and integer cents only — this is inside a hashed ledger payload. */
  details: jsonb("details").notNull().default({}),
  supersedesId: uuid("supersedes_id"),
  voids: boolean("voids").notNull().default(false),
  sourceSuggestionId: uuid("source_suggestion_id").references(() => suggestions.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fact_kind_period_idx").on(t.kind, t.periodStart)]);
```

Make sure `date` and `boolean` are in the `drizzle-orm/pg-core` import list at the top of the file; add them if missing.

- [ ] **Step 4: Apply the migration to the dev database**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
```
Expected: `0025_document_facts` applied, no error.

- [ ] **Step 5: Write the grants test**

```ts
// packages/db/src/document-facts-schema.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("document_facts grants", () => {
  let admin: Db, app: Db, worker: Db, docId: string, userId: string;

  beforeAll(async () => {
    admin = createDb(ADMIN_URL).db; app = createDb(APP_URL).db; worker = createDb(WORKER_URL).db;
    const [u] = await admin.insert(schema.users)
      .values({ email: `facts${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [d] = await admin.insert(schema.documents).values({
      sha256: `f${Date.now()}`.padEnd(64, "0"), title: "Loonstrook mei 2026",
      mime: "application/pdf", sizeBytes: 100, source: "email-attachment",
      receivedAt: new Date(),
    }).returning();
    docId = d.id;
  });

  const row = () => ({
    documentId: docId, kind: "payslip" as const, issuerName: "TrueFullstaq B.V.",
    amountCents: 266068, createdBy: userId,
  });

  it("verder_app may INSERT", async () => {
    const [f] = await app.insert(schema.documentFacts).values(row()).returning();
    expect(f.id).toBeTruthy();
  });

  it("verder_app may NOT UPDATE — a correction is a new superseding row", async () => {
    const [f] = await app.insert(schema.documentFacts).values(row()).returning();
    await expect(app.update(schema.documentFacts)
      .set({ amountCents: 1 }).where(eq(schema.documentFacts.id, f.id)))
      .rejects.toThrow(/permission denied/i);
  });

  it("verder_app may NOT DELETE", async () => {
    const [f] = await app.insert(schema.documentFacts).values(row()).returning();
    await expect(app.delete(schema.documentFacts)
      .where(eq(schema.documentFacts.id, f.id)))
      .rejects.toThrow(/permission denied/i);
  });

  it("verder_worker may NOT INSERT — the miner can only ever suggest", async () => {
    await expect(worker.insert(schema.documentFacts).values(row()))
      .rejects.toThrow(/permission denied/i);
  });

  it("verder_worker may SELECT — renderDocument folds facts into the chunk", async () => {
    await expect(worker.select().from(schema.documentFacts).limit(1)).resolves.toBeDefined();
  });

  it("rejects a period that ends before it starts", async () => {
    await expect(app.insert(schema.documentFacts).values({
      ...row(), periodStart: "2026-05-31", periodEnd: "2026-05-01",
    })).rejects.toThrow(/fact_period_ck/i);
  });

  it("rejects voids without a superseded row", async () => {
    await expect(app.insert(schema.documentFacts).values({ ...row(), voids: true }))
      .rejects.toThrow(/fact_void_ck/i);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `env -u NODE_ENV pnpm --filter @verder/db test document-facts-schema`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0025_document_facts.sql packages/db/drizzle/meta/_journal.json \
        packages/db/src/schema.ts packages/db/src/document-facts-schema.test.ts
git commit -m "feat(db): document_facts as append-only evidence, document_expectations as the horizon"
```

---

### Task 4: The evidence write path — payload, insert, live-set resolution

**Files:**
- Create: `packages/api/src/document-fact-decide.ts`
- Test: `packages/api/src/document-fact-decide.test.ts`

**Interfaces:**
- Consumes: `appendLedgerEvent` from `./ledger`; `schema.documentFacts`.
- Produces:
  - `type DocumentFact = typeof schema.documentFacts.$inferSelect`
  - `documentFactPayload(f: DocumentFact): Record<string, unknown>`
  - `insertDocumentFact(tx: Db, userId: string, input: InsertDocumentFactInput): Promise<DocumentFact>`
  - `effectiveFacts(db: Db, opts?: { documentId?: string; kind?: string }): Promise<DocumentFact[]>`
  - `interface InsertDocumentFactInput { documentId: string; kind: "payslip" | "annual-statement"; expectationId?: string | null; periodStart?: string | null; periodEnd?: string | null; issuerName: string; issuerPartyId?: string | null; amountCents?: number | null; details?: Record<string, string | number>; supersedesId?: string | null; voids?: boolean; sourceSuggestionId?: string | null; }`

**Context you need:** Mirror `packages/api/src/task-decide.ts` exactly — it is the house pattern for an evidence child table. The payload includes `supersedesId`, `voids` and `expectationId` so a withdrawal cannot be silently undone. `date` columns come back from the driver as `YYYY-MM-DD` strings, not `Date`, so the payload uses them verbatim.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/document-fact-decide.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { documentFactPayload, effectiveFacts, insertDocumentFact } from "./document-fact-decide";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("document facts", () => {
  let db: Db, userId: string, docId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `dfd${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [d] = await db.insert(schema.documents).values({
      sha256: `d${Date.now()}`.padEnd(64, "0"), title: "Loonstrook mei 2026",
      mime: "application/pdf", sizeBytes: 100, source: "email-attachment",
      receivedAt: new Date(),
    }).returning();
    docId = d.id;
  });

  const base = () => ({
    documentId: docId, kind: "payslip" as const, issuerName: "TrueFullstaq B.V.",
    periodStart: "2026-05-01", periodEnd: "2026-05-31", amountCents: 266068,
    details: { brutoCents: 350000 },
  });

  it("inserts the fact and its ledger event in one transaction", async () => {
    const fact = await db.transaction((tx) => insertDocumentFact(tx, userId, base()));
    expect(fact.amountCents).toBe(266068);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, fact.id));
    expect(ev.eventType).toBe("document.fact");
    expect(ev.entityType).toBe("document_fact");
    expect(ev.payloadHash).toBe(sha256Hex(canonicalJson(documentFactPayload(fact))));
  });

  it("the payload carries supersedesId, voids and expectationId", async () => {
    const fact = await db.transaction((tx) => insertDocumentFact(tx, userId, base()));
    const p = documentFactPayload(fact);
    expect(p).toHaveProperty("supersedesId", null);
    expect(p).toHaveProperty("voids", false);
    expect(p).toHaveProperty("expectationId", null);
  });

  it("details survives the driver round-trip byte-identically", async () => {
    const fact = await db.transaction((tx) => insertDocumentFact(tx, userId, base()));
    const [reread] = await db.select().from(schema.documentFacts)
      .where(eq(schema.documentFacts.id, fact.id));
    expect(sha256Hex(canonicalJson(documentFactPayload(reread))))
      .toBe(sha256Hex(canonicalJson(documentFactPayload(fact))));
  });

  it("a superseding row hides its predecessor from the live set", async () => {
    const first = await db.transaction((tx) => insertDocumentFact(tx, userId, base()));
    const second = await db.transaction((tx) => insertDocumentFact(tx, userId,
      { ...base(), amountCents: 266069, supersedesId: first.id }));
    const live = await effectiveFacts(db, { documentId: docId });
    const ids = live.map((f) => f.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(first.id);
  });

  it("a voiding row removes the fact from the live set entirely", async () => {
    const first = await db.transaction((tx) => insertDocumentFact(tx, userId, base()));
    await db.transaction((tx) => insertDocumentFact(tx, userId,
      { ...base(), supersedesId: first.id, voids: true }));
    const ids = (await effectiveFacts(db, { documentId: docId })).map((f) => f.id);
    expect(ids).not.toContain(first.id);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-fact-decide`
Expected: FAIL — cannot resolve `./document-fact-decide`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/api/src/document-fact-decide.ts
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "./ledger";

export type DocumentFact = typeof schema.documentFacts.$inferSelect;

export interface InsertDocumentFactInput {
  documentId: string;
  kind: "payslip" | "annual-statement";
  expectationId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  issuerName: string;
  issuerPartyId?: string | null;
  amountCents?: number | null;
  details?: Record<string, string | number>;
  supersedesId?: string | null;
  voids?: boolean;
  sourceSuggestionId?: string | null;
}

/**
 * Canonical ledger payload for document.fact events. The verifier rebuilds this
 * from the live document_facts row to detect tampering, so any change to this
 * shape invalidates existing chains — NEVER change it.
 *
 * supersedesId, voids and expectationId are INSIDE the hash on purpose: a
 * withdrawal that could be silently undone would make the append-only guarantee
 * decorative.
 *
 * `details` is the first JSONB value this repo puts inside a hashed payload
 * (taskStatusPayload and registryDecisionPayload are entirely scalar). It may
 * hold strings and integer cents only — never floats, which do not round-trip
 * identically through the driver and would turn /verify red on a row nobody
 * touched. document-fact-decide.test.ts asserts the round-trip.
 *
 * periodStart/periodEnd are `date` columns and arrive as YYYY-MM-DD strings.
 */
export function documentFactPayload(f: DocumentFact) {
  return {
    id: f.id,
    documentId: f.documentId,
    kind: f.kind,
    expectationId: f.expectationId ?? null,
    periodStart: f.periodStart ?? null,
    periodEnd: f.periodEnd ?? null,
    issuerName: f.issuerName,
    issuerPartyId: f.issuerPartyId ?? null,
    amountCents: f.amountCents ?? null,
    details: f.details ?? {},
    supersedesId: f.supersedesId ?? null,
    voids: f.voids,
    createdBy: f.createdBy,
    createdAt: f.createdAt.toISOString(),
  };
}

/**
 * Inserts one fact and appends its document.fact ledger event in the SAME
 * transaction (tx must be a transaction handle). There is no update path: a
 * correction is a new row carrying supersedesId, and a withdrawal is such a row
 * with voids = true.
 */
export async function insertDocumentFact(
  tx: Db, userId: string, input: InsertDocumentFactInput,
): Promise<DocumentFact> {
  const [fact] = await tx.insert(schema.documentFacts).values({
    documentId: input.documentId,
    kind: input.kind,
    expectationId: input.expectationId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    issuerName: input.issuerName,
    issuerPartyId: input.issuerPartyId ?? null,
    amountCents: input.amountCents ?? null,
    details: input.details ?? {},
    supersedesId: input.supersedesId ?? null,
    voids: input.voids ?? false,
    sourceSuggestionId: input.sourceSuggestionId ?? null,
    createdBy: userId,
  }).returning();
  await appendLedgerEvent(tx, {
    eventType: "document.fact", entityType: "document_fact", entityId: fact.id,
    payload: documentFactPayload(fact),
  });
  return fact;
}

/**
 * The LIVE set of facts: not voided, and not superseded by a later row.
 *
 * EVERY reader must go through this. A query straight against document_facts
 * sees superseded rows and reports them as current — the same trap
 * effectiveDocument exists to close one level up.
 */
export async function effectiveFacts(
  db: Db, opts: { documentId?: string; kind?: string } = {},
): Promise<DocumentFact[]> {
  const where = [
    eq(schema.documentFacts.voids, false),
    sql`NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = ${schema.documentFacts.id})`,
  ];
  if (opts.documentId) where.push(eq(schema.documentFacts.documentId, opts.documentId));
  if (opts.kind) where.push(eq(schema.documentFacts.kind, opts.kind as "payslip"));
  return db.select().from(schema.documentFacts).where(and(...where))
    .orderBy(sql`${schema.documentFacts.periodStart} DESC NULLS LAST, ${schema.documentFacts.id}`);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-fact-decide`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/document-fact-decide.ts packages/api/src/document-fact-decide.test.ts
git commit -m "feat(api): insert document facts as ledger-backed append-only evidence"
```

---

### Task 5: Verification — the `document.fact` branch and the orphan count

**Files:**
- Modify: `packages/api/src/verification.ts`
- Test: `packages/api/src/document-fact-verify.test.ts` (create)

**Interfaces:**
- Consumes: `documentFactPayload` from Task 4.
- Produces: `documentFactPayloadHash(db: Db, factId: string): Promise<string>`; `FullVerificationResult` gains `orphanFacts: number`.

**Context you need:** `makeLedgerRecompute` ends with `if (e.eventType !== "document.ingested") return e.payloadHash;` (verification.ts:205). A `document.fact` event falling through to that line would have its stored hash returned as its own recomputed hash — tampering with the row would be invisible. That is the sub-project 2 lesson, and it is why the dispatch line gets a direct test rather than only a whole-chain one. The orphan count is new: `/verify` walks events → rows and never rows → events, so a fact written around the approval queue is invisible to it today.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/document-fact-verify.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { insertDocumentFact } from "./document-fact-decide";
import { documentFactPayloadHash, makeLedgerRecompute } from "./verification";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("document.fact verification", () => {
  let app: Db, admin: Db, userId: string, docId: string;

  beforeAll(async () => {
    app = createDb(APP_URL).db; admin = createDb(ADMIN_URL).db;
    const [u] = await app.insert(schema.users)
      .values({ email: `dfv${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [d] = await app.insert(schema.documents).values({
      sha256: `v${Date.now()}`.padEnd(64, "0"), title: "Loonstrook", mime: "application/pdf",
      sizeBytes: 10, source: "email-attachment", receivedAt: new Date(),
    }).returning();
    docId = d.id;
  });

  const mk = () => app.transaction((tx) => insertDocumentFact(tx, userId, {
    documentId: docId, kind: "payslip", issuerName: "TrueFullstaq B.V.",
    periodStart: "2026-05-01", periodEnd: "2026-05-31", amountCents: 266068,
  }));

  it("the dispatch recomputes a document.fact event from its live row", async () => {
    const fact = await mk();
    const [ev] = await app.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, fact.id));
    const recompute = makeLedgerRecompute(app, "./vault-files", {
      linkedLater: new Map(), resolvedLinkHash: new Map(), resolvedStatusHash: new Map(),
    });
    expect(await recompute({
      seq: ev.seq, eventType: ev.eventType, entityType: ev.entityType,
      entityId: ev.entityId, payloadHash: ev.payloadHash,
      prevHash: ev.prevHash, eventHash: ev.eventHash,
    })).toBe(ev.payloadHash);
  });

  it("a tampered amount no longer recomputes to the stored hash", async () => {
    const fact = await mk();
    const [ev] = await app.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, fact.id));
    // Only the admin role can UPDATE — that is exactly the tampering we detect.
    await admin.execute(sql`UPDATE document_facts SET amount_cents = 1 WHERE id = ${fact.id}`);
    expect(await documentFactPayloadHash(app, fact.id)).not.toBe(ev.payloadHash);
  });

  it("returns a sentinel when the row is gone", async () => {
    expect(await documentFactPayloadHash(app, "00000000-0000-0000-0000-000000000000"))
      .toBe("missing-document-fact-row".padEnd(64, "0"));
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-fact-verify`
Expected: FAIL — `documentFactPayloadHash` is not exported.

- [ ] **Step 3: Add the hash helper**

In `packages/api/src/verification.ts`, next to `taskStatusPayloadHash` (around line 34), add:

```ts
import { documentFactPayload } from "./document-fact-decide";

/**
 * The canonical payload a document.fact event carries, rebuilt from the live
 * document_facts row. A missing row returns a sentinel rather than the stored
 * hash, so a deleted fact reads as tampering, not as agreement.
 */
export async function documentFactPayloadHash(db: Db, factId: string): Promise<string> {
  const [fact] = await db.select().from(schema.documentFacts)
    .where(eq(schema.documentFacts.id, factId));
  if (!fact) return "missing-document-fact-row".padEnd(64, "0");
  return sha256Hex(canonicalJson(documentFactPayload(fact)));
}
```

- [ ] **Step 4: Add the dispatch branch**

In `makeLedgerRecompute`, immediately before the line `if (e.eventType !== "document.ingested") return e.payloadHash;` (verification.ts:205), add:

```ts
    // MUST sit before the document.ingested fall-through. Without this branch a
    // document.fact event returns its own stored hash as its recomputed hash and
    // an edited fact verifies green — the sub-project 2 lesson.
    if (e.eventType === "document.fact")
      return documentFactPayloadHash(db, e.entityId);
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-fact-verify`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the orphan count to `runFullVerification`**

In `packages/api/src/verification.ts`, inside `runFullVerification`, just before the `return`:

```ts
  // /verify walks events -> rows and never rows -> events, so a fact written
  // around the approval queue is invisible to the chain walk. One query is the
  // only thing that can see it.
  const [orphan] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM document_facts f
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_events e
      WHERE e.event_type = 'document.fact' AND e.entity_id = f.id)
  `);
  return { ...res, headHash: rows.at(-1)?.eventHash ?? null, checkedFiles,
    orphanFacts: orphan?.n ?? 0 };
```

Add `orphanFacts: number;` to the `FullVerificationResult` interface in the same file.

- [ ] **Step 7: Test the orphan count**

Append to `packages/api/src/document-fact-verify.test.ts`:

```ts
  it("counts a fact that has no document.fact event", async () => {
    const fact = await mk();
    await admin.execute(sql`DELETE FROM ledger_events
      WHERE event_type = 'document.fact' AND entity_id = ${fact.id}`);
    const { runFullVerification } = await import("./verification");
    expect((await runFullVerification(app, "./vault-files")).orphanFacts).toBeGreaterThan(0);
  });
```

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-fact-verify`
Expected: PASS, 4 tests.

- [ ] **Step 8: Surface it on `/verify`**

In `apps/web/src/app/verify/page.tsx`, render the count alongside the existing chain result, with copy that is honest about what it proves:

```tsx
<p className="text-sm text-slate-400">
  Feiten zonder ledger-gebeurtenis: <strong>{data.orphanFacts}</strong>.
  {" "}/verify bewijst dat een vastgelegd feit niet is aangepast — niet dat je het
  hebt goedgekeurd, en niet dat het klopt met het document zelf.
</p>
```

- [ ] **Step 9: Run the full api suite and commit**

```bash
env -u NODE_ENV pnpm --filter @verder/api test
git add packages/api/src/verification.ts packages/api/src/document-fact-verify.test.ts \
        apps/web/src/app/verify/page.tsx
git commit -m "feat(verify): recompute document.fact events and count facts with no event"
```

---

### Task 6: Validators — measured, not self-reported

**Files:**
- Create: `packages/api/src/docfact-validate.ts`
- Test: `packages/api/src/docfact-validate.test.ts`

**Interfaces:**
- Produces:
  - `type ValidatorName = "required-fields" | "period-order" | "arithmetic"`
  - `interface ExtractedFact { kind: string; periodStart: string | null; periodEnd: string | null; issuerName: string; amountCents: number | null; details: Record<string, string | number>; }`
  - `validateFact(f: ExtractedFact): ValidatorName[]` — the names that FAILED; empty means green.

**Context you need:** Pure module, no DB and no LLM imports, unit-tested without a database — the `money-series.ts` precedent. This is what "not confident" means in this system: a model's self-reported confidence tracks fluency, not correctness, so escalation keys on checkable facts. Nothing here is ever persisted as a score; the spec forbids a `confidence` column because a stored number invites treating an unapproved fact as three-quarters true.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/docfact-validate.test.ts
import { describe, expect, it } from "vitest";
import { validateFact, type ExtractedFact } from "./docfact-validate";

const ok: ExtractedFact = {
  kind: "payslip", periodStart: "2026-05-01", periodEnd: "2026-05-31",
  issuerName: "TrueFullstaq B.V.", amountCents: 266068,
  details: { brutoCents: 350000, inhoudingenCents: 83932 },
};

describe("validateFact", () => {
  it("passes a well-formed payslip whose arithmetic reconciles", () => {
    expect(validateFact(ok)).toEqual([]);
  });

  it("fails when the period is missing", () => {
    expect(validateFact({ ...ok, periodStart: null })).toContain("required-fields");
  });

  it("fails when the amount is missing", () => {
    expect(validateFact({ ...ok, amountCents: null })).toContain("required-fields");
  });

  it("fails when the period ends before it starts", () => {
    expect(validateFact({ ...ok, periodStart: "2026-05-31", periodEnd: "2026-05-01" }))
      .toContain("period-order");
  });

  it("fails when bruto minus inhoudingen does not equal netto", () => {
    expect(validateFact({ ...ok, details: { brutoCents: 350000, inhoudingenCents: 1 } }))
      .toContain("arithmetic");
  });

  it("does not run the arithmetic check when the parts are absent", () => {
    expect(validateFact({ ...ok, details: {} })).toEqual([]);
  });

  it("tolerates a one-cent rounding difference", () => {
    expect(validateFact({ ...ok, details: { brutoCents: 350000, inhoudingenCents: 83931 } }))
      .toEqual([]);
  });

  it("does not require an amount on an annual statement", () => {
    expect(validateFact({
      ...ok, kind: "annual-statement", amountCents: null, details: {},
    })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test docfact-validate`
Expected: FAIL — cannot resolve `./docfact-validate`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/api/src/docfact-validate.ts
/**
 * Whether an extracted fact is worth believing — measured, never self-reported.
 *
 * Asking a model for a confidence score returns a number that tracks fluency, not
 * correctness. These checks are arithmetic and shape: they are either true or they
 * are not. A failure ROUTES the extraction to a stronger model; it never decides
 * whether Martin reviews, and no result here is ever persisted as a score (the spec
 * forbids a confidence column for exactly that reason).
 *
 * Pure: no database, no LLM, no imports from @verder/db. Unit-tested without a
 * database, the money-series.ts precedent.
 */
export type ValidatorName = "required-fields" | "period-order" | "arithmetic";

export interface ExtractedFact {
  kind: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuerName: string;
  amountCents: number | null;
  details: Record<string, string | number>;
}

/** Cent rounding on a payslip is real: a one-cent gap is not a mis-read. */
const ROUNDING_TOLERANCE_CENTS = 1;

const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

export function validateFact(f: ExtractedFact): ValidatorName[] {
  const failed: ValidatorName[] = [];

  // A payslip with no period cannot fill a slot, and one with no netto cannot be
  // cross-checked against the bank. An annual statement carries no single amount.
  const needsAmount = f.kind === "payslip";
  if (!f.periodStart || !f.periodEnd || !f.issuerName.trim()
      || (needsAmount && f.amountCents === null)) {
    failed.push("required-fields");
  }

  if (f.periodStart && f.periodEnd && f.periodEnd < f.periodStart) {
    failed.push("period-order");
  }

  // The strongest signal available without a database: bruto minus inhoudingen
  // must equal netto. Only runs when the model actually reported both parts —
  // their absence is a thinner extraction, not a wrong one.
  const bruto = int(f.details.brutoCents);
  const inhoudingen = int(f.details.inhoudingenCents);
  if (bruto !== null && inhoudingen !== null && f.amountCents !== null) {
    if (Math.abs(bruto - inhoudingen - f.amountCents) > ROUNDING_TOLERANCE_CENTS) {
      failed.push("arithmetic");
    }
  }

  return failed;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test docfact-validate`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/docfact-validate.ts packages/api/src/docfact-validate.test.ts
git commit -m "feat(api): measured validators for extracted document facts"
```

---

### Task 7: The prompt and the deterministic gate

**Files:**
- Modify: `apps/worker/src/prompts.ts`
- Create: `apps/worker/src/docfacts-gate.ts`
- Test: `apps/worker/src/docfacts-gate.test.ts`

**Interfaces:**
- Produces:
  - `DOCFACTS_PROMPT_VERSION = "docfacts-v1"` and `buildDocFactsPrompt(title: string, text: string): string` from `prompts.ts`
  - `worthExtracting(doc: { title: string; docType: string | null }, text: string): boolean` from `docfacts-gate.ts`

**Context you need:** `prompts.ts` is the single index of every prompt in this system — a new prompt goes there and nowhere else. The gate exists because the LLM call costs up to 20 s on a contended GPU and most vault documents are not payslips; it is the `already-have.ts` precedent. It must be pure and cheap.

- [ ] **Step 1: Write the failing gate test**

```ts
// apps/worker/src/docfacts-gate.test.ts
import { describe, expect, it } from "vitest";
import { worthExtracting } from "./docfacts-gate";

describe("worthExtracting", () => {
  it("accepts a document already typed as a loonstrook", () => {
    expect(worthExtracting({ title: "scan001.pdf", docType: "loonstrook" }, "")).toBe(true);
  });

  it("accepts a jaaropgave by docType", () => {
    expect(worthExtracting({ title: "x.pdf", docType: "jaaropgave" }, "")).toBe(true);
  });

  it("accepts on a filename match when the type is unknown", () => {
    expect(worthExtracting({ title: "Loonstrook-mei-2026.pdf", docType: null }, "")).toBe(true);
  });

  it("accepts on body text even when title and type say nothing", () => {
    expect(worthExtracting({ title: "scan001.pdf", docType: null },
      "Periode 05  Cumulatief loon SV  1.234,00")).toBe(true);
  });

  it("rejects an unrelated letter", () => {
    expect(worthExtracting({ title: "Brief gemeente.pdf", docType: "brief" },
      "Geachte heer Van der Poel, hierbij bevestigen wij de ontvangst.")).toBe(false);
  });

  it("rejects an empty document rather than guessing", () => {
    expect(worthExtracting({ title: "image.png", docType: null }, "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts-gate`
Expected: FAIL — cannot resolve `./docfacts-gate`.

- [ ] **Step 3: Write the gate**

```ts
// apps/worker/src/docfacts-gate.ts
/**
 * Is this document worth a 20 s extraction call?
 *
 * The vault holds beschikkingen, letters, screenshots and bank exports; only a
 * small minority carry document facts. The GPU is shared with the evals, which
 * already abort under production contention, so a cheap deterministic gate runs
 * before every LLM call — the already-have.ts precedent.
 *
 * Deliberately generous on the text branch and strict on nothing: a false accept
 * costs one wasted call, a false reject costs a payslip that never becomes a fact.
 */
const TYPE_VOCABULARY = ["loonstrook", "salarisstrook", "jaaropgave", "payslip", "annual-statement"];
const FILENAME_RE = /loonstrook|salarisstrook|jaaropgave|payslip/i;
const BODY_RE = /Loonstrook|Jaaropgave|Cumulatief|Periode\s+\d+/;

export function worthExtracting(
  doc: { title: string; docType: string | null }, text: string,
): boolean {
  const type = doc.docType?.toLowerCase().trim();
  if (type && TYPE_VOCABULARY.includes(type)) return true;
  if (FILENAME_RE.test(doc.title)) return true;
  return BODY_RE.test(text);
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts-gate`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the prompt**

Append to `apps/worker/src/prompts.ts`:

```ts
export const DOCFACTS_PROMPT_VERSION = "docfacts-v1";

/**
 * Extraction prompt for document facts. Lives here because prompts.ts is the
 * single index of every prompt in this system.
 *
 * Amounts are asked for in CENTS as integers: the model must never hand back a
 * float, because the value ends up inside a hashed ledger payload where a float
 * that round-trips differently turns /verify red.
 */
export function buildDocFactsPrompt(title: string, text: string): string {
  return [
    "Je leest een Nederlands document en haalt er feiten uit. Antwoord met JSON.",
    "",
    "Velden:",
    '  kind: "payslip" voor een loonstrook, "annual-statement" voor een jaaropgave.',
    "  periodStart, periodEnd: de periode die het document dekt, als YYYY-MM-DD.",
    "    Een loonstrook over mei 2026 dekt 2026-05-01 tot 2026-05-31.",
    "    Bij een deelmaand (in dienst getreden of uit dienst) neem je de echte dagen.",
    "  issuerName: de naam van de werkgever, precies zoals het document hem spelt.",
    "  amountCents: het NETTO bedrag in hele centen, als geheel getal. 2660,68 wordt 266068.",
    "  details: brutoCents en inhoudingenCents, ook in hele centen, als je ze ziet.",
    "",
    "Regels:",
    "  - Verzin niets. Wat er niet staat, is null.",
    "  - Nooit een komma of punt in een bedrag: alleen hele centen als geheel getal.",
    "  - Is dit geen loonstrook en geen jaaropgave, antwoord dan met kind: null.",
    "",
    `Bestandsnaam: ${title}`,
    "Tekst:",
    text.slice(0, 8000),
  ].join("\n");
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
env -u NODE_ENV pnpm --filter worker typecheck
git add apps/worker/src/prompts.ts apps/worker/src/docfacts-gate.ts apps/worker/src/docfacts-gate.test.ts
git commit -m "feat(worker): docfacts prompt and the deterministic gate before it"
```

---

### Task 8: The vision port and the class routing

**Files:**
- Create: `apps/worker/src/openai.ts`
- Create: `apps/worker/src/docfacts-route.ts`
- Test: `apps/worker/src/docfacts-route.test.ts`

**Interfaces:**
- Produces:
  - `interface VisionPort { chatJsonVision(prompt: string, images: Buffer[]): Promise<unknown> }`
  - `realVisionPort(): VisionPort` from `openai.ts`
  - `type CloudDecision = "allowed" | "local-only"`
  - `cloudAllowedFor(doc: { title: string; docType: string | null }): CloudDecision` from `docfacts-route.ts`

**Context you need:** THE TRAP: a document's class is not known until something has read it. So the gate keys only on what is known *before* any model runs — an already-approved `docType`, the filename — and an **unclassified document is local-only**. Cloud is opt-in per class, never the default for an unknown, or the first paspoort scan with a generic filename goes straight out the door. That is the exact case this routing exists to prevent. `rasterizePdf` in `extract.ts` already produces the PNGs the vision call needs.

- [ ] **Step 1: Write the failing routing test**

```ts
// apps/worker/src/docfacts-route.test.ts
import { describe, expect, it } from "vitest";
import { cloudAllowedFor } from "./docfacts-route";

describe("cloudAllowedFor", () => {
  it("allows a loonstrook", () => {
    expect(cloudAllowedFor({ title: "x.pdf", docType: "loonstrook" })).toBe("allowed");
  });

  it("allows a jaaropgave", () => {
    expect(cloudAllowedFor({ title: "x.pdf", docType: "jaaropgave" })).toBe("allowed");
  });

  it("keeps an identity document local", () => {
    expect(cloudAllowedFor({ title: "x.pdf", docType: "paspoort" })).toBe("local-only");
  });

  it("keeps anything medical local", () => {
    expect(cloudAllowedFor({ title: "x.pdf", docType: "medisch dossier" })).toBe("local-only");
  });

  it("keeps an UNCLASSIFIED document local — the safe default", () => {
    expect(cloudAllowedFor({ title: "scan001.pdf", docType: null })).toBe("local-only");
  });

  it("keeps a document local when the filename smells like identity, whatever the type says", () => {
    expect(cloudAllowedFor({ title: "paspoort-scan.pdf", docType: "loonstrook" }))
      .toBe("local-only");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts-route`
Expected: FAIL — cannot resolve `./docfacts-route`.

- [ ] **Step 3: Write the routing**

```ts
// apps/worker/src/docfacts-route.ts
/**
 * May this document's pages be sent to a cloud model?
 *
 * THE TRAP THIS CLOSES: a document's class is not known until something has read
 * it, so this decision can only use what is known BEFORE any model runs — an
 * already-approved docType and the filename. An UNCLASSIFIED document is
 * therefore local-only. Cloud is opt-in per class, never the default for an
 * unknown: otherwise the first paspoort scan that arrives named "scan001.pdf"
 * goes straight out the door, which is the exact case this routing exists to
 * prevent.
 *
 * The identity/medical veto wins over an allowing docType. A mis-typed document
 * that looks like a passport by filename stays home; the cost of that being wrong
 * is one extraction that has to be done locally.
 */
export type CloudDecision = "allowed" | "local-only";

const CLOUD_TYPES = ["loonstrook", "salarisstrook", "jaaropgave", "payslip",
  "annual-statement", "bankafschrift", "factuur"];
const NEVER_RE = /paspoort|identiteit|\bid-?kaart\b|rijbewijs|\bbsn\b|medisch|huisarts|apotheek|diagnose/i;

export function cloudAllowedFor(doc: { title: string; docType: string | null }): CloudDecision {
  const type = doc.docType?.toLowerCase().trim() ?? "";
  if (NEVER_RE.test(type) || NEVER_RE.test(doc.title)) return "local-only";
  return CLOUD_TYPES.includes(type) ? "allowed" : "local-only";
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts-route`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the vision port**

```ts
// apps/worker/src/openai.ts
/**
 * The ONLY file in this repo that talks to OpenAI.
 *
 * It exists for one measured reason: extractDocumentText sends a PDF through
 * pdf-parse, which returns a flat character stream with the LAYOUT DESTROYED. A
 * Dutch loonstrook is a dense multi-column form, so "Netto" and its amount can end
 * up unrelated in that string — the text path discards the structure the facts need
 * before any model sees the document. And when it falls through to OCR, tesseract.js
 * at 200 dpi is the weakest link in the chain and has already shipped silently broken
 * once (extract.ts:36-50).
 *
 * A vision model reading the rendered page skips both failure modes. It is a
 * FALLBACK only: reached when the local validators fail, and only for document
 * classes cloudAllowedFor() permits.
 *
 * OPENAI_API_KEY lives in ~/apps/verder/.env.prod at 600, never committed. A key in
 * the local macOS keychain does not reach a worker running in Docker on the homelab.
 */
export interface VisionPort {
  chatJsonVision(prompt: string, images: Buffer[]): Promise<unknown>;
}

const MAX_PAGES = 3;

export function realVisionPort(): VisionPort {
  return {
    async chatJsonVision(prompt, images) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
          response_format: { type: "json_object" },
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.slice(0, MAX_PAGES).map((png) => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
              })),
            ],
          }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const data = await res.json() as { choices: { message: { content: string } }[] };
      return JSON.parse(data.choices[0].message.content) as unknown;
    },
  };
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
env -u NODE_ENV pnpm --filter worker typecheck
git add apps/worker/src/openai.ts apps/worker/src/docfacts-route.ts apps/worker/src/docfacts-route.test.ts
git commit -m "feat(worker): vision port and per-class cloud routing, local-only by default"
```

---

### Task 9: `suggestDocFacts` — the miner and the escalation ladder

**Files:**
- Create: `apps/worker/src/docfacts.ts`
- Test: `apps/worker/src/docfacts.test.ts`

**Interfaces:**
- Consumes: `LlmPort` from `./ollama`, `VisionPort` from `./openai`, `worthExtracting`, `cloudAllowedFor`, `validateFact`, `rasterizePdf`, `recordRun`.
- Produces: `suggestDocFacts(deps, documentId, fileBuf): Promise<void>`, where
  `deps: { db: Db; llm: LlmPort; vision?: VisionPort; rasterize?: typeof rasterizePdf; sendPush?: SendPushFn }`.

**Context you need:** Copy `suggestDocMeta`'s failure contract exactly (`ollama.ts:96-120`): a parse failure becomes a `needs-manual` suggestion with a degraded `proposed`, never a lost document, and the function never throws. The escalation trail goes in `proposed.attempts[]`; `suggestions.model` and `promptVersion` keep their strict meaning — they name the call that produced `proposed`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/docfacts.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { suggestDocFacts } from "./docfacts";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const GOOD = {
  kind: "payslip", periodStart: "2026-05-01", periodEnd: "2026-05-31",
  issuerName: "TrueFullstaq B.V.", amountCents: 266068,
  details: { brutoCents: 350000, inhoudingenCents: 83932 },
};

describe("suggestDocFacts", () => {
  let db: Db;
  beforeAll(() => { db = createDb(APP_URL).db; });

  async function mkDoc(title: string, docType: string | null, text: string) {
    const [d] = await db.insert(schema.documents).values({
      sha256: `s${Date.now()}${Math.floor(Math.random() * 1e6)}`.padEnd(64, "0"),
      title, docType, mime: "application/pdf", sizeBytes: 10,
      source: "email-attachment", receivedAt: new Date(),
    }).returning();
    await db.insert(schema.documentTexts).values({
      documentId: d.id, sha256: d.sha256, text, charCount: text.length,
      extractor: "pdf-parse", truncated: false });
    return d;
  }
  const facts = (docId: string) => db.select().from(schema.suggestions)
    .where(eq(schema.suggestions.documentId, docId));

  it("suggests a fact when the local model is green", async () => {
    const d = await mkDoc("Loonstrook mei.pdf", "loonstrook", "Periode 05 Cumulatief");
    await suggestDocFacts({ db, llm: { chatJson: async () => GOOD } }, d.id, Buffer.from(""));
    const [s] = (await facts(d.id)).filter((r) => r.kind === "document-fact");
    expect(s.status).toBe("pending");
    expect((s.proposed as { amountCents: number }).amountCents).toBe(266068);
    expect((s.proposed as { attempts: unknown[] }).attempts).toHaveLength(1);
  });

  it("escalates to vision when the arithmetic fails, and records both attempts", async () => {
    const d = await mkDoc("Loonstrook juni.pdf", "loonstrook", "Periode 06 Cumulatief");
    await suggestDocFacts({
      db,
      llm: { chatJson: async () => ({ ...GOOD, details: { brutoCents: 350000, inhoudingenCents: 1 } }) },
      vision: { chatJsonVision: async () => GOOD },
      rasterize: async () => [Buffer.from("png")],
    }, d.id, Buffer.from(""));
    const [s] = (await facts(d.id)).filter((r) => r.kind === "document-fact");
    expect(s.status).toBe("pending");
    const attempts = (s.proposed as { attempts: { failed: string[] }[] }).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].failed).toContain("arithmetic");
    expect(attempts[1].failed).toEqual([]);
  });

  it("never escalates a local-only class, and lands needs-manual instead", async () => {
    const d = await mkDoc("paspoort.pdf", "paspoort", "Periode 05 Cumulatief");
    let visionCalled = false;
    await suggestDocFacts({
      db,
      llm: { chatJson: async () => ({ ...GOOD, amountCents: null }) },
      vision: { chatJsonVision: async () => { visionCalled = true; return GOOD; } },
      rasterize: async () => [Buffer.from("png")],
    }, d.id, Buffer.from(""));
    expect(visionCalled).toBe(false);
    const [s] = (await facts(d.id)).filter((r) => r.kind === "document-fact");
    expect(s.status).toBe("needs-manual");
  });

  it("writes nothing when the gate rejects the document", async () => {
    const d = await mkDoc("Brief gemeente.pdf", "brief", "Geachte heer Van der Poel");
    await suggestDocFacts({ db, llm: { chatJson: async () => { throw new Error("must not run"); } } },
      d.id, Buffer.from(""));
    expect((await facts(d.id)).filter((r) => r.kind === "document-fact")).toHaveLength(0);
  });

  it("does not mine the same document twice", async () => {
    const d = await mkDoc("Loonstrook juli.pdf", "loonstrook", "Periode 07 Cumulatief");
    await suggestDocFacts({ db, llm: { chatJson: async () => GOOD } }, d.id, Buffer.from(""));
    await suggestDocFacts({ db, llm: { chatJson: async () => GOOD } }, d.id, Buffer.from(""));
    expect((await facts(d.id)).filter((r) => r.kind === "document-fact")).toHaveLength(1);
  });

  it("never throws when the model dies", async () => {
    const d = await mkDoc("Loonstrook aug.pdf", "loonstrook", "Periode 08 Cumulatief");
    await expect(suggestDocFacts(
      { db, llm: { chatJson: async () => { throw new Error("ollama 500"); } } },
      d.id, Buffer.from(""))).resolves.toBeUndefined();
    const [s] = (await facts(d.id)).filter((r) => r.kind === "document-fact");
    expect(s.status).toBe("needs-manual");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts.test`
Expected: FAIL — cannot resolve `./docfacts`.

- [ ] **Step 3: Write the miner**

```ts
// apps/worker/src/docfacts.ts
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { validateFact, type ExtractedFact } from "@verder/api/src/docfact-validate";
import { recordRun } from "./heartbeat";
import { buildDocFactsPrompt, DOCFACTS_PROMPT_VERSION } from "./prompts";
import { worthExtracting } from "./docfacts-gate";
import { cloudAllowedFor } from "./docfacts-route";
import { rasterizePdf } from "./extract";
import { sendPush as realSendPush, type SendPushFn } from "./push";
import type { LlmPort } from "./ollama";
import type { VisionPort } from "./openai";

/**
 * Extract document facts from one vault document and queue them for Martin's
 * review. SUGGESTION-ONLY: this function has no grant to write document_facts and
 * could not if it wanted to (migration 0025 gives verder_worker SELECT alone).
 *
 * THE LADDER:
 *   1. local model reads the extracted text -> validators green  -> pending
 *   2. validators red AND the class allows cloud -> vision retry -> pending
 *   3. both fail, or the class is local-only     -> needs-manual, with every
 *      attempt recorded so Martin can see the two readings side by side
 *
 * Failure contract copied from suggestDocMeta: a parse error becomes needs-manual
 * with a degraded proposed, never a lost document, and this NEVER throws — a
 * docfacts failure must not fail (and thereby retry) its surrounding job.
 *
 * suggestions.model and promptVersion keep their strict meaning: they name the call
 * that produced `proposed`. The full trail lives in proposed.attempts[], which is
 * what later answers "how often did local get it right unaided" — the number that
 * says whether cloud is still earning its keep.
 */
const llmFactSchema = z.object({
  kind: z.enum(["payslip", "annual-statement"]).nullable().catch(null),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  issuerName: z.string().default(""),
  amountCents: z.number().int().nullable().catch(null),
  details: z.record(z.union([z.string(), z.number().int()])).default({}),
});

interface Attempt {
  model: string; promptVersion: string; failed: string[]; error?: string;
}

export async function suggestDocFacts(
  deps: { db: Db; llm: LlmPort; vision?: VisionPort;
    rasterize?: typeof rasterizePdf; sendPush?: SendPushFn },
  documentId: string, fileBuf: Buffer,
): Promise<void> {
  const sendPush = deps.sendPush ?? realSendPush;
  const localModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  const visionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
  const attempts: Attempt[] = [];
  try {
    const [doc] = await deps.db.select().from(schema.documents)
      .where(eq(schema.documents.id, documentId));
    if (!doc) return;

    // One mining attempt per document, ever — including a rejected one, so a
    // rejected suggestion can never resurrect under a reworded reading.
    const prior = await deps.db.select({ id: schema.suggestions.id })
      .from(schema.suggestions)
      .where(and(eq(schema.suggestions.kind, "document-fact"),
        eq(schema.suggestions.documentId, documentId))).limit(1);
    if (prior.length > 0) {
      await recordRun(deps.db, "docfacts", "ok", { documentId, skipped: true });
      return;
    }

    const [txt] = await deps.db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, documentId));
    const text = txt?.text ?? "";

    // Deterministic gate BEFORE the 20 s call.
    if (!worthExtracting({ title: doc.title, docType: doc.docType }, text)) {
      await recordRun(deps.db, "docfacts", "ok", { documentId, gated: true });
      return;
    }

    const prompt = buildDocFactsPrompt(doc.title, text);

    // --- attempt 1: local
    let parsed: ExtractedFact | null = null;
    let failed: string[] = ["required-fields"];
    try {
      const out = llmFactSchema.parse(await deps.llm.chatJson(prompt));
      parsed = { ...out, kind: out.kind ?? "" };
      failed = out.kind === null ? ["required-fields"] : validateFact(parsed);
      attempts.push({ model: localModel, promptVersion: DOCFACTS_PROMPT_VERSION, failed });
    } catch (err) {
      attempts.push({ model: localModel, promptVersion: DOCFACTS_PROMPT_VERSION,
        failed: ["required-fields"], error: String(err) });
    }

    // --- attempt 2: cloud vision, only if the class allows it
    let winner = failed.length === 0 ? parsed : null;
    let winnerModel = localModel;
    if (!winner && deps.vision
        && cloudAllowedFor({ title: doc.title, docType: doc.docType }) === "allowed") {
      try {
        const pages = await (deps.rasterize ?? rasterizePdf)(fileBuf, { maxPages: 3 });
        const out = llmFactSchema.parse(await deps.vision.chatJsonVision(prompt, pages));
        const cand: ExtractedFact = { ...out, kind: out.kind ?? "" };
        const vFailed = out.kind === null ? ["required-fields"] : validateFact(cand);
        attempts.push({ model: visionModel, promptVersion: DOCFACTS_PROMPT_VERSION, failed: vFailed });
        if (vFailed.length === 0) { winner = cand; winnerModel = visionModel; }
      } catch (err) {
        attempts.push({ model: visionModel, promptVersion: DOCFACTS_PROMPT_VERSION,
          failed: ["required-fields"], error: String(err) });
      }
    }

    const proposed = {
      documentId,
      kind: winner?.kind ?? parsed?.kind ?? "payslip",
      periodStart: winner?.periodStart ?? parsed?.periodStart ?? null,
      periodEnd: winner?.periodEnd ?? parsed?.periodEnd ?? null,
      issuerName: winner?.issuerName ?? parsed?.issuerName ?? "",
      amountCents: winner?.amountCents ?? parsed?.amountCents ?? null,
      details: winner?.details ?? parsed?.details ?? {},
      attempts,
    };
    await deps.db.insert(schema.suggestions).values({
      kind: "document-fact", documentId, model: winnerModel,
      promptVersion: DOCFACTS_PROMPT_VERSION,
      status: winner ? "pending" : "needs-manual",
      proposed,
    });
    try { await sendPush(deps.db, { title: "Feiten uit een document 📄", body: doc.title }); }
    catch { /* push is best-effort */ }
    await recordRun(deps.db, "docfacts", "ok",
      { documentId, escalated: attempts.length > 1, resolved: Boolean(winner) });
  } catch (err) {
    try { await recordRun(deps.db, "docfacts", "error", { documentId, message: String(err) }); }
    catch { /* recording must not turn a swallowed failure into a thrown one */ }
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter worker test docfacts.test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the worker**

In `apps/worker/src/index.ts`, inside the existing `suggest.docmeta` worker, after `suggestDocMeta(...)`:

```ts
  // Facts ride along after docmeta, error-isolated the way task-mine rides
  // suggest.entry: a docfacts crash must never fail (and re-run) the docmeta job,
  // which would re-OCR the document.
  try {
    await suggestDocFacts({ db, llm, vision: realVisionPort() }, documentId, buf);
  } catch (err) {
    await recordRun(db, "docfacts", "error", { documentId, message: String(err) });
  }
```

Add the imports `import { suggestDocFacts } from "./docfacts";` and `import { realVisionPort } from "./openai";`.

- [ ] **Step 6: Typecheck, test, commit**

```bash
env -u NODE_ENV pnpm --filter worker typecheck && env -u NODE_ENV pnpm --filter worker test
git add apps/worker/src/docfacts.ts apps/worker/src/docfacts.test.ts apps/worker/src/index.ts
git commit -m "feat(worker): mine document facts, local first, vision only on measured failure"
```

---

### Task 10: The router and the approval doorway

**Files:**
- Create: `packages/api/src/routers/document-facts.ts`
- Modify: `packages/api/src/routers/suggestions.ts`
- Modify: `packages/api/src/root.ts`
- Test: `packages/api/src/routers/document-facts.test.ts`

**Interfaces:**
- Produces: `factFields` (a zod object) and `documentFactsRouter` with `list({ kind, limit })` and `create(factFields)`; `suggestions.approveDocumentFact({ id, fact })`.

**Context you need:** `factFields` is exported from the router and imported by `suggestions.ts` — the `itemFields`/`taskFields` rule, so manual creation and approval cannot drift apart. The `list` query must filter discarded documents with `IS DISTINCT FROM` (not `<>`: `NULL <> 'discarded'` is NULL) and it must do so **before** the `LIMIT`, so a discarded document cannot eat one of the six slots.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/routers/document-facts.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { insertDocumentFact } from "../document-fact-decide";
import { listPayslipFacts } from "./document-facts";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("listPayslipFacts", () => {
  let db: Db, userId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `dfl${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  async function mkFact(period: string, issuer: string, cents: number, discard = false) {
    const [d] = await db.insert(schema.documents).values({
      sha256: `l${Date.now()}${Math.floor(Math.random() * 1e6)}`.padEnd(64, "0"),
      title: `Loonstrook ${period}`, mime: "application/pdf", sizeBytes: 10,
      source: "email-attachment", receivedAt: new Date(),
    }).returning();
    if (discard) await db.insert(schema.documentStatusChanges)
      .values({ documentId: d.id, status: "discarded" });
    return db.transaction((tx) => insertDocumentFact(tx, userId, {
      documentId: d.id, kind: "payslip", issuerName: issuer,
      periodStart: `${period}-01`, periodEnd: `${period}-28`, amountCents: cents }));
  }

  it("returns newest period first and spans both employers", async () => {
    await mkFact("2026-04", "TrueFullstaq B.V.", 64800);
    await mkFact("2026-07", "Saurens Marketing B.V.", 355642);
    const rows = await listPayslipFacts(db, 6);
    expect(rows[0].periodStart > rows[1].periodStart).toBe(true);
    expect(new Set(rows.map((r) => r.issuerName)).size).toBeGreaterThan(1);
  });

  it("excludes a fact whose document was discarded, before the limit applies", async () => {
    const bad = await mkFact("2026-03", "TrueFullstaq B.V.", 266068, true);
    const rows = await listPayslipFacts(db, 50);
    expect(rows.map((r) => r.id)).not.toContain(bad.id);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-facts`
Expected: FAIL — cannot resolve `./document-facts`.

- [ ] **Step 3: Write the router**

```ts
// packages/api/src/routers/document-facts.ts
import { z } from "zod";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { insertDocumentFact } from "../document-fact-decide";

/**
 * The create-input shape. EXPORTED and imported by suggestions.approveDocumentFact
 * so manual creation and approval cannot drift apart — the itemFields/taskFields
 * rule.
 */
export const factFields = z.object({
  documentId: z.string().uuid(),
  kind: z.enum(["payslip", "annual-statement"]),
  expectationId: z.string().uuid().nullable().default(null),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  issuerName: z.string().min(1),
  issuerPartyId: z.string().uuid().nullable().default(null),
  amountCents: z.number().int().nullable().default(null),
  // Integer cents and strings only: this lands inside a hashed ledger payload.
  details: z.record(z.union([z.string(), z.number().int()])).default({}),
  supersedesId: z.string().uuid().nullable().default(null),
  voids: z.boolean().default(false),
});

export type FactRow = {
  id: string; documentId: string; expectationId: string | null;
  periodStart: string | null; periodEnd: string | null;
  issuerName: string; amountCents: number | null;
  details: Record<string, string | number>; title: string; sha256: string;
};

/**
 * The ordered, live set of payslip facts.
 *
 * Three load-bearing details, all copied from code that already exists: the
 * discard filter is IS DISTINCT FROM, not <> (NULL <> 'discarded' is NULL, which
 * would drop every document with no status row); it sits BEFORE the LIMIT so a
 * discarded document cannot eat one of the six slots; and NULLS LAST, because a
 * fact with no period does not belong at the top.
 *
 * The employer is deliberately NOT in the WHERE. The set is kind + period, so an
 * employer change is an ORDER BY — where in money-series.ts the same change cost a
 * measured heuristic.
 */
export async function listPayslipFacts(db: Db, limit: number): Promise<FactRow[]> {
  const rows = await db.execute<FactRow>(sql`
    WITH effective AS (
      SELECT f.* FROM document_facts f
      WHERE f.kind = 'payslip' AND f.voids = false
        AND NOT EXISTS (SELECT 1 FROM document_facts s WHERE s.supersedes_id = f.id)
    )
    SELECT e.id, e.document_id AS "documentId", e.expectation_id AS "expectationId",
           e.period_start AS "periodStart", e.period_end AS "periodEnd",
           e.issuer_name AS "issuerName", e.amount_cents AS "amountCents",
           e.details, d.sha256, COALESCE(c.title, d.title) AS title
    FROM effective e
    JOIN documents d ON d.id = e.document_id
    LEFT JOIN LATERAL (
      SELECT status, title FROM document_status_changes
      WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE COALESCE(c.status, d.status::text) IS DISTINCT FROM 'discarded'
    ORDER BY e.period_start DESC NULLS LAST, e.issuer_name
    LIMIT ${limit}
  `);
  return [...rows];
}

export const documentFactsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(6) }))
    .query(({ ctx, input }) => listPayslipFacts(ctx.db, input.limit)),

  create: protectedProcedure.input(factFields).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => insertDocumentFact(tx, ctx.user.id, input))),
});
```

- [ ] **Step 4: Add the approval mutation**

In `packages/api/src/routers/suggestions.ts`, add the import `import { factFields } from "./document-facts";` and `import { insertDocumentFact } from "../document-fact-decide";`, then add this procedure next to `approveRegistryItem`:

```ts
  // The single doorway through which an extracted reading becomes evidence.
  approveDocumentFact: protectedProcedure.input(z.object({
    id: z.string().uuid(), fact: factFields,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      // FOR UPDATE: a concurrent approve/reject waits on the row lock and then
      // sees the committed verdict — double-approve is impossible.
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id)).for("update");
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new Error("Suggestion not open for review");
      if (s.kind !== "document-fact") throw new Error("Not a document-fact suggestion");
      const fact = await insertDocumentFact(tx, ctx.user.id,
        { ...input.fact, sourceSuggestionId: s.id });
      await tx.update(schema.suggestions).set({
        status: "approved", finalPayload: input.fact, verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return fact;
    })),
```

- [ ] **Step 5: Mount the router**

In `packages/api/src/root.ts`, add `documentFacts: documentFactsRouter,` to the router map and import it.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `env -u NODE_ENV pnpm --filter @verder/api test document-facts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Run the whole api suite and commit**

```bash
env -u NODE_ENV pnpm --filter @verder/api test
git add packages/api/src/routers/document-facts.ts packages/api/src/routers/document-facts.test.ts \
        packages/api/src/routers/suggestions.ts packages/api/src/root.ts
git commit -m "feat(api): document-facts router and the approval doorway"
```

---

### Task 11: Fold facts into the search chunk

**Files:**
- Modify: `packages/api/src/search/render.ts`
- Modify: `packages/api/src/search/index-entity.ts`
- Modify: `packages/api/src/search/render.test.ts`

**Interfaces:**
- Consumes: `effectiveFacts` from Task 4.
- Produces: `renderDocument`'s `ctx` gains `facts: { periodStart: string | null; periodEnd: string | null; issuerName: string; amountCents: number | null }[]`.

**Context you need:** No tenth `SEARCH_ENTITY_TYPES` value — a fact has no page of its own, and a retired entity kind can never be cleaned by `reindex --prune` (2875 poisoned outbox rows was the measured price). Facts fold into their document's chunk instead. Sort them deterministically on `(periodStart, id)`, or the chunk text changes between runs and every reindex re-embeds everything.

- [ ] **Step 1: Add the failing render test**

Append to `packages/api/src/search/render.test.ts`:

```ts
it("renders approved facts into the document body", () => {
  const r = renderDocument(
    { title: "Loonstrook mei", docType: "loonstrook", mime: "application/pdf",
      receivedAt: new Date("2026-06-01T00:00:00Z") },
    { status: "filed", text: "ruwe tekst",
      facts: [{ periodStart: "2026-05-01", periodEnd: "2026-05-31",
        issuerName: "TrueFullstaq B.V.", amountCents: 266068 }] });
  expect(r.body).toContain("Periode: 2026-05-01 — 2026-05-31");
  expect(r.body).toContain("Werkgever: TrueFullstaq B.V.");
  expect(r.body).toContain("Netto: 2660,68");
});

it("renders a document with no facts unchanged", () => {
  const r = renderDocument(
    { title: "Brief", docType: "brief", mime: "application/pdf", receivedAt: new Date() },
    { status: "filed", text: "tekst", facts: [] });
  expect(r.body).not.toContain("Periode:");
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test render`
Expected: FAIL — `facts` is not part of the ctx type / no "Periode:" in the body.

- [ ] **Step 3: Extend `renderDocument`**

In `packages/api/src/search/render.ts`, change the `renderDocument` signature and body:

```ts
export function renderDocument(doc: {
  title: string; docType: string | null; mime: string; receivedAt: Date;
}, ctx: {
  status: string; text: string;
  /** Live facts only — the caller resolves them via effectiveFacts(). */
  facts?: { periodStart: string | null; periodEnd: string | null;
    issuerName: string; amountCents: number | null }[];
}): Rendered {
  // Facts fold into the DOCUMENT's chunk rather than becoming a tenth entity type:
  // a fact has no page of its own, and a retired entity kind can never be cleaned
  // by reindex --prune. Sorted deterministically, or the chunk text changes between
  // runs and every reindex re-embeds the whole corpus.
  const facts = [...(ctx.facts ?? [])].sort((a, b) =>
    (a.periodStart ?? "").localeCompare(b.periodStart ?? ""));
  const factLines = facts.flatMap((f) => [
    f.periodStart && f.periodEnd ? `Periode: ${f.periodStart} — ${f.periodEnd}` : null,
    f.issuerName ? `Werkgever: ${f.issuerName}` : null,
    f.amountCents === null ? null
      : `Netto: ${(f.amountCents / 100).toFixed(2).replace(".", ",")}`,
  ]);
  return {
    title: doc.title,
    body: lines(
      field("Document", doc.title),
      field("Documentsoort", doc.docType ?? "onbekend"),
      field("Status", nlLabel(ctx.status)),
      field("Bestandstype", doc.mime),
      ...factLines,
      ctx.text.trim() || null),
    occurredAt: doc.receivedAt,
    status: ctx.status,
  };
}
```

- [ ] **Step 4: Load the facts in `index-entity.ts`**

In `packages/api/src/search/index-entity.ts`, in the `document` case, add the facts to the render call:

```ts
      const facts = await effectiveFacts(db, { documentId: id });
      return renderDocument(doc, { status, text, facts });
```

with `import { effectiveFacts } from "../document-fact-decide";` at the top.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test search`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/search/render.ts packages/api/src/search/render.test.ts \
        packages/api/src/search/index-entity.ts
git commit -m "feat(search): fold approved document facts into the document chunk"
```

---

### Task 12: `/dossier/loonstroken`

**Files:**
- Create: `apps/web/src/app/(app)/dossier/loonstroken/page.tsx`

**Interfaces:**
- Consumes: `trpc.documentFacts.list`.

**Context you need:** Follow the existing server-component page pattern in `apps/web/src/app/(app)`. This page is the slice's deliverable: a page Martin can paste into a mail to VerderGroep tomorrow. No gap analysis yet — that is slice 2.

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/app/(app)/dossier/loonstroken/page.tsx
import { api } from "@/lib/trpc-server";

const euro = (cents: number | null) =>
  cents === null ? "—" : `€ ${(cents / 100).toFixed(2).replace(".", ",")}`;

export default async function LoonstrokenPage() {
  const facts = await api.documentFacts.list({ limit: 24 });
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Loonstroken</h1>
      <p className="mt-2 text-sm text-slate-400">
        {facts.length === 0
          ? "Nog geen loonstroken vastgelegd. Zodra je een strook goedkeurt, staat hij hier."
          : `${facts.length} vastgelegd, nieuwste eerst. De periode is wat het document zelf dekt.`}
      </p>
      {facts.length > 0 && (
        <table className="mt-6 w-full text-sm">
          <thead className="text-left text-slate-400">
            <tr><th className="py-2">Periode</th><th>Werkgever</th><th className="text-right">Netto</th></tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id} className="border-t border-slate-800">
                <td className="py-2 font-mono">
                  {f.periodStart && f.periodEnd ? `${f.periodStart} → ${f.periodEnd}` : "onbekend"}
                </td>
                <td>{f.issuerName}</td>
                <td className="text-right font-mono">{euro(f.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Build and confirm the page compiles**

Run: `env -u NODE_ENV pnpm --filter web build`
Expected: build succeeds, `/dossier/loonstroken` in the route list.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/dossier/loonstroken/page.tsx
git commit -m "feat(web): /dossier/loonstroken — the ordered set across both employers"
```

---

### Task 13: The docfacts eval

**Files:**
- Create: `apps/worker/src/eval/run-docfacts-eval.ts`
- Create: `apps/worker/src/eval/samples-docfacts.json`
- Modify: `apps/worker/package.json`

**Interfaces:**
- Produces: `pnpm --filter worker docfacts-eval`.

**Context you need:** Follow `run-registry-eval.ts` exactly: real Ollama, fixed samples, one PASS/FAIL line per sample, a closing score line naming model and prompt version, and **no non-zero exit** — the house style is report, not block. The samples must be real post-OCR text with the noise in it: the eval must eat what production eats. The negatives earn their keep — the retrieval eval's were 0/3 on first run and were the only thing that found a real defect.

- [ ] **Step 1: Write the samples**

```json
[
  {
    "title": "Loonstrook-mei-2026.pdf",
    "text": "TrueFullstaq B.V.\nSalarisspecificatie\nPeriode 05  2026\nvan 01-05-2026 t/m 31-05-2026\nBruto loon       3.500,00\nInhoudingen        839,32\nNetto uit te betalen  2.660,68\nCumulatief loon SV  17.500,00",
    "expect": { "kind": "payslip", "periodStart": "2026-05-01", "periodEnd": "2026-05-31", "amountCents": 266068 }
  },
  {
    "title": "loonstrook juni deelmaand.pdf",
    "text": "TrueFullstaq B.V.\nSalarisspecificatie\nPeriode 06 2026\nvan 01-06-2026 t/m 10-06-2026\nUit dienst per 10-06-2026\nNetto uit te betalen 1.118,65",
    "expect": { "kind": "payslip", "periodStart": "2026-06-01", "periodEnd": "2026-06-10", "amountCents": 111865 }
  },
  {
    "title": "scan0042.pdf",
    "text": "Saurens Marketing B.V.\nSalarisspeciflcatie\nPeriodc 07 2O26\nvan 01-07-2026 t/m 31-07-2026\nNetto uit te betaien  3.556,42",
    "expect": { "kind": "payslip", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "amountCents": 355642 }
  },
  {
    "title": "jaaropgave-2025.pdf",
    "text": "TrueFullstaq B.V.\nJaaropgaaf 2025\nLoon loonbelasting/volksverzekeringen  42.000,00\nIngehouden loonheffing  11.230,00",
    "expect": { "kind": "annual-statement", "periodStart": "2025-01-01", "periodEnd": "2025-12-31", "amountCents": null }
  },
  {
    "title": "brief-gemeente-almere.pdf",
    "text": "Gemeente Almere\nGeachte heer Van der Poel,\nHierbij bevestigen wij de ontvangst van uw aanvraag bijzondere bijstand.",
    "expect": { "kind": null }
  },
  {
    "title": "ongedateerde-brief.pdf",
    "text": "Verder Bewindvoering\nBeste heer Van der Poel, wij hebben uw stukken in goede orde ontvangen.",
    "expect": { "kind": null }
  },
  {
    "title": "loonstrook-zonder-cumulatief.pdf",
    "text": "Saurens Marketing B.V.\nSalarisspecificatie\nPeriode 06 2026\nvan 10-06-2026 t/m 30-06-2026\nNetto uit te betalen 2.487,71",
    "expect": { "kind": "payslip", "periodStart": "2026-06-10", "periodEnd": "2026-06-30", "amountCents": 248771 }
  }
]
```

- [ ] **Step 2: Write the eval**

```ts
// apps/worker/src/eval/run-docfacts-eval.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { realLlmPort } from "../ollama";
import { buildDocFactsPrompt, DOCFACTS_PROMPT_VERSION } from "../prompts";

// Golden-rule eval for document-fact extraction. Mirrors run-registry-eval.ts:
// real Ollama, fixed samples, score printed with the prompt version, no non-zero
// exit — report, do not block.
//
// The samples carry real post-OCR noise ("Salarisspeciflcatie", "2O26"): the eval
// must eat what production eats. Three are NEGATIVES — an ordinary letter, an
// undated letter, and a jaaropgave that must not read as a loonstrook. The
// retrieval eval's negatives were 0/3 on first run and were the only thing that
// found a real defect.
//
// WHAT THIS CANNOT CATCH, and it belongs in the record: a well-formed but WRONG
// period on a document kind the model has never seen. That is exactly the error
// that looks most authoritative on the page Martin forwards to his bewindvoerder.
// Approval-before-fact damps it; it does not remove it.

const sampleSchema = z.array(z.object({
  title: z.string(),
  text: z.string(),
  expect: z.object({
    kind: z.string().nullable(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    amountCents: z.number().int().nullable().optional(),
  }),
}));

// The same shape docfacts.ts validates.
const shape = z.object({
  kind: z.enum(["payslip", "annual-statement"]).nullable().catch(null),
  periodStart: z.string().nullable().catch(null),
  periodEnd: z.string().nullable().catch(null),
  issuerName: z.string().default(""),
  amountCents: z.number().int().nullable().catch(null),
  details: z.record(z.union([z.string(), z.number().int()])).default({}),
});

const samples = sampleSchema.parse(
  JSON.parse(await readFile(new URL("./samples-docfacts.json", import.meta.url), "utf8")));
const llm = realLlmPort();
let pass = 0;
for (const s of samples) {
  const out = shape.safeParse(await llm.chatJson(buildDocFactsPrompt(s.title, s.text)));
  // issuerName is reference-only: it is free text and never scored.
  const ok = out.success
    && out.data.kind === s.expect.kind
    && (s.expect.periodStart === undefined || out.data.periodStart === s.expect.periodStart)
    && (s.expect.periodEnd === undefined || out.data.periodEnd === s.expect.periodEnd)
    && (s.expect.amountCents === undefined || out.data.amountCents === s.expect.amountCents);
  console.log(`${ok ? "PASS" : "FAIL"} — ${s.title}${ok ? "" : ` → ${JSON.stringify(out.success ? out.data : out.error.issues)}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${samples.length} with model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"} prompt=${DOCFACTS_PROMPT_VERSION}`);
```

- [ ] **Step 3: Add the script**

In `apps/worker/package.json`, add to `scripts`:

```json
"docfacts-eval": "tsx src/eval/run-docfacts-eval.ts",
```

- [ ] **Step 4: Run the eval three times and record the range**

```bash
for i in 1 2 3; do env -u NODE_ENV pnpm --filter worker docfacts-eval; done
```

Record the result in `CLAUDE.md` under Eval baselines as a **range over three completed runs**, naming any flaky sample — never a single number. A run that aborts on the 120 s Ollama timeout is a crashed run, not a result: rerun it.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/eval/run-docfacts-eval.ts apps/worker/src/eval/samples-docfacts.json \
        apps/worker/package.json CLAUDE.md
git commit -m "test(worker): docfacts eval with negatives, baseline recorded as a range"
```

---

### Task 14: Deploy

**Files:**
- Modify: `CLAUDE.md`, `docs/deploy.md`

**Context you need:** Migration BEFORE images. 0020, 0021, 0022 and 0023 all tripped on this, and the failure mode is every affected page returning 500 on an unknown column or enum value. The rsync must use `--delete` **and** `--exclude 'nightly.log'`, or the cron log's entire history is removed — the 2026-08-22 dry run printed exactly one line, `deleting nightly.log`, which is the only warning there is.

- [ ] **Step 1: Add the OpenAI key to prod secrets**

```bash
ssh homelab 'grep -q OPENAI_API_KEY ~/apps/verder/.env.prod || echo "OPENAI_API_KEY=<key>" >> ~/apps/verder/.env.prod'
ssh homelab 'chmod 600 ~/apps/verder/.env.prod'
```

- [ ] **Step 2: Dry-run the sync and read the deletions**

```bash
rsync -avn --delete --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude 'nightly.log' \
  ./ homelab:~/apps/verder/
```
Expected: review every `deleting` line before proceeding. Plain `--dry-run` without `--info=del` prints nothing, which reads as "no deletions".

- [ ] **Step 3: Sync**

```bash
rsync -av --delete --exclude '.git' --exclude 'node_modules' --exclude 'nightly.log' \
  ./ homelab:~/apps/verder/
```

- [ ] **Step 4: Migration FIRST, from the host**

```bash
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
```
Expected: `0025_document_facts` applied.

- [ ] **Step 5: Rebuild web and worker**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml up -d --build web worker'
```

- [ ] **Step 6: Verify**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```
Expected: `ok`, `orphanFacts: 0`, and the event count risen by exactly the number of facts approved. Then open `https://verder.vanderpoel.pro/dossier/loonstroken` and `/verify`.

- [ ] **Step 7: Watch the sweep for one full day**

```bash
ssh homelab "cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml \
  exec -T postgres psql -U verder -d verder -c \
  \"SELECT worker, status, count(*) FROM worker_runs WHERE started_at > now() - interval '1 day' \
    AND worker IN ('docmeta-sweep','docfacts') GROUP BY 1,2\""
```
Expected: no growing `error` count. A docmeta timeout under GPU contention is the thing to watch for.

- [ ] **Step 8: Record it in CLAUDE.md and commit**

Add a sentence to the deployment paragraph naming: migration 0025, the `docmeta.sweep` cron and its batch size, the `document_facts` grant, the `document.fact` verification branch and orphan count, the OpenAI fallback and its per-class gate, and the docfacts eval baseline range.

```bash
git add CLAUDE.md docs/deploy.md
git commit -m "docs: record the kennisbank slice 1 deploy and its ordering trap"
```

---

## Self-Review

**Spec coverage.** Every slice-0 and slice-1 requirement maps to a task: the ingest gap → Tasks 1–2; migration 0025 with grants, indexes and the search trigger → Task 3; the ledger payload and supersession → Task 4; both verification branches → Task 5; measured validators → Task 6; prompt and gate → Task 7; class routing and the vision port → Task 8; the ladder and `attempts[]` → Task 9; `factFields` shared between create and approve → Task 10; the chunk fold → Task 11; the page → Task 12; the eval with negatives → Task 13; migration-before-images → Task 14.

**Deferred to their own plans, by design:** `employments`, `party_links`, `parties.ingest_mail`, `profile_attributes` and `dossier-series.ts` with the four slot states (slice 2, migration 0026); `accounts`, the reconciliation join table and the vakantiegeld exclusion (slice 3, migration 0027). Slice 2's plan should be written after slice 1's eval numbers are real, because the gap engine's tolerance for a wrong period depends on how often extraction actually gets one wrong.

**One open decision carried from the spec** (spec §"Open question carried into the plan"): whether `profile_attributes` should be append-only like `document_facts`. It does not block slices 0–1 — it must be settled before migration 0026 is written.
