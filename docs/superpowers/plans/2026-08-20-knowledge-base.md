# Searchable Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every record in verder findable — by Martin through a ⌘K palette and a `/search` page, and by the agent through a retrieval API that grounds its suggestions and answers "do we already have this document?"

**Architecture:** One hybrid index in the existing Postgres: a `search_chunks` table carrying both a Dutch `tsvector` and a 768-dimension pgvector embedding, kept fresh by database triggers that write to an outbox a worker job drains every 60 seconds. Queries run lexical and semantic retrieval in parallel and fuse them with reciprocal rank in TypeScript; the agent path adds an Ollama rerank that falls back to the fused order on timeout. The index is **derived, not evidence** — fully rebuildable by `reindex`, so it allows UPDATE/DELETE and appends no ledger events.

**Tech Stack:** Postgres 17 via `pgvector/pgvector:pg17`, drizzle-orm 0.38.4 + drizzle-kit 0.30.6, tRPC, Next.js App Router (React server components), pg-boss, Ollama (`nomic-embed-text` for embeddings, the existing chat model for reranking), vitest, pnpm 10, Node 22, tesseract.js + pdf-parse + poppler-utils for text extraction.

**Spec:** `docs/superpowers/specs/2026-08-20-knowledge-base-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Build and test with `env -u NODE_ENV`.** The shell exports `NODE_ENV=development`, which breaks `next build`.
- **pnpm 10, Node 22+.** Images are `node:22-slim`.
- **Evidence tables stay append-only.** Every evidence mutation appends a `ledger_events` row in the same transaction. This plan never weakens that, and Task 2 carries a test proving indexing appends **zero** ledger events.
- **The three index tables are derived, not evidence** — `document_texts`, `search_chunks`, `search_outbox`. They are rebuildable by `reindex`, so the worker role holds UPDATE/DELETE on them. The grants migration must say so in an SQL comment.
- **AI output is suggestion-only.** Nothing enters the ledger without Martin's approval; model, prompt version, verdict and edit diff are always recorded. Retrieval references live in `suggestions.retrieved_refs`, never inside `proposed` — `proposed` is diffed against `final_payload` to record Martin's edits, and retrieval context in that column would corrupt every edit diff.
- **Migration numbers are fixed:** `0014_vector_extension.sql` (hand-written), `0015_knowledge_base.sql` (generated), `0016_search_grants.sql` (hand-written), `0017_search_triggers.sql` (hand-written), `0018_retrieved_refs.sql` (generated).
- **Module layout is fixed.** Pure primitives in `packages/core/src/search/` (`entity-types.ts`, `chunk.ts`, `source-hash.ts`, `fuse.ts`); the retrieval core in `packages/api/src/search/` (`embed.ts`, `render.ts`, `index-entity.ts`, `rerank.ts`, `retrieve.ts`, `health.ts`). `apps/worker` already depends on `@verder/api` and imports from it rather than duplicating.
- **Grants are fixed.** `verder_app` gets SELECT only on all three index tables. `verder_worker` gets SELECT/INSERT/UPDATE/DELETE on `document_texts` and `search_chunks`, and SELECT/DELETE on `search_outbox`. **Neither role gets INSERT on `search_outbox`** — rows arrive only through the `SECURITY DEFINER` trigger function.
- **Status is denormalized** into `search_chunks.status` at index time. Query-time filtering reads that column only; no per-entity-type status subquery exists anywhere in the query pipeline.
- **`SEARCH_STATUSES` is the single status vocabulary** (`packages/core/src/search/entity-types.ts`). The router's zod enum and the filter rail both import it, so the UI can never offer a value the router rejects.
- **Search degrades, never errors.** Ollama down → embeddings stay NULL and results come back lexical-only. Rerank timeout → the fused order, logged. Extraction failure → the document stays findable by title and metadata.
- **Eval baselines are honest ranges over three runs**, never a lucky run. Eval runs alongside the prod stack often abort on the 120 s Ollama timeout from GPU contention — rerun rather than trust a crashed run.
- **Never commit on the homelab.** It is an rsync target, not a checkout.
- **Tone:** supportive and encouraging toward Martin; short, professional, official register in anything another party may read.

## Task dependency order

Execute 1 → 17 in order. The edges that matter:

```
1 (schema + pgvector) → 2 (grants) → 3, 5, 6, 7, 8, 10, 13, 15
4 (pure primitives + renderers) → 5, 7, 8, 10, 11, 12, 16
3 (document_texts) → 5 (the loader reads it)
5 (loadAndRender / indexEntity) → 7 (drain), 10 (reindex), 16 (eval)
6 (14 triggers) → 7 (there is something to drain), 13 (outbox depth)
7 (embed client, health.ts, drain, worker vitest config) → 8, 10, 13, 14, 15, 16
8 (retrieve + search router) → 9, 11, 12, 13, 14, 15, 16
9 (rerank) → 15 (deep mode for "do we already have this?"), 16
11 (/search) → 12 (shares ENTITY_LABEL and the URL helpers)
10 (reindex) → 17 (the restore procedure calls it)
```

**Note on the router surface.** The design spec names `search.query`, `search.health` and `search.alreadyHave`. Task 12 adds one more, `search.recent`, backing the palette's empty state — a deliberate addition, called out here so it is not mistaken for drift.

---


### Task 1: pgvector infrastructure + derived-index schema

Swap both Postgres images to `pgvector/pgvector:pg17`, then add the three derived index tables (`document_texts`, `search_chunks`, `search_outbox`) to the drizzle schema — with the `vector(768)` column, the `tsvector GENERATED ALWAYS … STORED` column, the denormalized `status` column, the GIN index, the HNSW cosine index and the btree indexes.

**Which parts drizzle can express (verified against the installed toolchain, not assumed):**

- `vector("embedding", { dimensions: 768 })` — **native** in `drizzle-orm@0.38.4` (`pg-core/columns/vector_extension/vector.d.ts`), re-exported from `drizzle-orm/pg-core`.
- `bigserial("id", { mode: "number" })` — **native** (`pg-core/columns/bigserial.d.ts`).
- `.using("hnsw", t.embedding.op("vector_cosine_ops"))` — **native**; `PgIndexMethod` includes `'hnsw'` and `PgIndexOpClass` includes `'vector_cosine_ops'` (`pg-core/indexes.d.ts`), and `.op()` exists on `ExtraConfigColumn` (`pg-core/columns/common.d.ts:103`).
- `tsvector` — **no native column type**, but it **is** declared in the TypeScript schema all the same: `customType` (`pg-core/columns/custom.d.ts`) plus `.generatedAlwaysAs(sql\`…\`)` (`pg-core/columns/common.d.ts:49`). Postgres computes the value; drizzle knows the column exists. It round-trips through `drizzle-kit@0.30.6 generate`, emitting `"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('dutch', title || ' ' || body)) STORED` — valid Postgres, because the quoted lowercase type name resolves to `pg_catalog.tsvector`. **No later task may claim `tsv` is absent from the TS schema; it is present, declared below, and every task that reads `search_chunks` through drizzle sees it.**
- `CREATE EXTENSION vector` — **cannot** be expressed. `drizzle-kit@0.30.6`'s `extensionsFilters` type only accepts `'postgis'`. It must be a hand-written `--custom` migration numbered **before** the generated one, because the generated `CREATE TABLE "search_chunks"` uses the `vector(768)` type.

So: `0014_vector_extension.sql` (hand-written) → `0015_knowledge_base.sql` (generated). The journal currently has 14 entries, `0000` → `0013` (verified in `packages/db/drizzle/meta/_journal.json`), so those two numbers are the next free ones.

**Files**

- Modify: `/Users/martin/Workspace/mp/verder/docker-compose.yml`
- Modify: `/Users/martin/Workspace/mp/verder/docker-compose.prod.yml`
- Modify: `/Users/martin/Workspace/mp/verder/packages/db/src/schema.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0014_vector_extension.sql` (hand-written, via `--custom`)
- Create: `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0015_knowledge_base.sql` (generated)
- Create (tool-generated, commit them): `/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/0014_snapshot.json`, `/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/0015_snapshot.json`
- Modify (tool-generated): `/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/_journal.json`
- Test: `/Users/martin/Workspace/mp/verder/packages/db/src/search-schema.test.ts`

**Interfaces**

*Consumes* — nothing from any other task in this plan. Everything below already exists in the repo today, at these exact names:

- `createDb(url: string): { db: Db; pool: pg.Pool }` and `type Db = NodePgDatabase<typeof schema>` from `/Users/martin/Workspace/mp/verder/packages/db/src/client.ts`
- `schema.documents` — `id, sha256 (unique, notNull), title, docType, mime, sizeBytes, source, sourceRef, status, receivedAt, createdAt`
- `import { sql } from "drizzle-orm"` — already line 1 of `packages/db/src/schema.ts`

*Produces* (new exports from `packages/db/src/schema.ts`), consumed later by **Task 2** (grants), **Task 3** (`document_texts` writes), **Task 5** (`loadAndRender` writes `status` and reads `document_texts.text`), **Task 6** (triggers insert into `search_outbox`), **Task 7** (the drain), **Task 8** (the query pipeline) and **Task 13** (index health):

```ts
export const tsvector: ReturnType<typeof customType<{ data: string; driverData: string }>>;

export const documentTexts;  // pgTable("document_texts")
//   documentId: uuid PK → documents.id, sha256: text notNull, text: text notNull,
//   extractor: text notNull, charCount: integer notNull,
//   truncated: boolean notNull default false, extractedAt: timestamptz notNull default now()

export const searchChunks;   // pgTable("search_chunks")
//   id: uuid PK default gen_random_uuid(), entityType: text notNull, entityId: uuid notNull,
//   chunkIndex: integer notNull, title: text notNull, body: text notNull,
//   occurredAt: timestamptz nullable, status: text nullable,
//   tsv: tsvector generated always stored, embedding: vector(768) nullable,
//   sourceHash: text notNull, embedAttempts: integer notNull default 0,
//   indexedAt: timestamptz notNull default now()

export const searchOutbox;   // pgTable("search_outbox")
//   id: bigserial PK (mode "number"), entityType: text notNull, entityId: uuid notNull,
//   enqueuedAt: timestamptz notNull default now()
```

Two columns exist because of decisions made outside the spec's data-model block; neither is optional:

- **`search_chunks.status text` (nullable) — denormalized.** Every entity type keeps its effective status somewhere different: documents in `document_status_changes`, tasks in `task_status_changes`, financial items and debts in `registry_decisions`, and entries/emails/milestones/timeline events/parties have no status at all. Task 5's `loadAndRender` resolves the effective status once, at index time, and writes it here. Task 8's query pipeline filters on **this column only** and never issues a per-entity-type status subquery. That is what removes the entire class of "the filter rail offers a status the router rejects" bug. It is plain `text`, not an enum, so the vocabulary (`SEARCH_STATUSES`, defined in Task 4) can grow without a migration. No index: the vocabulary is ≤17 values, so a btree on it is not selective enough to beat the GIN/HNSW/`entity_type` access paths — Postgres applies it as a filter over the rows those indexes return.
- **`document_texts.truncated boolean not null default false`.** The spec's data-model block lists six columns, but its error-handling section says oversized text is "capped at 1 MB, truncation flagged". This column is that flag. It is a real, live column: **Task 3's `storeDocumentText` must set it explicitly** (`truncated: text.length > CAP`), and `char_count` stores the pre-cap length so the two together say how much was lost.

---

#### Steps

**Step 1 — branch, and preflight the pgvector image before touching anything.**

The image is not present on the homelab and its PG minor is unverified. The dev container currently runs `PostgreSQL 17.10 (Debian 17.10-1.pgdg13+1)`. A same-major image attaches to the existing data directory; a *lower* minor is not something to discover during a prod deploy.

```bash
cd /Users/martin/Workspace/mp/verder
git checkout -b sp4/task-1
docker pull pgvector/pgvector:pg17
docker run --rm pgvector/pgvector:pg17 postgres --version
docker run --rm pgvector/pgvector:pg17 ls /usr/share/postgresql/17/extension/ | grep '^vector'
```

Expected: `postgres (PostgreSQL) 17.x` with `x >= 10`, and the `ls | grep` prints at least `vector.control`. If the version prints a minor **below** 17.10, stop and report — do not continue; the existing `pgdata` volume was written by 17.10 and Postgres refuses to start on an older minor's catalog in some upgrade paths.

No commit.

**Step 2 — swap the dev and prod images and prove the existing suite is still green on them.**

This is a regression gate, not a feature step, and it is the one step in this task that commits before a new test exists. That is deliberate: same PG major, same `PGDATA` layout, same entrypoint, and the live DB has exactly one extension (`plpgsql`), so nothing extension-dependent is being migrated. What is being proven is that the *existing* suite is unaffected by the image change — which has to be proven *before* new tables muddy the picture.

Edit `/Users/martin/Workspace/mp/verder/docker-compose.yml` — change the `image:` line only, so the file reads:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: verder
      POSTGRES_PASSWORD: verder
      POSTGRES_DB: verder
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
volumes:
  pgdata:
```

Edit `/Users/martin/Workspace/mp/verder/docker-compose.prod.yml` — the `services.postgres` block currently starts:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
```

Change that one line so it starts:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
```

Both files change in **one commit**. Both declare the volume as `pgdata` and both resolve to the same project name in a given checkout, so a half-swap means a bare `docker compose up -d postgres` can attach a non-pgvector Postgres to a database containing `vector` columns — the container starts and then every query touching those objects fails.

Recreate the dev container on the new image and confirm the old data survived:

```bash
cd /Users/martin/Workspace/mp/verder
docker compose up -d postgres
docker inspect -f '{{.Config.Image}}' verder-postgres-1
docker exec verder-postgres-1 psql -U verder -d verder -Atc "select version();" -c "select count(*) from ledger_events;"
```

Expected: `pgvector/pgvector:pg17`, then a `PostgreSQL 17.x (Debian …)` line, then a non-zero `ledger_events` count (40 at the time of writing) — proving the existing volume mounted cleanly.

Run the two suites that talk to that database:

```bash
env -u NODE_ENV pnpm --filter @verder/db test
env -u NODE_ENV pnpm --filter @verder/api test
```

Expected: both green, exactly as before the swap.

Commit:

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "chore: pgvector/pgvector:pg17 postgres image for dev and prod"
```

**Step 3 — write the failing schema test.**

Create `/Users/martin/Workspace/mp/verder/packages/db/src/search-schema.test.ts`:

```ts
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// ADMIN role: this file checks the SHAPE of the derived index tables — the
// generated tsvector, the pgvector round-trip, the denormalized status column,
// the uniqueness constraint and the outbox sequence. Grants are a separate
// concern and are checked with the app and worker roles in search-grants.test.ts
// (Task 2), which is why this file connects as the owner and not as verder_app.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

describe("knowledge-base index schema", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    ({ db, pool } = createDb(ADMIN_URL));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores extracted document text keyed by the vault sha256", async () => {
    const sha = `kb${crypto.randomUUID().replace(/-/g, "")}`.padEnd(64, "0").slice(0, 64);
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha,
      title: "Brief van VerderGroep",
      mime: "application/pdf",
      sizeBytes: 12345,
      source: "upload",
      receivedAt: new Date("2026-08-01T00:00:00Z"),
    }).returning();

    const [text] = await db.insert(schema.documentTexts).values({
      documentId: doc.id,
      sha256: sha,
      text: "Hierbij bevestigen wij de opzegging van uw abonnement per 1 oktober.",
      extractor: "pdf-parse",
      charCount: 67,
    }).returning();

    expect(text.documentId).toBe(doc.id);
    expect(text.sha256).toBe(sha);
    expect(text.extractor).toBe("pdf-parse");
    // The truncation flag from the spec's error-handling section. Task 3's
    // storeDocumentText sets it to `text.length > CAP`; false is the default.
    expect(text.truncated).toBe(false);
    expect(text.charCount).toBe(67);
    expect(text.extractedAt).toBeInstanceOf(Date);
  });

  it("generates a Dutch tsvector that stems opzegging to opzeggen", async () => {
    const entityId = crypto.randomUUID();
    const [chunk] = await db.insert(schema.searchChunks).values({
      entityType: "document",
      entityId,
      chunkIndex: 0,
      title: "Opzegging abonnement Ziggo",
      body: "Hierbij bevestigen wij de opzegging van uw abonnement per 1 oktober.",
      occurredAt: new Date("2026-08-01T00:00:00Z"),
      sourceHash: "a".repeat(64),
    }).returning();

    expect(chunk.embedding).toBeNull();
    expect(chunk.embedAttempts).toBe(0);

    const rows = (await db.execute(sql`
      SELECT tsv::text AS tsv,
             tsv @@ websearch_to_tsquery('dutch', 'opzeggen') AS hit,
             tsv @@ websearch_to_tsquery('dutch', 'hypotheek') AS miss
      FROM search_chunks WHERE id = ${chunk.id}`)).rows as
      { tsv: string; hit: boolean; miss: boolean }[];
    // Title and body are concatenated by the generated column, so 'opzegg'
    // carries both positions: 1 (title) and 8 (body).
    expect(rows[0].tsv).toContain("'opzegg':1,8");
    expect(rows[0].hit).toBe(true);
    expect(rows[0].miss).toBe(false);
  });

  it("stores a denormalized status, nullable for entities that have none", async () => {
    const filedId = crypto.randomUUID();
    const [filed] = await db.insert(schema.searchChunks).values({
      entityType: "document", entityId: filedId, chunkIndex: 0,
      title: "Beschikking rechtbank", body: "Gearchiveerd stuk.",
      status: "filed", sourceHash: "1".repeat(64),
    }).returning();
    expect(filed.status).toBe("filed");

    const partyId = crypto.randomUUID();
    const [party] = await db.insert(schema.searchChunks).values({
      entityType: "party", entityId: partyId, chunkIndex: 0,
      title: "VerderGroep", body: "Bewindvoerder", sourceHash: "2".repeat(64),
    }).returning();
    // Parties, entries, emails, milestones and timeline events have no status.
    expect(party.status).toBeNull();

    const onlyFiled = await db.select({ id: schema.searchChunks.id })
      .from(schema.searchChunks)
      .where(sql`${schema.searchChunks.status} = 'filed'
                 AND ${schema.searchChunks.entityId} IN (${filedId}, ${partyId})`);
    expect(onlyFiled.map((r) => r.id)).toEqual([filed.id]);
  });

  it("round-trips a 768-dimension embedding and orders by cosine distance", async () => {
    const entityId = crypto.randomUUID();
    const near = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const far = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));

    const [a] = await db.insert(schema.searchChunks).values({
      entityType: "entry", entityId, chunkIndex: 0,
      title: "Vector near", body: "near", sourceHash: "b".repeat(64), embedding: near,
    }).returning();
    const [b] = await db.insert(schema.searchChunks).values({
      entityType: "entry", entityId, chunkIndex: 1,
      title: "Vector far", body: "far", sourceHash: "c".repeat(64), embedding: far,
    }).returning();

    expect(a.embedding).toHaveLength(768);
    expect(a.embedding?.[0]).toBe(1);

    const ranked = (await db.execute(sql`
      SELECT id::text AS id FROM search_chunks
      WHERE entity_id = ${entityId}
      ORDER BY embedding <=> ${JSON.stringify(near)}::vector
      LIMIT 2`)).rows as { id: string }[];
    expect(ranked.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("rejects a duplicate (entity_type, entity_id, chunk_index)", async () => {
    const entityId = crypto.randomUUID();
    await db.insert(schema.searchChunks).values({
      entityType: "task", entityId, chunkIndex: 0,
      title: "Eerste", body: "eerste", sourceHash: "d".repeat(64),
    });
    await expect(
      db.insert(schema.searchChunks).values({
        entityType: "task", entityId, chunkIndex: 0,
        title: "Tweede", body: "tweede", sourceHash: "e".repeat(64),
      }),
    ).rejects.toThrow(/search_chunk_uq/);
  });

  it("assigns monotonic bigserial ids on the outbox", async () => {
    const [first] = await db.insert(schema.searchOutbox)
      .values({ entityType: "document", entityId: crypto.randomUUID() }).returning();
    const [second] = await db.insert(schema.searchOutbox)
      .values({ entityType: "document", entityId: crypto.randomUUID() }).returning();
    expect(typeof first.id).toBe("number");
    expect(second.id).toBeGreaterThan(first.id);
    expect(first.enqueuedAt).toBeInstanceOf(Date);

    const drained = await db.delete(schema.searchOutbox)
      .where(eq(schema.searchOutbox.id, first.id)).returning();
    expect(drained).toHaveLength(1);
    await db.delete(schema.searchOutbox).where(eq(schema.searchOutbox.id, second.id));
  });

  it("keeps the newest chunk per entity findable by occurred_at ordering", async () => {
    const entityId = crypto.randomUUID();
    await db.insert(schema.searchChunks).values([
      { entityType: "email", entityId, chunkIndex: 0, title: "Oud", body: "oud",
        occurredAt: new Date("2026-01-01T00:00:00Z"), sourceHash: "f".repeat(64) },
      { entityType: "email", entityId, chunkIndex: 1, title: "Nieuw", body: "nieuw",
        occurredAt: new Date("2026-08-01T00:00:00Z"), sourceHash: "0".repeat(64) },
    ]);
    const rows = await db.select().from(schema.searchChunks)
      .where(eq(schema.searchChunks.entityId, entityId))
      .orderBy(desc(schema.searchChunks.occurredAt));
    expect(rows.map((r) => r.title)).toEqual(["Nieuw", "Oud"]);
  });
});
```

**Step 4 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test src/search-schema.test.ts
```

Expected: `Tests  7 failed (7)`. Vitest transpiles rather than typechecks, so `schema.documentTexts` / `schema.searchChunks` / `schema.searchOutbox` are simply `undefined` at runtime and every test dies on its first insert with:

```
TypeError: Cannot read properties of undefined (reading 'Symbol(drizzle:Columns)')
```

**Step 5 — hand-written extension migration (must be numbered before the generated one).**

```bash
cd /Users/martin/Workspace/mp/verder
env -u NODE_ENV pnpm --filter @verder/db exec drizzle-kit generate --custom --name=vector_extension
```

Expected output ends with:

```
Prepared empty file for your custom SQL migration!
[✓] Your SQL migration file ➜ drizzle/0014_vector_extension.sql 🚀
```

It also writes `drizzle/meta/0014_snapshot.json` and appends `{"idx": 14, "version": "7", "when": …, "tag": "0014_vector_extension", "breakpoints": true}` to `drizzle/meta/_journal.json`. Both are part of the commit.

Replace the whole contents of `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0014_vector_extension.sql` with:

```sql
-- pgvector. Must land BEFORE the table migration: search_chunks.embedding is
-- vector(768) and CREATE TABLE fails if the type does not exist yet.
-- drizzle-kit cannot express this (its extensionsFilters only knows postgis),
-- so it is hand-written, in the style of the DO $$ role blocks in 0001/0004.
-- Migrations run as the bootstrap superuser `verder`, which may CREATE
-- EXTENSION; verder_app and verder_worker need no grant, because types created
-- in schema public are usable by PUBLIC.
CREATE EXTENSION IF NOT EXISTS vector;
```

**Step 6 — add the schema.**

In `/Users/martin/Workspace/mp/verder/packages/db/src/schema.ts`, line 2 is currently:

```ts
import { bigint, boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
```

Replace it with — `bigserial`, `customType` and `vector` added, alphabetical order preserved:

```ts
import { bigint, bigserial, boolean, check, customType, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
```

Then insert the block below between the closing `});` of `timelineEvents` (line 276) and `export const workerRuns = pgTable("worker_runs", {` (line 278) — the same place the sub-project 3 and timeline sections were appended:

```ts
// --- searchable knowledge base (sub-project 4) ---
// DERIVED tables, deliberately NOT evidence. They hold no facts: only a
// rebuildable lookup FOR the facts that live in the evidence tables. They
// append no ledger_events and they allow UPDATE and DELETE, because the drain
// replaces chunks whose source text changed. `pnpm --filter worker reindex`
// recreates all of it from source records. A tampered index cannot corrupt the
// record — it can only fail to find it, and index health is shown on /verify.

// pg-core has no tsvector type; customType is the seam. The column IS part of
// this TypeScript schema — Postgres computes the value, drizzle knows it exists.
// drizzle-kit renders it as the quoted type name "tsvector", which resolves to
// pg_catalog.tsvector.
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() { return "tsvector"; },
});

// One row per vault document. OCR and PDF parsing are expensive, so they run
// once per sha256, ever — the content-addressed bytes are the cache key.
export const documentTexts = pgTable("document_texts", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  sha256: text("sha256").notNull(),
  text: text("text").notNull(),
  extractor: text("extractor").notNull(),
  // char_count is the length BEFORE the 1 MB cap; truncated says the cap bit.
  charCount: integer("char_count").notNull(),
  truncated: boolean("truncated").notNull().default(false),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const searchChunks = pgTable("search_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  // title and body are denormalized on purpose: results render without joins.
  title: text("title").notNull(),
  body: text("body").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  // Denormalized effective status, resolved once at index time from whichever
  // child table owns it (document_status_changes / task_status_changes /
  // registry_decisions). NULL for entities that have no status. Query-time
  // status filtering reads THIS column and never a per-type subquery. Plain
  // text, not an enum, so the vocabulary can grow without a migration. No index:
  // at most ~17 distinct values, too low-cardinality to beat the GIN/HNSW and
  // entity_type access paths — it is applied as a filter over their rows.
  status: text("status"),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('dutch', title || ' ' || body)`),
  // nomic-embed-text is 768-dimensional. NULL means the embedding failed and
  // the chunk is lexical-only until a later drain retries it.
  embedding: vector("embedding", { dimensions: 768 }),
  sourceHash: text("source_hash").notNull(),
  embedAttempts: integer("embed_attempts").notNull().default(0),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("search_chunk_uq").on(t.entityType, t.entityId, t.chunkIndex),
  index("search_chunks_tsv_idx").using("gin", t.tsv),
  index("search_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  index("search_chunks_entity_type_idx").on(t.entityType),
  index("search_chunks_occurred_idx").on(t.occurredAt),
]);

// Trigger outbox: source-table triggers write (entity_type, entity_id) here and
// the search.drain job dedupes, reindexes and deletes the drained rows. Rows
// arrive ONLY through the SECURITY DEFINER trigger function, so neither
// application role is granted INSERT on this table.
export const searchOutbox = pgTable("search_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("search_outbox_enqueued_idx").on(t.enqueuedAt)]);
```

Typecheck before generating:

```bash
env -u NODE_ENV pnpm --filter @verder/db typecheck
```

Expected: no output, exit 0.

**Step 7 — generate the table migration.**

```bash
env -u NODE_ENV pnpm --filter @verder/db exec drizzle-kit generate --name=knowledge_base
```

Expected tail:

```
[✓] Your SQL migration file ➜ drizzle/0015_knowledge_base.sql 🚀
```

Open `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0015_knowledge_base.sql` and confirm it is **exactly** this. If drizzle-kit orders or spells anything differently, hand-edit it to match — hand-editing a generated migration is established practice here (`0005_black_calypso.sql` and `0006_woozy_moonstone.sql` both carry hand-added statements below their generated ones):

```sql
CREATE TABLE "document_texts" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"text" text NOT NULL,
	"extractor" text NOT NULL,
	"char_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"status" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('dutch', title || ' ' || body)) STORED,
	"embedding" vector(768),
	"source_hash" text NOT NULL,
	"embed_attempts" integer DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_chunk_uq" ON "search_chunks" USING btree ("entity_type","entity_id","chunk_index");--> statement-breakpoint
CREATE INDEX "search_chunks_tsv_idx" ON "search_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_chunks_embedding_idx" ON "search_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "search_chunks_entity_type_idx" ON "search_chunks" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "search_chunks_occurred_idx" ON "search_chunks" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "search_outbox_enqueued_idx" ON "search_outbox" USING btree ("enqueued_at");
```

**Step 8 — apply both migrations to the dev database.**

```bash
env -u NODE_ENV pnpm --filter @verder/db migrate
docker exec verder-postgres-1 psql -U verder -d verder -Atc "select extname from pg_extension order by 1;" -c "\d search_chunks"
```

Expected: `pg_extension` lists `plpgsql` **and** `vector`; `\d search_chunks` shows `status | text |`, `tsv | tsvector | generated always as (to_tsvector('dutch'::regconfig, ((title || ' '::text) || body))) stored`, `embedding | vector(768)`, and the five indexes including `"search_chunks_embedding_idx" hnsw (embedding vector_cosine_ops)` and `"search_chunks_tsv_idx" gin (tsv)`.

**Step 9 — run the test, see it pass.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test src/search-schema.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

**Step 10 — full regression, then commit.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test
env -u NODE_ENV pnpm --filter @verder/api test
env -u NODE_ENV pnpm --filter @verder/db typecheck
```

Expected: all green. `packages/api` matters here because its tests share the same dev database and `packages/api/vitest.config.ts` sets `fileParallelism: false` — a broken migration surfaces there, not only in `packages/db`.

```bash
git add packages/db/src/schema.ts packages/db/src/search-schema.test.ts \
  packages/db/drizzle/0014_vector_extension.sql \
  packages/db/drizzle/0015_knowledge_base.sql \
  packages/db/drizzle/meta/_journal.json \
  packages/db/drizzle/meta/0014_snapshot.json \
  packages/db/drizzle/meta/0015_snapshot.json
git commit -m "feat(db): pgvector search index schema (document_texts, search_chunks, search_outbox)"
```

**Success criteria**

- `docker-compose.yml` and `docker-compose.prod.yml` both say `image: pgvector/pgvector:pg17`, changed in the same commit.
- The dev container came up on the new image against the **existing** `pgdata` volume with `ledger_events` intact.
- `select extname from pg_extension` includes `vector`.
- `\d search_chunks` shows the `status text` column and all five indexes.
- `env -u NODE_ENV pnpm --filter @verder/db test` and `env -u NODE_ENV pnpm --filter @verder/api test` are green.
- The drizzle journal has 16 entries, `0000` → `0015`.

---

### Task 2: grants for the derived tables

Grant the two application roles exactly the privileges they need on the three derived tables — and nothing more — while leaving every append-only evidence grant byte-identical, and prove both halves with tests.

This is the first `DELETE` grant to either role anywhere in this project, so the shape matters:

| Table | `verder_app` | `verder_worker` |
|---|---|---|
| `document_texts` | `SELECT` | `SELECT, INSERT, UPDATE, DELETE` |
| `search_chunks` | `SELECT` | `SELECT, INSERT, UPDATE, DELETE` |
| `search_outbox` | `SELECT` | `SELECT, DELETE` |

Three deliberate asymmetries, each of which a later task depends on:

1. **`verder_app` gets `SELECT` only, on all three.** The web app reads the index (Task 8's query pipeline, Task 13's health panel) and never writes it. Only the worker indexes.
2. **Neither role gets `INSERT` on `search_outbox`.** Rows arrive exclusively through the `SECURITY DEFINER` function `search_enqueue()` (Task 6), which is owned by `verder` and therefore inserts with the owner's privileges. Task 6's tests rely on this: an app-role INSERT into `search_outbox` must be denied, which is what proves the trigger — not the application — is the enqueue path.
3. **No grant on `search_outbox_id_seq`.** A sequence grant is only needed by a role that INSERTs. Since neither role does, granting it would widen the surface for nothing.

**Files**

- Create: `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0016_search_grants.sql` (hand-written, via `--custom`)
- Create (tool-generated, commit it): `/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/0016_snapshot.json`
- Modify (tool-generated): `/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/_journal.json`
- Test: `/Users/martin/Workspace/mp/verder/packages/db/src/search-grants.test.ts`

**Interfaces**

*Consumes*:

- `createDb(url: string): { db: Db; pool: pg.Pool }` and `type Db` from `/Users/martin/Workspace/mp/verder/packages/db/src/client.ts` (already in the repo)
- `schema.documentTexts`, `schema.searchChunks`, `schema.searchOutbox` — **produced by Task 1**, not by this task
- Evidence tables whose grants must stay frozen, all already in the repo: `schema.ledgerEvents`, `schema.logEntries`, `schema.documents`, `schema.parties`, `schema.registryDecisions`, `schema.taskStatusChanges`
- Role URLs, hardcoded exactly as every other grants-aware test in this repo does (`packages/db/src/task-schema.test.ts`, `timeline-schema.test.ts`):
  - `postgres://verder:verder@localhost:5432/verder` (owner — stands in for the `SECURITY DEFINER` trigger function until Task 6 creates it)
  - `postgres://verder_app:verder_app@localhost:5432/verder`
  - `postgres://verder_worker:verder_worker@localhost:5432/verder`

*Produces*: no TypeScript exports — a database privilege state, consumed by **Task 3** (worker writes `document_texts`), **Task 5** (`indexEntity` upserts and deletes `search_chunks`), **Task 6** (the trigger function is the only `search_outbox` writer), **Task 7** (the drain SELECTs and DELETEs outbox rows), **Task 8** (app-role SELECT on `search_chunks`) and **Task 13** (app-role SELECT on `search_outbox` for outbox depth).

---

#### Steps

**Step 1 — branch and write the failing grants test.**

```bash
cd /Users/martin/Workspace/mp/verder
git checkout -b sp4/task-2
```

Create `/Users/martin/Workspace/mp/verder/packages/db/src/search-grants.test.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// The derived index tables are the ONE place in this project where an
// application role may DELETE. This file pins the whole matrix: the worker owns
// the index, the app only reads it, nobody may INSERT into the outbox (the
// SECURITY DEFINER trigger function does that), and every evidence table is
// exactly as append-only as it was before this sub-project.
//
// The owner connection stands in for that trigger function, which does not
// exist yet (Task 6): it is the only thing allowed to put rows in the outbox.
const OWNER_URL = "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("knowledge-base index grants", () => {
  let owner: Db;
  let ownerPool: ReturnType<typeof createDb>["pool"];
  let app: Db;
  let appPool: ReturnType<typeof createDb>["pool"];
  let worker: Db;
  let workerPool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    ({ db: owner, pool: ownerPool } = createDb(OWNER_URL));
    ({ db: app, pool: appPool } = createDb(APP_URL));
    ({ db: worker, pool: workerPool } = createDb(WORKER_URL));
  });

  afterAll(async () => {
    await ownerPool.end();
    await appPool.end();
    await workerPool.end();
  });

  it("lets the worker role insert, update and DELETE a chunk", async () => {
    const entityId = crypto.randomUUID();
    const [chunk] = await worker.insert(schema.searchChunks).values({
      entityType: "document", entityId, chunkIndex: 0,
      title: "Opzegging abonnement Ziggo",
      body: "Hierbij bevestigen wij de opzegging van uw abonnement per 1 oktober.",
      status: "filed",
      sourceHash: "a".repeat(64),
    }).returning();

    const [reindexed] = await worker.update(schema.searchChunks)
      .set({ body: "Bijgewerkte tekst na herindexering.", sourceHash: "b".repeat(64) })
      .where(eq(schema.searchChunks.id, chunk.id)).returning();
    expect(reindexed.sourceHash).toBe("b".repeat(64));

    // Derived, not evidence: the drain must be able to drop stale chunks when a
    // re-render produces fewer of them than the previous run did.
    const deleted = await worker.delete(schema.searchChunks)
      .where(eq(schema.searchChunks.id, chunk.id)).returning();
    expect(deleted).toHaveLength(1);
  });

  it("lets the worker role re-extract a document text in place", async () => {
    const sha = `kbg${crypto.randomUUID().replace(/-/g, "")}`.padEnd(64, "0").slice(0, 64);
    const [doc] = await worker.insert(schema.documents).values({
      sha256: sha,
      title: "Gescande brief",
      mime: "application/pdf",
      sizeBytes: 4242,
      source: "nas-scan",
      receivedAt: new Date("2026-08-02T00:00:00Z"),
    }).returning();

    await worker.insert(schema.documentTexts).values({
      documentId: doc.id, sha256: sha, text: "", extractor: "none", charCount: 0,
    });
    const [rerun] = await worker.update(schema.documentTexts)
      .set({ text: "Beste heer Van der Poel, ...", extractor: "ocr-pdf", charCount: 28 })
      .where(eq(schema.documentTexts.documentId, doc.id)).returning();
    expect(rerun.extractor).toBe("ocr-pdf");

    const deleted = await worker.delete(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id)).returning();
    expect(deleted).toHaveLength(1);
  });

  it("lets the app role read the index but never write it", async () => {
    const entityId = crypto.randomUUID();
    const [chunk] = await worker.insert(schema.searchChunks).values({
      entityType: "milestone", entityId, chunkIndex: 0,
      title: "Toelating WSNP", body: "Zitting gepland.", sourceHash: "c".repeat(64),
    }).returning();

    const seen = await app.select({ title: schema.searchChunks.title })
      .from(schema.searchChunks).where(eq(schema.searchChunks.id, chunk.id));
    expect(seen.map((r) => r.title)).toEqual(["Toelating WSNP"]);

    // The web app searches the index; only the worker maintains it.
    await expect(
      app.insert(schema.searchChunks).values({
        entityType: "milestone", entityId, chunkIndex: 1,
        title: "Verboden", body: "verboden", sourceHash: "d".repeat(64),
      }),
    ).rejects.toThrow(/permission denied for table search_chunks/);
    await expect(
      app.update(schema.searchChunks).set({ title: "tampered" })
        .where(eq(schema.searchChunks.id, chunk.id)),
    ).rejects.toThrow(/permission denied for table search_chunks/);
    await expect(
      app.delete(schema.searchChunks).where(eq(schema.searchChunks.id, chunk.id)),
    ).rejects.toThrow(/permission denied for table search_chunks/);
    await expect(
      app.insert(schema.documentTexts).values({
        documentId: crypto.randomUUID(), sha256: "e".repeat(64),
        text: "verboden", extractor: "none", charCount: 8,
      }),
    ).rejects.toThrow(/permission denied for table document_texts/);

    await worker.delete(schema.searchChunks).where(eq(schema.searchChunks.id, chunk.id));
  });

  it("forbids BOTH roles from inserting into the outbox", async () => {
    // Rows may only arrive through the SECURITY DEFINER trigger function
    // search_enqueue() (Task 6). If either role could enqueue directly, the
    // outbox would stop being a faithful record of what actually changed.
    await expect(
      app.insert(schema.searchOutbox)
        .values({ entityType: "entry", entityId: crypto.randomUUID() }),
    ).rejects.toThrow(/permission denied for table search_outbox/);
    await expect(
      worker.insert(schema.searchOutbox)
        .values({ entityType: "entry", entityId: crypto.randomUUID() }),
    ).rejects.toThrow(/permission denied for table search_outbox/);
  });

  it("lets the worker role claim and delete outbox rows the owner enqueued", async () => {
    const entityId = crypto.randomUUID();
    const [queued] = await owner.insert(schema.searchOutbox)
      .values({ entityType: "entry", entityId }).returning();

    const claimed = await worker.select({ id: schema.searchOutbox.id })
      .from(schema.searchOutbox).where(eq(schema.searchOutbox.id, queued.id));
    expect(claimed).toHaveLength(1);

    const drained = await worker.delete(schema.searchOutbox)
      .where(eq(schema.searchOutbox.id, queued.id)).returning();
    expect(drained).toHaveLength(1);

    // The health panel on /verify reads outbox depth with the app role.
    const appSees = await app.select({ id: schema.searchOutbox.id })
      .from(schema.searchOutbox).where(eq(schema.searchOutbox.id, queued.id));
    expect(appSees).toHaveLength(0);
  });

  it("appends no ledger_events when the index is written", async () => {
    const entityId = crypto.randomUUID();
    const [chunk] = await worker.insert(schema.searchChunks).values({
      entityType: "party", entityId, chunkIndex: 0,
      title: "VerderGroep", body: "Bewindvoerder", sourceHash: "f".repeat(64),
    }).returning();
    await worker.update(schema.searchChunks).set({ embedAttempts: 1 })
      .where(eq(schema.searchChunks.id, chunk.id));
    await worker.delete(schema.searchChunks).where(eq(schema.searchChunks.id, chunk.id));

    const [queued] = await owner.insert(schema.searchOutbox)
      .values({ entityType: "party", entityId }).returning();
    await worker.delete(schema.searchOutbox).where(eq(schema.searchOutbox.id, queued.id));

    // The index is derived: rebuildable, therefore not chained. Scoped by the
    // fresh entity id and by entity_type so the assertion is exact even when
    // packages/api's suite is appending real ledger events concurrently.
    const forThisEntity = await app.select({ seq: schema.ledgerEvents.seq })
      .from(schema.ledgerEvents).where(eq(schema.ledgerEvents.entityId, entityId));
    expect(forThisEntity).toHaveLength(0);

    const forDerivedTables = await app.select({ seq: schema.ledgerEvents.seq })
      .from(schema.ledgerEvents)
      .where(inArray(schema.ledgerEvents.entityType,
        ["search_chunk", "search_chunks", "document_text", "document_texts", "search_outbox"]));
    expect(forDerivedTables).toHaveLength(0);
  });

  it("leaves every evidence grant exactly as it was (app role)", async () => {
    await expect(
      app.update(schema.ledgerEvents).set({ eventType: "hacked" }),
    ).rejects.toThrow(/permission denied/);
    await expect(app.delete(schema.ledgerEvents)).rejects.toThrow(/permission denied/);
    await expect(app.delete(schema.logEntries)).rejects.toThrow(/permission denied/);
    await expect(
      app.update(schema.logEntries).set({ summary: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(app.delete(schema.documents)).rejects.toThrow(/permission denied/);
    await expect(
      app.update(schema.documents).set({ title: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.update(schema.registryDecisions).set({ explanation: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.update(schema.taskStatusChanges).set({ note: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(app.delete(schema.parties)).rejects.toThrow(/permission denied/);
  });

  it("leaves every evidence grant exactly as it was (worker role)", async () => {
    await expect(
      worker.update(schema.ledgerEvents).set({ eventType: "hacked" }),
    ).rejects.toThrow(/permission denied/);
    await expect(worker.delete(schema.ledgerEvents)).rejects.toThrow(/permission denied/);
    await expect(worker.delete(schema.logEntries)).rejects.toThrow(/permission denied/);
    await expect(
      worker.update(schema.documents).set({ title: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      worker.update(schema.taskStatusChanges).set({ note: "tampered" }),
    ).rejects.toThrow(/permission denied/);
    await expect(worker.delete(schema.parties)).rejects.toThrow(/permission denied/);
  });
});
```

**Step 2 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test src/search-grants.test.ts
```

Expected: `Tests  5 failed | 3 passed (8)`, with the first failure reading:

```
error: permission denied for table search_chunks
```

Exactly which are which, and why that is the correct red state:

- **Fail** — "lets the worker role insert, update and DELETE a chunk" (`permission denied for table search_chunks`).
- **Fail** — "lets the worker role re-extract a document text in place" (`permission denied for table document_texts`; the `documents` insert before it succeeds, because the worker already has evidence INSERT from `0004_worker_role.sql`).
- **Fail** — "lets the app role read the index but never write it": the worker-role setup insert is denied.
- **Pass already** — "forbids BOTH roles from inserting into the outbox". A guard test that is green before *and* after the migration is the point: it is what will catch a future migration quietly handing out INSERT.
- **Fail** — "lets the worker role claim and delete outbox rows the owner enqueued" (`permission denied for table search_outbox` on the worker's SELECT; the owner's insert succeeds).
- **Fail** — "appends no ledger_events when the index is written" (`permission denied for table search_chunks`).
- **Pass already** — both "leaves every evidence grant exactly as it was" tests. Same reasoning as the outbox guard: they must be green now, and still green after.

**Step 3 — create the grants migration file.**

```bash
env -u NODE_ENV pnpm --filter @verder/db exec drizzle-kit generate --custom --name=search_grants
```

Expected tail:

```
Prepared empty file for your custom SQL migration!
[✓] Your SQL migration file ➜ drizzle/0016_search_grants.sql 🚀
```

It also writes `drizzle/meta/0016_snapshot.json` and appends `{"idx": 16, …, "tag": "0016_search_grants", …}` to `drizzle/meta/_journal.json`.

**Step 4 — write the SQL.**

Replace the whole contents of `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0016_search_grants.sql` with:

```sql
-- Searchable knowledge base grants (both app and worker roles).
--
-- READ THIS BEFORE CONCLUDING THE APPEND-ONLY LAW WAS WEAKENED.
-- document_texts, search_chunks and search_outbox are DERIVED tables, NOT
-- evidence. They hold no facts: only a rebuildable lookup FOR the facts that
-- live in the evidence tables. `pnpm --filter worker reindex` recreates every
-- row of all three from the source records, and they append no ledger_events.
--
-- They are therefore the first tables in this project to grant DELETE to an
-- application role, and that is deliberate: the drain replaces chunks whose
-- source text changed, drops chunks a shorter re-render no longer produces, and
-- clears outbox rows it has processed. An index that cannot forget is an index
-- that goes stale and lies. A tampered index cannot corrupt the record — it can
-- only fail to find it — and index health (chunk count, outbox depth, embedding
-- failures, last drain) is surfaced on /verify so that failure is visible.
--
-- Every append-only grant on every evidence table is untouched by this file.

-- The web app SEARCHES the index and never maintains it: SELECT only, on all
-- three tables. (search_outbox too — /verify reports outbox depth.)
GRANT SELECT ON "document_texts", "search_chunks", "search_outbox" TO verder_app;
--> statement-breakpoint
-- The worker OWNS the index: extraction writes document_texts, the drain
-- upserts and prunes search_chunks.
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_texts", "search_chunks" TO verder_worker;
--> statement-breakpoint
-- The worker CLAIMS from the outbox and deletes what it has processed — but it
-- may not enqueue. Nothing may: rows arrive only through the SECURITY DEFINER
-- function search_enqueue(), owned by `verder`, which the AFTER INSERT OR UPDATE
-- triggers call. That is why there is no INSERT here for either role, and why
-- search_outbox_id_seq needs no USAGE grant either — the only inserter is the
-- owner, who already has it.
GRANT SELECT, DELETE ON "search_outbox" TO verder_worker;
```

**Step 5 — apply, then verify the privilege state directly.**

```bash
env -u NODE_ENV pnpm --filter @verder/db migrate
docker exec verder-postgres-1 psql -U verder -d verder \
  -c "\dp document_texts" -c "\dp search_chunks" -c "\dp search_outbox"
```

Expected — the `Access privileges` column, verbatim:

- `document_texts`: `verder=arwdDxtm/verder`, `verder_app=r/verder`, `verder_worker=arwd/verder`
- `search_chunks`: `verder=arwdDxtm/verder`, `verder_app=r/verder`, `verder_worker=arwd/verder`
- `search_outbox`: `verder=arwdDxtm/verder`, `verder_app=r/verder`, `verder_worker=rd/verder`

(`a`=INSERT, `r`=SELECT, `w`=UPDATE, `d`=DELETE. The absence of `a` on the `search_outbox` rows is the load-bearing part: it is what Task 6's trigger tests prove is closed.)

Then confirm nothing leaked into the evidence tables:

```bash
docker exec verder-postgres-1 psql -U verder -d verder -Atc "
  SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee IN ('verder_app','verder_worker')
    AND table_name IN ('ledger_events','log_entries','documents','parties',
                       'registry_decisions','task_status_changes')
  GROUP BY 1,2 ORDER BY 1,2;"
```

Expected: exactly these twelve rows, unchanged from before the migration — no `UPDATE`, no `DELETE`:

```
documents|verder_app|INSERT,SELECT
documents|verder_worker|INSERT,SELECT
ledger_events|verder_app|INSERT,SELECT
ledger_events|verder_worker|INSERT,SELECT
log_entries|verder_app|INSERT,SELECT
log_entries|verder_worker|INSERT,SELECT
parties|verder_app|INSERT,SELECT
parties|verder_worker|INSERT,SELECT
registry_decisions|verder_app|INSERT,SELECT
registry_decisions|verder_worker|INSERT,SELECT
task_status_changes|verder_app|INSERT,SELECT
task_status_changes|verder_worker|INSERT,SELECT
```

**Step 6 — run the test, see it pass.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test src/search-grants.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  8 passed (8)`.

**Step 7 — full regression, then commit.**

```bash
env -u NODE_ENV pnpm --filter @verder/db test
env -u NODE_ENV pnpm --filter @verder/api test
env -u NODE_ENV pnpm -r --if-present test
```

Expected: all green. `packages/api` matters most here: it contains `src/ledger.test.ts` ("app role cannot UPDATE or DELETE evidence rows") and `src/routers/verify.test.ts` (whole-chain verification). Those staying green is the independent confirmation that the new `DELETE` grant did not reach the ledger.

```bash
git add packages/db/src/search-grants.test.ts \
  packages/db/drizzle/0016_search_grants.sql \
  packages/db/drizzle/meta/_journal.json \
  packages/db/drizzle/meta/0016_snapshot.json
git commit -m "feat(db): grants for the derived search index (first DELETE, deliberately)"
```

**Success criteria**

- `\dp` reports `verder_app=r/verder` + `verder_worker=arwd/verder` on `document_texts` and `search_chunks`, and `verder_app=r/verder` + `verder_worker=rd/verder` on `search_outbox`.
- Neither role has `INSERT` on `search_outbox`, and `search_outbox_id_seq` carries no grant for either role.
- `information_schema.role_table_grants` still shows `INSERT,SELECT` — unchanged — on `ledger_events`, `log_entries`, `documents`, `parties`, `registry_decisions`, `task_status_changes`.
- The "appends no ledger_events when the index is written" test passes: a full insert/update/delete cycle across `search_chunks` and `search_outbox` produces zero `ledger_events` rows for the entity id involved and zero for any derived-table entity type.
- `0016_search_grants.sql` carries the comment block explaining that these three tables are derived, not evidence.
- `env -u NODE_ENV pnpm -r --if-present test` is green across the workspace.
- The drizzle journal has 17 entries, `0000` → `0016`.

### Task 3: persisted text extraction, including scanned PDFs

**Files**

- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/fixtures/make-fixtures.sh` (fixture generator, committed)
- Create (generated by that script, committed as binaries): `/Users/martin/Workspace/mp/verder/apps/worker/src/fixtures/text-letter.pdf`, `/Users/martin/Workspace/mp/verder/apps/worker/src/fixtures/scan-letter.png`, `/Users/martin/Workspace/mp/verder/apps/worker/src/fixtures/scanned-letter.pdf`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/document-text.ts`
- Test: `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.test.ts` (no DB)
- Test: `/Users/martin/Workspace/mp/verder/apps/worker/src/document-text.test.ts` (live dev postgres, `verder_worker` role)
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/src/index.ts` (delete the private `extractText`, wire `storeDocumentText` into the `suggest.docmeta` handler)
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/Dockerfile` (add `poppler-utils`)
- Modify: `/Users/martin/Workspace/mp/verder/CLAUDE.md` (dev prerequisite line)

**Interfaces**

Consumes — already in the repo, exact names:
- `import { recordRun } from "./heartbeat";` — `recordRun(db: Db, worker: string, status: "ok" | "error", detail?: unknown): Promise<void>` (`apps/worker/src/heartbeat.ts`).
- `import { schema, type Db } from "@verder/db";`
- `import { createDb } from "@verder/db";` — `createDb(url: string): { db: Db; pool: Pool }`.
- `import { sha256Hex } from "@verder/core";`
- `import { ingestDocument } from "@verder/api/src/routers/documents";` — `ingestDocument(tx: Db, input: { sha256: string; sizeBytes: number; mime: string; title: string; source: "upload" | "nas-scan" | "email-attachment"; sourceRef?: string; receivedAt: Date; docType?: string })`. Used by the DB test to create a document plus its ledger event, exactly as `apps/worker/src/nas.ts` does.
- `import { readFilePath } from "@verder/api/src/storage";` — `readFilePath(vaultDir: string, sha256: string): string`.
- `import { suggestDocMeta } from "./ollama";` — dep object `{ db, llm, extractText: (mime: string, buf: Buffer) => Promise<string>, sendPush }`. **This signature is not changed by this task**; the handler feeds it the already-persisted text.

Consumes from **Task 1** (pgvector infrastructure + derived-index schema) — `schema.documentTexts`, table `document_texts`:

| TS property | column | type |
|---|---|---|
| `documentId` | `document_id` | uuid, primary key, → `documents.id` |
| `sha256` | `sha256` | text not null |
| `text` | `text` | text not null |
| `extractor` | `extractor` | text not null |
| `charCount` | `char_count` | integer not null |
| `truncated` | `truncated` | boolean not null default false |
| `extractedAt` | `extracted_at` | timestamptz not null default now() |

Consumes from **Task 2** (grants for the derived tables): `GRANT SELECT, INSERT, UPDATE, DELETE ON "document_texts" TO verder_worker;` — without it every write in this task fails with `ERROR: permission denied for table document_texts`.

Produces (`apps/worker/src/extract.ts`):
```ts
export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "none";
export interface ExtractedText { text: string; charCount: number; extractor: Extractor; truncated: boolean; error?: string }
export const MAX_TEXT_CHARS = 1_000_000;
export const MIN_PDF_TEXT_CHARS = 200;
export const RASTER_DPI = 200;
export const MAX_OCR_PAGES = 20;
export interface OcrPort { ocrImage(png: Buffer): Promise<string> }
export function realOcrPort(): OcrPort;
export function rasterizePdf(pdf: Buffer, opts?: { dpi?: number; maxPages?: number }): Promise<Buffer[]>;
export function extractDocumentText(mime: string, buf: Buffer,
  deps?: { ocr?: OcrPort; rasterize?: typeof rasterizePdf }): Promise<ExtractedText>;
```
Produces (`apps/worker/src/document-text.ts`):
```ts
export interface StoredText { text: string; extractor: Extractor; reused: boolean }
export function storeDocumentText(
  deps: { db: Db; extract?: typeof extractDocumentText },
  doc: { id: string; sha256: string; mime: string },
  fileBuf: Buffer,
): Promise<StoredText>;
```

`char_count` stores the code-point count **before** the 1 MB cap and `truncated` is a real boolean column that `storeDocumentText` always writes (`out.truncated`), so a truncated extraction is visible in the table itself and not only in `worker_runs.detail`.

New `worker_runs.worker` value introduced by this task: `"extract"`.

Produced for **Task 5** (the entity loader): `loadAndRender` reads `document_texts.text` for `entityType === "document"`. Nothing else in this plan writes that table.

---

**Steps**

1. **Fixture generator.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/fixtures/make-fixtures.sh` with exactly this content. The chain is: stdlib python writes a hand-built, uncompressed, ASCII PDF (readable by poppler); `pdftocairo` rewrites it into a PDF that `pdf-parse`'s bundled pdf.js accepts (the hand-built file alone fails with `bad XRef entry`); `pdftoppm` rasterizes it into the image fixture; ImageMagick wraps that PNG into an image-only PDF — the scanned-PDF fixture.

```bash
#!/usr/bin/env bash
# Regenerates the three extraction fixtures. Requires poppler-utils and
# ImageMagick 7 on the dev machine: brew install poppler imagemagick
#   bash apps/worker/src/fixtures/make-fixtures.sh
# The generated files are committed; this script exists so they are
# reproducible rather than mysterious binaries.
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PY'
lines = [
  "Beste heer Van der Poel,",
  "Hierbij bevestigen wij de opzegging van uw abonnement bij Ziggo.",
  "Uw dossiernummer is 2026-VG-00412. De beeindiging gaat in per 1 oktober 2026.",
  "Wij verzoeken u een kopie van uw paspoort op te sturen voor uw dossier.",
  "Met vriendelijke groet, VerderGroep Bewindvoering",
]
content = "BT\n/F1 14 Tf\n72 760 Td\n18 TL\n" + "".join(f"({l}) Tj\nT*\n" for l in lines) + "ET\n"
objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out, offs = "%PDF-1.4\n", []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += f"{i} 0 obj\n{o}\nendobj\n"
x = len(out)
out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
open("raw-letter.pdf", "w", newline="\n").write(out)
PY

pdftocairo -pdf raw-letter.pdf text-letter.pdf
pdftoppm -png -r 100 -f 1 -l 1 text-letter.pdf scan && mv scan-1.png scan-letter.png
magick scan-letter.png scanned-letter.pdf
rm raw-letter.pdf
echo "fixtures: $(ls -1 text-letter.pdf scan-letter.png scanned-letter.pdf)"
```

2. **Generate the fixtures and check the load-bearing numbers.**
```bash
cd /Users/martin/Workspace/mp/verder && bash apps/worker/src/fixtures/make-fixtures.sh && ls -l apps/worker/src/fixtures
```
Expect three files, roughly `text-letter.pdf` 12,594 B, `scan-letter.png` 39,356 B, `scanned-letter.pdf` 17,181 B (measured with poppler 26.02.0; byte sizes shift with the poppler/ImageMagick version and with the embedded creation date — the committed files are authoritative). Now check what `pdf-parse` actually sees, which is the entire reason the scanned branch exists:
```bash
cd /Users/martin/Workspace/mp/verder/apps/worker && node --input-type=module -e "
import { readFile } from 'node:fs/promises';
const pdfParse = (await import('pdf-parse')).default;
for (const f of ['text-letter.pdf','scanned-letter.pdf'])
  console.log(f, (await pdfParse(await readFile('src/fixtures/'+f))).text.length);
"
```
Expected output exactly:
```
text-letter.pdf 291
scanned-letter.pdf 2
```

3. **Commit the fixtures.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/fixtures && git commit -m "test(worker): reproducible text, image and scanned-PDF fixtures"
```

4. **Failing test for the text-PDF path.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.test.ts`:
```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "./extract";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

describe("extractDocumentText", () => {
  it("reads a text PDF with pdf-parse", async () => {
    const out = await extractDocumentText("application/pdf", await fixture("text-letter.pdf"));
    expect(out.extractor).toBe("pdf-parse");
    expect(out.text).toContain("dossiernummer");
    expect(out.truncated).toBe(false);
    expect(out.charCount).toBe(Array.from(out.text).length);
  });

  it("returns extractor none for a mime it cannot read", async () => {
    const out = await extractDocumentText("application/octet-stream", Buffer.from("blob"));
    expect(out).toEqual({ text: "", charCount: 0, extractor: "none", truncated: false });
  });
});
```

5. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected failure: `Error: Failed to resolve import "./extract" from "src/extract.test.ts". Does the file exist?`

6. **Minimal implementation: the pdf-parse branch only.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.ts`:
```ts
export type Extractor = "pdf-parse" | "ocr-image" | "ocr-pdf" | "none";

export interface ExtractedText {
  text: string;
  /** Code points extracted BEFORE the cap: charCount > text length means truncated. */
  charCount: number;
  extractor: Extractor;
  truncated: boolean;
  error?: string;
}

// Counted in code points, not UTF-16 units, so a Dutch letter full of accents
// is never measured or cut mid-code-point.
function measure(raw: string): { text: string; charCount: number; truncated: boolean } {
  return { text: raw, charCount: Array.from(raw).length, truncated: false };
}

export async function extractDocumentText(mime: string, buf: Buffer): Promise<ExtractedText> {
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return { ...measure((await pdfParse(buf)).text), extractor: "pdf-parse" };
  }
  return { text: "", charCount: 0, extractor: "none", truncated: false };
}
```

7. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Test Files  1 passed (1)` / `Tests  2 passed (2)`.

8. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/extract.ts apps/worker/src/extract.test.ts && git commit -m "feat(worker): extraction module with the pdf-parse path"
```

9. **Failing tests for the image path.** In `extract.test.ts` change the import line to
```ts
import { extractDocumentText, type OcrPort } from "./extract";
```
add this helper directly under the `fixture` const:
```ts
// OCR is never run for real in this suite: tesseract.js downloads ~15 MB of
// nld+eng training data on first use. The port is injected instead, and the one
// real-OCR test at the bottom of this file is opt-in.
const stubOcr = (out: string, seen: Buffer[] = []): OcrPort =>
  ({ ocrImage: async (png) => { seen.push(png); return out; } });
```
and append these two tests inside the `describe` block:
```ts
  it("OCRs an image", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"),
      { ocr: stubOcr("Beste heer Van der Poel", seen) });
    expect(out.extractor).toBe("ocr-image");
    expect(out.text).toBe("Beste heer Van der Poel");
    expect(seen).toHaveLength(1);
    expect(seen[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  });

  it("never OCRs a PDF that has a real text layer", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("application/pdf", await fixture("text-letter.pdf"),
      { ocr: stubOcr("SHOULD NOT RUN", seen) });
    expect(out.extractor).toBe("pdf-parse");
    expect(seen).toHaveLength(0);
  });
```

10. **Run, see the image test fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Tests  1 failed | 3 passed (4)` with `AssertionError: expected 'none' to be 'ocr-image' // Object.is equality`. (`pnpm --filter worker typecheck` is also red at this point — `extractDocumentText` still takes two parameters — and goes green in the next step; do not run it here.)

11. **Implement the OCR port and the image branch.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.ts`, insert above `function measure(` :
```ts
export interface OcrPort { ocrImage(png: Buffer): Promise<string> }

export function realOcrPort(): OcrPort {
  return {
    async ocrImage(png) {
      const { recognize } = await import("tesseract.js");
      return (await recognize(png, "nld+eng")).data.text;
    },
  };
}
```
and replace the whole `extractDocumentText` function with:
```ts
export async function extractDocumentText(
  mime: string, buf: Buffer,
  deps: { ocr?: OcrPort } = {},
): Promise<ExtractedText> {
  const ocr = deps.ocr ?? realOcrPort();
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return { ...measure((await pdfParse(buf)).text), extractor: "pdf-parse" };
  }
  if (mime.startsWith("image/")) {
    return { ...measure((await ocr.ocrImage(buf)).trim()), extractor: "ocr-image" };
  }
  return { text: "", charCount: 0, extractor: "none", truncated: false };
}
```

12. **Run, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Tests  4 passed (4)`.

13. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/extract.ts apps/worker/src/extract.test.ts && git commit -m "feat(worker): OCR port and the image extraction path"
```

14. **Failing tests for the scanned-PDF path.** In `extract.test.ts` change the import line to
```ts
import { extractDocumentText, rasterizePdf, type OcrPort } from "./extract";
```
and append inside the `describe` block:
```ts
  it("rasterizes and OCRs a scanned PDF whose text layer is empty", async () => {
    const seen: Buffer[] = [];
    const out = await extractDocumentText("application/pdf", await fixture("scanned-letter.pdf"),
      { ocr: stubOcr("Uw dossiernummer is 2026-VG-00412", seen) });
    expect(out.extractor).toBe("ocr-pdf");
    expect(out.text).toBe("Uw dossiernummer is 2026-VG-00412");
    expect(seen).toHaveLength(1); // one page in, one page rasterized
    expect(seen[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("rasterizes with real poppler", async () => {
    const pages = await rasterizePdf(await fixture("scanned-letter.pdf"), { dpi: 100 });
    expect(pages).toHaveLength(1);
    expect(pages[0].subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
```

15. **Run, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected failure — the whole file fails to load because the export does not exist: `SyntaxError: [vite] The requested module './extract' does not provide an export named 'rasterizePdf'`, reported as `Test Files  1 failed (1)`.

16. **Implement rasterization and the scanned-PDF branch.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.ts`, add at the very top of the file:
```ts
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
```
add these constants directly under the `ExtractedText` interface:
```ts
// A PDF that parses to less than this is a scan in a PDF wrapper: the NAS
// scanner produces image-only PDFs and pdf-parse returns a couple of newlines.
export const MIN_PDF_TEXT_CHARS = 200;
export const RASTER_DPI = 200;
export const MAX_OCR_PAGES = 20;
```
add this function directly above `function measure(`:
```ts
/** Rasterizes the first MAX_OCR_PAGES pages to PNG with poppler's pdftoppm. */
export async function rasterizePdf(
  pdf: Buffer, opts: { dpi?: number; maxPages?: number } = {},
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "verder-raster-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf);
    await run("pdftoppm", ["-png", "-r", String(opts.dpi ?? RASTER_DPI),
      "-f", "1", "-l", String(opts.maxPages ?? MAX_OCR_PAGES), input, join(dir, "page")],
      { timeout: 120_000 });
    // pdftoppm zero-pads page numbers from ten pages on (page-01.png), so the
    // file list is read back and sorted, never constructed by hand.
    const names = (await readdir(dir)).filter((n) => n.endsWith(".png")).sort();
    return await Promise.all(names.map((n) => readFile(join(dir, n))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```
and replace the whole `extractDocumentText` function with:
```ts
export async function extractDocumentText(
  mime: string, buf: Buffer,
  deps: { ocr?: OcrPort; rasterize?: typeof rasterizePdf } = {},
): Promise<ExtractedText> {
  const ocr = deps.ocr ?? realOcrPort();
  const rasterize = deps.rasterize ?? rasterizePdf;
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = (await pdfParse(buf)).text;
    if (Array.from(parsed).length >= MIN_PDF_TEXT_CHARS) {
      return { ...measure(parsed), extractor: "pdf-parse" };
    }
    const pages = await rasterize(buf);
    const texts: string[] = [];
    for (const page of pages) texts.push(await ocr.ocrImage(page));
    return { ...measure(texts.join("\n\n").trim()), extractor: "ocr-pdf" };
  }
  if (mime.startsWith("image/")) {
    return { ...measure((await ocr.ocrImage(buf)).trim()), extractor: "ocr-image" };
  }
  return { text: "", charCount: 0, extractor: "none", truncated: false };
}
```

17. **Run, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Tests  6 passed (6)`.

18. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/extract.ts apps/worker/src/extract.test.ts && git commit -m "feat(worker): rasterize scanned PDFs with poppler before OCR"
```

19. **Failing tests for the 1 MB cap and the never-throws guarantee.** Append inside the `describe` block of `extract.test.ts`:
```ts
  it("caps oversized text at 1 MB and flags the truncation", async () => {
    const huge = "é".repeat(1_000_050);
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"),
      { ocr: stubOcr(huge) });
    expect(Array.from(out.text)).toHaveLength(1_000_000);
    expect(out.charCount).toBe(1_000_050); // the length BEFORE the cap
    expect(out.truncated).toBe(true);
  });

  it("never throws: a rasterizer failure comes back as extractor none with the error", async () => {
    const out = await extractDocumentText("application/pdf", await fixture("scanned-letter.pdf"), {
      ocr: stubOcr("SHOULD NOT RUN"),
      rasterize: async () => { throw new Error("pdftoppm ENOENT"); },
    });
    expect(out.extractor).toBe("none");
    expect(out.text).toBe("");
    expect(out.error).toContain("pdftoppm ENOENT");
  });

  // Opt-in: downloads nld+eng training data on first run. Run once by hand with
  //   OCR_TESTS=1 env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
  it.runIf(process.env.OCR_TESTS === "1")("really OCRs the scan fixture", async () => {
    const out = await extractDocumentText("image/png", await fixture("scan-letter.png"));
    expect(out.extractor).toBe("ocr-image");
    expect(out.text).toContain("Ziggo");
  }, 180_000);
```

20. **Run, see both new tests fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Tests  2 failed | 6 passed | 1 skipped (9)` — the cap test fails with `AssertionError: expected [ 'é', 'é', 'é', …(1000047 more) ] to have a length of 1000000 but got 1000050`, and the failure test fails with the raw `Error: pdftoppm ENOENT` escaping `extractDocumentText`.

21. **Implement the cap and the catch-all.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/extract.ts`, add this constant directly under `export const MAX_OCR_PAGES = 20;`:
```ts
// The cap is on characters (code points), not bytes, so a Dutch letter full of
// accents is never cut mid-code-point.
export const MAX_TEXT_CHARS = 1_000_000;
```
replace the whole `measure` function with:
```ts
function cap(raw: string): { text: string; charCount: number; truncated: boolean } {
  const cps = Array.from(raw);
  if (cps.length <= MAX_TEXT_CHARS) return { text: raw, charCount: cps.length, truncated: false };
  return { text: cps.slice(0, MAX_TEXT_CHARS).join(""), charCount: cps.length, truncated: true };
}
```
and replace the whole `extractDocumentText` function with this final version:
```ts
export async function extractDocumentText(
  mime: string, buf: Buffer,
  deps: { ocr?: OcrPort; rasterize?: typeof rasterizePdf } = {},
): Promise<ExtractedText> {
  const ocr = deps.ocr ?? realOcrPort();
  const rasterize = deps.rasterize ?? rasterizePdf;
  try {
    if (mime === "application/pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = (await pdfParse(buf)).text;
      if (Array.from(parsed).length >= MIN_PDF_TEXT_CHARS) {
        return { ...cap(parsed), extractor: "pdf-parse" };
      }
      const pages = await rasterize(buf);
      const texts: string[] = [];
      for (const page of pages) texts.push(await ocr.ocrImage(page));
      return { ...cap(texts.join("\n\n").trim()), extractor: "ocr-pdf" };
    }
    if (mime.startsWith("image/")) {
      return { ...cap((await ocr.ocrImage(buf)).trim()), extractor: "ocr-image" };
    }
    return { text: "", charCount: 0, extractor: "none", truncated: false };
  } catch (err) {
    // Never throws: a document that cannot be read stays findable by its title
    // and metadata, and the caller records the reason in worker_runs.
    return { text: "", charCount: 0, extractor: "none", truncated: false, error: String(err) };
  }
}
```

22. **Run, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/extract.test.ts
```
Expected: `Tests  8 passed | 1 skipped (9)` — the skipped one is the opt-in real-OCR test.

23. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/extract.ts apps/worker/src/extract.test.ts && git commit -m "feat(worker): 1 MB cap and never-throwing extraction failures"
```

24. **Failing tests for persistence.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/document-text.test.ts`:
```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeDocumentText } from "./document-text";

// NOT named URL: the fixture helper below constructs a real URL, and a const
// named URL would shadow the global and blow up with "URL is not a constructor".
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

async function insertDoc(db: Db, buf: Buffer) {
  // Unique bytes per run: the vault is content-addressed and documents.sha256
  // is unique, so a fixed fixture would collide with the previous run.
  const unique = Buffer.concat([buf, Buffer.from(`\n% ${crypto.randomUUID()}\n`)]);
  return { doc: await db.transaction((tx) => ingestDocument(tx, {
    sha256: sha256Hex(unique), sizeBytes: unique.length, mime: "application/pdf",
    title: `brief-${Date.now()}.pdf`, source: "nas-scan", receivedAt: new Date() })), unique };
}

describe("storeDocumentText", () => {
  it("extracts once and never re-extracts the same sha256", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));

    const first = await storeDocumentText({ db }, doc, unique);
    expect(first.reused).toBe(false);
    expect(first.extractor).toBe("pdf-parse");
    expect(first.text).toContain("dossiernummer");

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.sha256).toBe(doc.sha256);
    expect(row.extractor).toBe("pdf-parse");
    expect(row.charCount).toBe(Array.from(row.text).length);
    expect(row.truncated).toBe(false);

    let calls = 0;
    const second = await storeDocumentText(
      { db, extract: async () => { calls++; return { text: "", charCount: 0, extractor: "none" as const, truncated: false }; } },
      doc, unique);
    expect(calls).toBe(0);
    expect(second.reused).toBe(true);
    expect(second.text).toContain("dossiernummer");
    await pool.end();
  });

  it("re-extracts when the stored sha256 no longer matches the document", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));
    await db.insert(schema.documentTexts).values({ documentId: doc.id,
      sha256: "stale".padEnd(64, "0"), text: "verouderd", extractor: "none", charCount: 9 });

    const out = await storeDocumentText({ db }, doc, unique);
    expect(out.reused).toBe(false);
    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.sha256).toBe(doc.sha256);
    expect(row.text).toContain("dossiernummer");
    await pool.end();
  });

  it("stores the pre-cap char_count and the truncated flag", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));
    await storeDocumentText({ db, extract: async () => ({
      text: "é".repeat(1_000_000), charCount: 1_000_050,
      extractor: "ocr-pdf" as const, truncated: true }) }, doc, unique);

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.truncated).toBe(true);
    expect(row.charCount).toBe(1_000_050);
    expect(Array.from(row.text)).toHaveLength(1_000_000);
    await pool.end();
  });

  it("records an extraction failure in worker_runs and still stores a row", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("scanned-letter.pdf"));
    await storeDocumentText({ db, extract: async () => ({
      text: "", charCount: 0, extractor: "none" as const, truncated: false,
      error: "Error: pdftoppm ENOENT" }) }, doc, unique);

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.extractor).toBe("none");

    // Scoped by the unique documentId in detail, not by time: ran_at is the DB
    // clock while new Date() is the host clock.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "extract"));
    expect(runs.some((r) => r.status === "error"
      && (r.detail as Record<string, unknown> | null)?.documentId === doc.id)).toBe(true);
    await pool.end();
  });
});
```

25. **Run it, see it fail.** Postgres must be up and migrated through Tasks 1–2: `docker compose up -d postgres && env -u NODE_ENV pnpm --filter @verder/db migrate`.
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/document-text.test.ts
```
Expected failure: `Error: Failed to resolve import "./document-text" from "src/document-text.test.ts". Does the file exist?`

26. **Minimal implementation.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/document-text.ts`:
```ts
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { recordRun } from "./heartbeat";
import { extractDocumentText, type Extractor } from "./extract";

export interface StoredText { text: string; extractor: Extractor; reused: boolean }

/**
 * Extracted document text, stored once per vault file. Vault files are
 * content-addressed and never mutate, so a row whose sha256 still matches the
 * document is final — OCR is expensive and runs once, ever. Derived data: no
 * ledger event is appended here, and reindex can throw the whole table away.
 */
export async function storeDocumentText(
  deps: { db: Db; extract?: typeof extractDocumentText },
  doc: { id: string; sha256: string; mime: string },
  fileBuf: Buffer,
): Promise<StoredText> {
  const extract = deps.extract ?? extractDocumentText;
  const [existing] = await deps.db.select().from(schema.documentTexts)
    .where(eq(schema.documentTexts.documentId, doc.id));
  if (existing && existing.sha256 === doc.sha256) {
    return { text: existing.text, extractor: existing.extractor as Extractor, reused: true };
  }
  const out = await extract(doc.mime, fileBuf);
  await deps.db.insert(schema.documentTexts).values({
    documentId: doc.id, sha256: doc.sha256, text: out.text,
    extractor: out.extractor, charCount: out.charCount, truncated: out.truncated,
  }).onConflictDoUpdate({
    target: schema.documentTexts.documentId,
    set: { sha256: doc.sha256, text: out.text, extractor: out.extractor,
      charCount: out.charCount, truncated: out.truncated, extractedAt: new Date() },
  });
  await recordRun(deps.db, "extract", out.error ? "error" : "ok", {
    documentId: doc.id, extractor: out.extractor, charCount: out.charCount,
    truncated: out.truncated, ...(out.error ? { message: out.error } : {}) });
  return { text: out.text, extractor: out.extractor, reused: false };
}
```

27. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker test src/document-text.test.ts
```
Expected: `Tests  4 passed (4)`.

28. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/document-text.ts apps/worker/src/document-text.test.ts && git commit -m "feat(worker): persist extracted document text keyed by sha256"
```

29. **Wire it into the worker and delete the old private extractor.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/index.ts`:

(a) add the import directly below the existing line `import { scanNasFolder } from "./nas";`:
```ts
import { storeDocumentText } from "./document-text";
```
(b) delete this entire function (currently lines 40–50, between `const llm = realLlmPort();` and `await boss.work("suggest.entry", …`):
```ts
async function extractText(mime: string, buf: Buffer): Promise<string> {
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return (await pdfParse(buf)).text;
  }
  if (mime.startsWith("image/")) {
    const { recognize } = await import("tesseract.js");
    return (await recognize(buf, "nld+eng")).data.text;
  }
  return "";
}
```
(c) replace the existing block
```ts
await boss.createQueue("suggest.docmeta");
await boss.work("suggest.docmeta", async ([job]) => {
  const { documentId } = job.data as { documentId: string };
  const [doc] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  await suggestDocMeta({ db, llm, extractText, sendPush }, documentId, buf);
});
```
with
```ts
await boss.createQueue("suggest.docmeta");
await boss.work("suggest.docmeta", async ([job]) => {
  const { documentId } = job.data as { documentId: string };
  const [doc] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  // Extract once, store it, and hand the same text to the docmeta prompt: the
  // text the model saw is the text the search index holds.
  const stored = await storeDocumentText({ db }, doc, buf);
  await suggestDocMeta({ db, llm, extractText: async () => stored.text, sendPush },
    documentId, buf);
});
```

30. **Typecheck and run the whole worker suite.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter worker typecheck && env -u NODE_ENV pnpm --filter worker test
```
Expected: typecheck prints nothing; every worker test file passes. `ollama.test.ts` is unaffected — `suggestDocMeta`'s signature did not change, only the function passed into its `extractText` field.

31. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/src/index.ts && git commit -m "feat(worker): docmeta job stores extracted text instead of discarding it"
```

32. **Add poppler to the worker image.** In `/Users/martin/Workspace/mp/verder/apps/worker/Dockerfile`, insert between the existing line `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production` and the existing line `RUN corepack enable`:
```dockerfile
# poppler-utils gives us pdftoppm: scanned PDFs (an image in a PDF wrapper) are
# rasterized before OCR. First apt layer in this repo — a Debian mirror is now a
# build dependency. Deliberately above the COPY/pnpm install layers so a
# dependency change does not re-run apt.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
```

33. **Verify the image builds and the binary is there.**
```bash
cd /Users/martin/Workspace/mp/verder && docker build -f apps/worker/Dockerfile -t verder-worker-check . \
  && docker run --rm --entrypoint pdftoppm verder-worker-check -v
```
Expected: the build succeeds and the last command prints `pdftoppm version 22.12.0` (whatever bookworm ships) followed by the poppler copyright lines.

34. **Note the dev prerequisite.** In `/Users/martin/Workspace/mp/verder/CLAUDE.md`, under `## Build & test`, insert directly below the existing line beginning `- Dev DB: \`docker compose up -d postgres\``:
```md
- Worker tests need poppler (`pdftoppm`) on the host: `brew install poppler`. Regenerating the extraction fixtures additionally needs ImageMagick 7 (`brew install imagemagick`): `bash apps/worker/src/fixtures/make-fixtures.sh`.
```

35. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add apps/worker/Dockerfile CLAUDE.md && git commit -m "feat(worker): poppler-utils in the worker image for scanned-PDF OCR"
```

**Success criteria for Task 3**
- `env -u NODE_ENV pnpm --filter worker test` green; `env -u NODE_ENV pnpm --filter worker typecheck` prints nothing.
- `docker build -f apps/worker/Dockerfile .` succeeds and `pdftoppm -v` runs inside the image.
- `grep -rn "extractText" apps/worker/src` shows exactly two kinds of hit: the dep field in `ollama.ts`, and the `extractText: async () => stored.text` call site in `index.ts`. No standalone `extractText` function remains.
- A truncated extraction is visible in the table, not only in the run log: the third persistence test asserts `document_texts.truncated = true` with `char_count` holding the pre-cap length.
- Manual verification: `OCR_TESTS=1 env -u NODE_ENV pnpm --filter worker test src/extract.test.ts` passes once — real tesseract reads "Ziggo" off the scan fixture.

---

### Task 4: pure search primitives (chunker, source hash, RRF, entity types) and the renderers

**Files**

- Create: `/Users/martin/Workspace/mp/verder/packages/core/src/search/entity-types.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/core/src/search/chunk.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/core/src/search/source-hash.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/core/src/search/fuse.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/render.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/core/src/search/entity-types.test.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/core/src/search/chunk.test.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/core/src/search/source-hash.test.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/core/src/search/fuse.test.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/core/src/search/exports.test.ts`
- Test: `/Users/martin/Workspace/mp/verder/packages/api/src/search/render.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/core/src/index.ts` (re-export the four new modules)

**Interfaces**

This task depends on **no other task in this plan** — nothing here touches the database, the schema or the network, so it can be executed in parallel with Tasks 1–3.

Consumes (already in the repo, exact names):
- `import { sha256Hex } from "../hash";` — `sha256Hex(data: string | Uint8Array): string` (`packages/core/src/hash.ts`).
- `import { canonicalJson } from "../canonical-json";` — `canonicalJson(value: unknown): string` (`packages/core/src/canonical-json.ts`). Same pairing `computeEventHash` already uses, so a title/body boundary cannot be forged by concatenation.
- The existing `packages/core/src/index.ts`, whose full current content is:
```ts
export { canonicalJson } from "./canonical-json";
export { GENESIS_HASH, sha256Hex, computeEventHash, type EventHashInput } from "./hash";
export { verifyChain, type ChainEvent, type VerifyResult } from "./verify";
```

Produces (`packages/core/src/search/entity-types.ts`):
```ts
export const SEARCH_ENTITY_TYPES = ["document","entry","email","financial_item",
  "debt","task","milestone","timeline_event","party"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];
export const SEARCH_STATUSES = ["inbox","filed","open","in-progress","waiting","done","dropped",
  "identified","mandatory","allowed","requested","to-cancel","canceled",
  "acknowledged","disputed","in-settlement","settled"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];
```
Produces (`packages/core/src/search/chunk.ts`):
```ts
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
export function chunkBody(body: string): string[];
```
Produces (`packages/core/src/search/source-hash.ts`):
```ts
export function sourceHash(title: string, body: string): string;
```
Produces (`packages/core/src/search/fuse.ts`):
```ts
export const RRF_K = 60;
export type RankedId = { id: string; rank: number };            // rank is 1-based
export type FusedId = { id: string; score: number; inLexical: boolean; inSemantic: boolean };
export function rrfFuse(lexical: RankedId[], semantic: RankedId[], k?: number): FusedId[];
```
Produces (`packages/api/src/search/render.ts` — pure: rows in, `Rendered` out, zero imports):
```ts
export type Rendered = { title: string; body: string; occurredAt: Date | null; status: string | null };
export function euro(cents: number): string;
export function nlLabel(value: string): string;
export function stripQuotedReply(body: string): string;
export function renderDocument(doc: { title: string; docType: string | null; mime: string; receivedAt: Date }, ctx: { status: string; text: string }): Rendered;
export function renderEntry(entry: { summary: string; details: string | null; channel: string; direction: string; occurredAt: Date }, ctx: { participantNames: string[]; documentTitles: string[] }): Rendered;
export function renderEmail(email: { subject: string; fromAddr: string; toAddr: string; bodyText: string; sentAt: Date }): Rendered;
export function renderFinancialItem(item: { name: string; category: string; amountCents: number; billingCycle: string; paymentChannel: string; noticePeriod: string | null; cancellationMethod: string | null; cancellationDetails: string | null; accountNumber: string | null; createdAt: Date }, ctx: { status: string; providerName: string | null }): Rendered;
export function renderDebt(debt: { creditorName: string; claimedCents: number; principalCents: number | null; references_: string | null; origin: string | null; originStory: string | null; createdAt: Date }, ctx: { status: string; creditorPartyName: string | null }): Rendered;
export function renderTask(task: { title: string; details: string | null; dueAt: Date | null; createdAt: Date }, ctx: { status: string; assigneeName: string | null }): Rendered;
export function renderMilestone(m: { title: string; stage: string; done: boolean; happenedAt: Date | null; expectedAt: Date | null; note: string | null }): Rendered;
export function renderTimelineEvent(e: { title: string; kind: string; note: string | null; happenedAt: Date }): Rendered;
export function renderParty(p: { name: string; kind: string; organization: string | null; email: string | null; phone: string | null; notes: string | null; createdAt: Date }): Rendered;
```
`renderDocument`'s `title`, `docType` and `status` are the **effective** values (`document_status_changes` wins over `documents`); resolving them is the loader's job, not the renderer's. `Rendered.status` is the value written to the denormalized `search_chunks.status` column and is non-null only where the entity has a status in `SEARCH_STATUSES`: documents, financial items, debts and tasks. Entries, e-mails, milestones, timeline events and parties render `status: null` (a milestone's done/open state is prose in the body, not a filterable status).

Produced for:
- **Task 5** (the entity loader) — `loadAndRender` calls the nine renderers, then `chunkBody` and `sourceHash` per chunk, and copies `Rendered.status` into `RenderedChunk.status`.
- **Task 8** (hybrid query pipeline) — `rrfFuse` and `RRF_K` do the fusion arithmetic in TypeScript, and the router's input schema uses `SEARCH_STATUSES` / `SearchEntityType`.
- **Tasks 11 and 12** (the `/search` page and the ⌘K palette) — `SEARCH_ENTITY_TYPES` and `SEARCH_STATUSES` drive the filter rail.

---

**Steps**

1. **Failing test for the entity-type and status vocabularies.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/entity-types.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "./entity-types";

describe("SEARCH_ENTITY_TYPES", () => {
  it("is the nine indexed entity types, in the order the schema and the UI use", () => {
    expect([...SEARCH_ENTITY_TYPES]).toEqual([
      "document", "entry", "email", "financial_item", "debt",
      "task", "milestone", "timeline_event", "party"]);
  });
});

describe("SEARCH_STATUSES", () => {
  it("is the deduped union of every status vocabulary in the app", () => {
    // doc_status | TASK_STATUSES | item_status | debt_status, "identified"
    // shared between items and debts and therefore listed once.
    expect([...SEARCH_STATUSES]).toEqual([
      "inbox", "filed",
      "open", "in-progress", "waiting", "done", "dropped",
      "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled",
      "acknowledged", "disputed", "in-settlement", "settled"]);
  });

  it("contains no duplicates", () => {
    expect(new Set(SEARCH_STATUSES).size).toBe(SEARCH_STATUSES.length);
  });
});
```

2. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/entity-types.test.ts
```
Expected failure: `Error: Failed to resolve import "./entity-types" from "src/search/entity-types.test.ts". Does the file exist?`

3. **Minimal implementation.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/entity-types.ts`:
```ts
// The nine record types the knowledge base indexes. One tuple, one spelling:
// the schema's entity_type column, the trigger arguments, the router's input
// schema and the /search filter rail all read this list.
export const SEARCH_ENTITY_TYPES = ["document", "entry", "email", "financial_item",
  "debt", "task", "milestone", "timeline_event", "party"] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/**
 * Every status a search result can carry, deduped across the four vocabularies
 * that exist in the app: doc_status, TASK_STATUSES, item_status, debt_status.
 * search_chunks.status is denormalized, so a status filter is one WHERE clause
 * against one column instead of a per-entity-type subquery — which is what makes
 * "the filter rail offers a status the router rejects" impossible.
 */
export const SEARCH_STATUSES = [
  "inbox", "filed",                                            // documents
  "open", "in-progress", "waiting", "done", "dropped",         // tasks
  "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled", // financial items
  "acknowledged", "disputed", "in-settlement", "settled",      // debts ("identified" shared)
] as const;

export type SearchStatus = (typeof SEARCH_STATUSES)[number];
```

4. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/entity-types.test.ts
```
Expected: `Test Files  1 passed (1)` / `Tests  3 passed (3)`.

5. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/core/src/search/entity-types.ts packages/core/src/search/entity-types.test.ts && git commit -m "feat(core): search entity-type and status vocabularies"
```

6. **Failing test for the chunker.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/chunk.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chunkBody, CHUNK_SIZE, CHUNK_OVERLAP } from "./chunk";

describe("chunkBody", () => {
  it("returns a short body as exactly one chunk", () => {
    expect(chunkBody("Naam: Ziggo. Status: op te zeggen."))
      .toEqual(["Naam: Ziggo. Status: op te zeggen."]);
  });

  it("returns one empty chunk for an empty body", () => {
    // A record with no body text (a bare timeline event) must still be indexed:
    // the title is indexed alongside the body, so chunk 0 always exists.
    expect(chunkBody("")).toEqual([""]);
    expect(chunkBody("   \n\n  ")).toEqual([""]);
  });

  it("keeps a body of exactly the chunk size in one chunk, and splits one character more", () => {
    expect(chunkBody("a".repeat(CHUNK_SIZE))).toHaveLength(1);
    const two = chunkBody("a".repeat(CHUNK_SIZE + 1));
    expect(two.map((c) => c.length)).toEqual([CHUNK_SIZE, CHUNK_OVERLAP + 1]);
  });

  it("cuts on a paragraph boundary and overlaps into the next chunk", () => {
    const first = "A".repeat(700);
    const second = "B".repeat(700);
    const chunks = chunkBody(`${first}\n\n${second}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1].startsWith("A".repeat(CHUNK_OVERLAP))).toBe(true);
    expect(chunks[1].endsWith(second)).toBe(true);
  });

  it("never splits a code point", () => {
    const chunks = chunkBody("é👍".repeat(800)); // 1600 code points
    expect(Array.from(chunks[0])).toHaveLength(CHUNK_SIZE);
    expect(chunks[0].endsWith("👍")).toBe(true);
    expect(chunks.join("")).not.toMatch(/\uFFFD/);
    for (const c of chunks) expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
  });
});
```

7. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/chunk.test.ts
```
Expected failure: `Error: Failed to resolve import "./chunk" from "src/search/chunk.test.ts". Does the file exist?`

8. **Minimal implementation.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/chunk.ts`:
```ts
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;

/**
 * Splits a rendered body into overlapping chunks. Pure, no I/O.
 *
 * Works on code points, not UTF-16 units, so an accent or an emoji is never cut
 * in half. Prefers a blank-line (paragraph) boundary in the second half of the
 * window — cutting at the first blank line would produce stub chunks — and
 * otherwise cuts at the size limit. Consecutive chunks overlap by CHUNK_OVERLAP
 * so a sentence spanning a cut is still retrievable from at least one chunk.
 */
export function chunkBody(body: string): string[] {
  const trimmed = body.trim();
  // Every record gets at least one chunk: the title is indexed alongside the
  // body, so a record with no body text must still be findable. Never [].
  if (trimmed.length === 0) return [""];
  const cps = Array.from(trimmed);
  if (cps.length <= CHUNK_SIZE) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < cps.length) {
    let end = Math.min(start + CHUNK_SIZE, cps.length);
    if (end < cps.length) {
      let br = -1;
      for (let i = end - 2; i > start; i--) {
        if (cps[i] === "\n" && cps[i + 1] === "\n") { br = i; break; }
      }
      if (br > start + CHUNK_SIZE / 2) end = br;
    }
    const piece = cps.slice(start, end).join("").trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= cps.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}
```

9. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/chunk.test.ts
```
Expected: `Tests  5 passed (5)`.

10. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/core/src/search/chunk.ts packages/core/src/search/chunk.test.ts && git commit -m "feat(core): unicode-safe paragraph chunker for the search index"
```

11. **Failing test for the source hash.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/source-hash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sourceHash } from "./source-hash";

describe("sourceHash", () => {
  it("is stable for identical content and changes with either field", () => {
    const a = sourceHash("Ziggo", "Naam: Ziggo.");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("Ziggo", "Naam: Ziggo.")).toBe(a);
    expect(sourceHash("Ziggo", "Naam: Ziggo. Status: opgezegd.")).not.toBe(a);
    expect(sourceHash("Ziggo B.V.", "Naam: Ziggo.")).not.toBe(a);
  });

  it("cannot be forged by moving characters across the title/body boundary", () => {
    // Plain concatenation would make these two identical, and an edit that only
    // shifted the boundary would silently skip re-embedding.
    expect(sourceHash("ab", "c")).not.toBe(sourceHash("a", "bc"));
  });
});
```

12. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/source-hash.test.ts
```
Expected failure: `Error: Failed to resolve import "./source-hash" from "src/search/source-hash.test.ts". Does the file exist?`

13. **Minimal implementation.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/source-hash.ts`:
```ts
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../hash";

/**
 * Identity of a chunk's content. The drain re-embeds a chunk only when this
 * changes, so re-rendering an untouched record costs no GPU time. Hashed
 * through canonicalJson — the same pairing computeEventHash uses — so the
 * title/body boundary is part of the input and cannot be shifted unnoticed.
 */
export function sourceHash(title: string, body: string): string {
  return sha256Hex(canonicalJson({ title, body }));
}
```

14. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/source-hash.test.ts
```
Expected: `Tests  2 passed (2)`.

15. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/core/src/search/source-hash.ts packages/core/src/search/source-hash.test.ts && git commit -m "feat(core): source-hash helper for skip-unchanged embedding"
```

16. **Failing test for the RRF fusion math.** This is the spec's "Unit: RRF fusion math" test — the arithmetic lives in TypeScript precisely so it can be asserted here rather than inside a SQL query. Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/fuse.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { rrfFuse, RRF_K } from "./fuse";

describe("rrfFuse", () => {
  it("sums 1/(k+rank) for an id in both lists and flags it as both", () => {
    const fused = rrfFuse(
      [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
      [{ id: "b", rank: 1 }, { id: "c", rank: 2 }]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]).toMatchObject({ id: "b", inLexical: true, inSemantic: true });
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused[1]).toMatchObject({ id: "a", inLexical: true, inSemantic: false });
    expect(fused[2]).toMatchObject({ id: "c", inLexical: false, inSemantic: true });
  });

  it("passes a lexical-only result through in rank order", () => {
    const fused = rrfFuse([{ id: "a", rank: 1 }, { id: "b", rank: 2 }, { id: "c", rank: 3 }], []);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(fused.every((f) => f.inLexical && !f.inSemantic)).toBe(true);
    expect(fused[2].score).toBeCloseTo(1 / (RRF_K + 3), 12);
  });

  it("passes a semantic-only result through in rank order", () => {
    // Ollama down is the lexical-only case; a query with no tsquery match is
    // this one. Both must return results, not an empty page.
    const fused = rrfFuse([], [{ id: "x", rank: 1 }, { id: "y", rank: 2 }]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
    expect(fused.every((f) => f.inSemantic && !f.inLexical)).toBe(true);
  });

  it("breaks ties by id ascending, whichever list an id came from", () => {
    expect(rrfFuse([{ id: "b", rank: 1 }], [{ id: "a", rank: 1 }]).map((f) => f.id))
      .toEqual(["a", "b"]);
    expect(rrfFuse([{ id: "z", rank: 2 }], [{ id: "y", rank: 2 }]).map((f) => f.id))
      .toEqual(["y", "z"]);
  });

  it("takes an explicit k", () => {
    const [only] = rrfFuse([{ id: "x", rank: 1 }], [], 1);
    expect(only.score).toBeCloseTo(0.5, 12);
  });

  it("returns an empty array for two empty lists", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
```

17. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/fuse.test.ts
```
Expected failure: `Error: Failed to resolve import "./fuse" from "src/search/fuse.test.ts". Does the file exist?`

18. **Minimal implementation.** Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/fuse.ts`:
```ts
export const RRF_K = 60;

/** One entry of a ranked result list. rank is 1-based: the top hit has rank 1. */
export type RankedId = { id: string; rank: number };

export type FusedId = { id: string; score: number; inLexical: boolean; inSemantic: boolean };

/**
 * Reciprocal rank fusion: score(id) = Σ 1/(k + rank) over the lists the id
 * appears in. Deliberately computed here and not in SQL — it is the one piece
 * of ranking arithmetic worth unit-testing, and the inLexical/inSemantic flags
 * are what the result badge ("keyword / semantic / both") renders.
 *
 * Sorted by score descending, ties broken by id ascending so the same two
 * inputs always produce the same page order.
 */
export function rrfFuse(lexical: RankedId[], semantic: RankedId[], k: number = RRF_K): FusedId[] {
  const acc = new Map<string, FusedId>();
  const add = (list: RankedId[], flag: "inLexical" | "inSemantic"): void => {
    for (const { id, rank } of list) {
      const cur = acc.get(id) ?? { id, score: 0, inLexical: false, inSemantic: false };
      cur.score += 1 / (k + rank);
      cur[flag] = true;
      acc.set(id, cur);
    }
  };
  add(lexical, "inLexical");
  add(semantic, "inSemantic");
  return [...acc.values()].sort((a, b) =>
    b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
```

19. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/fuse.test.ts
```
Expected: `Tests  6 passed (6)`.

20. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/core/src/search/fuse.ts packages/core/src/search/fuse.test.ts && git commit -m "feat(core): reciprocal rank fusion with deterministic tie-breaks"
```

21. **Failing test for the package's public surface.** The API package and the worker import these through `@verder/core`, never by deep path. Create `/Users/martin/Workspace/mp/verder/packages/core/src/search/exports.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  CHUNK_OVERLAP, CHUNK_SIZE, RRF_K, SEARCH_ENTITY_TYPES, SEARCH_STATUSES,
  chunkBody, rrfFuse, sourceHash,
} from "../index";

describe("@verder/core public surface", () => {
  it("re-exports every search primitive consumers import by package name", () => {
    expect(SEARCH_ENTITY_TYPES).toHaveLength(9);
    expect(SEARCH_STATUSES).toHaveLength(17);
    expect(CHUNK_SIZE).toBe(1200);
    expect(CHUNK_OVERLAP).toBe(150);
    expect(RRF_K).toBe(60);
    expect(chunkBody("kort")).toEqual(["kort"]);
    expect(sourceHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
    expect(rrfFuse([{ id: "a", rank: 1 }], [])).toHaveLength(1);
  });
});
```

22. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core test src/search/exports.test.ts
```
Expected failure: `SyntaxError: [vite] The requested module '../index' does not provide an export named 'CHUNK_OVERLAP'`, reported as `Test Files  1 failed (1)`.

23. **Add the re-exports.** In `/Users/martin/Workspace/mp/verder/packages/core/src/index.ts`, append below the existing line `export { verifyChain, type ChainEvent, type VerifyResult } from "./verify";`:
```ts
export { SEARCH_ENTITY_TYPES, SEARCH_STATUSES, type SearchEntityType, type SearchStatus }
  from "./search/entity-types";
export { CHUNK_SIZE, CHUNK_OVERLAP, chunkBody } from "./search/chunk";
export { sourceHash } from "./search/source-hash";
export { RRF_K, rrfFuse, type RankedId, type FusedId } from "./search/fuse";
```

24. **Run the whole core package, typecheck included.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/core typecheck && env -u NODE_ENV pnpm --filter @verder/core test
```
Expected: typecheck prints nothing; `Test Files  8 passed (8)` — the three pre-existing files (`canonical-json.test.ts`, `hash.test.ts`, `verify.test.ts`) plus the five added here.

25. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/core/src/index.ts packages/core/src/search/exports.test.ts && git commit -m "feat(core): export the search primitives from the package root"
```

26. **Failing test for the Dutch rendering helpers.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/render.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { euro, nlLabel, stripQuotedReply } from "./render";

describe("stripQuotedReply", () => {
  it("cuts a Dutch reply tail", () => {
    const body = [
      "Beste heer Van der Poel,",
      "Bijgaand de bevestiging van de opzegging.",
      "",
      "Op 19 augustus 2026 om 10:12 schreef VerderGroep <info@verdergroep.nl>:",
      "> Kunt u de opzegging bevestigen?",
      "> Met vriendelijke groet",
    ].join("\n");
    expect(stripQuotedReply(body))
      .toBe("Beste heer Van der Poel,\nBijgaand de bevestiging van de opzegging.");
  });

  it("cuts an English reply tail and an Outlook original-message block", () => {
    expect(stripQuotedReply("Thanks, that works.\n\nOn Wed, 19 Aug 2026 at 10:12, X wrote:\n> hi"))
      .toBe("Thanks, that works.");
    expect(stripQuotedReply("Zie bijlage.\n\n-----Oorspronkelijk bericht-----\nVan: iemand"))
      .toBe("Zie bijlage.");
  });

  it("keeps a leading quote block, because cutting there would erase the record", () => {
    expect(stripQuotedReply("> Kunt u dit bevestigen?\n> Groet"))
      .toBe("> Kunt u dit bevestigen?\n> Groet");
  });

  it("leaves an unquoted body untouched apart from trimming", () => {
    expect(stripQuotedReply("  Beste Martin,\n\nGraag een kopie van uw paspoort.  "))
      .toBe("Beste Martin,\n\nGraag een kopie van uw paspoort.");
  });
});

describe("euro / nlLabel", () => {
  it("formats cents the Dutch way", () => {
    expect(euro(4250)).toBe("€ 42,50");
    expect(euro(5)).toBe("€ 0,05");
    expect(euro(-1999)).toBe("-€ 19,99");
  });

  it("renders the stored value with its Dutch label", () => {
    expect(nlLabel("to-cancel")).toBe("to-cancel (op te zeggen)");
    expect(nlLabel("open")).toBe("open");
    expect(nlLabel("iets-onbekends")).toBe("iets-onbekends");
  });
});
```

27. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/render.test.ts
```
Expected failure: `Error: Failed to resolve import "./render" from "src/search/render.test.ts". Does the file exist?`

28. **Implement the helpers.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/render.ts` with this first half:
```ts
/**
 * Per-entity text rendering for the search index. Pure: no DB, no network, no
 * imports at all. The caller (loadAndRender) passes plain rows plus the values
 * it already resolved — effective status, party names, extracted document text —
 * and gets back { title, body, occurredAt, status }, so one Dutch query hits
 * prose (documents, e-mails) and structured records (items, debts, tasks) alike.
 */

export type Rendered = {
  title: string;
  body: string;
  occurredAt: Date | null;
  /** Written to the denormalized search_chunks.status column; null when the
   *  entity has no status in SEARCH_STATUSES. */
  status: string | null;
};

// Both the stored value and a Dutch label are rendered: Martin searches in
// Dutch ("op te zeggen"), the stored enum values are English ("to-cancel").
const NL: Record<string, string> = {
  identified: "geïdentificeerd", mandatory: "noodzakelijk", allowed: "toegestaan",
  requested: "aangevraagd", "to-cancel": "op te zeggen", canceled: "opgezegd",
  acknowledged: "erkend", disputed: "betwist", "in-settlement": "in regeling",
  settled: "afgewikkeld",
  "in-progress": "in behandeling", waiting: "wachtend", done: "afgerond",
  dropped: "vervallen",
  application: "aanvraag", accepted: "toegelaten", onboarding: "intake",
  "wsnp-start": "start WSNP", settlement: "regeling", "clean-slate": "schone lei",
  call: "telefoon", meeting: "gesprek", email: "e-mail", voicemail: "voicemail",
  letter: "brief", other: "overig", process: "proces", mail: "post",
  inbound: "inkomend", outbound: "uitgaand", internal: "intern",
  person: "persoon", organization: "organisatie",
  monthly: "per maand", quarterly: "per kwartaal", yearly: "per jaar",
  irregular: "onregelmatig", "direct-debit": "automatische incasso",
  invoice: "factuur", inbox: "postvak in", filed: "gearchiveerd",
};

export function nlLabel(value: string): string {
  const label = NL[value];
  return label && label !== value ? `${value} (${label})` : value;
}

/** "€ 42,50" — integer math only, never parseFloat. */
export function euro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€ ${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function field(label: string, value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : `${label}: ${value}.`;
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function day(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// First line of a quoted reply tail, Dutch and English clients.
const QUOTE_MARKERS: RegExp[] = [
  /^>/,
  /^-{2,}\s*(oorspronkelijk bericht|original message)\s*-{2,}$/i,
  /^_{10,}$/,
  /^op\s.+\sschreef\b/i,
  /^on\s.+\swrote:?$/i,
  /^(van|from|verzonden|sent):\s/i,
];

/**
 * Drops the quoted tail of a reply so the index holds what was actually
 * written, not the same thread five times over. If the very first line is a
 * marker the body is kept whole — stripping everything would erase the record.
 */
export function stripQuotedReply(body: string): string {
  const rows = body.split(/\r?\n/);
  const cut = rows.findIndex((l) => QUOTE_MARKERS.some((re) => re.test(l.trim())));
  if (cut <= 0) return body.trim();
  return rows.slice(0, cut).join("\n").trim();
}
```

29. **Run it, see the helper tests pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/render.test.ts
```
Expected: `Tests  6 passed (6)`.

30. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/render.ts packages/api/src/search/render.test.ts && git commit -m "feat(api): Dutch rendering helpers and quoted-reply stripping"
```

31. **Failing tests for the nine renderers.** In `render.test.ts`, add this second import statement directly below the existing `import { euro, nlLabel, stripQuotedReply } from "./render";`:
```ts
import {
  renderDebt, renderDocument, renderEmail, renderEntry, renderFinancialItem,
  renderMilestone, renderParty, renderTask, renderTimelineEvent,
} from "./render";
```
and append at the end of the file:
```ts
describe("renderers", () => {
  it("renders a document with its extracted text and its effective status", () => {
    const r = renderDocument({ title: "Brief Ziggo.pdf", docType: "brief",
      mime: "application/pdf", receivedAt: new Date("2026-08-19T10:00:00Z") },
      { status: "inbox", text: "Uw dossiernummer is 2026-VG-00412." });
    expect(r.title).toBe("Brief Ziggo.pdf");
    expect(r.body).toContain("Documentsoort: brief.");
    expect(r.body).toContain("Status: inbox (postvak in).");
    expect(r.body).toContain("Uw dossiernummer is 2026-VG-00412.");
    expect(r.occurredAt).toEqual(new Date("2026-08-19T10:00:00Z"));
    expect(r.status).toBe("inbox");
  });

  it("renders a logbook entry with its participants and no status", () => {
    const r = renderEntry({ summary: "VerderGroep vraagt paspoort",
      details: "Kopie paspoort opsturen.", channel: "email", direction: "inbound",
      occurredAt: new Date("2026-08-19T09:00:00Z") },
      { participantNames: ["VerderGroep", "Martin van der Poel"],
        documentTitles: ["Brief VerderGroep.pdf"] });
    expect(r.title).toBe("VerderGroep vraagt paspoort");
    expect(r.body).toContain("Kanaal: email (e-mail).");
    expect(r.body).toContain("Richting: inbound (inkomend).");
    expect(r.body).toContain("Betrokkenen: VerderGroep, Martin van der Poel.");
    expect(r.body).toContain("Documenten: Brief VerderGroep.pdf.");
    expect(r.body).toContain("Kopie paspoort opsturen.");
    expect(r.status).toBeNull();
  });

  it("renders an e-mail without its quoted tail", () => {
    const r = renderEmail({ subject: "Opzegging bevestigd", fromAddr: "info@ziggo.nl",
      toAddr: "martin@vanderpoel.pro", sentAt: new Date("2026-08-18T08:30:00Z"),
      bodyText: "Uw abonnement is opgezegd.\n\nOp 17 augustus 2026 schreef Martin:\n> Graag opzeggen." });
    expect(r.title).toBe("Opzegging bevestigd");
    expect(r.body).toContain("Van: info@ziggo.nl.");
    expect(r.body).toContain("Uw abonnement is opgezegd.");
    expect(r.body).not.toContain("Graag opzeggen");
    expect(r.occurredAt).toEqual(new Date("2026-08-18T08:30:00Z"));
    expect(r.status).toBeNull();
  });

  it("renders a financial item as a structured Dutch record", () => {
    const r = renderFinancialItem({ name: "Ziggo", category: "telecom", amountCents: 4250,
      billingCycle: "monthly", paymentChannel: "direct-debit", noticePeriod: "1 maand",
      cancellationMethod: "online", cancellationDetails: "Via Mijn Ziggo opzeggen.",
      accountNumber: "12345678", createdAt: new Date("2026-08-01T00:00:00Z") },
      { status: "to-cancel", providerName: "Ziggo B.V." });
    expect(r.title).toBe("Ziggo");
    expect(r.body).toContain("Naam: Ziggo.");
    expect(r.body).toContain("Categorie: telecom.");
    expect(r.body).toContain("Status: to-cancel (op te zeggen).");
    expect(r.body).toContain("Bedrag: € 42,50 per maand.");
    expect(r.body).toContain("Betaalwijze: direct-debit (automatische incasso).");
    expect(r.body).toContain("Leverancier: Ziggo B.V..");
    expect(r.body).toContain("Opzegtermijn: 1 maand.");
    expect(r.body).toContain("Via Mijn Ziggo opzeggen.");
    expect(r.status).toBe("to-cancel");
  });

  it("renders a debt", () => {
    const r = renderDebt({ creditorName: "Intrum", claimedCents: 125000, principalCents: 100000,
      references_: "DOS-9912", origin: "telefoonabonnement",
      originStory: "Openstaande facturen 2024.",
      createdAt: new Date("2026-07-01T00:00:00Z") },
      { status: "disputed", creditorPartyName: "Intrum Justitia B.V." });
    expect(r.title).toBe("Intrum");
    expect(r.body).toContain("Schuldeiser: Intrum.");
    expect(r.body).toContain("Schuldeiser (partij): Intrum Justitia B.V..");
    expect(r.body).toContain("Status: disputed (betwist).");
    expect(r.body).toContain("Gevorderd bedrag: € 1250,00.");
    expect(r.body).toContain("Hoofdsom: € 1000,00.");
    expect(r.body).toContain("Kenmerk: DOS-9912.");
    expect(r.status).toBe("disputed");
  });

  it("renders a task, dated by its deadline", () => {
    const r = renderTask({ title: "Kopie paspoort opsturen", details: "Naar VerderGroep mailen.",
      dueAt: new Date("2026-09-01T00:00:00Z"), createdAt: new Date("2026-08-19T00:00:00Z") },
      { status: "in-progress", assigneeName: "Martin van der Poel" });
    expect(r.title).toBe("Kopie paspoort opsturen");
    expect(r.body).toContain("Status: in-progress (in behandeling).");
    expect(r.body).toContain("Toegewezen aan: Martin van der Poel.");
    expect(r.body).toContain("Deadline: 2026-09-01.");
    expect(r.occurredAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(r.status).toBe("in-progress");
  });

  it("renders a milestone, falling back to the expected date, with no filterable status", () => {
    const r = renderMilestone({ title: "Toelating WSNP", stage: "wsnp-start", done: false,
      happenedAt: null, expectedAt: new Date("2026-10-01T00:00:00Z"), note: "Zitting gepland." });
    expect(r.body).toContain("Fase: wsnp-start (start WSNP).");
    expect(r.body).toContain("Status: open.");
    expect(r.body).toContain("Zitting gepland.");
    expect(r.occurredAt).toEqual(new Date("2026-10-01T00:00:00Z"));
    // done/open is prose, not one of SEARCH_STATUSES: a status filter of "open"
    // must return tasks, not milestones.
    expect(r.status).toBeNull();
  });

  it("renders a timeline event with no note as a title-only body", () => {
    const r = renderTimelineEvent({ title: "Intakegesprek", kind: "meeting", note: null,
      happenedAt: new Date("2026-08-05T13:00:00Z") });
    expect(r.title).toBe("Intakegesprek");
    expect(r.body).toContain("Gebeurtenis: Intakegesprek.");
    expect(r.body).toContain("Soort: meeting (gesprek).");
    expect(r.status).toBeNull();
  });

  it("renders a party", () => {
    const r = renderParty({ name: "VerderGroep", kind: "organization",
      organization: "VerderGroep B.V.", email: "info@verdergroep.nl", phone: "0800-1234",
      notes: "Bewindvoerder.", createdAt: new Date("2026-06-01T00:00:00Z") });
    expect(r.title).toBe("VerderGroep");
    expect(r.body).toContain("Soort: organization (organisatie).");
    expect(r.body).toContain("E-mail: info@verdergroep.nl.");
    expect(r.body).toContain("Bewindvoerder.");
    expect(r.status).toBeNull();
  });
});
```

32. **Run, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/render.test.ts
```
Expected failure: `SyntaxError: [vite] The requested module './render' does not provide an export named 'renderDebt'`, reported as `Test Files  1 failed (1)`.

33. **Implement the nine renderers.** Append to `/Users/martin/Workspace/mp/verder/packages/api/src/search/render.ts`:
```ts
export function renderDocument(doc: {
  title: string; docType: string | null; mime: string; receivedAt: Date;
}, ctx: { status: string; text: string }): Rendered {
  // title/docType are the EFFECTIVE values and ctx.status is the effective status:
  // document_status_changes wins over documents, and resolving that is the loader's
  // job (Task 5), not this function's. ctx.text is document_texts.text, or "" when
  // extraction has not run yet — the document is still indexed on title + metadata.
  return {
    title: doc.title,
    body: lines(
      field("Document", doc.title),
      field("Documentsoort", doc.docType ?? "onbekend"),
      field("Status", nlLabel(ctx.status)),
      field("Bestandstype", doc.mime),
      ctx.text.trim() || null),
    occurredAt: doc.receivedAt,
    status: ctx.status,
  };
}

export function renderEntry(entry: {
  summary: string; details: string | null; channel: string; direction: string; occurredAt: Date;
}, ctx: { participantNames: string[]; documentTitles: string[] }): Rendered {
  return {
    title: entry.summary,
    body: lines(
      field("Logboekregel", entry.summary),
      field("Kanaal", nlLabel(entry.channel)),
      field("Richting", nlLabel(entry.direction)),
      field("Betrokkenen", ctx.participantNames.join(", ")),
      field("Documenten", ctx.documentTitles.join(", ")),
      entry.details?.trim() || null),
    occurredAt: entry.occurredAt,
    status: null,
  };
}

export function renderEmail(email: {
  subject: string; fromAddr: string; toAddr: string; bodyText: string; sentAt: Date;
}): Rendered {
  return {
    title: email.subject,
    body: lines(
      field("E-mail", email.subject),
      field("Van", email.fromAddr),
      field("Aan", email.toAddr),
      stripQuotedReply(email.bodyText) || null),
    occurredAt: email.sentAt,
    status: null,
  };
}

export function renderFinancialItem(item: {
  name: string; category: string; amountCents: number; billingCycle: string;
  paymentChannel: string; noticePeriod: string | null; cancellationMethod: string | null;
  cancellationDetails: string | null; accountNumber: string | null; createdAt: Date;
}, ctx: { status: string; providerName: string | null }): Rendered {
  const cycle = NL[item.billingCycle] ?? item.billingCycle;
  return {
    title: item.name,
    body: lines(
      field("Naam", item.name),
      field("Categorie", item.category),
      field("Status", nlLabel(ctx.status)),
      field("Bedrag", `${euro(item.amountCents)} ${cycle}`),
      field("Betaalwijze", nlLabel(item.paymentChannel)),
      field("Leverancier", ctx.providerName),
      field("Opzegtermijn", item.noticePeriod),
      field("Opzeggen via", item.cancellationMethod),
      field("Klantnummer", item.accountNumber),
      item.cancellationDetails?.trim() || null),
    occurredAt: item.createdAt,
    status: ctx.status,
  };
}

export function renderDebt(debt: {
  creditorName: string; claimedCents: number; principalCents: number | null;
  references_: string | null; origin: string | null; originStory: string | null; createdAt: Date;
}, ctx: { status: string; creditorPartyName: string | null }): Rendered {
  return {
    title: debt.creditorName,
    body: lines(
      field("Schuldeiser", debt.creditorName),
      field("Schuldeiser (partij)", ctx.creditorPartyName),
      field("Status", nlLabel(ctx.status)),
      field("Gevorderd bedrag", euro(debt.claimedCents)),
      field("Hoofdsom", debt.principalCents === null ? null : euro(debt.principalCents)),
      field("Kenmerk", debt.references_),
      field("Herkomst", debt.origin),
      debt.originStory?.trim() || null),
    occurredAt: debt.createdAt,
    status: ctx.status,
  };
}

export function renderTask(task: {
  title: string; details: string | null; dueAt: Date | null; createdAt: Date;
}, ctx: { status: string; assigneeName: string | null }): Rendered {
  return {
    title: task.title,
    body: lines(
      field("Taak", task.title),
      field("Status", nlLabel(ctx.status)),
      field("Toegewezen aan", ctx.assigneeName),
      field("Deadline", day(task.dueAt)),
      task.details?.trim() || null),
    // Dated by its deadline where there is one: a task's place on a timeline is
    // when it is due, not when it was typed in.
    occurredAt: task.dueAt ?? task.createdAt,
    status: ctx.status,
  };
}

export function renderMilestone(m: {
  title: string; stage: string; done: boolean; happenedAt: Date | null;
  expectedAt: Date | null; note: string | null;
}): Rendered {
  const at = m.happenedAt ?? m.expectedAt;
  return {
    title: m.title,
    body: lines(
      field("Mijlpaal", m.title),
      field("Fase", nlLabel(m.stage)),
      field("Status", m.done ? "afgerond" : "open"),
      field("Datum", day(at)),
      m.note?.trim() || null),
    occurredAt: at,
    // A milestone's done/open flag is not one of SEARCH_STATUSES; it stays prose
    // in the body so a status filter cannot half-match it.
    status: null,
  };
}

export function renderTimelineEvent(e: {
  title: string; kind: string; note: string | null; happenedAt: Date;
}): Rendered {
  return {
    title: e.title,
    body: lines(
      field("Gebeurtenis", e.title),
      field("Soort", nlLabel(e.kind)),
      e.note?.trim() || null),
    occurredAt: e.happenedAt,
    status: null,
  };
}

export function renderParty(p: {
  name: string; kind: string; organization: string | null; email: string | null;
  phone: string | null; notes: string | null; createdAt: Date;
}): Rendered {
  return {
    title: p.name,
    body: lines(
      field("Naam", p.name),
      field("Soort", nlLabel(p.kind)),
      field("Organisatie", p.organization),
      field("E-mail", p.email),
      field("Telefoon", p.phone),
      p.notes?.trim() || null),
    occurredAt: p.createdAt,
    status: null,
  };
}
```

34. **Run, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/render.test.ts
```
Expected: `Tests  15 passed (15)`.

35. **Typecheck and run the full API suite.** Postgres must be up — most API test files use the dev database, this one does not.
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api typecheck && env -u NODE_ENV pnpm --filter @verder/api test
```
Expected: typecheck prints nothing; `Test Files  19 passed (19)` — the 18 pre-existing files plus `src/search/render.test.ts`.

36. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/render.ts packages/api/src/search/render.test.ts && git commit -m "feat(api): Dutch renderers for all nine indexed entity types"
```

**Success criteria for Task 4**
- `env -u NODE_ENV pnpm --filter @verder/core test` and `env -u NODE_ENV pnpm --filter @verder/api test` are green; both `typecheck` scripts print nothing.
- `packages/api/src/search/render.ts` is import-free: `grep -c "^import" packages/api/src/search/render.ts` prints `0`.
- The core search modules import nothing outside `@verder/core`: `grep -hn "^import" packages/core/src/search/*.ts` shows only `../canonical-json` and `../hash`.
- The spec's "Unit: RRF fusion math" item is covered by `packages/core/src/search/fuse.test.ts`: both-lists summation, lexical-only, semantic-only, tie-break determinism, explicit `k`, empty input.
- Every symbol Tasks 5, 8, 11 and 12 import from `@verder/core` resolves through the package root, proven by `packages/core/src/search/exports.test.ts`.

### Task 5: the entity loader — DB row → rendered, chunked, hashed

This is the piece that turns a source record into index-ready chunks. Nothing before it
reads `document_texts`, calls the chunker, or resolves an effective status; nothing after it
can work without it (NEW Task 7's `search.drain` job, NEW Task 10's `reindex` CLI and NEW
Task 16's retrieval eval all call `indexEntity`).

It also creates `packages/api/src/search/embed.ts` with the **port contract only** —
`EmbedPort`, `EMBED_DIMENSIONS`, `EMBED_MODEL_ENV`, `asDocument`, `asQuery`. The loader must
prefix every indexed text with `search_document: `, and it must be typed against the port it
calls, but the HTTP client behind that port (`realEmbedPort`) is NEW Task 7's job and lands
in this same file later. Splitting it this way keeps Task 5 executable on its own.

**Files**

- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/embed.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/embed.test.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.test.ts`
- Modify: nothing. No migration, no router, no schema change.

**Interfaces**

*Consumes — from NEW Task 1 (`packages/db/src/schema.ts`, migrations `0014`/`0015`):*
```ts
schema.documentTexts  // { documentId: string (pk → documents.id); sha256: string; text: string;
                      //   extractor: string; charCount: number; truncated: boolean;
                      //   extractedAt: Date }
schema.searchChunks   // { id: string; entityType: string; entityId: string; chunkIndex: number;
                      //   title: string; body: string; occurredAt: Date | null;
                      //   status: string | null;          <- denormalized, written HERE
                      //   tsv: string (GENERATED ALWAYS, declared via customType);
                      //   embedding: number[] | null; sourceHash: string;
                      //   embedAttempts: number; indexedAt: Date }
                      // uniqueIndex("search_chunk_uq") on (entityType, entityId, chunkIndex)
```

*Consumes — from NEW Task 2 (`0016_search_grants.sql`):* `verder_worker` holds
`SELECT, INSERT, UPDATE, DELETE` on `document_texts` and `search_chunks`; `verder_app` holds
`SELECT` only. Everything in this task therefore runs as `verder_worker`, and the test file
connects as `verder_worker`.

*Consumes — from NEW Task 3 (`apps/worker/src/document-text.ts`):* `storeDocumentText` is
what fills `document_texts` in production. This task only ever **reads** that table; the
tests insert the row directly so Task 5 does not depend on the extractor being wired.

*Consumes — from NEW Task 4:*
```ts
// re-exported from packages/core/src/index.ts
export const SEARCH_ENTITY_TYPES = ["document","entry","email","financial_item",
  "debt","task","milestone","timeline_event","party"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
export function chunkBody(body: string): string[];      // never returns []
export function sourceHash(title: string, body: string): string;   // 64 lowercase hex

// packages/api/src/search/render.ts — pure, rows in, text out, no DB access
export type Rendered = { title: string; body: string; occurredAt: Date | null; status: string | null };
export function renderDocument(
  doc: { title: string; docType: string | null; mime: string; receivedAt: Date },
  ctx: { status: string; text: string }): Rendered;
export function renderEntry(
  entry: { summary: string; details: string | null; channel: string; direction: string; occurredAt: Date },
  ctx: { participantNames: string[]; documentTitles: string[] }): Rendered;
export function renderEmail(
  email: { subject: string; fromAddr: string; toAddr: string; bodyText: string; sentAt: Date }): Rendered;
export function renderFinancialItem(
  item: { name: string; category: string; amountCents: number; billingCycle: string;
          paymentChannel: string; noticePeriod: string | null; cancellationMethod: string | null;
          cancellationDetails: string | null; accountNumber: string | null; createdAt: Date },
  ctx: { status: string; providerName: string | null }): Rendered;
export function renderDebt(
  debt: { creditorName: string; claimedCents: number; principalCents: number | null;
          references_: string | null; origin: string | null; originStory: string | null; createdAt: Date },
  ctx: { status: string; creditorPartyName: string | null }): Rendered;
export function renderTask(
  task: { title: string; details: string | null; dueAt: Date | null; createdAt: Date },
  ctx: { status: string; assigneeName: string | null }): Rendered;
export function renderMilestone(
  m: { title: string; stage: string; done: boolean; happenedAt: Date | null;
       expectedAt: Date | null; note: string | null }): Rendered;
export function renderTimelineEvent(
  e: { title: string; kind: string; note: string | null; happenedAt: Date }): Rendered;
export function renderParty(
  p: { name: string; kind: string; organization: string | null; email: string | null;
       phone: string | null; notes: string | null; createdAt: Date }): Rendered;
```
Only `renderDocument`, `renderTask`, `renderFinancialItem` and `renderDebt` return a
non-null `status`; the other five return `null`.

*Consumes — existing repo helpers, reused by exact name, never reimplemented:*
```ts
// packages/api/src/routers/documents.ts:28
export async function effectiveDocument(db: Db, id: string):
  Promise<typeof schema.documents.$inferSelect & {
    effectiveStatus: string; effectiveTitle: string; effectiveDocType: string | null }>;
// resolves documents + the latest document_status_changes row; THROWS "Document not found"
// when the document row does not exist.

// packages/api/src/task-decide.ts:43
export async function effectiveTaskStatus(db: Db, taskId: string): Promise<string>;
// latest task_status_changes row ordered by ledger seq, default "open".

// packages/api/src/registry-decide.ts:49
export async function effectiveStatus(
  db: Db, target: { financialItemId?: string; debtId?: string }): Promise<string>;
// latest registry_decisions row ordered by ledger seq, default "identified".
// Throws unless exactly one of financialItemId / debtId is set.
```

*Produces:*
```ts
// packages/api/src/search/embed.ts  (NEW Task 7 appends realEmbedPort to this same file)
export const EMBED_DIMENSIONS = 768;
export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
export function asDocument(text: string): string;   // "search_document: " + text
export function asQuery(text: string): string;      // "search_query: " + text

// packages/api/src/search/index-entity.ts
export type RenderedChunk = {
  entityType: SearchEntityType; entityId: string; chunkIndex: number;
  title: string; body: string; occurredAt: Date | null; status: string | null;
  sourceHash: string;
};
export async function loadAndRender(
  db: Db, entityType: SearchEntityType, entityId: string): Promise<RenderedChunk[]>;
export async function indexEntity(
  deps: { db: Db; embed: EmbedPort },
  entityType: SearchEntityType, entityId: string,
): Promise<{ chunks: number; embedded: number; unchanged: number }>;
```

Contract notes downstream tasks may rely on:
- `loadAndRender` returns `[]` when the source row is gone; `indexEntity` then deletes every
  chunk for that entity (this is also what `reindex --prune` leans on).
- `indexEntity` **never throws on an embedding failure**. A dead Ollama yields `embedding
  NULL`, `embed_attempts` incremented, and the chunk stays lexically searchable — the spec's
  documented degraded mode. The failure count is therefore `chunks - embedded - unchanged`.
- `indexEntity` calls `deps.embed.embed(...)` **zero times** when nothing changed.
- The index is DERIVED: no `ledger_events` row is ever appended here, and UPDATE/DELETE on
  `search_chunks` is deliberate and legal.

---

**Steps**

1. **Failing test for the embedding port contract.** Create
`/Users/martin/Workspace/mp/verder/packages/api/src/search/embed.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { asDocument, asQuery, EMBED_DIMENSIONS, EMBED_MODEL_ENV } from "./embed";

describe("nomic task prefixes", () => {
  it("prefixes stored text with search_document and query text with search_query", () => {
    // nomic-embed-text is asymmetric. Indexing with one prefix and querying with
    // the other silently halves recall — no error, just worse results — so the
    // two prefixes exist as functions rather than as inline string literals.
    expect(asDocument("Opzegging Ziggo")).toBe("search_document: Opzegging Ziggo");
    expect(asQuery("opzegging ziggo")).toBe("search_query: opzegging ziggo");
  });
});

describe("embedding constants", () => {
  it("declares the 768 dimensions the vector column is sized for", () => {
    expect(EMBED_DIMENSIONS).toBe(768);
  });

  it("names the env var that selects the embedding model", () => {
    expect(EMBED_MODEL_ENV).toBe("OLLAMA_EMBED_MODEL");
  });
});
```

2. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/embed.test.ts
```
Expected failure:
```
Error: Failed to resolve import "./embed" from "src/search/embed.test.ts". Does the file exist?
```

3. **Implement the port contract.** Create
`/Users/martin/Workspace/mp/verder/packages/api/src/search/embed.ts`:
```ts
/**
 * The embedding seam for the hybrid index.
 *
 * This file holds the CONTRACT: the port type, the vector width the
 * search_chunks.embedding column is declared with, the env var that selects the
 * model, and nomic's two task prefixes. The real Ollama client behind the port
 * (realEmbedPort) lands here in the search.drain task; the entity loader only
 * needs the contract, and tests substitute a fake port so indexing is testable
 * without a GPU.
 */

/** One vector per input text, in order. null = embedding failed for that text. */
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };

/** nomic-embed-text is 768-dimensional; search_chunks.embedding is vector(768). */
export const EMBED_DIMENSIONS = 768;

/** Env var read by the real client; default model is nomic-embed-text. */
export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";

/** Prefix for text that is STORED in the index. */
export function asDocument(text: string): string {
  return `search_document: ${text}`;
}

/** Prefix for text that is SEARCHED WITH. Used by the query pipeline. */
export function asQuery(text: string): string {
  return `search_query: ${text}`;
}
```

4. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/embed.test.ts
```
Expected: `Tests  3 passed (3)`.

5. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/embed.ts packages/api/src/search/embed.test.ts && git commit -m "feat(api): embedding port contract and nomic task prefixes"
```

6. **Failing test for loading and rendering a document.** Create
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appendLedgerEvent } from "../ledger";
import { ingestDocument } from "../routers/documents";
import { loadAndRender } from "./index-entity";

// verder_worker, not verder_app: the derived-index grants give the app role
// SELECT only on document_texts and search_chunks — writing them is the
// worker's job, and this loader runs inside the worker.
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

let db: Db;
let userId: string;

beforeAll(async () => {
  db = createDb(DB_URL).db;
  const [u] = await db.insert(schema.users)
    .values({ email: `loader${Date.now()}@test.local`, name: "Martin" }).returning();
  userId = u.id;
});

/** ~2.7 kB of letter text with paragraph breaks, so a 1200-character chunker
 *  has to produce more than one chunk. The two markers sit at the very start
 *  and the very end, so the first and last chunk are identifiable. */
function longLetter(marker: string): string {
  return [
    `DOSSIER-${marker} betreft de opzegging van uw abonnement.`,
    "a".repeat(650),
    "b".repeat(650),
    "c".repeat(650),
    "d".repeat(650),
    `SLOT-${marker} einde van de brief.`,
  ].join("\n\n");
}

/** A vault document plus the extracted text row that Task 3's
 *  storeDocumentText writes in production. */
async function makeDocument(marker: string, text: string) {
  const doc = await db.transaction((tx) => ingestDocument(tx, {
    sha256: sha256Hex(marker), sizeBytes: 12_345, mime: "application/pdf",
    title: `Brief Ziggo ${marker}.pdf`, source: "nas-scan", docType: "brief",
    receivedAt: new Date("2026-08-19T10:00:00Z"),
  }));
  await db.insert(schema.documentTexts).values({
    documentId: doc.id, sha256: doc.sha256, text, extractor: "ocr-pdf",
    charCount: text.length, truncated: false,
  });
  return doc;
}

describe("loadAndRender — documents", () => {
  it("reads the persisted extracted text and splits a long letter into several chunks", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));

    const chunks = await loadAndRender(db, "document", doc.id);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.entityType === "document")).toBe(true);
    expect(chunks.every((c) => c.entityId === doc.id)).toBe(true);
    expect(chunks.every((c) => c.title === `Brief Ziggo ${marker}.pdf`)).toBe(true);
    expect(chunks.every((c) => c.occurredAt?.toISOString() === "2026-08-19T10:00:00.000Z")).toBe(true);
    // The OCR'd text is actually in the index — this is the whole point of
    // persisting document_texts.
    expect(chunks[0].body).toContain(`DOSSIER-${marker}`);
    expect(chunks[chunks.length - 1].body).toContain(`SLOT-${marker}`);
    // One hash per chunk, all distinct: the drain re-embeds per chunk, so a
    // single shared hash would make a partial edit invisible.
    expect(chunks.every((c) => /^[0-9a-f]{64}$/.test(c.sourceHash))).toBe(true);
    expect(new Set(chunks.map((c) => c.sourceHash)).size).toBe(chunks.length);
    // No status change yet: the documents row's own status stands.
    expect(chunks[0].status).toBe("inbox");
  });

  it("takes title and status from document_status_changes once doc-meta is approved", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, `Korte brief ${marker}.`);
    // Exactly what suggestions.approveDocumentMeta does: the insert-only
    // evidence row plus its ledger event, in one transaction.
    await db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: doc.id, status: "filed",
        title: `Ziggo opzegbrief ${marker}.pdf`, docType: "opzegging",
      });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: doc.id,
        payload: { id: doc.id, status: "filed",
          title: `Ziggo opzegbrief ${marker}.pdf`, docType: "opzegging" },
      });
    });

    const chunks = await loadAndRender(db, "document", doc.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe(`Ziggo opzegbrief ${marker}.pdf`);
    expect(chunks[0].status).toBe("filed");
  });

  it("returns [] when the row no longer exists", async () => {
    expect(await loadAndRender(db, "document", randomUUID())).toEqual([]);
  });
});
```

7. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected failure:
```
Error: Failed to resolve import "./index-entity" from "src/search/index-entity.test.ts". Does the file exist?
```

8. **Implement the loader for documents.** Create
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.ts`:
```ts
import { eq } from "drizzle-orm";
import { chunkBody, sourceHash, type SearchEntityType } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { effectiveDocument } from "../routers/documents";
import { renderDocument, type Rendered } from "./render";

/**
 * The bridge between the evidence tables and the search index: one entity id in,
 * index-ready chunks out.
 *
 * The renderers in render.ts are pure — they take a row plus the values the
 * caller already resolved. This file is the caller: it loads the row, the
 * extracted text, the effective status and the related party names, hands them
 * to the right renderer, chunks the rendered body and hashes each chunk.
 *
 * Status is resolved with the SAME helpers the rest of the app uses
 * (effectiveDocument, effectiveTaskStatus, effectiveStatus) and then stamped on
 * every chunk. Query-time status filtering reads that one denormalized column
 * instead of four per-entity-type subqueries.
 */

export type RenderedChunk = {
  entityType: SearchEntityType;
  entityId: string;
  chunkIndex: number;
  title: string;
  body: string;
  occurredAt: Date | null;
  status: string | null;
  sourceHash: string;
};

/** null when the entity's row is gone — the caller turns that into []. */
async function renderRow(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<Rendered | null> {
  switch (entityType) {
    case "document": {
      // effectiveDocument throws "Document not found" when the row is gone, and
      // loadAndRender must return [] instead, so existence is checked first.
      const [row] = await db.select({ id: schema.documents.id }).from(schema.documents)
        .where(eq(schema.documents.id, entityId));
      if (!row) return null;
      // Title, doc type and status all move to document_status_changes the
      // moment a doc-meta suggestion is approved — the documents row itself is
      // never updated. effectiveDocument is the one helper that resolves that,
      // and re-deriving it here would drift from the rest of the app.
      const doc = await effectiveDocument(db, entityId);
      const [extracted] = await db.select({ text: schema.documentTexts.text })
        .from(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, entityId));
      return renderDocument(
        { title: doc.effectiveTitle, docType: doc.effectiveDocType,
          mime: doc.mime, receivedAt: doc.receivedAt },
        // No extracted text yet (extraction runs asynchronously, or the file is
        // not text at all): the document is still indexed on title and metadata.
        { status: doc.effectiveStatus, text: extracted?.text ?? "" });
    }
    default:
      throw new Error(`loadAndRender: unsupported entity type "${entityType}"`);
  }
}

/**
 * Loads one entity, renders it, chunks it and hashes each chunk.
 * Returns [] when the row no longer exists, which is how indexEntity learns to
 * drop every chunk it still holds for that entity.
 */
export async function loadAndRender(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<RenderedChunk[]> {
  const rendered = await renderRow(db, entityType, entityId);
  if (!rendered) return [];
  return chunkBody(rendered.body).map((body, chunkIndex) => ({
    entityType, entityId, chunkIndex,
    title: rendered.title, body,
    occurredAt: rendered.occurredAt, status: rendered.status,
    // Per chunk, not per entity: the drain re-embeds chunk by chunk, so a hash
    // covering the whole entity would hide which chunk actually changed.
    sourceHash: sourceHash(rendered.title, body),
  }));
}
```

9. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected: `Tests  3 passed (3)`.

10. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/index-entity.ts packages/api/src/search/index-entity.test.ts && git commit -m "feat(api): load and render documents into hashed search chunks"
```

11. **Failing tests for the other eight entity types.** In
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.test.ts`, replace the
import block at the top of the file (the six `import` lines, from `import { randomUUID }`
through `import { loadAndRender } from "./index-entity";`) with:
```ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex, type SearchEntityType } from "@verder/core";
import { appendLedgerEvent } from "../ledger";
import { ingestDocument } from "../routers/documents";
import { insertEntry } from "../routers/entries";
import { decide } from "../registry-decide";
import { setTaskStatus } from "../task-decide";
import { loadAndRender } from "./index-entity";
```
and append at the end of the file:
```ts
describe("loadAndRender — related values and effective status", () => {
  it("renders a logbook entry with its participants and linked documents, ordered by name", async () => {
    const marker = randomUUID();
    const [org] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `VerderGroep ${marker}` }).returning();
    const [person] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Anna ${marker}` }).returning();
    const doc = await makeDocument(marker, `Bijlage ${marker}.`);
    const entry = await db.transaction((tx) => insertEntry(tx, userId, {
      occurredAt: new Date("2026-08-19T09:00:00Z"), channel: "email", direction: "inbound",
      summary: `Paspoort gevraagd ${marker}`, details: "Kopie paspoort opsturen.",
      source: "manual", participantPartyIds: [org.id, person.id],
      documentIds: [doc.id], actionItems: [],
    }, { eventType: "entry.created" }));

    const chunks = await loadAndRender(db, "entry", entry.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe(`Paspoort gevraagd ${marker}`);
    expect(chunks[0].body).toContain(`Anna ${marker}`);
    expect(chunks[0].body).toContain(`VerderGroep ${marker}`);
    expect(chunks[0].body).toContain(`Brief Ziggo ${marker}.pdf`);
    // Sorted by party name, not by join order: an unordered join lets Postgres
    // return the same participants in a different order on a later drain, which
    // changes the body, changes source_hash and re-embeds for nothing.
    expect(chunks[0].body.indexOf(`Anna ${marker}`))
      .toBeLessThan(chunks[0].body.indexOf(`VerderGroep ${marker}`));
    expect(chunks[0].status).toBeNull();
  });

  it("stamps the effective task status and the assignee name", async () => {
    const marker = randomUUID();
    const [assignee] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Martin ${marker}` }).returning();
    const [task] = await db.insert(schema.tasks).values({
      title: `Kopie paspoort opsturen ${marker}`, details: "Naar VerderGroep mailen.",
      assigneePartyId: assignee.id, dueAt: new Date("2026-09-01T00:00:00Z"),
      createdBy: userId,
    }).returning();
    await db.transaction((tx) => setTaskStatus(tx, userId, {
      taskId: task.id, status: "in-progress", note: "Begonnen." }));

    const chunks = await loadAndRender(db, "task", task.id);

    expect(chunks).toHaveLength(1);
    // Status lives in task_status_changes; the tasks row itself has no status
    // column at all, so reading the row alone would index nothing.
    expect(chunks[0].status).toBe("in-progress");
    expect(chunks[0].body).toContain(`Martin ${marker}`);
    expect(chunks[0].occurredAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("stamps the effective financial-item status and the provider name", async () => {
    const marker = randomUUID();
    const [provider] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `Ziggo B.V. ${marker}` }).returning();
    const [item] = await db.insert(schema.financialItems).values({
      name: `Ziggo ${marker}`, category: "telecom", providerPartyId: provider.id,
      amountCents: 4250, billingCycle: "monthly", paymentChannel: "direct-debit",
      noticePeriod: "1 maand", cancellationMethod: "online",
      cancellationDetails: "Via Mijn Ziggo opzeggen.", accountNumber: "12345678",
    }).returning();
    await db.transaction((tx) => decide(tx, userId, {
      financialItemId: item.id, status: "to-cancel", explanation: "Niet noodzakelijk." }));

    const chunks = await loadAndRender(db, "financial_item", item.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].status).toBe("to-cancel");
    expect(chunks[0].body).toContain(`Ziggo B.V. ${marker}`);
  });

  it("stamps the effective debt status and the creditor party name", async () => {
    const marker = randomUUID();
    const [creditor] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `Intrum ${marker}` }).returning();
    const [debt] = await db.insert(schema.debts).values({
      creditorPartyId: creditor.id, creditorName: `Intrum ${marker}`,
      claimedCents: 125_000, principalCents: 100_000, references_: `DOS-${marker}`,
    }).returning();
    await db.transaction((tx) => decide(tx, userId, {
      debtId: debt.id, status: "disputed", explanation: "Bedrag klopt niet." }));

    const chunks = await loadAndRender(db, "debt", debt.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].status).toBe("disputed");
    expect(chunks[0].body).toContain(`DOS-${marker}`);
  });

  it("renders e-mails, milestones, timeline events and parties with a null status", async () => {
    const marker = randomUUID();
    const [email] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${marker}`, gmailThreadId: `thr-${marker}`,
      fromAddr: "info@ziggo.nl", toAddr: "martin@vanderpoel.pro",
      subject: `Opzegging bevestigd ${marker}`, sentAt: new Date("2026-08-18T08:30:00Z"),
      rawRfc822Sha256: sha256Hex(`raw-${marker}`),
      bodyText: "Uw abonnement is opgezegd per 1 oktober.",
    }).returning();
    const [milestone] = await db.insert(schema.milestones).values({
      stage: "wsnp-start", title: `Toelating WSNP ${marker}`,
      expectedAt: new Date("2026-10-01T00:00:00Z"), note: "Zitting gepland.",
    }).returning();
    const [event] = await db.insert(schema.timelineEvents).values({
      title: `Intakegesprek ${marker}`, kind: "meeting",
      happenedAt: new Date("2026-08-05T13:00:00Z"),
    }).returning();
    const [party] = await db.insert(schema.parties).values({
      kind: "organization", name: `Bewind ${marker}`, email: "info@verdergroep.nl",
    }).returning();

    const cases: { type: SearchEntityType; id: string; title: string; contains: string }[] = [
      { type: "email", id: email.id, title: `Opzegging bevestigd ${marker}`,
        contains: "Uw abonnement is opgezegd per 1 oktober." },
      { type: "milestone", id: milestone.id, title: `Toelating WSNP ${marker}`,
        contains: "Zitting gepland." },
      { type: "timeline_event", id: event.id, title: `Intakegesprek ${marker}`,
        contains: `Intakegesprek ${marker}` },
      { type: "party", id: party.id, title: `Bewind ${marker}`,
        contains: "info@verdergroep.nl" },
    ];
    for (const c of cases) {
      const chunks = await loadAndRender(db, c.type, c.id);
      expect(chunks, c.type).toHaveLength(1);
      expect(chunks[0].title, c.type).toBe(c.title);
      expect(chunks[0].body, c.type).toContain(c.contains);
      expect(chunks[0].status, c.type).toBeNull();
    }
  });
});
```

12. **Run it, see the five new tests fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected: `Tests  5 failed | 3 passed (8)`, the first failure reading:
```
Error: loadAndRender: unsupported entity type "entry"
```

13. **Implement the remaining eight loaders.** In
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.ts`, replace the five
import lines at the top of the file (from `import { eq } from "drizzle-orm";` through
`import { renderDocument, type Rendered } from "./render";`) with:
```ts
import { asc, eq } from "drizzle-orm";
import { chunkBody, sourceHash, type SearchEntityType } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { effectiveStatus } from "../registry-decide";
import { effectiveTaskStatus } from "../task-decide";
import { effectiveDocument } from "../routers/documents";
import {
  renderDebt, renderDocument, renderEmail, renderEntry, renderFinancialItem,
  renderMilestone, renderParty, renderTask, renderTimelineEvent, type Rendered,
} from "./render";
```
Then insert this helper directly above the `async function renderRow(` line:
```ts
/** Party display name for a nullable FK — the renderers take the name, not the id. */
async function partyName(db: Db, partyId: string | null): Promise<string | null> {
  if (!partyId) return null;
  const [party] = await db.select({ name: schema.parties.name }).from(schema.parties)
    .where(eq(schema.parties.id, partyId));
  return party?.name ?? null;
}
```
Finally replace the two lines
```ts
    default:
      throw new Error(`loadAndRender: unsupported entity type "${entityType}"`);
```
with the eight remaining branches and an exhaustiveness guard:
```ts
    case "entry": {
      const [entry] = await db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.id, entityId));
      if (!entry) return null;
      // Ordered by name and by title: without ORDER BY, Postgres may return the
      // same rows in a different order on a later drain, which rewrites the
      // body, changes source_hash and burns GPU time re-embedding identical text.
      const participants = await db.select({ name: schema.parties.name })
        .from(schema.entryParticipants)
        .innerJoin(schema.parties, eq(schema.parties.id, schema.entryParticipants.partyId))
        .where(eq(schema.entryParticipants.entryId, entityId))
        .orderBy(asc(schema.parties.name));
      const documents = await db.select({ title: schema.documents.title })
        .from(schema.entryDocuments)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.entryDocuments.documentId))
        .where(eq(schema.entryDocuments.entryId, entityId))
        .orderBy(asc(schema.documents.title));
      return renderEntry(entry, {
        participantNames: participants.map((p) => p.name),
        documentTitles: documents.map((d) => d.title),
      });
    }
    case "email": {
      const [email] = await db.select().from(schema.rawEmails)
        .where(eq(schema.rawEmails.id, entityId));
      return email ? renderEmail(email) : null;
    }
    case "financial_item": {
      const [item] = await db.select().from(schema.financialItems)
        .where(eq(schema.financialItems.id, entityId));
      if (!item) return null;
      // Status lives in registry_decisions, ordered by ledger seq — never in the
      // financial_items row. effectiveStatus is that query; do not inline it.
      return renderFinancialItem(item, {
        status: await effectiveStatus(db, { financialItemId: item.id }),
        providerName: await partyName(db, item.providerPartyId),
      });
    }
    case "debt": {
      const [debt] = await db.select().from(schema.debts)
        .where(eq(schema.debts.id, entityId));
      if (!debt) return null;
      return renderDebt(debt, {
        status: await effectiveStatus(db, { debtId: debt.id }),
        creditorPartyName: await partyName(db, debt.creditorPartyId),
      });
    }
    case "task": {
      const [task] = await db.select().from(schema.tasks)
        .where(eq(schema.tasks.id, entityId));
      if (!task) return null;
      // Status lives in task_status_changes, ordered by ledger seq.
      return renderTask(task, {
        status: await effectiveTaskStatus(db, task.id),
        assigneeName: await partyName(db, task.assigneePartyId),
      });
    }
    case "milestone": {
      const [milestone] = await db.select().from(schema.milestones)
        .where(eq(schema.milestones.id, entityId));
      return milestone ? renderMilestone(milestone) : null;
    }
    case "timeline_event": {
      const [event] = await db.select().from(schema.timelineEvents)
        .where(eq(schema.timelineEvents.id, entityId));
      return event ? renderTimelineEvent(event) : null;
    }
    case "party": {
      const [party] = await db.select().from(schema.parties)
        .where(eq(schema.parties.id, entityId));
      return party ? renderParty(party) : null;
    }
    default: {
      // SearchEntityType is a closed union: this is unreachable, and the never
      // assignment makes adding a tenth entity type a compile error here rather
      // than a silently unindexed record.
      const exhaustive: never = entityType;
      throw new Error(`loadAndRender: unsupported entity type "${String(exhaustive)}"`);
    }
```

14. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected: `Tests  8 passed (8)`.

15. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/index-entity.ts packages/api/src/search/index-entity.test.ts && git commit -m "feat(api): entity loader for all nine indexed entity types"
```

16. **Failing tests for `indexEntity`.** In
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.test.ts`, replace the
line
```ts
import { beforeAll, describe, expect, it } from "vitest";
```
with
```ts
import { beforeAll, describe, expect, it, vi } from "vitest";
```
replace the line
```ts
import { eq } from "drizzle-orm";
```
with
```ts
import { and, asc, eq } from "drizzle-orm";
```
replace the line
```ts
import { loadAndRender } from "./index-entity";
```
with
```ts
import { EMBED_DIMENSIONS, type EmbedPort } from "./embed";
import { indexEntity, loadAndRender } from "./index-entity";
```
and append at the end of the file:
```ts
/** A fake embedding client that records every text it is handed. */
function fakeEmbed() {
  const spy = vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))));
  return { spy, port: { embed: spy } satisfies EmbedPort };
}

const chunkRows = (entityId: string) =>
  db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "document"),
      eq(schema.searchChunks.entityId, entityId)))
    .orderBy(asc(schema.searchChunks.chunkIndex));

describe("indexEntity", () => {
  it("upserts every chunk and embeds each one exactly once, with the document prefix", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    const { spy, port } = fakeEmbed();

    const result = await indexEntity({ db, embed: port }, "document", doc.id);

    expect(result.chunks).toBeGreaterThan(1);
    expect(result.embedded).toBe(result.chunks);
    expect(result.unchanged).toBe(0);
    const rows = await chunkRows(doc.id);
    expect(rows).toHaveLength(result.chunks);
    expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
    expect(rows.every((r) => r.embedding !== null)).toBe(true);
    expect(rows.every((r) => r.embedAttempts === 0)).toBe(true);
    expect(rows.every((r) => r.status === "inbox")).toBe(true);
    const texts = spy.mock.calls.flatMap(([batch]) => batch);
    expect(texts).toHaveLength(result.chunks);
    expect(texts.every((t) => t.startsWith("search_document: "))).toBe(true);
    // Chunks are indexed, not evidence: nothing is appended to the ledger.
    const ledger = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.eventType, "search.indexed"));
    expect(ledger).toHaveLength(0);
  });

  it("makes zero embed calls when the rendered content is unchanged", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);
    const before = await chunkRows(doc.id);

    const { spy, port } = fakeEmbed();
    const result = await indexEntity({ db, embed: port }, "document", doc.id);

    // The whole point of source_hash: re-indexing an untouched record costs no
    // GPU time at all, so the 60 s drain can run forever without loading Ollama.
    expect(spy).not.toHaveBeenCalled();
    expect(result.embedded).toBe(0);
    expect(result.unchanged).toBe(result.chunks);
    const after = await chunkRows(doc.id);
    expect(after.map((r) => r.indexedAt.getTime()))
      .toEqual(before.map((r) => r.indexedAt.getTime()));
  });

  it("deletes the orphan tail chunks when the source text shrinks", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);
    expect((await chunkRows(doc.id)).length).toBeGreaterThan(1);

    // A re-scan of the same document that extracts far less text: the trailing
    // chunks would otherwise haunt results forever with text that is gone.
    await db.update(schema.documentTexts)
      .set({ text: `KORT-${marker}: één regel.`, charCount: 24 })
      .where(eq(schema.documentTexts.documentId, doc.id));

    const result = await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);

    expect(result.chunks).toBe(1);
    const rows = await chunkRows(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkIndex).toBe(0);
    expect(rows[0].body).toContain(`KORT-${marker}`);
  });

  it("removes every chunk when the source row is gone", async () => {
    const ghost = randomUUID();
    await db.insert(schema.searchChunks).values({
      entityType: "document", entityId: ghost, chunkIndex: 0,
      title: "Verdwenen document", body: "Deze brief bestaat niet meer.",
      occurredAt: null, status: "inbox", sourceHash: "0".repeat(64),
    });

    const result = await indexEntity({ db, embed: fakeEmbed().port }, "document", ghost);

    expect(result).toEqual({ chunks: 0, embedded: 0, unchanged: 0 });
    expect(await chunkRows(ghost)).toHaveLength(0);
  });
});
```

17. **Run it, see it fail.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected failure:
```
SyntaxError: [vite] The requested module './index-entity' does not provide an export named 'indexEntity'
```

18. **Implement `indexEntity`.** In
`/Users/martin/Workspace/mp/verder/packages/api/src/search/index-entity.ts`, replace the line
```ts
import { asc, eq } from "drizzle-orm";
```
with
```ts
import { and, asc, eq, gte, sql } from "drizzle-orm";
```
replace the line
```ts
import { schema, type Db } from "@verder/db";
```
with
```ts
import { schema, type Db } from "@verder/db";
import { asDocument, type EmbedPort } from "./embed";
```
and append at the end of the file:
```ts
/**
 * Brings search_chunks in line with one entity's current content.
 *
 * Re-embeds ONLY chunks whose source_hash changed (or whose previous embedding
 * failed), upserts them on (entity_type, entity_id, chunk_index), and deletes
 * chunks past the new chunk count so a shortened record leaves no orphans
 * behind. When the source row is gone, loadAndRender returns [] and every chunk
 * for that entity is deleted — which is also what `reindex --prune` relies on.
 *
 * UPDATE and DELETE here are legal and deliberate: the index is DERIVED, not
 * evidence. It appends no ledger events, and `reindex` rebuilds all of it from
 * the source records.
 *
 * A failing embedding client never throws out of this function: the chunk still
 * lands, with embedding NULL and embed_attempts incremented, and stays findable
 * by full text until a later pass succeeds. Callers read the failure count as
 * `chunks - embedded - unchanged`.
 */
export async function indexEntity(
  deps: { db: Db; embed: EmbedPort },
  entityType: SearchEntityType, entityId: string,
): Promise<{ chunks: number; embedded: number; unchanged: number }> {
  const rendered = await loadAndRender(deps.db, entityType, entityId);
  const existing = await deps.db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, entityType),
      eq(schema.searchChunks.entityId, entityId)));
  const byIndex = new Map(existing.map((c) => [c.chunkIndex, c]));

  const pending: RenderedChunk[] = [];
  let unchanged = 0;
  for (const chunk of rendered) {
    const prev = byIndex.get(chunk.chunkIndex);
    // Identical text that already carries a vector is left completely alone.
    // A NULL embedding means a previous attempt failed, so it is retried.
    if (prev && prev.sourceHash === chunk.sourceHash && prev.embedding !== null) {
      unchanged++;
      continue;
    }
    pending.push(chunk);
  }

  let vectors: (number[] | null)[] = [];
  if (pending.length > 0) {
    try {
      vectors = await deps.embed.embed(
        pending.map((c) => asDocument(`${c.title}\n${c.body}`)));
    } catch {
      // Ollama down: index the chunks lexically now, retry the vectors later.
      vectors = [];
    }
  }

  let embedded = 0;
  for (const [i, chunk] of pending.entries()) {
    const embedding = vectors[i] ?? null;
    await deps.db.insert(schema.searchChunks).values({
      entityType: chunk.entityType, entityId: chunk.entityId,
      chunkIndex: chunk.chunkIndex, title: chunk.title, body: chunk.body,
      occurredAt: chunk.occurredAt, status: chunk.status,
      embedding, sourceHash: chunk.sourceHash,
      embedAttempts: embedding ? 0 : 1, indexedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.searchChunks.entityType, schema.searchChunks.entityId,
        schema.searchChunks.chunkIndex],
      set: {
        title: chunk.title, body: chunk.body, occurredAt: chunk.occurredAt,
        status: chunk.status, embedding, sourceHash: chunk.sourceHash,
        // Failed attempts keep counting up so index health can surface a chunk
        // that never embeds; a success resets the counter.
        embedAttempts: embedding ? 0 : sql`${schema.searchChunks.embedAttempts} + 1`,
        indexedAt: new Date(),
      },
    });
    if (embedding) embedded++;
  }

  if (existing.some((c) => c.chunkIndex >= rendered.length)) {
    await deps.db.delete(schema.searchChunks).where(and(
      eq(schema.searchChunks.entityType, entityType),
      eq(schema.searchChunks.entityId, entityId),
      gte(schema.searchChunks.chunkIndex, rendered.length)));
  }

  return { chunks: rendered.length, embedded, unchanged };
}
```

19. **Run it, see it pass.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity.test.ts
```
Expected: `Tests  12 passed (12)`.

20. **Typecheck and run the whole api suite.**
```bash
cd /Users/martin/Workspace/mp/verder && env -u NODE_ENV pnpm --filter @verder/api typecheck && env -u NODE_ENV pnpm --filter @verder/api test
```
Expected: `typecheck` prints nothing and exits 0; the test summary ends with
`Test Files  … passed` and no `failed` count. (`packages/api/vitest.config.ts` already sets
`fileParallelism: false`, so these DB-backed files never race the other api suites.)

21. **Commit.**
```bash
cd /Users/martin/Workspace/mp/verder && git add packages/api/src/search/index-entity.ts packages/api/src/search/index-entity.test.ts && git commit -m "feat(api): incremental search_chunks upsert with hash-gated embedding"
```

**Success criteria for Task 5**
- `env -u NODE_ENV pnpm --filter @verder/api test` green; `env -u NODE_ENV pnpm --filter @verder/api typecheck` silent.
- `loadAndRender` covers all nine `SearchEntityType` values, and the `never` guard in the
  `default` arm makes a tenth type a compile error.
- The three effective-status helpers are **called, not copied**: verify with
  `grep -n "effectiveDocument\|effectiveTaskStatus\|effectiveStatus" packages/api/src/search/index-entity.ts`
  — three import lines and four call sites, and no `documentStatusChanges`,
  `taskStatusChanges` or `registryDecisions` query anywhere in the file.
- `document_texts` is read: `grep -n "documentTexts" packages/api/src/search/index-entity.ts`
  returns the `select` in the `document` branch. This is the only consumer of the table that
  Task 3 fills.
- Re-indexing unchanged content calls `EmbedPort.embed` zero times (asserted, not assumed).
- No `ledger_events` insert and no `appendLedgerEvent` import in
  `packages/api/src/search/index-entity.ts` — the index is derived, and the append-only law
  is untouched.

### Task 6: Trigger outbox on the fourteen source tables

**Files:**
- Create: `packages/db/drizzle/0017_search_triggers.sql` (hand-written `--custom` migration; Step 4's command creates the file, the journal entry and the snapshot)
- Create: `packages/db/src/search-outbox.test.ts`
- Modify: nothing in `packages/db/src/schema.ts` — drizzle-kit 0.30.6 cannot express `CREATE FUNCTION` / `CREATE TRIGGER`, so this migration is SQL-only and the schema file stays exactly as Task 1 left it.

**Interfaces:**

*Consumes (from Task 1 — the derived-index schema, migration `0015_knowledge_base.sql`):*
```ts
// packages/db/src/schema.ts
export const searchOutbox = pgTable("search_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
});
```

*Consumes (from Task 2 — grants, migration `0016_search_grants.sql`):*
```
search_outbox : verder_app SELECT | verder_worker SELECT, DELETE
```
**Neither role has INSERT on `search_outbox`.** That is the whole point of this task: rows arrive only through a `SECURITY DEFINER` function owned by the `verder` admin role, so no application code can write junk into the outbox and no sequence grant is needed for `search_outbox_id_seq`.

*Produces (consumed by Task 7's `search.drain` job):*
```sql
-- Postgres objects, not TS exports:
FUNCTION public.search_enqueue()                     -- SECURITY DEFINER, TG_ARGV[0] = entity type,
                                                     -- TG_ARGV[1] = the column on NEW holding the entity id
FUNCTION public.search_enqueue_registry_decision()   -- SECURITY DEFINER, routes on which FK is non-null

-- Nine entity triggers (the row IS the indexed entity):
documents_search_outbox_trg              ON documents             -> 'document'
log_entries_search_outbox_trg            ON log_entries           -> 'entry'
raw_emails_search_outbox_trg             ON raw_emails            -> 'email'
financial_items_search_outbox_trg        ON financial_items       -> 'financial_item'
debts_search_outbox_trg                  ON debts                 -> 'debt'
tasks_search_outbox_trg                  ON tasks                 -> 'task'
milestones_search_outbox_trg             ON milestones            -> 'milestone'
timeline_events_search_outbox_trg        ON timeline_events       -> 'timeline_event'
parties_search_outbox_trg                ON parties               -> 'party'

-- Five parent-refresh triggers (the row is a CHILD whose content the parent renders):
document_status_changes_search_outbox_trg ON document_status_changes -> 'document'       via NEW.document_id
task_status_changes_search_outbox_trg     ON task_status_changes     -> 'task'           via NEW.task_id
entry_participants_search_outbox_trg      ON entry_participants      -> 'entry'          via NEW.entry_id
entry_documents_search_outbox_trg         ON entry_documents         -> 'entry'          via NEW.entry_id
registry_decisions_search_outbox_trg      ON registry_decisions      -> 'financial_item' via NEW.financial_item_id
                                                                     -> 'debt'           via NEW.debt_id
```
The nine `entity_type` strings are exactly `SEARCH_ENTITY_TYPES` from `packages/core/src/search/entity-types.ts` (Task 4). Do not invent new spellings.

The five parent-refresh triggers are not optional decoration. `loadAndRender` (Task 5) renders a document's effective status and title from `document_status_changes`, a task's status from `task_status_changes`, a financial item's / debt's status from `registry_decisions`, and an entry's participants and attached documents from `entry_participants` / `entry_documents`. Approving a doc-meta suggestion writes `document_status_changes` and never touches `documents` (see `packages/api/src/routers/suggestions.ts`), so without trigger #10 the most common queue action in the app would silently never reindex.

---

- [ ] **Step 1:** Bring the dev database up and migrated through Task 2:
```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
```
Expected tail: `[✓] migrations applied successfully!`. Confirm the derived tables and their grants are really there:
```bash
docker compose exec -T postgres psql -U verder -d verder -c "\dp search_outbox"
```
Expected: one row for `search_outbox` whose `Access privileges` cell contains the two lines `verder_app=r/verder` and `verder_worker=rd/verder`. If that cell shows `arwd` for either role, Task 2 is not merged (or was merged wrong) and this task cannot be verified — fix Task 2's migration first.

- [ ] **Step 2:** Write the failing integration test. Create `packages/db/src/search-outbox.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// APP role: the triggers must work for the role the web app actually uses, and
// that role has NO INSERT grant on search_outbox (Task 2) — the SECURITY
// DEFINER function is the only thing that makes these rows land.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("search_outbox triggers", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];
  let userId: string;

  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  beforeAll(async () => {
    ({ db, pool } = createDb(APP_URL));
    const [u] = await db.insert(schema.users)
      .values({ email: `outbox${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  // The dev database is shared by every test file, so every assertion is scoped
  // to an entity id this test just created — never a global count.
  const outboxFor = (entityType: string, entityId: string) =>
    db.select().from(schema.searchOutbox)
      .where(and(eq(schema.searchOutbox.entityType, entityType),
        eq(schema.searchOutbox.entityId, entityId)));

  const makeDocument = async () => {
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha(), title: "Brief van de rechtbank", mime: "application/pdf",
      sizeBytes: 1234, source: "upload", receivedAt: new Date("2026-08-01T09:00:00Z"),
    }).returning();
    return doc;
  };

  const makeEntry = async () => {
    const [entry] = await db.insert(schema.logEntries).values({
      occurredAt: new Date("2026-08-01T10:00:00Z"), channel: "email",
      direction: "inbound", summary: "Bericht van VerderGroep ontvangen",
      source: "manual", createdBy: userId,
    }).returning();
    return entry;
  };

  it("enqueues exactly one row per insert on each of the nine entity tables", async () => {
    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `VerderGroep ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("party", party.id)).toHaveLength(1);

    const doc = await makeDocument();
    expect(await outboxFor("document", doc.id)).toHaveLength(1);

    const entry = await makeEntry();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);

    const [email] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `outbox-test-${crypto.randomUUID()}`,
      gmailThreadId: `thread-${crypto.randomUUID()}`,
      fromAddr: "contact@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Opzegging bevestigd", sentAt: new Date("2026-08-01T11:00:00Z"),
      rawRfc822Sha256: sha(), bodyText: "Uw opzegging is verwerkt.",
    }).returning();
    expect(await outboxFor("email", email.id)).toHaveLength(1);

    const [item] = await db.insert(schema.financialItems).values({
      name: `Ziggo ${crypto.randomUUID()}`, category: "telecom", amountCents: 5500,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    expect(await outboxFor("financial_item", item.id)).toHaveLength(1);

    const [debt] = await db.insert(schema.debts)
      .values({ creditorName: `Intrum ${crypto.randomUUID()}`, claimedCents: 120000 }).returning();
    expect(await outboxFor("debt", debt.id)).toHaveLength(1);

    const [task] = await db.insert(schema.tasks)
      .values({ title: "Kopie paspoort opsturen", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);

    const [milestone] = await db.insert(schema.milestones)
      .values({ stage: "onboarding", title: "Onboarding gestart (outbox test)" }).returning();
    expect(await outboxFor("milestone", milestone.id)).toHaveLength(1);

    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Verzoek verstuurd naar de rechtbank",
      happenedAt: new Date("2026-08-01T12:00:00Z"), kind: "process",
    }).returning();
    expect(await outboxFor("timeline_event", event.id)).toHaveLength(1);
  });

  it("enqueues a second row when an entity row is UPDATEd", async () => {
    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Tyop in het onderwerp", happenedAt: new Date("2026-08-02T09:00:00Z"),
    }).returning();
    expect(await outboxFor("timeline_event", event.id)).toHaveLength(1);
    await db.update(schema.timelineEvents).set({ title: "Typo in het onderwerp" })
      .where(eq(schema.timelineEvents.id, event.id));
    expect(await outboxFor("timeline_event", event.id)).toHaveLength(2);

    const [task] = await db.insert(schema.tasks)
      .values({ title: "Bankafschrift zoeken", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);
    await db.update(schema.tasks).set({ details: "Q2 2026" })
      .where(eq(schema.tasks.id, task.id));
    expect(await outboxFor("task", task.id)).toHaveLength(2);
  });

  it("refreshes the parent document when a status change lands", async () => {
    const doc = await makeDocument();
    expect(await outboxFor("document", doc.id)).toHaveLength(1);
    // Approving a doc-meta suggestion writes here and never touches `documents`.
    await db.insert(schema.documentStatusChanges).values({
      documentId: doc.id, status: "filed", title: "Beschikking rechtbank",
      docType: "beschikking",
    });
    expect(await outboxFor("document", doc.id)).toHaveLength(2);
  });

  it("refreshes the parent task when a status change lands", async () => {
    const [task] = await db.insert(schema.tasks)
      .values({ title: "Loonstrook uploaden", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);
    await db.insert(schema.taskStatusChanges)
      .values({ taskId: task.id, status: "in-progress", createdBy: userId });
    expect(await outboxFor("task", task.id)).toHaveLength(2);
  });

  it("refreshes the financial item a registry decision targets", async () => {
    const [item] = await db.insert(schema.financialItems).values({
      name: `Eneco ${crypto.randomUUID()}`, category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    expect(await outboxFor("financial_item", item.id)).toHaveLength(1);
    await db.insert(schema.registryDecisions).values({
      financialItemId: item.id, status: "mandatory",
      explanation: "Energie is een vaste last.", createdBy: userId,
    });
    expect(await outboxFor("financial_item", item.id)).toHaveLength(2);
  });

  it("refreshes the debt a registry decision targets, and not a financial item", async () => {
    const [debt] = await db.insert(schema.debts)
      .values({ creditorName: `Vesting ${crypto.randomUUID()}`, claimedCents: 84000 }).returning();
    expect(await outboxFor("debt", debt.id)).toHaveLength(1);
    await db.insert(schema.registryDecisions).values({
      debtId: debt.id, status: "acknowledged",
      explanation: "Vordering erkend na controle.", createdBy: userId,
    });
    expect(await outboxFor("debt", debt.id)).toHaveLength(2);
    // The routing branch must not fire the other way round.
    expect(await outboxFor("financial_item", debt.id)).toHaveLength(0);
  });

  it("refreshes the parent entry when a participant is linked", async () => {
    const entry = await makeEntry();
    const [party] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Bewindvoerder ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);
    await db.insert(schema.entryParticipants).values({ entryId: entry.id, partyId: party.id });
    expect(await outboxFor("entry", entry.id)).toHaveLength(2);
  });

  it("refreshes the parent entry when a document is linked", async () => {
    const entry = await makeEntry();
    const doc = await makeDocument();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);
    await db.insert(schema.entryDocuments).values({ entryId: entry.id, documentId: doc.id });
    expect(await outboxFor("entry", entry.id)).toHaveLength(2);
  });

  it("appends no ledger events — the index is derived, not evidence", async () => {
    const [party] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Ledgerloos ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("party", party.id)).toHaveLength(1);
    const events = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, party.id));
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 3:** Run it and watch it fail: `env -u NODE_ENV pnpm --filter @verder/db test src/search-outbox.test.ts`. The tables exist (Task 1) but nothing writes to the outbox yet, so the first assertion of the first test fails:
```
AssertionError: expected [] to have a length of 1 but got +0
```

- [ ] **Step 4:** Create the migration skeleton so drizzle assigns the index, the journal entry and the snapshot:
```bash
env -u NODE_ENV pnpm --filter @verder/db exec drizzle-kit generate --custom --name=search_triggers
```
The journal currently holds `0000`–`0016`, so this writes `packages/db/drizzle/0017_search_triggers.sql`. Use that path; do not rename it.

- [ ] **Step 5:** Write the two trigger functions into the top of `packages/db/drizzle/0017_search_triggers.sql`:

```sql
-- Search outbox triggers (sub-project 4 — DERIVED index, no ledger events).
--
-- FOURTEEN AFTER INSERT OR UPDATE row triggers write (entity_type, entity_id)
-- into search_outbox; the search.drain worker job dedupes and re-indexes.
-- Chosen over calling an enqueue helper at each mutation site: there are dozens
-- of those across four routers and the worker, and one forgotten call is an
-- invisible bug (a record that silently never becomes findable). A trigger
-- catches every path, manual psql included.
--
-- SECURITY DEFINER: the function runs as its owner (the `verder` admin role
-- that runs migrations), so verder_app and verder_worker need no INSERT grant
-- on search_outbox and no grant on its sequence — they can never write junk
-- into the outbox directly, only by touching a real record. search_path is
-- pinned so the function can never be tricked into resolving `search_outbox`
-- in an attacker-controlled schema.
--
-- TG_ARGV[0] is the entity_type; TG_ARGV[1] is the column on NEW that holds the
-- entity id. That second argument is what lets ONE function serve both the nine
-- entity tables ('id') and the four single-parent child tables
-- ('document_id', 'task_id', 'entry_id'). Status and relations live in those
-- child tables: an approved doc-meta suggestion writes document_status_changes
-- and never touches documents, so without the child triggers the most common
-- queue action would never reindex.
CREATE OR REPLACE FUNCTION public.search_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
BEGIN
  target := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  IF target IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id) VALUES (TG_ARGV[0], target);
  END IF;
  RETURN NULL; -- AFTER trigger: the return value is ignored
END $$;
--> statement-breakpoint
-- registry_decisions is the one child table with TWO possible parents. Its
-- check constraint registry_decision_target_ck guarantees exactly one of the
-- two FKs is non-null, so the routing below is total.
CREATE OR REPLACE FUNCTION public.search_enqueue_registry_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.financial_item_id IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id)
      VALUES ('financial_item', NEW.financial_item_id);
  ELSIF NEW.debt_id IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id)
      VALUES ('debt', NEW.debt_id);
  END IF;
  RETURN NULL;
END $$;
```

- [ ] **Step 6:** Append the fourteen triggers to the same file, below the two functions:

```sql
--> statement-breakpoint
-- The nine entity tables: the row IS the indexed entity.
CREATE OR REPLACE TRIGGER "documents_search_outbox_trg" AFTER INSERT OR UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "log_entries_search_outbox_trg" AFTER INSERT OR UPDATE ON "log_entries"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "raw_emails_search_outbox_trg" AFTER INSERT OR UPDATE ON "raw_emails"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('email', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "financial_items_search_outbox_trg" AFTER INSERT OR UPDATE ON "financial_items"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('financial_item', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "debts_search_outbox_trg" AFTER INSERT OR UPDATE ON "debts"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('debt', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "tasks_search_outbox_trg" AFTER INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('task', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "milestones_search_outbox_trg" AFTER INSERT OR UPDATE ON "milestones"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('milestone', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "timeline_events_search_outbox_trg" AFTER INSERT OR UPDATE ON "timeline_events"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('timeline_event', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "parties_search_outbox_trg" AFTER INSERT OR UPDATE ON "parties"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('party', 'id');
--> statement-breakpoint
-- The five parent-refresh tables: the row is a CHILD whose content the parent's
-- rendered text contains (effective status, participants, attached documents).
CREATE OR REPLACE TRIGGER "document_status_changes_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "document_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'document_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "task_status_changes_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "task_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('task', 'task_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entry_participants_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "entry_participants"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'entry_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entry_documents_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "entry_documents"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'entry_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "registry_decisions_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "registry_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue_registry_decision();
```

- [ ] **Step 7:** Apply the migration: `env -u NODE_ENV pnpm --filter @verder/db migrate`. Expected tail: `[✓] migrations applied successfully!`.

- [ ] **Step 8:** Run the test again and watch it pass: `env -u NODE_ENV pnpm --filter @verder/db test src/search-outbox.test.ts`. Expected:
```
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

- [ ] **Step 9:** Verify by hand that all fourteen triggers are installed and enabled:
```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "SELECT count(*) AS triggers FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\_search\_outbox\_trg';"
```
Expected:
```
 triggers 
----------
       14
```

- [ ] **Step 10:** Verify the app role has no direct write path into the outbox — this is exactly what `SECURITY DEFINER` buys, and Task 2 granted `verder_app` `SELECT` only:
```bash
docker compose exec -T postgres psql -U verder_app -d verder \
  -c "INSERT INTO search_outbox (entity_type, entity_id) VALUES ('party', gen_random_uuid());"
```
Required output:
```
ERROR:  permission denied for table search_outbox
```
If that INSERT succeeds, Task 2's grants migration is wrong (it granted more than `SELECT`); fix `0016_search_grants.sql` there rather than working around it here.

- [ ] **Step 11:** Confirm nothing else broke — the triggers now fire on every insert in every other suite:
```bash
env -u NODE_ENV pnpm --filter @verder/db test \
  && env -u NODE_ENV pnpm --filter @verder/api test \
  && env -u NODE_ENV pnpm --filter worker test
```
All three must end with `Test Files … passed` and no `failed`.

- [ ] **Step 12:** Commit:
```bash
git add packages/db/drizzle packages/db/src/search-outbox.test.ts
git commit -m "feat(db): search outbox triggers on the fourteen source tables"
```

---

### Task 7: Embedding client + the `search.drain` worker job

**Files:**
- Write in full: `packages/api/src/search/embed.ts`
- Modify: `packages/api/src/search/embed.test.ts` (created in Task 5)
- Create: `packages/api/src/search/health.ts`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/src/search-drain.ts`
- Create: `apps/worker/src/search-drain.test.ts`
- Modify: `apps/worker/src/index.ts` (new queue, schedule, worker)
- Modify: `/Users/martin/Workspace/mp/verder/.env.example` (`OLLAMA_EMBED_MODEL`)

**Interfaces:**

*Consumes (from Task 5 — the entity loader):*
```ts
// packages/api/src/search/index-entity.ts
export async function indexEntity(
  deps: { db: Db; embed: EmbedPort },
  entityType: SearchEntityType, entityId: string,
): Promise<{ chunks: number; embedded: number; unchanged: number }>;
// Upserts search_chunks; re-embeds ONLY chunks whose sourceHash changed;
// deletes chunks with chunk_index >= the new chunk count; returns
// { chunks: 0, embedded: 0, unchanged: 0 } when the row no longer exists.
```
Task 5 also placed the five declarations it needed to type `indexEntity`'s deps into `packages/api/src/search/embed.ts` — `EMBED_DIMENSIONS`, `EmbedPort`, `EMBED_MODEL_ENV`, `asDocument` and `asQuery`:
```ts
export const EMBED_DIMENSIONS = 768;
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
```
This task owns that file from here on: Step 3 writes it in full, re-declaring both of those exports byte-identically and adding the real client around them, so nothing that already imports them breaks.

*Consumes (from Task 4 — pure search primitives):*
```ts
// packages/core/src/search/entity-types.ts, re-exported from packages/core/src/index.ts
export type SearchEntityType =
  | "document" | "entry" | "email" | "financial_item" | "debt"
  | "task" | "milestone" | "timeline_event" | "party";
```

*Consumes (from Task 6 — the fourteen triggers) and (from Task 1 — the schema):*
```ts
// packages/db/src/schema.ts (Task 1)
schema.searchOutbox  // { id: number; entityType: string; entityId: string; enqueuedAt: Date }
schema.searchChunks  // { id: string; entityType: string; entityId: string; chunkIndex: number;
                     //   title: string; body: string; occurredAt: Date | null; status: string | null;
                     //   embedding: number[] | null; sourceHash: string;
                     //   embedAttempts: number; indexedAt: Date }
```
Task 2 granted `verder_worker` `SELECT, DELETE` on `search_outbox` and `SELECT, INSERT, UPDATE, DELETE` on `search_chunks`. The drain never INSERTs into `search_outbox` — only the trigger function does.

*Produces:*
```ts
// packages/api/src/search/embed.ts
export const EMBED_DIMENSIONS = 768;
export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";        // default "nomic-embed-text"
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
export function asDocument(text: string): string;           // "search_document: " + text
export function asQuery(text: string): string;              // "search_query: " + text
export function realEmbedPort(opts?: { url?: string; model?: string; timeoutMs?: number }): EmbedPort;

// packages/api/src/search/health.ts
export const DRAIN_WORKER_NAME = "search-drain";  // the ONLY definition of this string
// Task 13 adds `IndexHealth` and `readIndexHealth(db)` to this same file, so the
// job that writes worker_runs and the health read that looks for it can never drift.

// apps/worker/src/search-drain.ts
export interface DrainResult { claimed: number; indexed: number; failed: number }
export function drainOnce(
  deps: { db: Db; embed: EmbedPort },
  opts?: { limit?: number; entityIds?: string[] },
): Promise<DrainResult>;
```
`worker_runs.worker` gains one new value: `"search-drain"` (always written via `DRAIN_WORKER_NAME`).

---

- [ ] **Step 1:** Write the failing embedding-client test. Create `packages/api/src/search/embed.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asDocument, asQuery, EMBED_DIMENSIONS, EMBED_MODEL_ENV, realEmbedPort,
} from "./embed";

const vec = (n: number) => Array.from({ length: EMBED_DIMENSIONS }, () => n);
const ok = (embeddings: number[][]) =>
  new Response(JSON.stringify({ embeddings }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("nomic task prefixes", () => {
  it("prefixes stored text with search_document and queries with search_query", () => {
    // nomic-embed-text is asymmetric: the wrong prefix silently costs recall,
    // and nothing about the results looks broken when it happens.
    expect(EMBED_MODEL_ENV).toBe("OLLAMA_EMBED_MODEL");
    expect(asDocument("Opzegging Ziggo")).toBe("search_document: Opzegging Ziggo");
    expect(asQuery("opzegging ziggo")).toBe("search_query: opzegging ziggo");
  });
});

describe("realEmbedPort", () => {
  it("posts to /api/embed with the configured url and model and an abort signal", async () => {
    const fetchMock = vi.fn(async () => ok([vec(1)]));
    vi.stubGlobal("fetch", fetchMock);
    await realEmbedPort({ url: "http://gpu.local:11434", model: "nomic-embed-text" })
      .embed(["search_document: hallo"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gpu.local:11434/api/embed");
    const body = JSON.parse(String(init.body)) as { model: string; input: string[] };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["search_document: hallo"]);
    // Without this the drain can hang forever on a wedged Ollama.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads the model from OLLAMA_EMBED_MODEL when no model is passed", async () => {
    const fetchMock = vi.fn(async () => ok([vec(1)]));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv(EMBED_MODEL_ENV, "nomic-embed-text:v1.5");
    await realEmbedPort().embed(["a"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { model: string }).model)
      .toBe("nomic-embed-text:v1.5");
  });

  it("returns one vector per text, in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([vec(1), vec(2)])));
    const out = await realEmbedPort().embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBe(1);
    expect(out[1]![0]).toBe(2);
  });

  it("splits into batches of 16 and never runs more than 2 in flight", async () => {
    // Ollama on the homelab is shared with qwen3.5:9b (suggest.entry,
    // registry.mine and three evals); a stampede here starves those.
    let inFlight = 0;
    let peak = 0;
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      sizes.push(body.input.length);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(body.input.map(() => vec(3)));
    }));
    const out = await realEmbedPort().embed(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(40);
    expect(out.every((v) => v !== null)).toBe(true);
    expect(sizes).toEqual([16, 16, 8]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retries a failing batch with backoff and succeeds", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return ok([vec(4)]);
    }));
    const out = await realEmbedPort().embed(["a"]); // ~250 ms of real backoff
    expect(n).toBe(2);
    expect(out[0]![0]).toBe(4);
  });

  it("gives up after three attempts and returns null — chunks stay lexically searchable", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await realEmbedPort().embed(["a"]); // ~750 ms of real backoff
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out).toEqual([null]);
  });

  it("rejects a wrong-width reply rather than storing a corrupt vector", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([[1, 2, 3]])));
    const out = await realEmbedPort().embed(["a"]);
    expect(out).toEqual([null]);
  });
});
```

- [ ] **Step 2:** Run it and watch it fail: `env -u NODE_ENV pnpm --filter @verder/api test src/search/embed.test.ts`. `packages/api/src/search/embed.ts` already holds Task 5's `EMBED_DIMENSIONS`, `EmbedPort`, `EMBED_MODEL_ENV`, `asDocument` and `asQuery`, so the constant and prefix assertions pass. `realEmbedPort` is the one export Task 5 did not write, so the failure lands on the first test that constructs a port:
```
TypeError: realEmbedPort is not a function
```

- [ ] **Step 3:** Write `packages/api/src/search/embed.ts` in full — the five declarations Task 5 put there are re-declared unchanged:

```ts
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Ollama embedding client (nomic-embed-text, 768 dims): the vector half of the
 * hybrid index. Mirrors LlmPort in apps/worker/src/ollama.ts — an injectable
 * port with one real implementation reading env — so the indexer, the drain and
 * the search router are all testable without a GPU.
 *
 * It lives in @verder/api rather than the worker because three consumers need
 * it: the indexer (packages/api/src/search/index-entity.ts), the query pipeline
 * (packages/api/src/search/retrieve.ts) and the drain job in apps/worker.
 *
 * Ollama on the homelab is shared with qwen3.5:9b (suggest.entry, registry.mine
 * and three evals), so this client is deliberately polite: batches of 16, at
 * most 2 requests in flight, an explicit timeout, and three attempts with
 * exponential backoff. A permanently failing batch yields nulls rather than an
 * exception — a chunk without an embedding is still findable by full text, and
 * that is the spec's documented degraded mode. A THROWN error from this port is
 * therefore a genuine fault (a crashed client, a bug), never "Ollama is down".
 */

export const EMBED_DIMENSIONS = 768;
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };

export const EMBED_MODEL_ENV = "OLLAMA_EMBED_MODEL";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 16;
const CONCURRENCY = 2;
const ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

/** nomic is asymmetric: indexed text carries this prefix. */
export function asDocument(text: string): string {
  return `search_document: ${text}`;
}

/** …and query text carries this one. Used by the query pipeline. */
export function asQuery(text: string): string {
  return `search_query: ${text}`;
}

async function embedBatch(
  url: string, model: string, timeoutMs: number, texts: string[],
): Promise<number[][]> {
  const res = await fetch(`${url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const vectors = data.embeddings ?? [];
  if (vectors.length !== texts.length) {
    throw new Error(`ollama embed returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const v of vectors) {
    // A wrong-width vector cannot go into vector(768) and must never be
    // half-written: fail the whole batch instead.
    if (v.length !== EMBED_DIMENSIONS) {
      throw new Error(`ollama embed dims ${v.length} != ${EMBED_DIMENSIONS}`);
    }
  }
  return vectors;
}

export function realEmbedPort(
  opts: { url?: string; model?: string; timeoutMs?: number } = {},
): EmbedPort {
  const url = opts.url ?? process.env.OLLAMA_URL ?? DEFAULT_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async embed(texts) {
      const model = opts.model ?? process.env[EMBED_MODEL_ENV] ?? DEFAULT_MODEL;
      const out: (number[] | null)[] = new Array<number[] | null>(texts.length).fill(null);
      const starts: number[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) starts.push(i);
      let next = 0;
      const runner = async (): Promise<void> => {
        for (;;) {
          const slot = next++;
          if (slot >= starts.length) return;
          const start = starts[slot]!;
          const batch = texts.slice(start, start + BATCH_SIZE);
          for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            try {
              const vectors = await embedBatch(url, model, timeoutMs, batch);
              vectors.forEach((v, i) => { out[start + i] = v; });
              break;
            } catch {
              // Last attempt: those slots stay null and the caller keeps the
              // chunk lexically searchable.
              if (attempt < ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, starts.length) }, () => runner()));
      return out;
    },
  };
}
```

- [ ] **Step 4:** Run it and watch it pass: `env -u NODE_ENV pnpm --filter @verder/api test src/search/embed.test.ts`. Expected (the two backoff tests spend ~1 s of real time):
```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

- [ ] **Step 5:** Document the new env var. In `/Users/martin/Workspace/mp/verder/.env.example`, replace these three lines:
```
# --- AI (local Ollama only) -------------------------------------------------
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:9b
```
with:
```
# --- AI (local Ollama only) -------------------------------------------------
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:9b
# Embedding model for the search index (768 dims, asymmetric task prefixes).
# Pull once on the machine running Ollama: ollama pull nomic-embed-text
OLLAMA_EMBED_MODEL=nomic-embed-text
```

- [ ] **Step 6:** Commit:
```bash
git add packages/api/src/search/embed.ts packages/api/src/search/embed.test.ts .env.example
git commit -m "feat(api): ollama embedding client with nomic prefixes and retry"
```

- [ ] **Step 7:** Create `packages/api/src/search/health.ts` — the single definition of the worker name, so the job that writes `worker_runs` and the `/verify` health read that looks for it can never drift apart:

```ts
/**
 * The `worker_runs.worker` value written by the search.drain job in
 * apps/worker/src/search-drain.ts, and read back by index health on /verify.
 * Defined once, here, and imported by both — a typo on either side would make
 * a stalled index look healthy.
 */
export const DRAIN_WORKER_NAME = "search-drain";
```

- [ ] **Step 8:** Create `apps/worker/vitest.config.ts`. Without it the worker's test files run in parallel against the one shared dev database, and the drain tests below would race every other suite's inserts through the fourteen triggers of Task 6:

```ts
import { defineConfig } from "vitest/config";

// Test files share one dev postgres. The search-drain suite claims rows from
// the single global search_outbox that every other suite's inserts fill via the
// triggers, so files must not run concurrently against the shared database —
// same reason, same fix as packages/api/vitest.config.ts.
export default defineConfig({
  test: { fileParallelism: false },
});
```

- [ ] **Step 9:** Confirm the worker suite still passes under the new config: `env -u NODE_ENV pnpm --filter worker test`. Expected: the summary ends with `Test Files … passed` and no `failed`. Commit:
```bash
git add packages/api/src/search/health.ts apps/worker/vitest.config.ts
git commit -m "chore(worker): serial test files and the shared drain worker name"
```

- [ ] **Step 10:** Write the failing drain test. Create `apps/worker/src/search-drain.test.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { EMBED_DIMENSIONS, type EmbedPort } from "@verder/api/src/search/embed";
import { DRAIN_WORKER_NAME } from "@verder/api/src/search/health";
import { drainOnce } from "./search-drain";

const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

const vec = (n: number) => Array.from({ length: EMBED_DIMENSIONS }, () => n);

/** Records every text it is asked to embed so a test can assert on the texts
 *  that belong to IT — the dev database is shared and every other suite keeps
 *  filling the same outbox. */
function recordingEmbed(mode: "ok" | "null" = "ok") {
  const seen: string[] = [];
  const port: EmbedPort = {
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => (mode === "ok" ? vec(1) : null));
    },
  };
  return { port, seen };
}

async function makeEvent(db: ReturnType<typeof createDb>["db"], title: string) {
  const [event] = await db.insert(schema.timelineEvents)
    .values({ title, happenedAt: new Date("2026-08-03T09:00:00Z"), kind: "mail" })
    .returning();
  return event;
}

const chunksFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "timeline_event"),
      eq(schema.searchChunks.entityId, entityId)));

const outboxFor = (db: ReturnType<typeof createDb>["db"], entityId: string) =>
  db.select().from(schema.searchOutbox)
    .where(eq(schema.searchOutbox.entityId, entityId));

describe("drainOnce", () => {
  it("indexes an enqueued entity, deletes its outbox row and records the run", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Opzegging Ziggo bevestigd ${crypto.randomUUID()}`);
    const { port, seen } = recordingEmbed("ok");

    const result = await drainOnce({ db, embed: port }, { entityIds: [event.id] });

    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    const chunks = await chunksFor(db, event.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.embedding).not.toBeNull();
    expect(chunks[0]!.embedAttempts).toBe(0);
    // Indexed text carries nomic's document prefix; the query side uses
    // asQuery. Mixing the two silently halves recall.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith("search_document: ")).toBe(true);
    expect(seen[0]).toContain(event.title);
    expect(await outboxFor(db, event.id)).toHaveLength(0);
    // The sweep is visible to index health on /verify.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME));
    expect(runs.length).toBeGreaterThan(0);
    await pool.end();
  });

  it("re-embeds nothing when a touch leaves the rendered text unchanged", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Onveranderd ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [event.id] });

    // An UPDATE always fires the trigger, even when it writes the same value,
    // so the entity is re-enqueued while its rendered text is identical — that
    // is exactly what source_hash exists for.
    await db.update(schema.timelineEvents).set({ title: event.title })
      .where(eq(schema.timelineEvents.id, event.id));
    expect(await outboxFor(db, event.id)).toHaveLength(1);

    const second = recordingEmbed("ok");
    const result = await drainOnce({ db, embed: second.port }, { entityIds: [event.id] });

    expect(second.seen).toHaveLength(0);
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(await chunksFor(db, event.id)).toHaveLength(1);
    expect(await outboxFor(db, event.id)).toHaveLength(0);
    await pool.end();
  });

  it("keeps the entity enqueued when the embedding fails, and the chunk lexically searchable", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Opzegging per 1 oktober ${crypto.randomUUID()}`);

    // Ollama down: the port signals per-text failure with null, never a throw.
    const result = await drainOnce({ db, embed: recordingEmbed("null").port },
      { entityIds: [event.id] });

    expect(result).toEqual({ claimed: 1, indexed: 0, failed: 0 });
    const [chunk] = await chunksFor(db, event.id);
    expect(chunk).toBeDefined();
    expect(chunk!.embedding).toBeNull();
    expect(chunk!.embedAttempts).toBe(1);
    // Left in the outbox on purpose, so the next sweep retries the vector once
    // Ollama is back. A stuck backlog shows up as outbox depth on /verify.
    expect(await outboxFor(db, event.id)).toHaveLength(1);

    // Dutch stemming over the generated tsvector column: 'opzeggen' finds
    // 'Opzegging' with no vector involved at all.
    const rows = (await db.execute(sql`
      SELECT embedding IS NULL AS no_vector FROM search_chunks
      WHERE entity_type = 'timeline_event' AND entity_id = ${event.id}
        AND tsv @@ websearch_to_tsquery('dutch', 'opzeggen')`))
      .rows as { no_vector: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.no_vector).toBe(true);
    await pool.end();
  });

  it("does not let one failing entity stop the sweep", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const bad = await makeEvent(db, `Kapot ${marker}`);
    const good = await makeEvent(db, `Goed ${marker}`);
    // A THROW from the port is a genuine fault (a crashed client), not the
    // documented Ollama-down path, and must propagate out of indexEntity so the
    // drain can isolate it to the one entity being indexed.
    const port: EmbedPort = {
      embed: async (texts) => {
        if (texts.some((t) => t.includes(`Kapot ${marker}`))) {
          throw new Error("embed client crashed");
        }
        return texts.map(() => vec(1));
      },
    };

    const result = await drainOnce({ db, embed: port }, { entityIds: [bad.id, good.id] });

    expect(result).toEqual({ claimed: 2, indexed: 1, failed: 1 });
    expect(await chunksFor(db, good.id)).toHaveLength(1);
    expect(await outboxFor(db, good.id)).toHaveLength(0);
    expect(await outboxFor(db, bad.id)).toHaveLength(1); // retried next sweep
    const runs = await db.select().from(schema.workerRuns)
      .where(and(eq(schema.workerRuns.worker, DRAIN_WORKER_NAME),
        eq(schema.workerRuns.status, "error")));
    expect(runs.length).toBeGreaterThan(0);
    await pool.end();
  });

  it("scopes the sweep to entityIds and respects limit", async () => {
    const { db, pool } = createDb(DB_URL);
    const marker = crypto.randomUUID();
    const first = await makeEvent(db, `Eerste ${marker}`);
    const second = await makeEvent(db, `Tweede ${marker}`);

    const result = await drainOnce({ db, embed: recordingEmbed("ok").port },
      { entityIds: [first.id, second.id], limit: 1 });

    // Claimed in outbox id order, so the first event and nothing else.
    expect(result).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(await chunksFor(db, first.id)).toHaveLength(1);
    expect(await chunksFor(db, second.id)).toHaveLength(0);
    expect(await outboxFor(db, second.id)).toHaveLength(1);
    await pool.end();
  });

  it("appends no ledger events — indexing is derived, not evidence", async () => {
    const { db, pool } = createDb(DB_URL);
    const event = await makeEvent(db, `Ledgerloos ${crypto.randomUUID()}`);
    await drainOnce({ db, embed: recordingEmbed("ok").port }, { entityIds: [event.id] });
    const events = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, event.id));
    expect(events).toHaveLength(0);
    await pool.end();
  });
});
```

- [ ] **Step 11:** Run it and watch it fail: `env -u NODE_ENV pnpm --filter worker test src/search-drain.test.ts`. Expected failure:
```
Error: Failed to resolve import "./search-drain" from "src/search-drain.test.ts". Does the file exist?
```

- [ ] **Step 12:** Implement the drain. Create `apps/worker/src/search-drain.ts`:

```ts
import { asc, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import type { SearchEntityType } from "@verder/core";
import { type EmbedPort } from "@verder/api/src/search/embed";
import { indexEntity } from "@verder/api/src/search/index-entity";
import { DRAIN_WORKER_NAME } from "@verder/api/src/search/health";
import { recordRun } from "./heartbeat";

/**
 * search.drain (cron, every 60 s): outbox rows -> deduped entities ->
 * indexEntity (re-render, re-chunk, re-embed only what changed, upsert) ->
 * delete the rows that are fully done.
 *
 * The index is DERIVED, not evidence: it appends no ledger events, and it may
 * UPDATE and DELETE its own rows. Nothing here can corrupt the record; the
 * worst it can do is fail to find something, which index health on /verify
 * makes visible.
 */

const DEFAULT_LIMIT = 500;

export interface DrainResult {
  claimed: number;
  indexed: number;
  failed: number;
}

export async function drainOnce(
  deps: { db: Db; embed: EmbedPort },
  opts: { limit?: number; entityIds?: string[] } = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // entityIds exists for the tests: the dev database is shared, so a suite that
  // drained the whole outbox would index — and with a stub embedder, mangle —
  // every other suite's records.
  if (opts.entityIds && opts.entityIds.length === 0) {
    return { claimed: 0, indexed: 0, failed: 0 };
  }

  // Claim by id, ascending. Anything enqueued while this sweep runs gets a
  // higher id and stays in the outbox, so a write during the sweep is never
  // lost.
  const claimed = opts.entityIds
    ? await deps.db.select().from(schema.searchOutbox)
        .where(inArray(schema.searchOutbox.entityId, opts.entityIds))
        .orderBy(asc(schema.searchOutbox.id)).limit(limit)
    : await deps.db.select().from(schema.searchOutbox)
        .orderBy(asc(schema.searchOutbox.id)).limit(limit);

  const result: DrainResult = { claimed: claimed.length, indexed: 0, failed: 0 };
  if (claimed.length === 0) {
    await recordRun(deps.db, DRAIN_WORKER_NAME, "ok", { ...result, retained: 0, failures: [] });
    return result;
  }

  // Dedupe: an entity touched ten times between sweeps is re-indexed once.
  const entities = new Map<string,
    { entityType: SearchEntityType; entityId: string; rowIds: number[] }>();
  for (const row of claimed) {
    const key = `${row.entityType}:${row.entityId}`;
    const seen = entities.get(key);
    if (seen) seen.rowIds.push(row.id);
    else entities.set(key, {
      entityType: row.entityType as SearchEntityType,
      entityId: row.entityId,
      rowIds: [row.id],
    });
  }

  const done: number[] = [];
  const failures: { scope: string; message: string }[] = [];

  for (const entity of entities.values()) {
    try {
      const { chunks, embedded, unchanged } = await indexEntity(
        { db: deps.db, embed: deps.embed }, entity.entityType, entity.entityId);
      if (embedded + unchanged === chunks) {
        // Every chunk has a vector (or the entity is gone and has no chunks at
        // all): the outbox rows can go.
        done.push(...entity.rowIds);
        result.indexed++;
      }
      // Otherwise some chunk landed with a NULL embedding — Ollama is down. The
      // chunks are written and lexically searchable, and the rows stay enqueued
      // so the next sweep retries the vectors. That is the spec's degraded
      // mode; the backlog is visible as outbox depth on /verify.
    } catch (err) {
      // One broken entity must never stop the sweep (same discipline as
      // registry.mine). Its rows stay enqueued and the failure is recorded.
      failures.push({ scope: `${entity.entityType}:${entity.entityId}`, message: String(err) });
      result.failed++;
    }
  }

  if (done.length > 0) {
    await deps.db.delete(schema.searchOutbox).where(inArray(schema.searchOutbox.id, done));
  }

  await recordRun(deps.db, DRAIN_WORKER_NAME, failures.length > 0 ? "error" : "ok",
    { ...result, entities: entities.size, retained: claimed.length - done.length, failures });
  return result;
}
```

- [ ] **Step 13:** Run it and watch it pass: `env -u NODE_ENV pnpm --filter worker test src/search-drain.test.ts`. Expected:
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

- [ ] **Step 14:** Typecheck and run the whole worker suite plus the api suite:
```bash
env -u NODE_ENV pnpm --filter worker typecheck \
  && env -u NODE_ENV pnpm --filter worker test \
  && env -u NODE_ENV pnpm --filter @verder/api test
```
All three must succeed (`Test Files … passed`, no `failed`). Commit:
```bash
git add apps/worker/src/search-drain.ts apps/worker/src/search-drain.test.ts
git commit -m "feat(worker): search.drain job over the trigger outbox"
```

- [ ] **Step 15:** Wire the queue into the worker process. In `apps/worker/src/index.ts`, add two lines directly below the last import, which is:
```ts
import { sendPush } from "./push";
```
so the import block ends with:
```ts
import { sendPush } from "./push";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { drainOnce } from "./search-drain";
```

- [ ] **Step 16:** In the same file, insert the queue immediately above the final line `console.log("worker up");`:
```ts
// Search index freshness: the fourteen triggers fill search_outbox and this is
// its only consumer. Every minute is pg-boss's finest cron granularity and the
// spec's 60 s target.
const embed = realEmbedPort();
await boss.createQueue("search.drain");
await boss.schedule("search.drain", "* * * * *");
await boss.work("search.drain", async () => {
  await drainOnce({ db, embed });
});
```

- [ ] **Step 17:** Typecheck the wiring: `env -u NODE_ENV pnpm --filter worker typecheck`. Expected: no output and exit code 0.

- [ ] **Step 18:** Manual verification of the wiring — there is no test for `index.ts` in this repo. With `docker compose up -d postgres` running and Ollama reachable at `OLLAMA_URL` with `nomic-embed-text` pulled:
```bash
env -u NODE_ENV pnpm --filter worker start
```
Expected: the process prints `worker up` and stays alive. In a second shell, touch a record and wait ~60 s for the drain:
```bash
docker compose exec -T postgres psql -U verder -d verder \
  -c "INSERT INTO timeline_events (title, happened_at) VALUES ('Drain rooktest opzegging', now());"
sleep 70
docker compose exec -T postgres psql -U verder -d verder \
  -c "SELECT status, detail FROM worker_runs WHERE worker = 'search-drain' ORDER BY ran_at DESC LIMIT 1;" \
  -c "SELECT title, embedding IS NOT NULL AS has_vector FROM search_chunks WHERE title LIKE '%Drain rooktest%';" \
  -c "SELECT count(*) AS outbox_depth FROM search_outbox;"
```
Expected: a `search-drain` run with status `ok`, one chunk row with `has_vector` = `t`, and `outbox_depth` back at or near 0. Stop the worker with Ctrl-C.

- [ ] **Step 19:** Full-suite gate and commit:
```bash
env -u NODE_ENV pnpm -r --if-present test
git add apps/worker/src/index.ts
git commit -m "feat(worker): schedule search.drain every 60 seconds"
```

### Task 8: Hybrid query pipeline (fast mode) + `search` tRPC router

**Files:**
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve.test.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/root.ts`

**Interfaces — Consumes:**
```ts
// packages/core/src/search/entity-types.ts (Task 4), re-exported from packages/core/src/index.ts:
export const SEARCH_ENTITY_TYPES = ["document","entry","email","financial_item","debt",
  "task","milestone","timeline_event","party"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];
export const SEARCH_STATUSES = ["inbox","filed","open","in-progress","waiting","done","dropped",
  "identified","mandatory","allowed","requested","to-cancel","canceled",
  "acknowledged","disputed","in-settlement","settled"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

// packages/core/src/search/fuse.ts (Task 4), re-exported from packages/core/src/index.ts:
export const RRF_K = 60;
export type RankedId = { id: string; rank: number };            // rank is 1-based
export type FusedId = { id: string; score: number; inLexical: boolean; inSemantic: boolean };
export function rrfFuse(lexical: RankedId[], semantic: RankedId[], k?: number): FusedId[];
// descending score; deterministic tie-break by id ascending

// packages/api/src/search/embed.ts (Task 7):
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
export function realEmbedPort(opts?: { url?: string; model?: string; timeoutMs?: number }): EmbedPort;
export function asQuery(text: string): string;                   // "search_query: " + text

// packages/db/src/schema.ts (Task 1): table search_chunks with columns
//   id uuid pk, entity_type text, entity_id uuid, chunk_index integer, title text, body text,
//   occurred_at timestamptz null, status text null (DENORMALIZED — the only status source at
//   query time), tsv tsvector GENERATED ALWAYS, embedding vector(768) null, source_hash text,
//   embed_attempts integer, indexed_at timestamptz;
//   unique (entity_type, entity_id, chunk_index); GIN on tsv; HNSW vector_cosine_ops on embedding
// packages/db/drizzle/0016_search_grants.sql (Task 2): verder_app has SELECT on search_chunks and
//   NOTHING else; verder_worker has SELECT, INSERT, UPDATE, DELETE. Tests therefore INSERT their
//   fixtures over the verder_worker connection and query over the verder_app connection.
// packages/db/src/client.ts (shipped): export function createDb(url: string): { db: Db; pool: pg.Pool }
// packages/api/src/trpc.ts (shipped): export const router, protectedProcedure, createContext;
//   Context = { db: Db; userId: string | null }
// packages/db (shipped): schema.users, schema.entryParticipants(entry_id, party_id)
```

**Interfaces — Produces:**
```ts
// packages/api/src/search/retrieve.ts — the ONE entry point for retrieval. The router,
// the queue panels (Task 15), the citations worker (Task 14) and the eval (Task 16) all
// call retrieve(); nothing else runs search SQL.
export type SearchHit = {
  entityType: SearchEntityType; entityId: string; title: string; snippet: string;
  occurredAt: string | null; status: string | null; score: number;
  matchedBy: "keyword" | "semantic" | "both"; href: string;
};
export type RetrieveInput = {
  q: string; entityTypes?: SearchEntityType[]; from?: string; to?: string;
  partyId?: string; status?: SearchStatus; mode?: "fast" | "deep";
  limit?: number; cursor?: string | null;
};
export type RetrieveResult = {
  hits: SearchHit[]; nextCursor: string | null; semanticAvailable: boolean;
  reranked: boolean; rerankPromptVersion: string | null;
};
export async function retrieve(
  deps: { db: Db; embed: EmbedPort }, input: RetrieveInput,
): Promise<RetrieveResult>;
// `mode` is accepted and carried on the wire from this task on, so the output shape never
// changes again; deep mode is honoured in Task 9, which widens `deps` with `rerank?: RerankPort`.

// packages/api/src/routers/search.ts
export const searchRouter;   // search.query(input) — input is FLAT, no `filters` wrapper;
                             // returns RetrieveResult; nextCursor is an OPAQUE base64 STRING.
// packages/api/src/root.ts — appRouter gains `search: searchRouter`.
// (search.health() is added in Task 13; search.alreadyHave() in Task 15.)
```

- [ ] **Step 1:** Confirm the Dutch stemmer really collapses the pair the spec names, before writing a test that depends on it.
```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U verder -d verder \
  -c "SELECT to_tsvector('dutch','wij bevestigen de opzegging') AS a, to_tsvector('dutch','u wilt opzeggen') AS b;"
```
Expected output (verified against the running dev container on 2026-08-20 — note that `bevestigen` stems to `bevest`, **not** `bevestig`):
```
               a               |          b
-------------------------------+---------------------
 'bevest':2 'opzegg':4 'wij':1 | 'opzegg':3 'wilt':2
```
The load-bearing part is that `opzegging` and `opzeggen` both reduce to `'opzegg'`. If your run shows something else, stop and use a pair that does collapse — do not weaken the test to a substring match.

- [ ] **Step 2:** Create `packages/api/src/search/retrieve.test.ts` with the fixture harness and the first five cases.
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@verder/db";
import { retrieve } from "./retrieve";
import type { EmbedPort } from "./embed";

// Fixtures are INSERTed as verder_worker — in production only the worker writes the
// index (migration 0016 gives verder_app SELECT and nothing else). Queries run as
// verder_app, exactly as the router does, so this file also proves the grant split.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

/**
 * The dev database is shared and is never truncated, so every assertion below about
 * an EXACT result set needs the candidate set scoped to this test's own rows. A query
 * nonce only scopes the LEXICAL side; the semantic side ranks by cosine distance and
 * would happily return 50 foreign chunks. So every fixture chunk gets an occurred_at
 * inside a window unique to its test, and every retrieve() call passes that window as
 * from/to — which scopes BOTH branches, because filters are applied before fusion.
 */
const WINDOW_MS = 60_000;
// Random offset so a rerun never lands on the rows an earlier run left behind.
const BASE = Date.UTC(2999, 0, 1) + Math.floor(Math.random() * 2_000_000) * WINDOW_MS;
let slot = 0;
function testWindow() {
  const start = new Date(BASE + slot++ * WINDOW_MS);
  return {
    start,
    at: (ms: number) => new Date(start.getTime() + ms),
    from: start.toISOString(),
    to: new Date(start.getTime() + WINDOW_MS - 1).toISOString(),
  };
}

/** One-hot 768-dim vector (nomic-embed-text width). Never all-zero: cosine distance
 * against a zero vector is NaN in pgvector. */
const oneHot = (i0: number) => Array.from({ length: 768 }, (_, i) => (i === i0 ? 1 : 0));

const fixedEmbed = (vec: number[] | null): EmbedPort => ({
  embed: async (texts) => texts.map(() => vec),
});

async function insertChunk(db: Db, c: {
  entityType: string; entityId: string; chunkIndex?: number;
  title: string; body: string; occurredAt?: Date | null;
  status?: string | null; embedding?: number[] | null;
}): Promise<void> {
  const emb = c.embedding ? `[${c.embedding.join(",")}]` : null;
  await db.execute(sql`
    INSERT INTO search_chunks
      (entity_type, entity_id, chunk_index, title, body, occurred_at, status, embedding, source_hash)
    VALUES (${c.entityType}, ${c.entityId}::uuid, ${c.chunkIndex ?? 0}, ${c.title}, ${c.body},
            ${c.occurredAt ?? null}::timestamptz, ${c.status ?? null}::text,
            ${emb}::vector, ${`test-${crypto.randomUUID()}`})`);
}

describe("retrieve (fast mode)", () => {
  let writer: Db;
  let db: Db;
  beforeAll(() => {
    writer = createDb(WORKER_URL).db;
    db = createDb(APP_URL).db;
  });

  it("finds 'opzeggen' when the query says 'opzegging' (dutch stemming)", async () => {
    // No date window here on purpose: this is the only unfiltered case, so it also
    // exercises the code path that does NOT raise hnsw.ef_search. The embedder returns
    // null, so the semantic branch is skipped and the nonce alone scopes the result.
    const nonce = `zk${Date.now().toString(36)}a`;
    const entityId = crypto.randomUUID();
    await insertChunk(writer, {
      entityType: "entry", entityId, title: `Ziggo ${nonce}`,
      body: `${nonce} Wij willen het abonnement opzeggen per 1 oktober.`,
    });
    const out = await retrieve({ db, embed: fixedEmbed(null) }, { q: `${nonce} opzegging` });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("keyword");
    expect(out.hits[0].title).toBe(`Ziggo ${nonce}`);
    expect(out.hits[0].occurredAt).toBeNull();
    expect(out.hits[0].href).toBe(`/logbook/${entityId}`);
    // ts_headline marks the match with the guillemets the /search page renders.
    expect(out.hits[0].snippet).toContain("«opzeggen»");
    expect(out.nextCursor).toBeNull();
    expect(out.reranked).toBe(false);
    expect(out.rerankPromptVersion).toBeNull();
  });

  it("collapses one long document to a single result slot", async () => {
    const w = testWindow();
    const docId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      await insertChunk(writer, {
        entityType: "document", entityId: docId, chunkIndex: i,
        title: "Brief van Ziggo", body: `deel ${i} van de brief over de opzegging`,
        occurredAt: w.start,
      });
    }
    await insertChunk(writer, {
      entityType: "entry", entityId: otherId, title: "Notitie",
      body: "korte notitie over de opzegging", occurredAt: w.start,
    });
    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(out.hits.filter((h) => h.entityId === docId)).toHaveLength(1);
    expect(new Set(out.hits.map((h) => h.entityId))).toEqual(new Set([docId, otherId]));
  });

  it("applies the entityTypes filter before fusion", async () => {
    const w = testWindow();
    const docId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId: docId, title: "Doc",
      body: "opzegging van het abonnement", occurredAt: w.start });
    await insertChunk(writer, { entityType: "entry", entityId: entryId, title: "Entry",
      body: "opzegging van het abonnement", occurredAt: w.start });

    const both = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(new Set(both.hits.map((h) => h.entityId))).toEqual(new Set([docId, entryId]));

    const onlyDocs = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, entityTypes: ["document"] });
    expect(onlyDocs.hits.map((h) => h.entityId)).toEqual([docId]);
    expect(onlyDocs.hits[0].href).toBe(`/vault/${docId}`);
  });

  it("applies the date range filter before fusion", async () => {
    const w = testWindow();
    const newer = crypto.randomUUID();
    const older = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId: newer, title: "Nieuw",
      body: "opzegging bevestigd", occurredAt: w.at(30_000) });
    await insertChunk(writer, { entityType: "document", entityId: older, title: "Oud",
      body: "opzegging bevestigd", occurredAt: w.start });

    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.at(10_000).toISOString(), to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([newer]);
    expect(out.hits[0].occurredAt).toBe(w.at(30_000).toISOString());
  });

  it("filters on the denormalized status column, for every entity type", async () => {
    const w = testWindow();
    const filedDoc = crypto.randomUUID();
    const inboxDoc = crypto.randomUUID();
    const item = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId: filedDoc, title: "Gearchiveerd",
      body: "opzegging bevestigd", occurredAt: w.start, status: "filed" });
    await insertChunk(writer, { entityType: "document", entityId: inboxDoc, title: "Nieuw binnen",
      body: "opzegging bevestigd", occurredAt: w.start, status: "inbox" });
    // 'to-cancel' is a registry status. The router accepts it because SEARCH_STATUSES is the
    // deduped union of every status vocabulary in the app, and the pipeline resolves it with
    // one column comparison — there is no per-entity-type status subquery anywhere.
    await insertChunk(writer, { entityType: "financial_item", entityId: item, title: "Ziggo",
      body: "opzegging bevestigd", occurredAt: w.start, status: "to-cancel" });

    const filed = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, status: "filed" });
    expect(filed.hits.map((h) => h.entityId)).toEqual([filedDoc]);
    expect(filed.hits[0].status).toBe("filed");

    const toCancel = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, status: "to-cancel" });
    expect(toCancel.hits.map((h) => h.entityId)).toEqual([item]);
    expect(toCancel.hits[0].href).toBe(`/registry/${item}`);
  });
});
```

- [ ] **Step 3:** Append the remaining five cases to `packages/api/src/search/retrieve.test.ts`, inside the same `describe` block, directly after the status test.
```ts
  it("returns keyword results when every embedding is NULL, and still reports semantic up", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "party", entityId, title: "Incassobureau",
      body: "incassobureau dat de opzegging betwist", occurredAt: w.start, embedding: null });
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(3)) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits.every((h) => h.matchedBy === "keyword")).toBe(true);
    // The embedder answered; the corpus simply has no vectors yet.
    expect(out.semanticAvailable).toBe(true);
    expect(out.hits[0].href).toBe("/logbook");
  });

  it("degrades to keyword-only and flags it when the embedder is down", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "task", entityId, title: "Taak",
      body: "opzegging regelen bij Ziggo", occurredAt: w.start, embedding: oneHot(7) });
    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("keyword");
    expect(out.semanticAvailable).toBe(false);
    expect(out.hits[0].href).toBe(`/tasks/${entityId}`);
  });

  it("marks a chunk found by both retrievers as 'both'", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "debt", entityId, title: "Schuld",
      body: "opzegging van de overeenkomst", occurredAt: w.start, embedding: oneHot(11) });
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(11)) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("both");
    expect(out.hits[0].href).toBe(`/registry/debts/${entityId}`);
  });

  it("returns a semantic-only hit with the chunk head as its snippet", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "milestone", entityId, title: "Zitting",
      body: "toelating tot de wettelijke schuldsanering", occurredAt: w.start,
      embedding: oneHot(23) });
    // The query shares no lexeme with the body, so only the vector branch can find it.
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(23)) },
      { q: "kadaster erfpachtcanon", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("semantic");
    expect(out.hits[0].snippet).toBe("toelating tot de wettelijke schuldsanering");
    expect(out.hits[0].snippet).not.toContain("«");
    expect(out.hits[0].href).toBe("/milestones");
  });

  it("paginates with an opaque string cursor", async () => {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) {
      await insertChunk(writer, { entityType: "entry", entityId: id, title: `Brief ${i}`,
        body: `opzegging nummer ${i}`, occurredAt: w.start });
    }
    const page1 = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, limit: 2 });
    expect(page1.hits).toHaveLength(2);
    // base64 of the offset "2" — never a number on the wire.
    expect(page1.nextCursor).toBe("Mg==");

    const page2 = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, limit: 2, cursor: page1.nextCursor });
    expect(page2.hits).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.hits, ...page2.hits].map((h) => h.entityId))).toEqual(new Set(ids));

    await expect(retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", cursor: "not-a-cursor" })).rejects.toThrow(/invalid search cursor/);
  });
```

- [ ] **Step 4:** Run it and watch it fail on the missing module.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/retrieve.test.ts
```
Expected failure:
```
Error: Failed to load url ./retrieve (resolved id: /Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve) in /Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve.test.ts. Does the file exist?
```

- [ ] **Step 5:** Create `packages/api/src/search/retrieve.ts` with the module header, the public types and the helpers.
```ts
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { rrfFuse, type SearchEntityType, type SearchStatus } from "@verder/core";
import { asQuery, type EmbedPort } from "./embed";

/**
 * The single entry point for retrieval: the tRPC router, the ⌘K palette, the queue
 * panels, the suggestion citations and the retrieval eval all call retrieve(), so
 * every surface measures and shows the same pipeline.
 *
 * Postgres full text ('dutch') and pgvector cosine ANN run as two independent
 * candidate queries; the fusion arithmetic is done in TypeScript by rrfFuse (a pure,
 * unit-tested function in @verder/core) rather than in SQL, and the result is
 * collapsed to the best chunk per entity so one long document cannot fill the page.
 *
 * Read-only: the index is derived, so this path appends no ledger events and mutates
 * nothing. It also may not error — a dead embedder degrades to keyword-only results
 * with semanticAvailable: false.
 */

const CANDIDATES = 50;
/** A filtered search post-filters ANN output, so a narrow slice needs a wider sweep
 * or it comes back empty. Left at the pgvector default when nothing is filtered. */
const EF_SEARCH_FILTERED = 100;
const DEFAULT_LIMIT = 20;
const MAX_OFFSET = 500;

/** Where a hit sends the reader. milestones, timeline events, raw emails and parties
 * have no detail route in this application (verified against apps/web/src/app/(app)) —
 * they link to the screen they live on. */
const HREF: Record<SearchEntityType, (id: string) => string> = {
  document: (id) => `/vault/${id}`,
  entry: (id) => `/logbook/${id}`,
  email: () => "/queue",
  financial_item: (id) => `/registry/${id}`,
  debt: (id) => `/registry/debts/${id}`,
  task: (id) => `/tasks/${id}`,
  milestone: () => "/milestones",
  timeline_event: () => "/timeline",
  party: () => "/logbook",
};

export type SearchHit = {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  snippet: string;
  occurredAt: string | null;
  status: string | null;
  score: number;
  matchedBy: "keyword" | "semantic" | "both";
  href: string;
};

export type RetrieveInput = {
  q: string;
  entityTypes?: SearchEntityType[];
  from?: string;
  to?: string;
  partyId?: string;
  status?: SearchStatus;
  mode?: "fast" | "deep";
  limit?: number;
  cursor?: string | null;
};

export type RetrieveResult = {
  hits: SearchHit[];
  nextCursor: string | null;
  semanticAvailable: boolean;
  reranked: boolean;
  rerankPromptVersion: string | null;
};

/** The cursor is an opaque token on the wire so pagination can change shape later
 * without breaking a bookmarked /search URL. Today it wraps a numeric offset:
 * results are recomputed per page, which is correct because the index is derived and
 * the fused ordering is deterministic (score, then id). */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
  if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) {
    throw new Error(`invalid search cursor: ${cursor}`);
  }
  return n;
}

type CandidateRow = { id: string; entity_type: SearchEntityType; entity_id: string };

type DisplayRow = {
  id: string;
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  occurred_at: Date | string | null;
  status: string | null;
  headline: string;
  head: string;
};

/** Snippets for one page. Keyword hits get a ts_headline fragment, semantic-only hits
 * get the chunk head — the /search page renders both as plain React strings, never
 * with dangerouslySetInnerHTML, so the markers are guillemets and not HTML. */
async function fetchDisplayRows(db: Db, q: string, ids: string[]): Promise<Map<string, DisplayRow>> {
  if (ids.length === 0) return new Map();
  // These ids came straight out of search_chunks.id (uuid) — never from user input.
  const idLiteral = `{${ids.join(",")}}`;
  const rows = (await db.execute(sql`
    SELECT c.id, c.entity_type, c.entity_id, c.title, c.occurred_at, c.status,
           ts_headline('dutch', c.body, websearch_to_tsquery('dutch', ${q}),
             'StartSel=«,StopSel=»,MaxFragments=2,MinWords=15,MaxWords=35') AS headline,
           left(c.body, 240) AS head
    FROM search_chunks c
    WHERE c.id = ANY(${idLiteral}::uuid[])`)).rows as DisplayRow[];
  return new Map(rows.map((r) => [r.id, r]));
}
```

- [ ] **Step 6:** Append the `retrieve()` implementation to `packages/api/src/search/retrieve.ts`.
```ts
export async function retrieve(
  deps: { db: Db; embed: EmbedPort },
  input: RetrieveInput,
): Promise<RetrieveResult> {
  const q = input.q.trim();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(input.cursor);
  if (q === "") {
    return { hits: [], nextCursor: null, semanticAvailable: false, reranked: false, rerankPromptVersion: null };
  }

  // Entity types come from a zod enum of nine known values, so this array literal can
  // never carry a comma or a brace that is not one of them.
  const types = input.entityTypes && input.entityTypes.length > 0
    ? `{${input.entityTypes.join(",")}}` : null;
  const from = input.from ?? null;
  const to = input.to ?? null;
  const partyId = input.partyId ?? null;
  const status = input.status ?? null;
  const isFiltered = types !== null || from !== null || to !== null || partyId !== null || status !== null;

  const [vec] = await deps.embed.embed([asQuery(q)]);
  const vecLiteral = vec ? `[${vec.join(",")}]` : null;

  // Status resolution is ONE column comparison: search_chunks.status is denormalized by
  // loadAndRender (Task 5). No per-entity-type status subquery lives here, which is why
  // registry and debt statuses work exactly like document and task statuses.
  const where = sql`
    (${types}::text[] IS NULL OR c.entity_type = ANY(${types}::text[]))
    AND (${from}::timestamptz IS NULL OR c.occurred_at >= ${from}::timestamptz)
    AND (${to}::timestamptz IS NULL OR c.occurred_at <= ${to}::timestamptz)
    AND (${status}::text IS NULL OR c.status = ${status}::text)
    AND (${partyId}::uuid IS NULL
         OR (c.entity_type = 'party' AND c.entity_id = ${partyId}::uuid)
         OR (c.entity_type = 'entry' AND EXISTS (
               SELECT 1 FROM entry_participants ep
               WHERE ep.entry_id = c.entity_id AND ep.party_id = ${partyId}::uuid)))`;

  const { lex, sem } = await deps.db.transaction(async (tx) => {
    if (isFiltered) {
      // hnsw.ef_search is a GUC, not a bindable parameter — sql.raw over an integer
      // this module owns, never over anything a user typed.
      await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(EF_SEARCH_FILTERED))}`);
    }
    const lexRows = (await tx.execute(sql`
      SELECT c.id, c.entity_type, c.entity_id
      FROM search_chunks c
      WHERE ${where} AND c.tsv @@ websearch_to_tsquery('dutch', ${q})
      ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery('dutch', ${q})) DESC, c.id
      LIMIT ${sql.raw(String(CANDIDATES))}`)).rows as CandidateRow[];
    const semRows = vecLiteral === null ? [] : (await tx.execute(sql`
      SELECT c.id, c.entity_type, c.entity_id
      FROM search_chunks c
      WHERE ${where} AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vecLiteral}::vector
      LIMIT ${sql.raw(String(CANDIDATES))}`)).rows as CandidateRow[];
    return { lex: lexRows, sem: semRows };
  });

  const chunkEntity = new Map<string, { entityType: SearchEntityType; entityId: string }>();
  for (const r of [...lex, ...sem]) {
    chunkEntity.set(r.id, { entityType: r.entity_type, entityId: r.entity_id });
  }

  const fused = rrfFuse(
    lex.map((r, i) => ({ id: r.id, rank: i + 1 })),
    sem.map((r, i) => ({ id: r.id, rank: i + 1 })),
  );

  // Collapse to the best chunk per entity: rrfFuse returns descending score, so the
  // first chunk seen for an entity is that entity's best one.
  const seen = new Set<string>();
  const collapsed = fused.filter((f) => {
    const e = chunkEntity.get(f.id);
    if (!e) return false;
    const key = `${e.entityType}:${e.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const page = collapsed.slice(offset, offset + limit);
  const rows = await fetchDisplayRows(deps.db, q, page.map((f) => f.id));

  const hits: SearchHit[] = [];
  for (const f of page) {
    const r = rows.get(f.id);
    if (!r) continue;
    hits.push({
      entityType: r.entity_type,
      entityId: r.entity_id,
      title: r.title,
      snippet: f.inLexical ? r.headline : r.head,
      // node-postgres parses timestamptz into a JS Date; new Date() accepts either.
      occurredAt: r.occurred_at === null ? null : new Date(r.occurred_at).toISOString(),
      status: r.status,
      score: f.score,
      matchedBy: f.inLexical && f.inSemantic ? "both" : f.inLexical ? "keyword" : "semantic",
      href: HREF[r.entity_type](r.entity_id),
    });
  }

  return {
    hits,
    nextCursor: collapsed.length > offset + limit ? encodeCursor(offset + limit) : null,
    semanticAvailable: vec !== null,
    // Deep mode is wired in Task 9; the wire shape is final from here on.
    reranked: false,
    rerankPromptVersion: null,
  };
}
```

- [ ] **Step 7:** Run the pipeline test — all ten pass.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/retrieve.test.ts
```
Expected: `Test Files 1 passed`, `Tests 10 passed`.

- [ ] **Step 8:** Commit the pipeline.
```bash
git add packages/api/src/search/retrieve.ts packages/api/src/search/retrieve.test.ts
git commit -m "feat(api): hybrid full-text + vector retrieval with RRF fusion"
```

- [ ] **Step 9:** Write the failing router test `packages/api/src/routers/search.test.ts`.
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

// The router builds its own embed port from OLLAMA_URL. Point it at a closed port for
// the whole file: the tests are then deterministic (embeddings come back null, so only
// the keyword branch runs) and no test in this repo ever depends on a live GPU.
process.env.OLLAMA_URL = "http://127.0.0.1:1";

const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

const WINDOW_MS = 60_000;
const BASE = Date.UTC(2999, 6, 1) + Math.floor(Math.random() * 2_000_000) * WINDOW_MS;
let slot = 0;
function testWindow() {
  const start = new Date(BASE + slot++ * WINDOW_MS);
  return {
    start,
    from: start.toISOString(),
    to: new Date(start.getTime() + WINDOW_MS - 1).toISOString(),
  };
}

describe("search router", () => {
  let writer: Db;
  let db: Db;
  let userId: string;
  beforeAll(async () => {
    writer = createDb(WORKER_URL).db;
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `se${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function chunk(entityId: string, title: string, body: string, occurredAt: Date) {
    await writer.execute(sql`
      INSERT INTO search_chunks
        (entity_type, entity_id, chunk_index, title, body, occurred_at, source_hash)
      VALUES ('entry', ${entityId}::uuid, 0, ${title}, ${body}, ${occurredAt}::timestamptz,
              ${`test-${crypto.randomUUID()}`})`);
  }

  it("takes a FLAT input and paginates with an opaque string cursor", async () => {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) await chunk(id, `Brief ${i}`, `opzegging nummer ${i}`, w.start);

    const page1 = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, limit: 2,
    });
    expect(page1.hits).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.nextCursor).toBe("Mg==");
    expect(page1.semanticAvailable).toBe(false);
    expect(page1.reranked).toBe(false);
    expect(page1.rerankPromptVersion).toBeNull();

    const page2 = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, limit: 2, cursor: page1.nextCursor,
    });
    expect(page2.hits).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.hits, ...page2.hits].map((h) => h.entityId))).toEqual(new Set(ids));
  });

  it("accepts every status in the deduped SEARCH_STATUSES union", async () => {
    const w = testWindow();
    const id = crypto.randomUUID();
    await chunk(id, "Registry", "opzegging bij de provider", w.start);
    // 'to-cancel' and 'settled' are registry/debt statuses. The old plan's router
    // rejected them with BAD_REQUEST while the filter rail offered them.
    for (const status of ["to-cancel", "canceled", "settled", "in-progress"] as const) {
      const res = await caller().search.query({ q: "opzegging", from: w.from, to: w.to, status });
      expect(res.hits).toEqual([]);
    }
  });

  it("rejects an unknown status instead of silently ignoring it", async () => {
    await expect(caller().search.query({ q: "opzegging", status: "verzonnen" as never }))
      .rejects.toThrow(/BAD_REQUEST/);
  });

  it("rejects an unauthenticated caller", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.search.query({ q: "opzegging" })).rejects.toThrow(/UNAUTHORIZED/);
  });
});
```

- [ ] **Step 10:** Run it and watch it fail.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
```
Expected failure: `TypeError: Cannot read properties of undefined (reading 'query')` — `appRouter.search` does not exist yet.

- [ ] **Step 11:** Create `packages/api/src/routers/search.ts`.
```ts
import { z } from "zod";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "@verder/core";
import { protectedProcedure, router } from "../trpc";
import { realEmbedPort } from "../search/embed";
import { retrieve } from "../search/retrieve";

/** ISO date ("2026-01-31") or full ISO timestamp — both are what the /search filter
 * rail and the ⌘K palette produce. Validated here so a typo is a BAD_REQUEST and not
 * a Postgres cast error surfacing as INTERNAL_SERVER_ERROR. */
const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/,
  "expected an ISO date like 2026-01-31",
);

export const searchRouter = router({
  /**
   * Hybrid retrieval. The input is FLAT — no `filters` wrapper — because /search
   * builds it straight from URL search params and the ⌘K palette from one text box.
   * The cursor is opaque: a base64 string, never a number.
   */
  query: protectedProcedure.input(z.object({
    q: z.string().min(1).max(500),
    entityTypes: z.array(z.enum(SEARCH_ENTITY_TYPES)).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    partyId: z.string().uuid().optional(),
    status: z.enum(SEARCH_STATUSES).optional(),
    // "deep" costs an Ollama round trip: agent surfaces only, never ⌘K.
    // Accepted here; honoured in Task 9.
    mode: z.enum(["fast", "deep"]).default("fast"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().nullish(),
  })).query(({ ctx, input }) => retrieve({ db: ctx.db, embed: realEmbedPort() }, input)),
});
```

- [ ] **Step 12:** Register the router in `packages/api/src/root.ts`. Add the import immediately after the existing last import line `import { pushRouter } from "./routers/push";`:
```ts
import { searchRouter } from "./routers/search";
```
and add the entry to the `router({...})` call, changing these exact three lines:
```ts
  dashboard: dashboardRouter,
  push: pushRouter,
});
```
to:
```ts
  dashboard: dashboardRouter,
  push: pushRouter,
  search: searchRouter,
});
```

- [ ] **Step 13:** Run the router test — passes.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
```
Expected: `Tests 4 passed`.

- [ ] **Step 14:** Run the whole api package plus typecheck and the web build, so the new `AppRouter` shape cannot break an existing consumer.
```bash
env -u NODE_ENV pnpm --filter @verder/api test
env -u NODE_ENV pnpm --filter @verder/api typecheck
env -u NODE_ENV pnpm --filter web build
```
Expected: all green; `next build` succeeds (the web client's `AppRouter` type now carries `search`).

- [ ] **Step 15:** Commit the router.
```bash
git add packages/api/src/routers/search.ts packages/api/src/routers/search.test.ts \
        packages/api/src/root.ts
git commit -m "feat(api): search router with hybrid fast-mode retrieval"
```

**Success criteria:** `env -u NODE_ENV pnpm --filter @verder/api test` green. `retrieve()` is the only place search SQL runs. `search.query` takes a flat input, returns `nextCursor` as a base64 string or null, `matchedBy` badges, `«…»` `ts_headline` snippets for keyword hits and chunk heads for semantic-only hits, and an `href` per hit. One document occupies exactly one result slot. `entityTypes`, date range, `partyId` and `status` all narrow the candidate set before fusion, and every status in the deduped `SEARCH_STATUSES` union is accepted. A corpus with no embeddings still returns keyword results with `semanticAvailable: true`; a dead embedder returns keyword results with `semanticAvailable: false` and never throws.

---

### Task 9: Deep mode — LLM rerank (`rerank-v1`)

**Files:**
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/rerank.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/rerank.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/search/retrieve.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/src/prompts.ts`

**Interfaces — Consumes:**
```ts
// packages/api/src/search/retrieve.ts (Task 8):
export type SearchHit = { entityType; entityId; title; snippet; occurredAt; status; score;
  matchedBy: "keyword" | "semantic" | "both"; href };
export type RetrieveInput  = { q; entityTypes?; from?; to?; partyId?; status?;
  mode?: "fast" | "deep"; limit?; cursor? };
export type RetrieveResult = { hits: SearchHit[]; nextCursor: string | null;
  semanticAvailable: boolean; reranked: boolean; rerankPromptVersion: string | null };
export async function retrieve(deps: { db: Db; embed: EmbedPort }, input: RetrieveInput):
  Promise<RetrieveResult>;                       // this task widens deps with `rerank?`
// packages/api/src/routers/search.ts (Task 8): searchRouter, procedure `query`, flat input
//   already carrying `mode: z.enum(["fast","deep"]).default("fast")`
// packages/api/src/search/embed.ts (Task 7): realEmbedPort(opts?), type EmbedPort
// packages/db (shipped): schema.workerRuns { worker: text; status: text; detail: jsonb; ranAt }.
//   verder_app already holds SELECT, INSERT, UPDATE on worker_runs (migration 0001) —
//   verified with information_schema.role_table_grants; no grant change is needed.
// apps/worker/src/prompts.ts (shipped): the single index of every prompt and its version
//   (PROMPT_VERSION, TASK_PROMPT_VERSION, DOCMETA_PROMPT_VERSION, …). No imports today.
```

**Interfaces — Produces:**
```ts
// packages/api/src/search/rerank.ts
export const RERANK_PROMPT_VERSION = "rerank-v1";
export const RERANK_TIMEOUT_MS = 20_000;
export type RerankPort = {
  rerank(query: string, candidates: { id: string; text: string }[]):
    Promise<{ id: string; score: number }[]>;
};
export function buildRerankPrompt(query: string, candidates: { ref: number; text: string }[]): string;
export function realRerankPort(opts?: { url?: string; model?: string; timeoutMs?: number }): RerankPort;

// packages/api/src/search/retrieve.ts — deps widens to { db; embed; rerank? };
//   mode "deep" reranks the top 20 collapsed entities and sets
//   reranked / rerankPromptVersion. Timeout or error → fused order, logged, never thrown.
// apps/worker/src/prompts.ts — re-exports RERANK_PROMPT_VERSION and buildRerankPrompt.
```

- [ ] **Step 1:** Write the failing rerank-port test `packages/api/src/search/rerank.test.ts`. It stands up a tiny local HTTP server speaking the Ollama `/api/chat` shape, so the port's prompt, JSON parsing and ref→id mapping are all verified without a GPU.
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  buildRerankPrompt, realRerankPort, RERANK_PROMPT_VERSION, RERANK_TIMEOUT_MS,
} from "./rerank";

let server: Server;
let baseUrl = "";
let lastPrompt = "";
let reply: unknown = { order: [1] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      lastPrompt = body.messages[0].content;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const candidates = [
  { id: "aaa", text: "Brief van Ziggo over de opzegging" },
  { id: "bbb", text: "Loonstrook juni" },
  { id: "ccc", text: "Bevestiging beëindiging abonnement" },
];

describe("rerank port (rerank-v1)", () => {
  it("pins the prompt version and the 20 s budget", () => {
    expect(RERANK_PROMPT_VERSION).toBe("rerank-v1");
    expect(RERANK_TIMEOUT_MS).toBe(20_000);
  });

  it("puts the query and every numbered candidate in the prompt", () => {
    const prompt = buildRerankPrompt("kopie paspoort", [
      { ref: 1, text: "Brief 1" }, { ref: 2, text: "Brief 2" },
    ]);
    expect(prompt).toContain("kopie paspoort");
    expect(prompt).toContain("[1] Brief 1");
    expect(prompt).toContain("[2] Brief 2");
  });

  it("sends that prompt to Ollama and maps the answer back to candidate ids", async () => {
    reply = { order: [3, 1, 2] };
    const scored = await realRerankPort({ url: baseUrl }).rerank("opzegging Ziggo", candidates);
    expect(lastPrompt).toContain("opzegging Ziggo");
    expect(lastPrompt).toContain("[3] Bevestiging beëindiging abonnement");
    expect(scored.map((s) => s.id)).toEqual(["ccc", "aaa", "bbb"]);
    // Descending score, so the caller can sort without knowing the order semantics.
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
    expect(scored[1].score).toBeGreaterThan(scored[2].score);
  });

  it("drops refs the model repeated or invented", async () => {
    reply = { order: [3, 3, 0, 99, 2] };
    const scored = await realRerankPort({ url: baseUrl }).rerank("opzegging", candidates);
    expect(scored.map((s) => s.id)).toEqual(["ccc", "bbb"]);
  });

  it("throws when the endpoint is unreachable, so the caller can fall back", async () => {
    await expect(realRerankPort({ url: "http://127.0.0.1:1" }).rerank("opzegging", candidates))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2:** Run it and watch it fail on the missing module.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/rerank.test.ts
```
Expected failure:
```
Error: Failed to load url ./rerank (resolved id: /Users/martin/Workspace/mp/verder/packages/api/src/search/rerank) in /Users/martin/Workspace/mp/verder/packages/api/src/search/rerank.test.ts. Does the file exist?
```

- [ ] **Step 3:** Create `packages/api/src/search/rerank.ts`.
```ts
import { z } from "zod";

/**
 * Deep-mode reranking. Only the agent surfaces and the "do we already have this?"
 * panel pay this latency; ⌘K and /search stay on the fused order.
 *
 * The port owns the prompt, the JSON parsing and the ref→id mapping, and returns
 * plain scores so retrieve() only has to sort. It throws on any failure — timeout,
 * HTTP error, non-JSON reply — because retrieve() is the place that decides a
 * degradation is not an error.
 */

export const RERANK_PROMPT_VERSION = "rerank-v1";
/** 20 s, not the 120 s used for mining: a person is waiting on this one. */
export const RERANK_TIMEOUT_MS = 20_000;

const SNIPPET_CHARS = 400;

export type RerankPort = {
  rerank(query: string, candidates: { id: string; text: string }[]):
    Promise<{ id: string; score: number }[]>;
};

export function buildRerankPrompt(
  query: string, candidates: { ref: number; text: string }[],
): string {
  return [
    "You are ranking search results from a Dutch debt-restructuring (WSNP/bewindvoering) dossier.",
    "Order the numbered candidates below from most to least relevant to the search query.",
    "Reply with strict JSON only, one key:",
    "order (array of the candidate numbers, most relevant first, each number exactly once).",
    "Never invent a number that is not listed and never drop a listed number.",
    "",
    `Query: ${query}`,
    "",
    ...candidates.map((c) => `[${c.ref}] ${c.text}`),
  ].join("\n");
}

const orderSchema = z.object({ order: z.array(z.number().int()).default([]) });

export function realRerankPort(
  opts?: { url?: string; model?: string; timeoutMs?: number },
): RerankPort {
  return {
    async rerank(query, candidates) {
      const url = opts?.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
      const model = opts?.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
      const prompt = buildRerankPrompt(query, candidates.map((c, i) => ({
        ref: i + 1, text: c.text.slice(0, SNIPPET_CHARS),
      })));
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, messages: [{ role: "user", content: prompt }], format: "json", stream: false,
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? RERANK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message: { content: string } };
      const parsed = orderSchema.parse(JSON.parse(data.message.content));

      // A model that repeats, invents or drops a number must not corrupt the page:
      // unusable refs are skipped here, and retrieve() keeps whatever the model never
      // scored in its fused position behind the scored ones.
      const scored: { id: string; score: number }[] = [];
      const used = new Set<number>();
      for (const ref of parsed.order) {
        const idx = ref - 1;
        if (idx < 0 || idx >= candidates.length || used.has(idx)) continue;
        used.add(idx);
        scored.push({ id: candidates[idx].id, score: candidates.length - scored.length });
      }
      return scored;
    },
  };
}
```

- [ ] **Step 4:** Run the rerank test — all five pass.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/rerank.test.ts
```
Expected: `Tests 5 passed`.

- [ ] **Step 5:** Commit the port.
```bash
git add packages/api/src/search/rerank.ts packages/api/src/search/rerank.test.ts
git commit -m "feat(api): rerank-v1 port for deep search mode"
```

- [ ] **Step 6:** Append the failing deep-mode cases to `packages/api/src/search/retrieve.test.ts`, inside the existing `describe("retrieve (fast mode)")` block, after the pagination test. Add these two imports to the top of that file, directly under `import type { EmbedPort } from "./embed";`:
```ts
import { schema } from "@verder/db";
import { and, eq } from "drizzle-orm";
import type { RerankPort } from "./rerank";
```
and append the cases:
```ts
  /** Three entities in one window, all keyword-only, so the fused order is
   * deterministically Brief 0, Brief 1, Brief 2 (ts_rank_cd ties broken by chunk id
   * are irrelevant here — each title is asserted, not each position). */
  async function threeEntries() {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) {
      await insertChunk(writer, { entityType: "entry", entityId: id, title: `Brief ${i}`,
        body: `opzegging nummer ${i}`, occurredAt: w.start });
    }
    const fused = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to });
    return { w, fusedTitles: fused.hits.map((h) => h.title) };
  }

  it("deep mode reorders the fused hits and reports the prompt version", async () => {
    const { w, fusedTitles } = await threeEntries();
    // Reverse whatever the fused order was, so the assertion cannot pass by accident.
    const rerank: RerankPort = {
      rerank: async (_q, candidates) => [...candidates].reverse()
        .map((c, i) => ({ id: c.id, score: candidates.length - i })),
    };
    const out = await retrieve({ db, embed: fixedEmbed(null), rerank },
      { q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    expect(out.reranked).toBe(true);
    expect(out.rerankPromptVersion).toBe("rerank-v1");
    expect(out.hits.map((h) => h.title)).toEqual([...fusedTitles].reverse());
  });

  it("deep mode keeps hits the model did not score, in fused order, behind the scored ones", async () => {
    const { w, fusedTitles } = await threeEntries();
    // Score only the LAST candidate; the other two must keep their relative order.
    const rerank: RerankPort = {
      rerank: async (_q, candidates) => [{ id: candidates[candidates.length - 1].id, score: 3 }],
    };
    const out = await retrieve({ db, embed: fixedEmbed(null), rerank },
      { q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    expect(out.reranked).toBe(true);
    expect(out.hits.map((h) => h.title))
      .toEqual([fusedTitles[2], fusedTitles[0], fusedTitles[1]]);
  });

  it("deep mode returns the fused order and records the degradation when the rerank fails", async () => {
    const marker = `rr${crypto.randomUUID().slice(0, 8)}`;
    const { w, fusedTitles } = await threeEntries();
    const rerank: RerankPort = {
      rerank: async () => { throw new Error(`TimeoutError ${marker}`); },
    };
    const out = await retrieve({ db, embed: fixedEmbed(null), rerank },
      { q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    // Search may degrade; it may not error.
    expect(out.reranked).toBe(false);
    expect(out.rerankPromptVersion).toBe("rerank-v1");
    expect(out.hits.map((h) => h.title)).toEqual(fusedTitles);

    const runs = await db.select().from(schema.workerRuns).where(and(
      eq(schema.workerRuns.worker, "search-rerank"), eq(schema.workerRuns.status, "error")));
    const mine = runs.filter((r) =>
      String((r.detail as Record<string, unknown> | null)?.message ?? "").includes(marker));
    expect(mine).toHaveLength(1);
    expect((mine[0].detail as Record<string, unknown>).promptVersion).toBe("rerank-v1");
  });

  it("deep mode without a rerank port behaves exactly like fast mode", async () => {
    const { w, fusedTitles } = await threeEntries();
    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    expect(out.reranked).toBe(false);
    expect(out.rerankPromptVersion).toBeNull();
    expect(out.hits.map((h) => h.title)).toEqual(fusedTitles);
  });
```

- [ ] **Step 7:** Run and watch the deep cases fail against Task 8's fast-only pipeline.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/retrieve.test.ts
```
Expected: `Tests 3 failed | 11 passed`, the first failure reading `AssertionError: expected false to be true` on `expect(out.reranked).toBe(true)`.

- [ ] **Step 8:** Widen the module's imports and constants in `packages/api/src/search/retrieve.ts`. Change the first four lines from:
```ts
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { rrfFuse, type SearchEntityType, type SearchStatus } from "@verder/core";
import { asQuery, type EmbedPort } from "./embed";
```
to:
```ts
import { sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { rrfFuse, type SearchEntityType, type SearchStatus } from "@verder/core";
import { asQuery, type EmbedPort } from "./embed";
import { RERANK_PROMPT_VERSION, type RerankPort } from "./rerank";
```
and add these two constants directly under the existing `const MAX_OFFSET = 500;` line:
```ts
/** The spec's deep budget: rerank the top 20 collapsed entities, never the whole page set. */
const RERANK_TOP_N = 20;
/** worker_runs.worker for a degraded rerank, so a silently degraded search is visible
 * beside the other jobs on the dashboard's system-health list. */
const RERANK_WORKER_NAME = "search-rerank";
```

- [ ] **Step 9:** Wire deep mode into `retrieve()` in `packages/api/src/search/retrieve.ts`. Change the signature from:
```ts
export async function retrieve(
  deps: { db: Db; embed: EmbedPort },
  input: RetrieveInput,
): Promise<RetrieveResult> {
```
to:
```ts
export async function retrieve(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort },
  input: RetrieveInput,
): Promise<RetrieveResult> {
```
Then replace the block that runs from `const page = collapsed.slice(offset, offset + limit);` down to the closing `}` of the function with:
```ts
  // Deep mode reranks the head of the collapsed list BEFORE pagination, so page 1 of a
  // deep search reflects the model's judgement rather than the fused order's.
  let ordered = collapsed;
  let reranked = false;
  let rerankPromptVersion: string | null = null;
  if (input.mode === "deep" && deps.rerank) {
    rerankPromptVersion = RERANK_PROMPT_VERSION;
    const head = collapsed.slice(0, RERANK_TOP_N);
    const tail = collapsed.slice(RERANK_TOP_N);
    // One extra display query in deep mode; the 20 s LLM call dominates it.
    const headRows = await fetchDisplayRows(deps.db, q, head.map((f) => f.id));
    try {
      const scored = await deps.rerank.rerank(q, head.map((f) => {
        const r = headRows.get(f.id);
        return { id: f.id, text: r ? `${r.title}\n${r.head}` : "" };
      }));
      const byId = new Map(scored.map((s) => [s.id, s.score]));
      const judged = head.filter((f) => byId.has(f.id))
        .sort((a, b) => (byId.get(b.id) ?? 0) - (byId.get(a.id) ?? 0));
      const untouched = head.filter((f) => !byId.has(f.id));
      ordered = [...judged, ...untouched, ...tail];
      reranked = true;
    } catch (err) {
      // Search may degrade, it may never error: timeout, non-JSON reply and nonsense
      // ordering all return the fused order, recorded so the degradation is visible.
      try {
        await deps.db.insert(schema.workerRuns).values({
          worker: RERANK_WORKER_NAME, status: "error",
          detail: { promptVersion: RERANK_PROMPT_VERSION, message: String(err) },
        });
      } catch { /* recording a degradation must never turn it into a failure */ }
    }
  }

  const page = ordered.slice(offset, offset + limit);
  const rows = await fetchDisplayRows(deps.db, q, page.map((f) => f.id));

  const hits: SearchHit[] = [];
  for (const f of page) {
    const r = rows.get(f.id);
    if (!r) continue;
    hits.push({
      entityType: r.entity_type,
      entityId: r.entity_id,
      title: r.title,
      snippet: f.inLexical ? r.headline : r.head,
      // node-postgres parses timestamptz into a JS Date; new Date() accepts either.
      occurredAt: r.occurred_at === null ? null : new Date(r.occurred_at).toISOString(),
      status: r.status,
      score: f.score,
      matchedBy: f.inLexical && f.inSemantic ? "both" : f.inLexical ? "keyword" : "semantic",
      href: HREF[r.entity_type](r.entity_id),
    });
  }

  return {
    hits,
    nextCursor: ordered.length > offset + limit ? encodeCursor(offset + limit) : null,
    semanticAvailable: vec !== null,
    reranked,
    rerankPromptVersion,
  };
}
```

- [ ] **Step 10:** Run the pipeline test — all fourteen pass.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/retrieve.test.ts
```
Expected: `Tests 14 passed`.

- [ ] **Step 11:** Append the failing router deep-mode cases to `packages/api/src/routers/search.test.ts`, inside the existing `describe("search router")` block, after the `"rejects an unauthenticated caller"` test. The file already points `OLLAMA_URL` at the closed port `http://127.0.0.1:1`, so this is the honest production degradation path: Ollama unreachable.
```ts
  it("deep mode reports the prompt version and degrades to the fused order when Ollama is down", async () => {
    const w = testWindow();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) await chunk(id, `Brief ${i}`, `opzegging nummer ${i}`, w.start);

    const fast = await caller().search.query({ q: "opzegging", from: w.from, to: w.to });
    expect(fast.rerankPromptVersion).toBeNull();

    const deep = await caller().search.query({
      q: "opzegging", from: w.from, to: w.to, mode: "deep",
    });
    // The router really does hand retrieve() a rerank port — the version is recorded
    // even though the model never answered.
    expect(deep.rerankPromptVersion).toBe("rerank-v1");
    expect(deep.reranked).toBe(false);
    // Degraded, not errored: same hits, same order as fast mode.
    expect(deep.hits.map((h) => h.entityId)).toEqual(fast.hits.map((h) => h.entityId));
  });

  it("deep mode records the degradation in worker_runs", async () => {
    const w = testWindow();
    await chunk(crypto.randomUUID(), "Brief", "opzegging bevestigd", w.start);
    const before = await db.select().from(schema.workerRuns).where(and(
      eq(schema.workerRuns.worker, "search-rerank"), eq(schema.workerRuns.status, "error")));
    await caller().search.query({ q: "opzegging", from: w.from, to: w.to, mode: "deep" });
    const after = await db.select().from(schema.workerRuns).where(and(
      eq(schema.workerRuns.worker, "search-rerank"), eq(schema.workerRuns.status, "error")));
    expect(after.length).toBe(before.length + 1);
  });
```
Change the file's drizzle import line from:
```ts
import { sql } from "drizzle-orm";
```
to:
```ts
import { and, eq, sql } from "drizzle-orm";
```

- [ ] **Step 12:** Run and watch both new cases fail — the router still builds no rerank port.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
```
Expected: `Tests 2 failed | 4 passed`, the first failure reading `AssertionError: expected null to be 'rerank-v1'`.

- [ ] **Step 13:** Wire the rerank port into the router. `packages/api/src/routers/search.ts` in full after the edit — the whole procedure, not a fragment:
```ts
import { z } from "zod";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "@verder/core";
import { protectedProcedure, router } from "../trpc";
import { realEmbedPort } from "../search/embed";
import { realRerankPort } from "../search/rerank";
import { retrieve } from "../search/retrieve";

/** ISO date ("2026-01-31") or full ISO timestamp — both are what the /search filter
 * rail and the ⌘K palette produce. Validated here so a typo is a BAD_REQUEST and not
 * a Postgres cast error surfacing as INTERNAL_SERVER_ERROR. */
const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/,
  "expected an ISO date like 2026-01-31",
);

export const searchRouter = router({
  /**
   * Hybrid retrieval. The input is FLAT — no `filters` wrapper — because /search
   * builds it straight from URL search params and the ⌘K palette from one text box.
   * The cursor is opaque: a base64 string, never a number.
   *
   * The rerank port is passed on every call; retrieve() only reaches for it when
   * mode is "deep", so ⌘K and /search never pay an Ollama round trip.
   */
  query: protectedProcedure.input(z.object({
    q: z.string().min(1).max(500),
    entityTypes: z.array(z.enum(SEARCH_ENTITY_TYPES)).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    partyId: z.string().uuid().optional(),
    status: z.enum(SEARCH_STATUSES).optional(),
    // "deep" costs an Ollama round trip: agent surfaces only, never ⌘K.
    mode: z.enum(["fast", "deep"]).default("fast"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().nullish(),
  })).query(({ ctx, input }) => retrieve(
    { db: ctx.db, embed: realEmbedPort(), rerank: realRerankPort() },
    input,
  )),
});
```

- [ ] **Step 14:** Run the router test — all six pass.
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
```
Expected: `Tests 6 passed`.

- [ ] **Step 15:** Keep the prompt-version index complete. Append to `apps/worker/src/prompts.ts`, after the existing `buildDocMetaPrompt` function:
```ts
// The rerank prompt runs inside packages/api (the retrieval pipeline lives there; the
// worker imports @verder/api, never the other way round). Re-exported here so this file
// stays the single index of every prompt and its version.
export { RERANK_PROMPT_VERSION, buildRerankPrompt } from "@verder/api/src/search/rerank";
```

- [ ] **Step 16:** Verify nothing else broke, including the worker's prompt imports.
```bash
env -u NODE_ENV pnpm --filter @verder/api test
env -u NODE_ENV pnpm --filter @verder/api typecheck
env -u NODE_ENV pnpm --filter worker test
env -u NODE_ENV pnpm --filter worker typecheck
env -u NODE_ENV pnpm --filter web build
```
Expected: all green.

- [ ] **Step 17:** Commit.
```bash
git add packages/api/src/search/retrieve.ts packages/api/src/search/retrieve.test.ts \
        packages/api/src/routers/search.ts packages/api/src/routers/search.test.ts \
        apps/worker/src/prompts.ts
git commit -m "feat(api): deep search mode with rerank-v1 reranking"
```

**Success criteria:** `search.query({ mode: "deep" })` reorders the top 20 collapsed entities and reports `rerankPromptVersion: "rerank-v1"`; hits the model never scored keep their fused order behind the ones it did; a timeout, an HTTP error or a garbage ordering returns the fused order with `reranked: false` and leaves exactly one `worker_runs` row (`worker: "search-rerank"`, `status: "error"`, `detail.promptVersion: "rerank-v1"`); no code path throws out of the rerank; `mode: "fast"` makes no Ollama chat call at all.

---

### Task 10: Resumable `reindex` CLI

**Files:**
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/reindex.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/reindex.test.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/reindex.ts`
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/package.json`

**Interfaces — Consumes:**
```ts
// packages/api/src/search/index-entity.ts (Task 5) — the DB-backed entity loader:
export async function indexEntity(
  deps: { db: Db; embed: EmbedPort }, entityType: SearchEntityType, entityId: string,
): Promise<{ chunks: number; embedded: number; unchanged: number }>;
// Upserts search_chunks, re-embeds ONLY chunks whose sourceHash changed, deletes chunks
// with chunk_index >= the new chunk count, and returns {chunks:0,...} when the row is gone.

// packages/api/src/search/embed.ts (Task 7):
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
export function realEmbedPort(opts?: { url?: string; model?: string; timeoutMs?: number }): EmbedPort;

// packages/core/src/search/entity-types.ts (Task 4), re-exported from packages/core/src/index.ts:
export const SEARCH_ENTITY_TYPES = ["document","entry","email","financial_item","debt",
  "task","milestone","timeline_event","party"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

// apps/worker/src/heartbeat.ts (shipped):
export async function recordRun(db: Db, worker: string, status: "ok"|"error", detail?: unknown): Promise<void>;
// packages/db (shipped): export function createDb(url: string): { db: Db; pool: pg.Pool }
// packages/db/drizzle/0016_search_grants.sql (Task 2): verder_worker holds
//   SELECT, INSERT, UPDATE, DELETE on search_chunks — which is what --prune needs.
//   verder_worker already holds SELECT on all nine source tables (verified against
//   information_schema.role_table_grants on the dev database).
// apps/worker/vitest.config.ts (Task 7): { test: { fileParallelism: false } } — worker test
//   files share one dev postgres and must not run concurrently against it.
```

**Interfaces — Produces:**
```ts
// apps/worker/src/reindex.ts
export type ReindexArgs = { entity: SearchEntityType | null; since: Date | null; prune: boolean };
export function parseReindexArgs(argv: string[]): ReindexArgs;   // throws on unknown flag / bad type / bad date
export type ReindexResult = { scanned: number; chunks: number; embedded: number; unchanged: number; pruned: number };
export async function runReindex(
  deps: { db: Db; embed: EmbedPort;
    onProgress?: (p: { entityType: SearchEntityType; entityId: string; done: number }) => void | Promise<void> },
  args: ReindexArgs,
): Promise<ReindexResult>;

// apps/worker/src/ops/reindex.ts — the CLI entry (top-level await, runs on import).
// apps/worker/package.json scripts: "reindex": "tsx src/ops/reindex.ts"
// FLAGS ONLY — there is no env-var form:
//   pnpm --filter worker reindex -- [--entity=<type>] [--since=YYYY-MM-DD] [--prune]
```

- [ ] **Step 1:** Confirm the worker test suite is serialized before adding a DB-touching test file to it.
```bash
cat apps/worker/vitest.config.ts
```
Expected: the file exists (added by Task 7) and its `test` block contains `fileParallelism: false`. If it does not, stop and fix Task 7 — these tests insert into `parties` and walk the whole corpus, and a concurrent worker test file would make them non-deterministic.

- [ ] **Step 2:** Write the failing argument-parser tests in `apps/worker/src/reindex.test.ts`. They are pure and come first, so the CLI contract is nailed down before any indexing logic exists.
```ts
import { describe, expect, it } from "vitest";
import { parseReindexArgs } from "./reindex";

describe("parseReindexArgs", () => {
  it("defaults to the whole corpus with no pruning", () => {
    expect(parseReindexArgs([])).toEqual({ entity: null, since: null, prune: false });
  });

  it("reads --entity, --since and --prune", () => {
    expect(parseReindexArgs(["--entity=document", "--since=2026-01-31", "--prune"])).toEqual({
      entity: "document", since: new Date("2026-01-31T00:00:00Z"), prune: true,
    });
  });

  it("rejects an unknown entity type with a message naming the valid ones", () => {
    expect(() => parseReindexArgs(["--entity=invoice"]))
      .toThrow(/unknown entity type "invoice"/);
  });

  it("rejects a malformed --since", () => {
    expect(() => parseReindexArgs(["--since=yesterday"])).toThrow(/--since must be YYYY-MM-DD/);
    expect(() => parseReindexArgs(["--since=2026-02-30"])).toThrow(/not a real date/);
  });

  it("rejects an unknown flag instead of silently ignoring it", () => {
    // There is no env-var form of this CLI: an unrecognised argument must be loud,
    // or a partial backfill silently becomes a full one.
    expect(() => parseReindexArgs(["--dry-run"])).toThrow(/unknown argument "--dry-run"/);
    expect(() => parseReindexArgs(["REINDEX_ENTITY=document"]))
      .toThrow(/unknown argument "REINDEX_ENTITY=document"/);
  });
});
```

- [ ] **Step 3:** Append the failing idempotence, resume, prune and heartbeat tests to `apps/worker/src/reindex.test.ts`. They count only embed calls whose text carries this run's nonce, so rows another suite left in the shared dev database cannot make them flaky. Add these imports to the top of the file, directly under `import { parseReindexArgs } from "./reindex";`:
```ts
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import type { EmbedPort } from "@verder/api/src/search/embed";
import { runReindex } from "./reindex";
```
and append:
```ts
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

/** Records every text handed to the embedder; returns a valid 768-dim vector so the
 * chunks really do get embeddings and the second pass has something to skip. */
function countingEmbed() {
  const seen: string[] = [];
  const port: EmbedPort = {
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
    },
  };
  return { port, seen };
}

const chunkCount = async (db: Db, entityId: string): Promise<number> =>
  ((await db.execute(sql`
    SELECT count(*)::int AS n FROM search_chunks WHERE entity_id = ${entityId}::uuid`))
    .rows as [{ n: number }])[0].n;

describe("runReindex", () => {
  it("re-embeds nothing on the second pass (idempotent by source_hash)", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const nonce = `rix${crypto.randomUUID().slice(0, 8)}`;
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Incasso ${nonce}` }).returning();

      const first = countingEmbed();
      const r1 = await runReindex({ db, embed: first.port },
        { entity: "party", since: null, prune: false });
      expect(r1.scanned).toBeGreaterThan(0);
      expect(first.seen.filter((t) => t.includes(nonce))).toHaveLength(1);
      expect(await chunkCount(db, party.id)).toBe(1);

      const second = countingEmbed();
      const r2 = await runReindex({ db, embed: second.port },
        { entity: "party", since: null, prune: false });
      expect(second.seen.filter((t) => t.includes(nonce))).toHaveLength(0);
      expect(r2.unchanged).toBeGreaterThan(0);
      expect(await chunkCount(db, party.id)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("finishes the corpus after an interrupted run", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const nonce = `rix${crypto.randomUUID().slice(0, 8)}`;
      const created = [];
      for (let i = 0; i < 3; i++) {
        const [p] = await db.insert(schema.parties)
          .values({ kind: "organization", name: `Deurwaarder ${nonce} ${i}` }).returning();
        created.push(p);
      }
      const mine = new Set(created.map((p) => p.id));

      // Simulate a kill -9: blow up from the progress hook once two of OUR parties are
      // done. Everything already indexed is committed, because every entity commits on
      // its own.
      const first = countingEmbed();
      let mineDone = 0;
      await expect(runReindex({
        db, embed: first.port,
        onProgress: ({ entityId }) => {
          if (mine.has(entityId) && ++mineDone === 2) throw new Error("simulated kill");
        },
      }, { entity: "party", since: null, prune: false })).rejects.toThrow(/simulated kill/);
      const afterCrash = await Promise.all(created.map((p) => chunkCount(db, p.id)));
      expect(afterCrash.filter((n) => n > 0)).toHaveLength(2);

      const second = countingEmbed();
      await runReindex({ db, embed: second.port },
        { entity: "party", since: null, prune: false });
      expect(await Promise.all(created.map((p) => chunkCount(db, p.id)))).toEqual([1, 1, 1]);
      // The rerun re-embedded exactly the one entity the crash left undone.
      expect(second.seen.filter((t) => t.includes(nonce))).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("--prune deletes chunks whose source row is gone, and nothing else", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const orphanId = crypto.randomUUID();
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Levend ${crypto.randomUUID().slice(0, 8)}` })
        .returning();
      await db.execute(sql`
        INSERT INTO search_chunks (entity_type, entity_id, chunk_index, title, body, source_hash)
        VALUES ('party', ${orphanId}::uuid, 0, 'wees', 'chunk zonder bronrij',
                ${`test-${crypto.randomUUID()}`})`);

      const embed = countingEmbed();
      await runReindex({ db, embed: embed.port }, { entity: "party", since: null, prune: false });
      expect(await chunkCount(db, orphanId)).toBe(1);

      const pruned = await runReindex({ db, embed: embed.port },
        { entity: "party", since: null, prune: true });
      expect(pruned.pruned).toBeGreaterThan(0);
      expect(await chunkCount(db, orphanId)).toBe(0);
      expect(await chunkCount(db, party.id)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("records every pass in worker_runs so a backfill is visible in system health", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const embed = countingEmbed();
      await runReindex({ db, embed: embed.port },
        { entity: "milestone", since: null, prune: false });
      const runs = await db.select().from(schema.workerRuns)
        .where(eq(schema.workerRuns.worker, "reindex"));
      expect(runs.some((r) => r.status === "ok"
        && (r.detail as Record<string, unknown> | null)?.entityType === "milestone")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 4:** Run and watch it fail on the missing module.
```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter worker test src/reindex.test.ts
```
Expected failure:
```
Error: Failed to load url ./reindex (resolved id: /Users/martin/Workspace/mp/verder/apps/worker/src/reindex) in /Users/martin/Workspace/mp/verder/apps/worker/src/reindex.test.ts. Does the file exist?
```

- [ ] **Step 5:** Create `apps/worker/src/reindex.ts` with the module header, the source map and the argument parser.
```ts
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from "@verder/core";
import { indexEntity } from "@verder/api/src/search/index-entity";
import type { EmbedPort } from "@verder/api/src/search/embed";
import { recordRun } from "./heartbeat";

/**
 * Full or partial rebuild of the search index. The index is DERIVED, so this is always
 * safe to run: it appends no ledger events, touches no evidence table, and is idempotent
 * by source_hash — unchanged text is never re-embedded. Every entity is committed on its
 * own, so a kill -9 loses at most one entity and a rerun picks up where it stopped.
 *
 * The indexing itself is indexEntity() from @verder/api: the same loader the search.drain
 * job uses, so a backfilled record and a trigger-refreshed record are byte-identical.
 */

/** Source table per entity type, plus the column --since filters on. Verified against
 * packages/db/src/schema.ts. */
const SOURCES: Record<SearchEntityType, { table: string; sinceColumn: string }> = {
  document:       { table: "documents",       sinceColumn: "received_at" },
  entry:          { table: "log_entries",     sinceColumn: "occurred_at" },
  email:          { table: "raw_emails",      sinceColumn: "sent_at" },
  financial_item: { table: "financial_items", sinceColumn: "created_at" },
  debt:           { table: "debts",           sinceColumn: "created_at" },
  task:           { table: "tasks",           sinceColumn: "created_at" },
  milestone:      { table: "milestones",      sinceColumn: "created_at" },
  timeline_event: { table: "timeline_events", sinceColumn: "happened_at" },
  party:          { table: "parties",         sinceColumn: "created_at" },
};

const PAGE = 500;

export type ReindexArgs = {
  entity: SearchEntityType | null;
  since: Date | null;
  prune: boolean;
};

const USAGE = "usage: reindex [--entity=<type>] [--since=YYYY-MM-DD] [--prune]";

/** Flags only — this CLI has no env-var form. An unrecognised argument throws rather
 * than being ignored, so a mistyped partial backfill can never silently become a full
 * one on the homelab. */
export function parseReindexArgs(argv: string[]): ReindexArgs {
  const args: ReindexArgs = { entity: null, since: null, prune: false };
  for (const raw of argv) {
    if (raw === "--prune") { args.prune = true; continue; }
    const m = /^--(entity|since)=(.+)$/.exec(raw);
    if (!m) throw new Error(`reindex: unknown argument "${raw}" (${USAGE})`);
    if (m[1] === "entity") {
      if (!(SEARCH_ENTITY_TYPES as readonly string[]).includes(m[2])) {
        throw new Error(
          `reindex: unknown entity type "${m[2]}" (one of ${SEARCH_ENTITY_TYPES.join(", ")})`);
      }
      args.entity = m[2] as SearchEntityType;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m[2])) {
        throw new Error(`reindex: --since must be YYYY-MM-DD, got "${m[2]}"`);
      }
      const d = new Date(`${m[2]}T00:00:00Z`);
      // new Date("2026-02-30T00:00:00Z") is Invalid Date, not March 2nd.
      if (Number.isNaN(d.getTime())) {
        throw new Error(`reindex: --since is not a real date: "${m[2]}"`);
      }
      args.since = d;
    }
  }
  return args;
}
```

- [ ] **Step 6:** Append `runReindex` and the pruning helper to `apps/worker/src/reindex.ts`.
```ts
export type ReindexResult = {
  scanned: number; chunks: number; embedded: number; unchanged: number; pruned: number;
};

/** Keyset page of source ids. Ordering by id keeps the walk stable while rows are being
 * inserted underneath it, which is exactly what a rerun after a crash relies on. */
async function pageIds(
  db: Db, entityType: SearchEntityType, since: Date | null, afterId: string | null,
): Promise<string[]> {
  const { table, sinceColumn } = SOURCES[entityType];
  // Both raw fragments come from the SOURCES map above — never from an argument.
  const rows = (await db.execute(sql`
    SELECT id FROM ${sql.raw(table)}
    WHERE (${since}::timestamptz IS NULL OR ${sql.raw(sinceColumn)} >= ${since}::timestamptz)
      AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
    ORDER BY id
    LIMIT ${sql.raw(String(PAGE))}`)).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/** Records are never deleted in this application, so orphans only appear if that ever
 * changes or if a chunk outlives a hand-rolled cleanup. --prune is the escape hatch. */
async function pruneOrphans(db: Db, entityType: SearchEntityType): Promise<number> {
  const { table } = SOURCES[entityType];
  const res = await db.execute(sql`
    DELETE FROM search_chunks c
    WHERE c.entity_type = ${entityType}
      AND NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} t WHERE t.id = c.entity_id)`);
  return res.rowCount ?? 0;
}

export async function runReindex(
  deps: {
    db: Db; embed: EmbedPort;
    onProgress?: (p: { entityType: SearchEntityType; entityId: string; done: number })
      => void | Promise<void>;
  },
  args: ReindexArgs,
): Promise<ReindexResult> {
  const types = args.entity ? [args.entity] : [...SEARCH_ENTITY_TYPES];
  const total: ReindexResult = { scanned: 0, chunks: 0, embedded: 0, unchanged: 0, pruned: 0 };

  for (const entityType of types) {
    const perType = { scanned: 0, chunks: 0, embedded: 0, unchanged: 0 };
    let afterId: string | null = null;
    for (;;) {
      const ids = await pageIds(deps.db, entityType, args.since, afterId);
      if (ids.length === 0) break;
      for (const id of ids) {
        // One entity, one commit: interrupting here loses at most this entity, and the
        // rerun skips everything whose source_hash is unchanged.
        const r = await indexEntity({ db: deps.db, embed: deps.embed }, entityType, id);
        perType.scanned++;
        perType.chunks += r.chunks;
        perType.embedded += r.embedded;
        perType.unchanged += r.unchanged;
        await deps.onProgress?.({ entityType, entityId: id, done: perType.scanned });
      }
      afterId = ids[ids.length - 1];
      if (ids.length < PAGE) break;
    }
    if (args.prune) total.pruned += await pruneOrphans(deps.db, entityType);
    total.scanned += perType.scanned;
    total.chunks += perType.chunks;
    total.embedded += perType.embedded;
    total.unchanged += perType.unchanged;
    await recordRun(deps.db, "reindex", "ok", { entityType, ...perType, prune: args.prune });
  }
  return total;
}
```

- [ ] **Step 7:** Run the tests — all nine (five parser, four database) pass.
```bash
env -u NODE_ENV pnpm --filter worker test src/reindex.test.ts
```
Expected: `Test Files 1 passed`, `Tests 9 passed`.

- [ ] **Step 8:** Create the thin CLI entry `apps/worker/src/ops/reindex.ts`, mirroring `apps/worker/src/ops/verify-nightly.ts` (top-level await, `WORKER_DATABASE_URL`, `recordRun` on failure, non-zero exit). The logic lives in `src/reindex.ts` precisely because files under `ops/` run on import and cannot be unit-tested.
```ts
// Rebuild the search index. The index is derived: this is always safe to run, it is
// idempotent (unchanged text is never re-embedded) and it is safe to interrupt — rerun
// and it continues where it stopped.
//
//   pnpm --filter worker reindex
//   pnpm --filter worker reindex -- --entity=document --since=2026-01-01
//   pnpm --filter worker reindex -- --prune
//
// In production it runs inside the worker container, like nightly-verify:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker reindex
import { createDb } from "@verder/db";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { recordRun } from "../heartbeat";
import { parseReindexArgs, runReindex } from "../reindex";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";

const { db, pool } = createDb(url);
try {
  const args = parseReindexArgs(process.argv.slice(2));
  console.log(`reindex: start entity=${args.entity ?? "all"} since=${args.since?.toISOString() ?? "all"} prune=${args.prune}`);
  const result = await runReindex({
    db,
    embed: realEmbedPort(),
    // Progress every 50 entities: enough to watch a GPU-bound backfill move, quiet
    // enough for a cron log.
    onProgress: ({ entityType, done }) => {
      if (done % 50 === 0) console.log(`reindex: ${entityType} — ${done} done`);
    },
  }, args);
  console.log(`reindex: done — scanned ${result.scanned}, chunks ${result.chunks}, embedded ${result.embedded}, unchanged ${result.unchanged}, pruned ${result.pruned}`);
} catch (err) {
  await recordRun(db, "reindex", "error", { message: String(err) }).catch(() => {});
  console.error(`reindex: failed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
```

- [ ] **Step 9:** Add the script to `apps/worker/package.json`. Change the last line of the `"scripts"` block from:
```json
    "backfill": "tsx src/ops/backfill-gmail.ts"
```
to:
```json
    "backfill": "tsx src/ops/backfill-gmail.ts",
    "reindex": "tsx src/ops/reindex.ts"
```

- [ ] **Step 10:** Run the CLI end to end against the dev database, twice, and confirm the second pass embeds nothing new.
```bash
env -u NODE_ENV pnpm --filter worker reindex -- --entity=party
env -u NODE_ENV pnpm --filter worker reindex -- --entity=party
```
Expected: both runs end with a line of the form `reindex: done — scanned N, chunks N, embedded E, unchanged U, pruned 0`. On the second run `embedded` is `0` and `unchanged` equals that run's `chunks`. (On the first run `E` equals the number of newly written chunks when Ollama is reachable and `0` when it is not — a dead embedder leaves `embedding` NULL and the chunk keyword-searchable, by design.)

- [ ] **Step 11:** Confirm a bad flag is loud and exits non-zero, rather than degrading a partial reindex into a full one.
```bash
env -u NODE_ENV pnpm --filter worker reindex -- --entity=invoice; echo "exit=$?"
```
Expected:
```
reindex: failed — Error: reindex: unknown entity type "invoice" (one of document, entry, email, financial_item, debt, task, milestone, timeline_event, party)
exit=1
```

- [ ] **Step 12:** Full worker suite plus typecheck.
```bash
env -u NODE_ENV pnpm --filter worker test
env -u NODE_ENV pnpm --filter worker typecheck
```
Expected: green.

- [ ] **Step 13:** Commit.
```bash
git add apps/worker/src/reindex.ts apps/worker/src/reindex.test.ts \
        apps/worker/src/ops/reindex.ts apps/worker/package.json
git commit -m "feat(worker): resumable reindex CLI with --entity, --since and --prune"
```

**Success criteria:** `pnpm --filter worker reindex` rebuilds the whole corpus through the same `indexEntity` the drain uses; a second immediate run reports `embedded 0`; an interrupted run followed by a rerun leaves every source row with chunks and re-embeds only the entity the interruption missed; `--prune` deletes orphan chunks and leaves live ones untouched; every pass writes a `worker_runs` row (`worker: "reindex"`); an unknown flag or entity type exits non-zero with a message naming the valid values, and no env-var form of any option exists.

### Task 11: `/search` — server-rendered results page

The durable half of the search UI: a page whose entire state lives in the query string, rendered on the server, so a bookmarked or shared `/search?q=…` link reproduces itself with JavaScript disabled. Filter rail (type, date range, party, status), a **keyword / semantic / both** badge per result, opaque-cursor pagination, and an honest note when the semantic half of the index could not run.

**Files**

| | Path |
|---|---|
| Modify | `/Users/martin/Workspace/mp/verder/apps/web/package.json` |
| Modify | `/Users/martin/Workspace/mp/verder/pnpm-lock.yaml` (tool-generated by `pnpm install`) |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-kinds.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-kinds.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/search-url.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/search-url.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-results.tsx` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-filters.tsx` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/search/page.tsx` |
| Modify | `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/layout.tsx` |

**Interfaces**

*Consumes* — from **Task 4** (`packages/core/src/search/entity-types.ts`, re-exported from `packages/core/src/index.ts`, so `@verder/core` is the import specifier):

```ts
export const SEARCH_ENTITY_TYPES = ["document","entry","email","financial_item",
  "debt","task","milestone","timeline_event","party"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const SEARCH_STATUSES = [
  "inbox","filed",
  "open","in-progress","waiting","done","dropped",
  "identified","mandatory","allowed","requested","to-cancel","canceled",
  "acknowledged","disputed","in-settlement","settled",
] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];
```

*Consumes* — from **Task 8** (`packages/api/src/routers/search.ts`, registered in `packages/api/src/root.ts` as `search`). The input is **flat — there is no `filters` wrapper** — and `nextCursor` is an **opaque string**, never a number:

```ts
search.query(input) where input = {
  q: string;                       // min 1
  entityTypes?: SearchEntityType[];
  from?: string;                   // ISO date, "YYYY-MM-DD"
  to?: string;
  partyId?: string;                // uuid
  status?: SearchStatus;
  mode?: "fast" | "deep";          // default "fast"
  limit?: number;                  // 1..50, default 20
  cursor?: string | null;
}
// returns RetrieveResult:
{
  hits: {
    entityType: SearchEntityType; entityId: string; title: string; snippet: string;
    occurredAt: string | null; status: string | null; score: number;
    matchedBy: "keyword" | "semantic" | "both"; href: string;
  }[];
  nextCursor: string | null;       // base64 of the numeric offset, or null
  semanticAvailable: boolean;
  reranked: boolean;
  rerankPromptVersion: string | null;
}
```

`snippet` is plain text, built by Task 8 with
`ts_headline('dutch', body, query, 'StartSel=«,StopSel=»,MaxFragments=2,MinWords=15,MaxWords=35')`.
This page renders it as a text node and must **never** use `dangerouslySetInnerHTML`.

*Consumes* (already shipped): `partiesRouter.list` in `/Users/martin/Workspace/mp/verder/packages/api/src/routers/parties.ts` → rows of `schema.parties` (`{ id, kind, name, organization, email, phone, notes, createdAt }`); `serverCaller()` in `/Users/martin/Workspace/mp/verder/apps/web/src/lib/trpc-server.ts`.

*Produces*

```ts
// apps/web/src/components/search-kinds.ts   (NOT a "use client" module)
export const ENTITY_LABEL: Record<SearchEntityType, string>;
export const ENTITY_BADGE: Record<SearchEntityType, string>;
export const MATCH_LABEL: Record<"keyword" | "semantic" | "both", string>;
export const MATCH_BADGE: Record<"keyword" | "semantic" | "both", string>;
export const STATUS_FILTERS: readonly { value: SearchStatus; label: string }[];

// apps/web/src/lib/search-url.ts
export const PAGE_SIZE = 20;
export interface ParsedSearch { q: string; entityTypes: SearchEntityType[];
  from: string; to: string; partyId: string; status: SearchStatus | ""; cursor: string }
export function parseSearchParams(sp: Record<string, string | string[] | undefined>): ParsedSearch;
export function buildSearchHref(p: ParsedSearch, override?: { cursor?: string | null }): string;
export function toQueryInput(p: ParsedSearch): { q: string; entityTypes?: SearchEntityType[];
  from?: string; to?: string; partyId?: string; status?: SearchStatus; cursor?: string;
  limit: number; mode: "fast" };
export function semanticNotice(result: { semanticAvailable: boolean }): string | null;

// apps/web/src/components/search-results.tsx
export type SearchHitRow = { entityType: string; entityId: string; title: string;
  snippet: string; matchedBy: string; occurredAt: string | null;
  status: string | null; href: string };
export function SearchResults(props: { hits: SearchHitRow[] }): JSX.Element;

// apps/web/src/components/search-filters.tsx
export function SearchFilters(props: { parsed: ParsedSearch;
  parties: { id: string; name: string }[] }): JSX.Element;
```

**Two decisions this task makes, stated up front.**

1. **The "semantic search unavailable" note is driven by `semanticAvailable` on the `search.query` response, not by `search.health()`.** `search.health()` and `packages/api/src/search/health.ts` are built in **Task 13**, which executes *after* this task — calling it here would make this task unexecutable. `semanticAvailable` is also the better signal for this screen: it is the truth about *this query* (the query embedding failed, so these results are the keyword half only), which is exactly what the spec's error-handling section asks for. Index-wide health belongs on `/verify`, and that is where Task 13 puts it.
2. **The web uses `hit.href` from the router.** Task 8 fills `SearchHit.href`, the same field the agent surfaces in Tasks 14–15 render, so there is one route mapping for the whole feature and no second copy in the web package.

**How this repo tests screens.** `/Users/martin/Workspace/mp/verder/apps/web/vitest.config.ts` is `test: { environment: "node" }`, and no workspace package depends on jsdom, happy-dom, @testing-library or Playwright — the only two existing web tests are Node-side route-handler tests (`src/app/api/upload/route.test.ts`, `src/app/api/registry-import/route.test.ts`). So this task does not render components in a test. It unit-tests the two pure data-shaping modules under the node environment, proves the page compiles with `next build`, and covers the rendered behaviour with an explicit manual-verification step — the fallback the previous sub-project used (`docs/superpowers/plans/2026-08-19-tasks-milestones.md`).

---

**Step 1 — branch, and write the failing test for the shared search constants.**

```bash
cd /Users/martin/Workspace/mp/verder
git checkout -b sp4/task-11
```

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-kinds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "@verder/core";
import {
  ENTITY_BADGE, ENTITY_LABEL, MATCH_BADGE, MATCH_LABEL, STATUS_FILTERS,
} from "./search-kinds";

describe("search-kinds", () => {
  it("labels and colours every entity type the router accepts", () => {
    for (const t of SEARCH_ENTITY_TYPES) {
      expect(ENTITY_LABEL[t], t).toBeTruthy();
      expect(ENTITY_BADGE[t], t).toBeTruthy();
    }
  });

  it("labels and colours every matchedBy value", () => {
    for (const m of ["keyword", "semantic", "both"] as const) {
      expect(MATCH_LABEL[m], m).toBeTruthy();
      expect(MATCH_BADGE[m], m).toBeTruthy();
    }
  });

  // The whole point of deriving the rail from SEARCH_STATUSES: the UI can never
  // offer a value the router's z.enum rejects, and can never quietly omit one.
  it("offers exactly the statuses the router accepts — no more, no less", () => {
    expect(STATUS_FILTERS.map((s) => s.value)).toEqual([...SEARCH_STATUSES]);
  });

  it("names the record type in every status label, because statuses are per type", () => {
    for (const s of STATUS_FILTERS) expect(s.label, s.value).toContain(" — ");
  });
});
```

**Step 2 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter web test src/components/search-kinds.test.ts
```

Expected failure: `Error: Failed to resolve import "./search-kinds" from "src/components/search-kinds.test.ts". Does the file exist?`

**Step 3 — make `@verder/core` reachable from the web app.**

`apps/web` does not depend on `@verder/core` today (`ls apps/web/node_modules/@verder/` lists only `api`, `auth`, `db`), so the import above cannot resolve even once the file exists. `next.config.ts` already lists `"@verder/core"` in `transpilePackages`, so only the dependency is missing.

In `/Users/martin/Workspace/mp/verder/apps/web/package.json`, change this line:

```json
    "@verder/api": "workspace:*", "@verder/auth": "workspace:*", "@verder/db": "workspace:*",
```

to:

```json
    "@verder/api": "workspace:*", "@verder/auth": "workspace:*", "@verder/core": "workspace:*", "@verder/db": "workspace:*",
```

Then:

```bash
cd /Users/martin/Workspace/mp/verder
pnpm install
ls -l apps/web/node_modules/@verder/core
```

Expected: `pnpm install` finishes with `Done in …`, and the `ls` prints a symlink `core -> ../../../../packages/core`.

**Step 4 — write `search-kinds.ts`.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-kinds.ts`:

```ts
import { SEARCH_STATUSES, type SearchEntityType, type SearchStatus } from "@verder/core";

// Shared search constants. Deliberately NOT a "use client" module: both the
// server-rendered /search page and the client command palette import it, and
// exports of a client module reach server components as client references
// instead of their values (same reason as components/timeline-kinds.ts).

export const ENTITY_LABEL: Record<SearchEntityType, string> = {
  document: "Document",
  entry: "Logbook",
  email: "E-mail",
  financial_item: "Registry item",
  debt: "Debt",
  task: "Task",
  milestone: "Milestone",
  timeline_event: "Key event",
  party: "Party",
};

export const ENTITY_BADGE: Record<SearchEntityType, string> = {
  document: "bg-emerald-100 text-emerald-800",
  entry: "bg-sky-100 text-sky-800",
  email: "bg-amber-100 text-amber-800",
  financial_item: "bg-indigo-100 text-indigo-800",
  debt: "bg-red-100 text-red-700",
  task: "bg-violet-100 text-violet-800",
  milestone: "bg-teal-100 text-teal-800",
  timeline_event: "bg-orange-100 text-orange-800",
  party: "bg-slate-100 text-slate-700",
};

// Why a result matched — the point is that Martin can see it, not guess it.
export const MATCH_LABEL: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "keyword", semantic: "semantic", both: "keyword + semantic",
};
export const MATCH_BADGE: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "bg-slate-100 text-slate-600",
  semantic: "bg-purple-100 text-purple-700",
  both: "bg-green-100 text-green-700",
};

// Statuses are per entity type, so picking one implicitly narrows the results
// to the types that carry it — the labels say which. Typing this as a full
// Record<SearchStatus, string> means adding a status in @verder/core without a
// label here is a compile error, not a blank <option>.
const STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: "Document — inbox",
  filed: "Document — filed",
  open: "Task — open",
  "in-progress": "Task — in progress",
  waiting: "Task — waiting on someone",
  done: "Task — done",
  dropped: "Task — dropped",
  identified: "Registry — identified (item or debt)",
  mandatory: "Registry item — mandatory",
  allowed: "Registry item — allowed",
  requested: "Registry item — cancellation requested",
  "to-cancel": "Registry item — to cancel",
  canceled: "Registry item — canceled",
  acknowledged: "Debt — acknowledged",
  disputed: "Debt — disputed",
  "in-settlement": "Debt — in settlement",
  settled: "Debt — settled",
};

/** The status rail, derived from the router's own vocabulary so it can never drift. */
export const STATUS_FILTERS: readonly { value: SearchStatus; label: string }[] =
  SEARCH_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
```

**Step 5 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter web test src/components/search-kinds.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  4 passed (4)`.

**Step 6 — commit.**

```bash
git add apps/web/package.json pnpm-lock.yaml \
  apps/web/src/components/search-kinds.ts apps/web/src/components/search-kinds.test.ts
git commit -m "feat(web): shared search labels and router-derived status rail"
```

**Step 7 — write the failing test for the URL helpers.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/search-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE, buildSearchHref, parseSearchParams, semanticNotice, toQueryInput,
} from "./search-url";

describe("parseSearchParams", () => {
  it("reads repeated type params and drops unknown ones", () => {
    const p = parseSearchParams({ q: " opzegging ", type: ["document", "task", "nonsense"] });
    expect(p.q).toBe("opzegging");
    expect(p.entityTypes).toEqual(["document", "task"]);
  });

  it("accepts a single type param as a string", () => {
    expect(parseSearchParams({ type: "debt" }).entityTypes).toEqual(["debt"]);
  });

  it("keeps a well-formed date and drops a malformed one", () => {
    const p = parseSearchParams({ from: "2026-08-01", to: "gisteren" });
    expect(p.from).toBe("2026-08-01");
    expect(p.to).toBe("");
  });

  it("drops a status the router would reject", () => {
    expect(parseSearchParams({ status: "to-cancel" }).status).toBe("to-cancel");
    expect(parseSearchParams({ status: "verzonnen" }).status).toBe("");
  });

  it("treats empty strings as absent filters", () => {
    const p = parseSearchParams({ q: "", party: "", status: "", cursor: "" });
    expect(p).toEqual({ q: "", entityTypes: [], from: "", to: "",
      partyId: "", status: "", cursor: "" });
  });
});

describe("buildSearchHref", () => {
  it("round-trips every filter and replaces the cursor", () => {
    const p = parseSearchParams({
      q: "ziggo", type: ["document", "task"], from: "2026-08-01",
      party: "p1", status: "open", cursor: "b2Zmc2V0OjIw",
    });
    const href = buildSearchHref(p, { cursor: "b2Zmc2V0OjQw" });
    expect(href).toContain("type=document&type=task");
    expect(href).toContain("cursor=b2Zmc2V0OjQw");
    const again = parseSearchParams(
      Object.fromEntries(new URL(href, "http://x").searchParams.entries()));
    expect(again.q).toBe("ziggo");
    expect(again.status).toBe("open");
    expect(again.from).toBe("2026-08-01");
  });

  it("drops the cursor when told to, so a filter change starts at page one", () => {
    const p = parseSearchParams({ q: "ziggo", cursor: "b2Zmc2V0OjIw" });
    expect(buildSearchHref(p, { cursor: null })).toBe("/search?q=ziggo");
  });
});

describe("toQueryInput", () => {
  it("omits empty filters instead of sending empty strings to the router", () => {
    expect(toQueryInput(parseSearchParams({ q: "ziggo" }))).toEqual({
      q: "ziggo", entityTypes: undefined, from: undefined, to: undefined,
      partyId: undefined, status: undefined, cursor: undefined,
      limit: PAGE_SIZE, mode: "fast",
    });
  });

  it("forwards the filters that are set, in the router's flat shape", () => {
    const input = toQueryInput(parseSearchParams({
      q: "ziggo", type: ["debt"], from: "2026-01-01", to: "2026-08-01",
      party: "5a1c4e11-0000-4000-8000-000000000001", status: "settled",
      cursor: "b2Zmc2V0OjIw",
    }));
    expect(input).toEqual({
      q: "ziggo", entityTypes: ["debt"], from: "2026-01-01", to: "2026-08-01",
      partyId: "5a1c4e11-0000-4000-8000-000000000001", status: "settled",
      cursor: "b2Zmc2V0OjIw", limit: PAGE_SIZE, mode: "fast",
    });
  });
});

describe("semanticNotice", () => {
  it("says nothing when the semantic half ran", () => {
    expect(semanticNotice({ semanticAvailable: true })).toBeNull();
  });

  it("is explicit when the semantic half could not run", () => {
    expect(semanticNotice({ semanticAvailable: false }))
      .toContain("Semantic search is unavailable");
  });
});
```

**Step 8 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/search-url.test.ts
```

Expected failure: `Error: Failed to resolve import "./search-url" from "src/lib/search-url.test.ts". Does the file exist?`

**Step 9 — write `search-url.ts`.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/search-url.ts`:

```ts
import {
  SEARCH_ENTITY_TYPES, SEARCH_STATUSES,
  type SearchEntityType, type SearchStatus,
} from "@verder/core";

// Everything /search needs comes from the URL, so a bookmarked or shared search
// renders identically with JavaScript disabled. Unknown types, malformed dates
// and unknown statuses are dropped here rather than forwarded to the router and
// rejected there with a BAD_REQUEST Martin would have to decode.

export const PAGE_SIZE = 20;

export interface ParsedSearch {
  q: string;
  entityTypes: SearchEntityType[];
  from: string;              // "YYYY-MM-DD" or "" — feeds <input type="date">
  to: string;
  partyId: string;           // "" when absent
  status: SearchStatus | ""; // "" when absent
  cursor: string;            // opaque router cursor, "" when absent
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function one(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? "").trim();
}
function many(v: string | string[] | undefined): string[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

export function parseSearchParams(
  sp: Record<string, string | string[] | undefined>,
): ParsedSearch {
  const from = one(sp.from);
  const to = one(sp.to);
  const status = one(sp.status);
  return {
    q: one(sp.q),
    entityTypes: many(sp.type).filter((t): t is SearchEntityType =>
      (SEARCH_ENTITY_TYPES as readonly string[]).includes(t)),
    from: DATE_RE.test(from) ? from : "",
    to: DATE_RE.test(to) ? to : "",
    partyId: one(sp.party),
    status: (SEARCH_STATUSES as readonly string[]).includes(status)
      ? (status as SearchStatus) : "",
    cursor: one(sp.cursor),
  };
}

/** Rebuilds the /search URL, optionally replacing the opaque cursor. */
export function buildSearchHref(
  p: ParsedSearch, override: { cursor?: string | null } = {},
): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  for (const t of p.entityTypes) qs.append("type", t);
  if (p.from) qs.set("from", p.from);
  if (p.to) qs.set("to", p.to);
  if (p.partyId) qs.set("party", p.partyId);
  if (p.status) qs.set("status", p.status);
  const cursor = "cursor" in override ? override.cursor : p.cursor;
  if (cursor) qs.set("cursor", cursor);
  return `/search?${qs.toString()}`;
}

/**
 * The router's input is flat — no `filters` wrapper — and every optional field
 * must be absent rather than an empty string, or zod rejects it.
 */
export function toQueryInput(p: ParsedSearch): {
  q: string; entityTypes?: SearchEntityType[]; from?: string; to?: string;
  partyId?: string; status?: SearchStatus; cursor?: string;
  limit: number; mode: "fast";
} {
  return {
    q: p.q,
    entityTypes: p.entityTypes.length ? p.entityTypes : undefined,
    from: p.from || undefined,
    to: p.to || undefined,
    partyId: p.partyId || undefined,
    status: p.status || undefined,
    cursor: p.cursor || undefined,
    limit: PAGE_SIZE,
    mode: "fast",
  };
}

/**
 * Honest note about semantic coverage. The keyword half of the index is always
 * complete; only the vector half can be missing — when the query embedding
 * fails, `retrieve` returns semanticAvailable: false and the fused ranking is
 * lexical only. Martin gets told which half he is looking at instead of being
 * handed a silently thinner list.
 */
export function semanticNotice(result: { semanticAvailable: boolean }): string | null {
  if (result.semanticAvailable) return null;
  return "Semantic search is unavailable right now — the meaning-based half of the index could not be reached. The keyword results below are complete and nothing is lost; try the same search again once the model host is back.";
}
```

**Step 10 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/search-url.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  11 passed (11)`.

**Step 11 — commit.**

```bash
git add apps/web/src/lib/search-url.ts apps/web/src/lib/search-url.test.ts
git commit -m "feat(web): search url parsing, cursor hrefs and the semantic notice"
```

**Step 12 — write the results list.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-results.tsx`:

```tsx
import Link from "next/link";
import { ENTITY_BADGE, ENTITY_LABEL, MATCH_BADGE, MATCH_LABEL } from "./search-kinds";

// Presentational (server-safe) result list. The snippet is plain text — Task 8
// builds it with ts_headline StartSel=«/StopSel=» precisely so nothing here has
// to render HTML that came out of the database.

export type SearchHitRow = {
  entityType: string;
  entityId: string;
  title: string;
  snippet: string;
  matchedBy: string;
  occurredAt: string | null;
  status: string | null;
  href: string;
};

export function SearchResults({ hits }: { hits: SearchHitRow[] }) {
  if (hits.length === 0) {
    return (
      <p className="text-slate-500">
        Nothing found — try fewer words or widen the filters. An empty result
        isn&apos;t a mistake; it may simply not be in the dossier yet.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {hits.map((h) => (
        <li key={`${h.entityType}:${h.entityId}`} className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${ENTITY_BADGE[h.entityType as keyof typeof ENTITY_BADGE] ?? ENTITY_BADGE.party}`}>
              {ENTITY_LABEL[h.entityType as keyof typeof ENTITY_LABEL] ?? h.entityType}
            </span>
            <Link href={h.href} className="font-medium hover:underline">{h.title}</Link>
            {h.status && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {h.status}
              </span>
            )}
            <span className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${MATCH_BADGE[h.matchedBy as keyof typeof MATCH_BADGE] ?? MATCH_BADGE.keyword}`}>
              {MATCH_LABEL[h.matchedBy as keyof typeof MATCH_LABEL] ?? h.matchedBy}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{h.snippet}</p>
          {h.occurredAt && (
            <p className="mt-1 text-xs text-slate-500">
              {new Date(h.occurredAt).toLocaleDateString("nl-NL")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
```

**Step 13 — write the filter rail.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-filters.tsx`:

```tsx
import { SEARCH_ENTITY_TYPES } from "@verder/core";
import { ENTITY_LABEL, STATUS_FILTERS } from "./search-kinds";
import type { ParsedSearch } from "@/lib/search-url";

// A plain GET form: no client state, no JavaScript. Submitting reloads /search
// with the filters in the URL — which is exactly what a bookmarked or shared
// search needs in order to reproduce itself. The cursor is deliberately not a
// field: changing a filter starts a new search at the first page.

export function SearchFilters({ parsed, parties }: {
  parsed: ParsedSearch; parties: { id: string; name: string }[];
}) {
  return (
    <form method="get" action="/search" className="rounded border bg-white p-4 space-y-3">
      <label className="block text-sm">Search
        <input name="q" defaultValue={parsed.q} placeholder="opzegging Ziggo"
          className="w-full border rounded p-2" />
      </label>
      <fieldset className="space-y-1">
        <legend className="text-sm">Type</legend>
        <div className="flex flex-wrap gap-3">
          {SEARCH_ENTITY_TYPES.map((t) => (
            <label key={t} className="text-sm flex items-center gap-1">
              <input type="checkbox" name="type" value={t}
                defaultChecked={parsed.entityTypes.includes(t)} />
              {ENTITY_LABEL[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">From
          <input type="date" name="from" defaultValue={parsed.from}
            className="block border rounded p-2" />
        </label>
        <label className="text-sm">To
          <input type="date" name="to" defaultValue={parsed.to}
            className="block border rounded p-2" />
        </label>
        <label className="text-sm">Party
          <select name="party" defaultValue={parsed.partyId} className="block border rounded p-2">
            <option value="">Anyone</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select name="status" defaultValue={parsed.status} className="block border rounded p-2">
            <option value="">Any status</option>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <button type="submit" className="rounded bg-slate-900 text-white px-4 py-2">Search</button>
    </form>
  );
}
```

**Step 14 — write the page.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/search/page.tsx`:

```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { SearchFilters } from "@/components/search-filters";
import { SearchResults } from "@/components/search-results";
import {
  buildSearchHref, parseSearchParams, semanticNotice, toQueryInput,
} from "@/lib/search-url";

// Everything on this page comes from the URL and is rendered on the server, so
// a bookmarked or shared /search?q=… link reproduces exactly this view with
// JavaScript disabled. The ⌘K palette is the fast path; this is the durable one.

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = parseSearchParams(await searchParams);
  const caller = await serverCaller();
  const parties = await caller.parties.list();
  // The router requires q of at least one character, so an empty box asks nothing.
  const result = parsed.q ? await caller.search.query(toQueryInput(parsed)) : null;
  const notice = result ? semanticNotice(result) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Search</h1>
        <p className="text-slate-600 mt-1">
          Everything in the dossier — documents, logbook, e-mail, registry, tasks,
          milestones — in one place. Every result says why it matched.
        </p>
      </div>

      <SearchFilters parsed={parsed}
        parties={parties.map((p) => ({ id: p.id, name: p.name }))} />

      {notice && (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {notice}
        </p>
      )}

      {result ? (
        <>
          <SearchResults hits={result.hits} />
          <div className="flex items-center gap-3">
            {result.nextCursor && (
              <Link className="inline-block rounded border px-4 py-2 hover:bg-slate-100"
                href={buildSearchHref(parsed, { cursor: result.nextCursor })}>
                More results →
              </Link>
            )}
            {parsed.cursor && (
              <Link className="text-sm text-slate-500 hover:underline"
                href={buildSearchHref(parsed, { cursor: null })}>
                back to the first page
              </Link>
            )}
          </div>
        </>
      ) : (
        <p className="text-slate-500">
          Type something above — or press ⌘K anywhere in the app.
        </p>
      )}
    </div>
  );
}
```

**Step 15 — add the nav entry.**

In `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/layout.tsx`, replace this exact line (line 8):

```tsx
        {[["Dashboard", "/dashboard"], ["Logbook", "/logbook"], ["Vault", "/vault"],
```

with:

```tsx
        {[["Dashboard", "/dashboard"], ["Search", "/search"], ["Logbook", "/logbook"], ["Vault", "/vault"],
```

**Step 16 — typecheck, build, test.**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
env -u NODE_ENV pnpm --filter web test
```

Expected: `typecheck` prints nothing, `next build` prints `✓ Compiled successfully` and lists `/search` in the route table as a dynamic route (`ƒ`), and the web suite is green (`Tests  26 passed (26)` — the 11 pre-existing route-handler tests (5 in `api/upload/route.test.ts`, 6 in `api/registry-import/route.test.ts`), plus 4 from `search-kinds.test.ts` and 11 from `search-url.test.ts`).

**Step 17 — manual verification** (the repo has no DOM test environment; this is the established fallback).

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter web dev
```

Log in as `martin@vanderpoel.pro` / `devpass`, then:
- Click **Search** in the left nav — it sits directly under Dashboard and lands on `/search` with an empty box and the "Type something above" hint.
- Visit `/search?q=opzegging` — results render; each row shows a type badge, the title as a link, and a `keyword` / `semantic` / `keyword + semantic` badge on the right.
- Open DevTools → Settings → Debugger → **Disable JavaScript**, reload the same URL: the page and every result still render, and submitting the filter form still navigates.
- Tick the **Document** and **Task** checkboxes, set a From date, pick a status, submit: the URL carries `type=document&type=task&from=…&status=…`, and reloading that URL reproduces the same page with the same boxes ticked.
- Click **More results →**: the URL gains an opaque `cursor=` value and the result set changes; the "back to the first page" link removes it.
- With no Ollama reachable from the dev machine (the default — `OLLAMA_URL` points at `http://localhost:11434`), the amber "Semantic search is unavailable right now" note is shown above the results. Point `OLLAMA_URL` at the homelab (`OLLAMA_URL=http://homelab:11434 env -u NODE_ENV pnpm --filter web dev`) and reload: the note disappears and rows start showing `semantic` / `keyword + semantic` badges.

**Step 18 — commit.**

```bash
git add apps/web/src/components/search-results.tsx apps/web/src/components/search-filters.tsx \
  "apps/web/src/app/(app)/search/page.tsx" "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): server-rendered /search results page"
```

---

### Task 12: the ⌘K command palette

The fast path into the dossier: ⌘K / Ctrl+K anywhere in the app, 150 ms debounce, at most 8 hits grouped by record type, arrow-key navigation, Enter opens, ⇧Enter goes to `/search?q=`, and an empty state that lists the records that changed most recently. Everything it can reach, `/search` can reach too — the palette is never the only way in, and it never mutates anything.

**Files**

| | Path |
|---|---|
| Create | `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.ts` |
| Create | `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.test.ts` |
| Modify | `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts` |
| Create | `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search-recent.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/palette.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/palette.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/command-palette.tsx` |
| Modify | `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/layout.tsx` |

**Interfaces**

*Consumes* — from **Task 1** (`packages/db/src/schema.ts`): table `search_chunks` with columns `id uuid`, `entity_type text`, `entity_id uuid`, `chunk_index integer`, `title text`, `body text`, `occurred_at timestamptz null`, `status text null`, `tsv tsvector GENERATED`, `embedding vector(768) null`, `source_hash text`, `embed_attempts integer`, `indexed_at timestamptz not null default now()`.

*Consumes* — from **Task 2** (`packages/db/drizzle/0016_search_grants.sql`): `verder_app` has `SELECT` on `search_chunks` (`verder_app=r/verder`). `recentEntities` is a read, so the app role is enough; the fixtures in its test are written with the worker role, which is the only role holding `INSERT`.

*Consumes* — from **Task 4** (`@verder/core`): `SEARCH_ENTITY_TYPES`, `type SearchEntityType`.

*Consumes* — from **Task 8** (`packages/api/src/routers/search.ts`): the router object `export const searchRouter = router({ … })`, registered in `packages/api/src/root.ts` as `search`, whose file already imports `z` from `"zod"` and `{ protectedProcedure, router }` from `"../trpc"`. `search.query` takes the flat input and returns the `RetrieveResult` documented in Task 11, whose hits each carry `href: string`.

*Consumes* — from **Task 11**: `ENTITY_LABEL` in `/Users/martin/Workspace/mp/verder/apps/web/src/components/search-kinds.ts`, and the `@verder/core` dependency added to `apps/web/package.json`.

*Consumes* (already shipped): `trpc` from `/Users/martin/Workspace/mp/verder/apps/web/src/lib/trpc-client.tsx` (`createTRPCReact<AppRouter>()`; hooks are used as `trpc.<router>.<procedure>.useQuery(input, options)` — see `apps/web/src/components/enable-push.tsx` and `apps/web/src/components/verify-panel.tsx`).

*Produces*

```ts
// packages/api/src/search/recent.ts
export const LINKABLE_ENTITY_TYPES = ["document","entry","financial_item","debt",
  "task","milestone","timeline_event"] as const;
export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];
export type RecentRecord = { entityType: LinkableEntityType; entityId: string;
  title: string; occurredAt: string | null; href: string };
export function entityHref(entityType: LinkableEntityType, entityId: string): string;
export async function recentEntities(db: Db, limit: number): Promise<RecentRecord[]>;

// packages/api/src/routers/search.ts (added procedure)
search.recent: (input?: { limit?: number /* 1..20, default 8 */ }) => Promise<RecentRecord[]>;

// apps/web/src/lib/palette.ts
export interface PaletteHit { entityType: string; entityId: string; title: string; href: string }
export interface PaletteGroup { entityType: string; hits: PaletteHit[] }
export function groupHits(hits: PaletteHit[]): PaletteGroup[];
export function flatOrder(groups: PaletteGroup[]): PaletteHit[];
export function nextIndex(length: number, current: number, key: "ArrowDown" | "ArrowUp"): number;

// apps/web/src/components/command-palette.tsx
export function CommandPalette(): JSX.Element | null;   // "use client"
```

**Why `search.recent` returns `href`.** The palette renders two lists — search hits and the empty-state recent list — and both must navigate the same way. `search.query` hits already carry `href` (Task 8), so the recent rows carry it too and the component has exactly one navigation path. `entityHref` lives beside the query in `packages/api/src/search/recent.ts` and is unit-tested against the seven real routes under `apps/web/src/app/(app)`, so a route rename fails a test rather than producing a dead link. Parties and e-mails are excluded from the recent list because neither has a screen of its own — offering something that cannot be opened would be worse than omitting it.

**Same testing reality as Task 11:** `apps/web/vitest.config.ts` is `environment: "node"` and there is no jsdom, testing-library or Playwright anywhere in the workspace, so the keyboard and grouping logic is extracted into `palette.ts` and unit-tested there, and the component wiring is covered by `next build` plus an explicit manual-verification step.

---

**Step 1 — branch, and write the failing test for the route map.**

```bash
cd /Users/martin/Workspace/mp/verder
git checkout -b sp4/task-12
```

Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LINKABLE_ENTITY_TYPES, entityHref } from "./recent";

const ID = "11111111-1111-1111-1111-111111111111";

describe("entityHref", () => {
  it("maps every linkable type to a real route under apps/web/src/app/(app)", () => {
    expect(entityHref("document", ID)).toBe(`/vault/${ID}`);
    expect(entityHref("entry", ID)).toBe(`/logbook/${ID}`);
    expect(entityHref("financial_item", ID)).toBe(`/registry/${ID}`);
    expect(entityHref("debt", ID)).toBe(`/registry/debts/${ID}`);
    expect(entityHref("task", ID)).toBe(`/tasks/${ID}`);
    expect(entityHref("milestone", ID)).toBe("/milestones");
    expect(entityHref("timeline_event", ID)).toBe("/timeline");
  });

  it("covers the whole linkable list, so no row can render without a target", () => {
    for (const t of LINKABLE_ENTITY_TYPES) {
      expect(entityHref(t, ID), t).toMatch(/^\//);
    }
  });
});
```

**Step 2 — run it, see it fail.**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/api test src/search/recent.test.ts
```

Expected failure: `Error: Failed to resolve import "./recent" from "src/search/recent.test.ts". Does the file exist?`

**Step 3 — write the route map.**

Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";

// The ⌘K palette's empty state. Parties and e-mails are deliberately absent
// from this list: neither has a screen of its own, and a row you cannot open is
// worse than no row at all.
export const LINKABLE_ENTITY_TYPES = [
  "document", "entry", "financial_item", "debt", "task", "milestone", "timeline_event",
] as const;
export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];

export type RecentRecord = {
  entityType: LinkableEntityType;
  entityId: string;
  title: string;
  occurredAt: string | null;
  href: string;
};

/** Detail route for a record. Every path here is a real route under apps/web/src/app/(app). */
export function entityHref(entityType: LinkableEntityType, entityId: string): string {
  switch (entityType) {
    case "document": return `/vault/${entityId}`;
    case "entry": return `/logbook/${entityId}`;
    case "financial_item": return `/registry/${entityId}`;
    case "debt": return `/registry/debts/${entityId}`;
    case "task": return `/tasks/${entityId}`;
    case "milestone": return "/milestones";
    case "timeline_event": return "/timeline";
  }
}
```

**Step 4 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/recent.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  2 passed (2)`.

**Step 5 — add the failing test for `recentEntities`.**

Append to `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.test.ts`, and change its first line's import to pull in the two new symbols:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { LINKABLE_ENTITY_TYPES, entityHref, recentEntities } from "./recent";
```

```ts
// The app role only holds SELECT on search_chunks (migration 0016), so fixtures
// are written with the worker role and read back with the app role — the same
// split production runs with.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("recentEntities", () => {
  let app: Db; let worker: Db;
  beforeAll(() => {
    app = createDb(APP_URL).db;
    worker = createDb(WORKER_URL).db;
  });

  it("returns the newest-indexed head chunks with their route, capped at the limit", async () => {
    const entityId = crypto.randomUUID();
    await worker.insert(schema.searchChunks).values([
      { entityType: "task", entityId, chunkIndex: 0, title: "Palette probe head",
        body: "eerste stuk", sourceHash: crypto.randomUUID() },
      { entityType: "task", entityId, chunkIndex: 1, title: "Palette probe tail",
        body: "tweede stuk", sourceHash: crypto.randomUUID() },
    ]);

    const rows = await recentEntities(app, 8);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0].entityId).toBe(entityId);
    expect(rows[0].title).toBe("Palette probe head");
    expect(rows[0].href).toBe(`/tasks/${entityId}`);
    // chunk_index > 0 must never appear: one long document may not fill the list.
    expect(rows.some((r) => r.title === "Palette probe tail")).toBe(false);
  });

  it("never lists a record type the palette cannot open", async () => {
    await worker.insert(schema.searchChunks).values({
      entityType: "party", entityId: crypto.randomUUID(), chunkIndex: 0,
      title: "Palette probe party", body: "Naam: VerderGroep",
      sourceHash: crypto.randomUUID(),
    });

    const rows = await recentEntities(app, 8);
    expect(rows.some((r) => r.title === "Palette probe party")).toBe(false);
    for (const r of rows) {
      expect(LINKABLE_ENTITY_TYPES as readonly string[]).toContain(r.entityType);
    }
  });
});
```

**Step 6 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/recent.test.ts
```

Expected: the two `entityHref` tests still pass and both new tests fail with `TypeError: recentEntities is not a function`.

**Step 7 — write `recentEntities`.**

Append to `/Users/martin/Workspace/mp/verder/packages/api/src/search/recent.ts`:

```ts
/**
 * The records that changed most recently, read straight off the index so the
 * palette's empty state costs one query instead of nine per-table ones.
 * Ordered by indexed_at, not occurred_at: "recent" here means "recently touched
 * in the dossier", which is what someone reaching for ⌘K is usually after, and
 * it does not let a record dated in the future pin itself to the top forever.
 */
export async function recentEntities(db: Db, limit: number): Promise<RecentRecord[]> {
  const rows = (await db.execute(sql`
    SELECT entity_type, entity_id, title, occurred_at
    FROM search_chunks
    WHERE chunk_index = 0
      AND entity_type NOT IN ('party', 'email')
    ORDER BY indexed_at DESC
    LIMIT ${limit}`)).rows as {
      entity_type: string; entity_id: string; title: string;
      occurred_at: string | Date | null;
    }[];
  return rows.map((r) => {
    const entityType = r.entity_type as LinkableEntityType;
    return {
      entityType,
      entityId: r.entity_id,
      title: r.title,
      occurredAt: r.occurred_at === null ? null : new Date(r.occurred_at).toISOString(),
      href: entityHref(entityType, r.entity_id),
    };
  });
}
```

**Step 8 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/recent.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  4 passed (4)`.

**Step 9 — write the failing test for the router procedure.**

Create `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search-recent.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// Shared dev postgres: assert only about the shape and the cap, never about
// rows other test files happen to have indexed.
describe("search.recent", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `sr${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("caps the list at the requested limit and gives every row a route", async () => {
    const rows = await caller().search.recent({ limit: 3 });
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(r.href).toMatch(/^\//);
  });

  it("defaults to 8 rows when called with no input", async () => {
    const rows = await caller().search.recent();
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});
```

**Step 10 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search-recent.test.ts
```

Expected failure, twice: `TRPCError: No procedure found on path "search,recent"`.

**Step 11 — add the procedure.**

In `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts`, add this import line directly below the existing `import { protectedProcedure, router } from "../trpc";`:

```ts
import { recentEntities } from "../search/recent";
```

Then insert this procedure immediately after the line `export const searchRouter = router({`, so it is the first entry in the router object:

```ts
  // Empty-state list for the ⌘K palette. Reads the index rather than nine
  // source tables, and returns the same href field search.query hits carry so
  // the palette has exactly one way to navigate.
  recent: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).default(8) }).default({}))
    .query(({ ctx, input }) => recentEntities(ctx.db, input.limit)),
```

**Step 12 — run it, see it pass, then the whole package.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search-recent.test.ts
env -u NODE_ENV pnpm --filter @verder/api test
```

Expected: `Tests  2 passed (2)` for the file, and the whole `@verder/api` suite green.

**Step 13 — commit.**

```bash
git add packages/api/src/search/recent.ts packages/api/src/search/recent.test.ts \
  packages/api/src/routers/search.ts packages/api/src/routers/search-recent.test.ts
git commit -m "feat(api): recent records for the command palette"
```

**Step 14 — write the failing test for the palette logic.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/palette.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { flatOrder, groupHits, nextIndex } from "./palette";

const hits = [
  { entityType: "task", entityId: "t1", title: "Kopie paspoort opsturen", href: "/tasks/t1" },
  { entityType: "document", entityId: "d1", title: "Brief VerderGroep", href: "/vault/d1" },
  { entityType: "task", entityId: "t2", title: "Ziggo opzeggen", href: "/tasks/t2" },
];

describe("groupHits", () => {
  it("groups by record type in the fixed SEARCH_ENTITY_TYPES order", () => {
    const groups = groupHits(hits);
    expect(groups.map((g) => g.entityType)).toEqual(["document", "task"]);
    expect(groups[1].hits.map((h) => h.entityId)).toEqual(["t1", "t2"]);
  });

  it("drops empty groups", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("flatOrder", () => {
  it("is the order the arrow keys walk", () => {
    expect(flatOrder(groupHits(hits)).map((h) => h.entityId)).toEqual(["d1", "t1", "t2"]);
  });
});

describe("nextIndex", () => {
  it("moves down and wraps at the end", () => {
    expect(nextIndex(3, 0, "ArrowDown")).toBe(1);
    expect(nextIndex(3, 2, "ArrowDown")).toBe(0);
  });
  it("moves up and wraps at the start", () => {
    expect(nextIndex(3, 1, "ArrowUp")).toBe(0);
    expect(nextIndex(3, 0, "ArrowUp")).toBe(2);
  });
  it("stays at 0 for an empty list so the caller never renders a bad index", () => {
    expect(nextIndex(0, 0, "ArrowDown")).toBe(0);
    expect(nextIndex(0, 0, "ArrowUp")).toBe(0);
  });
});
```

**Step 15 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/palette.test.ts
```

Expected failure: `Error: Failed to resolve import "./palette" from "src/lib/palette.test.ts". Does the file exist?`

**Step 16 — write `palette.ts`.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/palette.ts`:

```ts
import { SEARCH_ENTITY_TYPES } from "@verder/core";

// Pure palette logic, kept out of the client component so it can be tested
// under vitest's node environment (this repo has no DOM test setup).

export interface PaletteHit {
  entityType: string;
  entityId: string;
  title: string;
  href: string;
}
export interface PaletteGroup { entityType: string; hits: PaletteHit[] }

/**
 * Groups hits by record type in the fixed SEARCH_ENTITY_TYPES order, so the
 * sections never reshuffle between keystrokes while Martin is aiming at one.
 */
export function groupHits(hits: PaletteHit[]): PaletteGroup[] {
  return (SEARCH_ENTITY_TYPES as readonly string[])
    .map((entityType) => ({
      entityType,
      hits: hits.filter((h) => h.entityType === entityType),
    }))
    .filter((g) => g.hits.length > 0);
}

/** The groups flattened back into one list — the order the arrow keys walk. */
export function flatOrder(groups: PaletteGroup[]): PaletteHit[] {
  return groups.flatMap((g) => g.hits);
}

/**
 * Arrow-key cursor. Wraps at both ends, and returns 0 for an empty list so the
 * caller never has to guard the index it renders with.
 */
export function nextIndex(
  length: number, current: number, key: "ArrowDown" | "ArrowUp",
): number {
  if (length === 0) return 0;
  const delta = key === "ArrowDown" ? 1 : -1;
  return (current + delta + length) % length;
}
```

**Step 17 — run it, see it pass, and commit.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/palette.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

```bash
git add apps/web/src/lib/palette.ts apps/web/src/lib/palette.test.ts
git commit -m "feat(web): palette grouping and arrow-key navigation logic"
```

**Step 18 — write the palette component.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/command-palette.tsx`:

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { ENTITY_LABEL } from "@/components/search-kinds";
import { flatOrder, groupHits, nextIndex, type PaletteHit } from "@/lib/palette";

// The fast path into the dossier: ⌘K / Ctrl+K anywhere in the app. Everything
// it can reach, /search can reach too — the palette is never the only way in,
// and it never mutates anything.

const MIN_QUERY = 2;
const HITS = 8;
const DEBOUNCE_MS = 150;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut, registered once. The handler only calls setState, so it
  // never needs re-binding as the query changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 150 ms debounce: one request per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setCursor(0); }, [debounced]);

  const searching = debounced.length >= MIN_QUERY;
  const results = trpc.search.query.useQuery(
    { q: debounced, limit: HITS, mode: "fast" as const },
    { enabled: open && searching },
  );
  const recent = trpc.search.recent.useQuery(
    { limit: HITS },
    { enabled: open && !searching },
  );

  const hits: PaletteHit[] = useMemo(() => {
    const source = searching
      ? results.data?.hits ?? []
      : recent.data ?? [];
    return source.map((h) => ({
      entityType: h.entityType, entityId: h.entityId, title: h.title, href: h.href,
    }));
  }, [searching, results.data, recent.data]);

  const groups = groupHits(hits);
  const flat = flatOrder(groups);

  function openHit(hit: PaletteHit | undefined) {
    if (!hit) return;
    setOpen(false);
    router.push(hit.href);
  }
  function seeAll() {
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/30 p-4" onClick={() => setOpen(false)}>
      <div className="mx-auto max-w-xl rounded border bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={q}
          placeholder="Search everything — ⇧Enter for all results"
          className="w-full border-b p-3 outline-none"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => nextIndex(flat.length, c, e.key as "ArrowDown" | "ArrowUp"));
            } else if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              seeAll();
            } else if (e.key === "Enter") {
              e.preventDefault();
              openHit(flat[cursor]);
            }
          }} />
        <div className="max-h-96 overflow-y-auto p-2">
          {!searching && (
            <p className="px-2 py-1 text-xs text-slate-500">Recently updated</p>
          )}
          {groups.length === 0 && (
            <p className="px-2 py-3 text-sm text-slate-500">
              {results.isFetching || recent.isFetching
                ? "Searching…"
                : "Nothing found — try fewer words."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.entityType} className="py-1">
              <p className="px-2 text-xs font-medium text-slate-500">
                {ENTITY_LABEL[g.entityType as keyof typeof ENTITY_LABEL] ?? g.entityType}
              </p>
              <ul>
                {g.hits.map((h) => {
                  const i = flat.indexOf(h);
                  return (
                    <li key={`${h.entityType}:${h.entityId}`}>
                      <button
                        className={`w-full rounded px-2 py-1.5 text-left text-sm ${i === cursor ? "bg-slate-100" : ""}`}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => openHit(h)}>{h.title}</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-slate-500">
          <span>↑↓ to move · Enter to open · ⇧Enter for all · Esc to close</span>
          <button className="hover:underline" onClick={seeAll}>see all results →</button>
        </div>
      </div>
    </div>
  );
}
```

**Step 19 — mount it in the app layout.**

In `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/layout.tsx`, replace this exact line (line 1):

```tsx
import Link from "next/link";
```

with:

```tsx
import Link from "next/link";
import { CommandPalette } from "@/components/command-palette";
```

Then replace this exact line:

```tsx
      <main className="flex-1 p-8">{children}</main>
```

with:

```tsx
      <main className="flex-1 p-8">{children}</main>
      <CommandPalette />
```

A client component rendered by a server layout — the same arrangement `EnablePush` uses on the dashboard.

**Step 20 — typecheck, build, test.**

```bash
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
env -u NODE_ENV pnpm --filter web test
```

Expected: `typecheck` silent, `next build` prints `✓ Compiled successfully`, and the web suite is green (`Tests  32 passed (32)` — the 11 pre-existing route-handler tests, Task 11's 15, plus the 6 from `palette.test.ts`).

**Step 21 — manual verification** (no DOM test environment exists in this repo).

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter web dev
```

Log in and land on `/dashboard`, then:
- Press **⌘K**: the overlay opens with the input focused and a "Recently updated" list of at most 8 indexed records, grouped under type headings.
- Press **Escape**: it closes. Press **Ctrl+K**: it opens again (both modifiers work).
- Type `zig`: with the Network tab open, exactly one `/api/trpc` batch fires per pause in typing — not one per character — and at most 8 hits appear, grouped by type.
- Press **↓ ↓ ↑**: the highlight moves and wraps around both ends. Press **Enter**: the highlighted record's detail page opens and the overlay closes.
- Press ⌘K, type `zig`, press **⇧Enter**: it navigates to `/search?q=zig`. Do the same with the "see all results →" button in the footer.
- Press ⌘K and click the dimmed backdrop: the overlay closes.

**Step 22 — commit.**

```bash
git add apps/web/src/components/command-palette.tsx "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): ⌘K command palette over the search index"
```

---

### Task 13: index health on `/verify`

Chunk count, outbox depth, embedding failures and last drain time, reported beside the ledger checks, so a stalled index is as visible as a broken chain — with the difference spelled out on the card itself: the index is derived and rebuildable, the chain is the evidence.

**Files**

| | Path |
|---|---|
| Modify | `/Users/martin/Workspace/mp/verder/packages/api/src/search/health.ts` (created in Task 7) |
| Create | `/Users/martin/Workspace/mp/verder/packages/api/src/search/health.test.ts` |
| Modify | `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts` |
| Create | `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search-health.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/index-health-state.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/lib/index-health-state.test.ts` |
| Create | `/Users/martin/Workspace/mp/verder/apps/web/src/components/index-health.tsx` |
| Modify | `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/verify/page.tsx` |

**Interfaces**

*Consumes* — from **Task 1** (`packages/db/src/schema.ts`): `search_chunks` (`embedding vector(768) null`, `embed_attempts integer not null default 0`) and `search_outbox`. From the shipped schema: `worker_runs (worker text, status text, detail jsonb, ran_at timestamptz not null default now())` — verified at `packages/db/src/schema.ts:278–284`.

*Consumes* — from **Task 2** (`packages/db/drizzle/0016_search_grants.sql`): `verder_app` has `SELECT` on both `search_chunks` and `search_outbox` (`\dp` shows `verder_app=r/verder` for each). `readIndexHealth` runs as the app role in production, so `health.test.ts` doubles as the proof that grant landed.

*Consumes* — from **Task 7** (`packages/api/src/search/health.ts`): `export const DRAIN_WORKER_NAME = "search-drain";`. Task 7 creates that file containing the constant alone, because `apps/worker/src/search-drain.ts` needs it at the moment it is written; this task extends the same file with the health read. One definition, no re-export, no circularity.

*Consumes* — from **Task 8**: `export const searchRouter = router({ … })` in `packages/api/src/routers/search.ts`, registered as `search` in `root.ts`; the file already imports `{ protectedProcedure, router }` from `"../trpc"`.

*Consumes* (already shipped): `serverCaller()` in `apps/web/src/lib/trpc-server.ts`; `VerifyPanel` in `apps/web/src/components/verify-panel.tsx`.

*Produces*

```ts
// packages/api/src/search/health.ts
// DRAIN_WORKER_NAME is already exported from this file (created in Task 7).
export const DRAIN_STALE_MS = 10 * 60 * 1000;
export const OUTBOX_WARN_DEPTH = 500;
export type IndexHealth = { chunks: number; outboxDepth: number; embedFailures: number;
  lastDrainAt: string | null; degraded: boolean };
export async function readIndexHealth(db: Db): Promise<IndexHealth>;

// packages/api/src/routers/search.ts (added procedure)
search.health: () => Promise<IndexHealth>;

// apps/web/src/lib/index-health-state.ts
export type IndexHealthTone = "ok" | "warn" | "bad";
export function indexHealthState(h: IndexHealth, now: number):
  { tone: IndexHealthTone; message: string };

// apps/web/src/components/index-health.tsx
export function IndexHealthCard(props: { health: IndexHealth; now: number }): JSX.Element;
```

**Where `DRAIN_WORKER_NAME` lives.** In `packages/api/src/search/health.ts`, exactly as the contract sheet says — one definition, imported by everyone. **Task 7 creates that file** containing nothing but the constant, because `apps/worker/src/search-drain.ts` (written in Task 7) records `worker_runs` under it. This task appends the health read to the same file. Nothing here depends on a file a later task creates, and this task is still executable standalone: `health.ts` already exists when you start it.

**Design constraint (do not violate).** `search.health` is a **query** and must not be folded into `verify.run` / `runFullVerification`. The doc comment on `runFullVerification` in `/Users/martin/Workspace/mp/verder/packages/api/src/verification.ts` requires the router and the nightly worker script to report identical results; the search index appends no ledger events, so its health is reported *beside* the chain checks, never inside them. `verify.run` and `packages/api/src/routers/verify.ts` are not touched by this task.

---

**Step 1 — branch, and write the failing test for `readIndexHealth`.**

```bash
cd /Users/martin/Workspace/mp/verder
git checkout -b sp4/task-13
```

Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/health.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { DRAIN_WORKER_NAME, readIndexHealth } from "./health";

// APP role: the same grants the web app runs with, so a missing SELECT on
// search_outbox fails here rather than in production. Fixtures go in as the
// worker role, which is the only role holding INSERT on search_chunks.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

// The dev postgres is shared by every test file, so every assertion below is a
// delta around rows THIS file creates — never an absolute count.
describe("readIndexHealth", () => {
  let app: Db; let worker: Db;
  beforeAll(() => {
    app = createDb(APP_URL).db;
    worker = createDb(WORKER_URL).db;
  });

  it("counts chunks and the ones that failed to embed", async () => {
    const before = await readIndexHealth(app);
    const entityId = crypto.randomUUID();
    await worker.insert(schema.searchChunks).values([
      { entityType: "party", entityId, chunkIndex: 0, title: "Health probe A",
        body: "keyword only", sourceHash: crypto.randomUUID(), embedAttempts: 3 },
      { entityType: "party", entityId, chunkIndex: 1, title: "Health probe B",
        body: "keyword only", sourceHash: crypto.randomUUID(), embedAttempts: 0 },
    ]);

    const after = await readIndexHealth(app);
    expect(after.chunks - before.chunks).toBe(2);
    // Only the chunk that was tried and failed counts as a failure; a chunk
    // nobody has attempted yet is simply not embedded yet.
    expect(after.embedFailures - before.embedFailures).toBe(1);
  });

  it("reports the newest search-drain run as an ISO timestamp", async () => {
    await worker.insert(schema.workerRuns).values({
      worker: DRAIN_WORKER_NAME, status: "ok", detail: { probe: "index-health" },
    });
    const health = await readIndexHealth(app);
    expect(health.lastDrainAt).not.toBeNull();
    expect(Date.now() - Date.parse(health.lastDrainAt!)).toBeLessThan(60_000);
  });

  it("flags degraded while chunks are still missing their embedding", async () => {
    await worker.insert(schema.searchChunks).values({
      entityType: "party", entityId: crypto.randomUUID(), chunkIndex: 0,
      title: "Health probe C", body: "keyword only",
      sourceHash: crypto.randomUUID(), embedAttempts: 2,
    });
    const health = await readIndexHealth(app);
    expect(health.embedFailures).toBeGreaterThan(0);
    expect(health.degraded).toBe(true);
  });
});
```

**Step 2 — run it, see it fail.**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/api test src/search/health.test.ts
```

Expected failure: `Error: Failed to resolve import "./health" from "src/search/health.test.ts". Does the file exist?`

**Step 3 — extend `health.ts`.**

Open `/Users/martin/Workspace/mp/verder/packages/api/src/search/health.ts`. Task 7 created it with a single export:

```ts
// The worker_runs.worker value the search drain records under. One definition,
// imported by both the drain job and this health read, so they cannot drift.
export const DRAIN_WORKER_NAME = "search-drain";
```

Replace the file with that constant plus the health read:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";

// The worker_runs.worker value the search drain records under. One definition,
// imported by both the drain job and this health read, so they cannot drift.
export const DRAIN_WORKER_NAME = "search-drain";

// The drain job runs on a short cycle. Ten minutes of silence is a stalled
// index, not a slow minute.
export const DRAIN_STALE_MS = 10 * 60 * 1000;

// Below this the queue is simply working; above it, it is behind.
export const OUTBOX_WARN_DEPTH = 500;

export type IndexHealth = {
  chunks: number;
  outboxDepth: number;
  embedFailures: number;
  lastDrainAt: string | null;
  degraded: boolean;
};

/**
 * Read-only stats over the derived search tables. Deliberately NOT part of
 * runFullVerification: the index appends no ledger events, so its health is
 * reported BESIDE the chain checks and the nightly verifier stays untouched.
 * count(*)::int because postgres returns bigint as a string.
 */
export async function readIndexHealth(db: Db): Promise<IndexHealth> {
  const [chunks] = (await db.execute(sql`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE embedding IS NULL AND embed_attempts > 0))::int AS failures
    FROM search_chunks`)).rows as { total: number; failures: number }[];

  const [outbox] = (await db.execute(sql`
    SELECT count(*)::int AS depth FROM search_outbox`)).rows as { depth: number }[];

  const [drain] = (await db.execute(sql`
    SELECT ran_at FROM worker_runs
    WHERE worker = ${DRAIN_WORKER_NAME}
    ORDER BY ran_at DESC LIMIT 1`)).rows as { ran_at: string | Date }[];

  const lastDrainAt = drain ? new Date(drain.ran_at).toISOString() : null;
  const stale = lastDrainAt === null
    || Date.now() - Date.parse(lastDrainAt) > DRAIN_STALE_MS;

  return {
    chunks: chunks.total,
    outboxDepth: outbox.depth,
    embedFailures: chunks.failures,
    lastDrainAt,
    // One boolean the whole app can trust. The last run's status column is
    // deliberately not part of it: a drain that errors and keeps retrying shows
    // up here as embedFailures or a growing outbox, which is the thing that
    // actually costs Martin a result.
    degraded: stale || chunks.failures > 0 || outbox.depth > OUTBOX_WARN_DEPTH,
  };
}
```

**Step 4 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/health.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  3 passed (3)`.

**Step 5 — write the failing test for the router procedure.**

Create `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search-health.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("search.health", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `ih${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("exposes the index counters to a signed-in user", async () => {
    const h = await caller().search.health();
    expect(h.chunks).toBeGreaterThanOrEqual(0);
    expect(h.outboxDepth).toBeGreaterThanOrEqual(0);
    expect(h.embedFailures).toBeGreaterThanOrEqual(0);
    expect(typeof h.degraded).toBe("boolean");
  });

  // Project law: the index is derived, never evidence. Reading its health must
  // not touch the chain.
  it("appends no ledger events", async () => {
    const [before] = await db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    await caller().search.health();
    const [after] = await db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    expect(after?.seq ?? 0).toBe(before?.seq ?? 0);
  });
});
```

**Step 6 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search-health.test.ts
```

Expected failure, twice: `TRPCError: No procedure found on path "search,health"`.

**Step 7 — add the procedure.**

In `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts`, add this import line directly below the existing `import { recentEntities } from "../search/recent";` (added in Task 12):

```ts
import { readIndexHealth } from "../search/health";
```

Then insert this procedure immediately after the line `export const searchRouter = router({`, above the `recent:` procedure:

```ts
  // Index health for /verify. A query, never part of verify.run: the search
  // index is derived, rebuildable and appends no ledger events, so
  // runFullVerification — shared with the nightly worker script — stays exactly
  // as it was. A stalled index can only fail to find a record; it can never
  // change one.
  health: protectedProcedure.query(({ ctx }) => readIndexHealth(ctx.db)),
```

**Step 8 — run it, see it pass, then the whole package.**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search-health.test.ts
env -u NODE_ENV pnpm --filter @verder/api test
```

Expected: `Tests  2 passed (2)` for the file, and the whole `@verder/api` suite green — including the untouched `src/routers/verify.test.ts` chain suite.

**Step 9 — commit.**

```bash
git add packages/api/src/search/health.ts packages/api/src/search/health.test.ts \
  packages/api/src/routers/search.ts packages/api/src/routers/search-health.test.ts
git commit -m "feat(api): search index health read and search.health procedure"
```

**Step 10 — write the failing test for the degraded-state verdict.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/index-health-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DRAIN_STALE_MS } from "@verder/api/src/search/health";
import { indexHealthState } from "./index-health-state";

const now = new Date("2026-08-20T12:00:00Z").getTime();
const healthy = {
  chunks: 1200, outboxDepth: 0, embedFailures: 0,
  lastDrainAt: new Date(now - 30_000).toISOString(),
  degraded: false,
};

describe("indexHealthState", () => {
  it("is green when the API says the index is not degraded", () => {
    const s = indexHealthState(healthy, now);
    expect(s.tone).toBe("ok");
    expect(s.message).toContain("searchable");
  });

  it("is red when the drain has never reported", () => {
    const s = indexHealthState({ ...healthy, lastDrainAt: null, degraded: true }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("never reported");
  });

  it("is red when the drain is stale", () => {
    const s = indexHealthState({
      ...healthy, degraded: true,
      lastDrainAt: new Date(now - DRAIN_STALE_MS - 1000).toISOString(),
    }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("hasn't run since");
  });

  it("is amber when embeddings failed but the drain is alive", () => {
    const s = indexHealthState({ ...healthy, embedFailures: 4, degraded: true }, now);
    expect(s.tone).toBe("warn");
    expect(s.message).toContain("4 chunks could not be embedded");
  });

  it("is amber when the queue is deep", () => {
    const s = indexHealthState({ ...healthy, outboxDepth: 900, degraded: true }, now);
    expect(s.tone).toBe("warn");
    expect(s.message).toContain("900 records are waiting");
  });

  // A stalled drain outranks failed embeddings: if nothing is draining, the
  // failure count is stale too, and "4 chunks failed" while the indexer is dead
  // would be a lie by omission.
  it("reports the stalled drain when both are wrong", () => {
    const s = indexHealthState({
      ...healthy, embedFailures: 4, degraded: true,
      lastDrainAt: new Date(now - DRAIN_STALE_MS - 1000).toISOString(),
    }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("hasn't run since");
  });
});
```

**Step 11 — run it, see it fail.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/index-health-state.test.ts
```

Expected failure: `Error: Failed to resolve import "./index-health-state" from "src/lib/index-health-state.test.ts". Does the file exist?`

**Step 12 — write `index-health-state.ts`.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/lib/index-health-state.ts`:

```ts
import { DRAIN_STALE_MS, type IndexHealth } from "@verder/api/src/search/health";

export type IndexHealthTone = "ok" | "warn" | "bad";

/**
 * One honest verdict for the /verify card. The green case is gated on the API's
 * own `degraded` flag so the card and the API can never disagree; the branches
 * below only explain WHICH of the three conditions behind that flag fired, in
 * severity order. The final branch is the remaining cause (a deep queue), not a
 * fallback: readIndexHealth sets `degraded` from exactly stale-drain,
 * embedFailures and outboxDepth.
 */
export function indexHealthState(
  h: IndexHealth, now: number,
): { tone: IndexHealthTone; message: string } {
  if (!h.degraded) {
    return { tone: "ok", message: "Everything written is searchable." };
  }
  if (h.lastDrainAt === null) {
    return {
      tone: "bad",
      message: "The indexer has never reported. Nothing new is becoming searchable yet — start the worker and it will catch up.",
    };
  }
  if (now - Date.parse(h.lastDrainAt) > DRAIN_STALE_MS) {
    return {
      tone: "bad",
      message: `The indexer hasn't run since ${new Date(h.lastDrainAt).toLocaleString("nl-NL")} — anything written after that isn't searchable yet. Nothing is lost; it catches up as soon as the worker is back.`,
    };
  }
  if (h.embedFailures > 0) {
    const noun = h.embedFailures === 1 ? "chunk" : "chunks";
    return {
      tone: "warn",
      message: `${h.embedFailures} ${noun} could not be embedded — keyword search is complete, semantic search is thin. The next index run retries them.`,
    };
  }
  return {
    tone: "warn",
    message: `${h.outboxDepth} records are waiting to be indexed — the queue is catching up.`,
  };
}
```

**Step 13 — run it, see it pass.**

```bash
env -u NODE_ENV pnpm --filter web test src/lib/index-health-state.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

**Step 14 — write the card.**

Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/index-health.tsx`:

```tsx
import type { IndexHealth } from "@verder/api/src/search/health";
import { indexHealthState } from "@/lib/index-health-state";

// Server-safe card. Sits beside the ledger checks on /verify so a stalled index
// is as visible as a broken chain — with the difference spelled out: the index
// is derived and rebuildable, the chain is the evidence.

const TONE_ICON: Record<string, string> = { ok: "🟢", warn: "🟡", bad: "🔴" };
const TONE_TEXT: Record<string, string> = {
  ok: "text-emerald-700", warn: "text-amber-700", bad: "text-red-700",
};

export function IndexHealthCard({ health, now }: { health: IndexHealth; now: number }) {
  const state = indexHealthState(health, now);
  return (
    <div className="rounded border bg-white p-6 space-y-3">
      <h2 className="font-semibold">Search index</h2>
      <p className="text-sm text-slate-600">
        The index is derived, never evidence: it can be rebuilt from the record at any
        time (<code>pnpm --filter worker reindex</code>). A broken index can only fail
        to find something — it can never change what happened.
      </p>
      <p className={TONE_TEXT[state.tone]}>{TONE_ICON[state.tone]} {state.message}</p>
      <ul className="text-sm space-y-1 text-slate-600">
        <li>{health.chunks} chunks indexed</li>
        <li>{health.embedFailures} chunks waiting on a retry after a failed embedding</li>
        <li>{health.outboxDepth} records waiting in the queue</li>
        <li>
          Last index run:{" "}
          {health.lastDrainAt
            ? new Date(health.lastDrainAt).toLocaleString("nl-NL")
            : "never"}
        </li>
      </ul>
    </div>
  );
}
```

**Step 15 — render it on `/verify`.**

Replace the entire contents of `/Users/martin/Workspace/mp/verder/apps/web/src/app/(app)/verify/page.tsx` — currently four lines beginning `import { VerifyPanel } from "@/components/verify-panel";` — with:

```tsx
import { serverCaller } from "@/lib/trpc-server";
import { VerifyPanel } from "@/components/verify-panel";
import { IndexHealthCard } from "@/components/index-health";

export default async function VerifyPage() {
  const caller = await serverCaller();
  const health = await caller.search.health();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Verify & export</h1>
      <div className="max-w-xl mb-6">
        <IndexHealthCard health={health} now={Date.now()} />
      </div>
      <VerifyPanel />
    </div>
  );
}
```

**Step 16 — typecheck, build, test.**

```bash
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
env -u NODE_ENV pnpm --filter web test
```

Expected: `typecheck` silent, `next build` prints `✓ Compiled successfully` and lists `/verify` as a dynamic route (`ƒ`) because the page now reads the session and the database, and the web suite is green (`Tests  38 passed (38)` — the 11 pre-existing route-handler tests, Task 11's 15, Task 12's 6, plus the 6 from `index-health-state.test.ts`).

**Step 17 — manual verification.**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter web dev
```

- Open `/verify`. The "Search index" card sits above the existing "Integrity check" and "Export a report" cards, and "Run verification" still works and reports the chain result unchanged.
- With the worker running and the index caught up, the card shows 🟢 "Everything written is searchable."
- Simulate a stalled indexer and reload `/verify`:
  ```bash
  docker compose exec -T postgres psql -U verder -d verder \
    -c "UPDATE worker_runs SET ran_at = now() - interval '20 minutes' WHERE worker = 'search-drain';"
  ```
  The card turns 🔴 with "The indexer hasn't run since …".
- Simulate a failed embedding and reload:
  ```bash
  docker compose exec -T postgres psql -U verder -d verder \
    -c "UPDATE worker_runs SET ran_at = now() WHERE worker = 'search-drain';" \
    -c "UPDATE search_chunks SET embedding = NULL, embed_attempts = 3 WHERE id = (SELECT id FROM search_chunks LIMIT 1);"
  ```
  The card turns 🟡 with "1 chunk could not be embedded".

**Step 18 — run the full suite and commit.**

```bash
env -u NODE_ENV pnpm -r --if-present test
git add apps/web/src/lib/index-health-state.ts apps/web/src/lib/index-health-state.test.ts \
  apps/web/src/components/index-health.tsx "apps/web/src/app/(app)/verify/page.tsx"
git commit -m "feat(web): index health card on /verify"
```

### Task 14: `retrieved_refs` on suggestions + "the model saw these" citations

**Why a separate column, not a key inside `proposed`:** `packages/api/src/routers/suggestions.ts` diffs `proposed` against the final submitted values to decide whether a verdict is truthfully `"approved"` or `"edited"` — `unchangedFromProposal` (lines 37–44) and the hand-rolled comparison in `approveEntry` (lines 77–79). Retrieval context inside `proposed` would be reviewer noise on every card, and `approveEntry` reads `s.proposed` fields directly, so a fat `proposed` is one careless edit away from corrupting the golden-rule edit diff. `retrieved_refs` is provenance about the *model's input*, not a proposal: it gets its own column and is never compared to `final_payload`. Step 12 below asserts exactly that.

**No grants migration is needed, and this is verified rather than assumed.** `suggestions` already carries `GRANT SELECT, INSERT, UPDATE … TO verder_app` (`packages/db/drizzle/0001_grants.sql:17`) and `TO verder_worker` (`packages/db/drizzle/0004_worker_role.sql:20`). Postgres table-level grants cover columns added later. Step 4 proves it with `information_schema.column_privileges` instead of trusting the rule.

**Migration number is fixed: `0018_retrieved_refs.sql`.** Tasks 1, 2, 6 and 14 of this plan take `0014_vector_extension`, `0015_knowledge_base`, `0016_search_grants` and `0017_search_triggers`; the journal (`packages/db/drizzle/meta/_journal.json`) held 14 entries `0000`–`0013` before this sub-project. `drizzle-kit generate --name=retrieved_refs` therefore emits `0018_retrieved_refs.sql` deterministically.

**Files:**
- Modify: `/Users/martin/Workspace/mp/verder/packages/db/src/schema.ts` (add `retrievedRefs` to `suggestions`)
- Create: `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0018_retrieved_refs.sql` + `packages/db/drizzle/meta/0018_snapshot.json` + a `_journal.json` entry — all three produced by `drizzle-kit generate --name=retrieved_refs`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/retrieval-refs.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/retrieval-refs.test.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/web/src/components/retrieved-refs.tsx`
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/src/ollama.ts` (`suggestEntry` deps + both insert paths)
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/src/index.ts` (wire the real retriever into the `suggest.entry` handler)
- Modify: `/Users/martin/Workspace/mp/verder/apps/web/src/components/suggestion-card.tsx` (widen the local `Suggestion` type; render citations in all five cards)
- Test: `/Users/martin/Workspace/mp/verder/packages/db/src/schema.test.ts`, `/Users/martin/Workspace/mp/verder/apps/worker/src/ollama.test.ts`, `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.test.ts`

**Interfaces:**

Consumes — produced by **Task 7** (`packages/api/src/search/embed.ts`) and **Task 8** (`packages/api/src/search/retrieve.ts`):
```ts
// packages/api/src/search/embed.ts   (Task 7)
export type EmbedPort = { embed(texts: string[]): Promise<(number[] | null)[]> };
export function realEmbedPort(opts?: { url?: string; model?: string; timeoutMs?: number }): EmbedPort;

// packages/api/src/search/retrieve.ts   (Task 8)
export type SearchHit = {
  entityType: SearchEntityType; entityId: string; title: string; snippet: string;
  occurredAt: string | null; status: string | null; score: number;
  matchedBy: "keyword" | "semantic" | "both"; href: string;
};
export type RetrieveResult = {
  hits: SearchHit[]; nextCursor: string | null; semanticAvailable: boolean;
  reranked: boolean; rerankPromptVersion: string | null;
};
export async function retrieve(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort },
  input: { q: string; entityTypes?: SearchEntityType[]; from?: string; to?: string;
           partyId?: string; status?: SearchStatus; mode?: "fast" | "deep";
           limit?: number; cursor?: string | null },
): Promise<RetrieveResult>;
```
The worker reaches these through the deep-import idiom already used at `apps/worker/src/index.ts:5` (`import { readFilePath } from "@verder/api/src/storage";`) — `@verder/api`'s `main` is `./src/root.ts`, so `@verder/api/src/search/…` is the only working form.

**Task 7** also created `/Users/martin/Workspace/mp/verder/apps/worker/vitest.config.ts` with `{ test: { fileParallelism: false } }`; the worker tests below rely on it so they do not race other worker suites on the shared dev database.

Existing, verified: `schema.suggestions` (`packages/db/src/schema.ts:135`), `suggestEntry(deps, rawEmailId)` (`apps/worker/src/ollama.ts:45`), `recordRun(db, worker, status, detail?)` (`apps/worker/src/heartbeat.ts:3`), `suggestions.list` spreading `...s` (`packages/api/src/routers/suggestions.ts:54`), `makeTaskSuggestion()` (`packages/api/src/routers/suggestions.test.ts:356`).

Produces:
```ts
// packages/db/src/schema.ts — new column on suggestions
retrievedRefs: jsonb("retrieved_refs")

// apps/worker/src/retrieval-refs.ts
export type RetrievedRef = {
  entityType: string; entityId: string; title: string; score: number; snippet: string;
};
export type RetrieveRefsFn = (query: string) => Promise<RetrievedRef[]>;
export function refsFromHits(hits: SearchHit[]): RetrievedRef[];
export function retrieveRefsWith(run: (q: string) => Promise<{ hits: SearchHit[] }>): RetrieveRefsFn;
export function realRetrieveRefs(db: Db): RetrieveRefsFn;

// apps/worker/src/ollama.ts — suggestEntry deps gains one optional field
deps: { db: Db; llm: LlmPort; sendPush?: SendPushFn; retrieveRefs?: RetrieveRefsFn }

// apps/web/src/components/retrieved-refs.tsx
export const ENTITY_LABEL: Record<string, string>;
export function hrefForEntity(entityType: string, entityId: string): string | null;
export function RetrievedRefs({ refs }: { refs: unknown }): JSX.Element | null;
```

---

- [ ] **Step 1 — failing DB test for the column.** `/Users/martin/Workspace/mp/verder/packages/db/src/schema.test.ts` is a 17-line file whose only `it(...)` is `"inserts and reads a party"`. Add a second `it(...)` immediately after that block's closing `  });`, still inside `describe("schema", …)`:

```ts
  it("stores retrieval citations on a suggestion without touching proposed", async () => {
    const { db, pool } = createDb(url);
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry",
      model: "qwen3.5:9b",
      promptVersion: "entry-v1",
      proposed: { summary: "VerderGroep vraagt loonstroken" },
      retrievedRefs: [{
        entityType: "document", entityId: crypto.randomUUID(),
        title: "Loonstrook juni", score: 0.031, snippet: "…loonstrook juni 2026…",
      }],
    }).returning();
    expect(s.retrievedRefs).toHaveLength(1);
    // Provenance lives beside the proposal, never inside it: `proposed` is
    // diffed against `final_payload` to record Martin's edits (golden rule).
    expect((s.proposed as Record<string, unknown>).retrievedRefs).toBeUndefined();
    await pool.end();
  });
```

- [ ] **Step 2 — see it fail.**
```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db test
```
Expected failure: `error: column "retrieved_refs" of relation "suggestions" does not exist` (vitest's esbuild transform strips types, so the runtime Postgres error is what you see; `pnpm --filter @verder/db typecheck` additionally reports `Object literal may only specify known properties, and 'retrievedRefs' does not exist in type …`).

- [ ] **Step 3 — add the column.** In `/Users/martin/Workspace/mp/verder/packages/db/src/schema.ts`, inside `export const suggestions = pgTable("suggestions", {…})` (line 135), the current lines 143–145 read:

```ts
  proposed: jsonb("proposed"),
  finalPayload: jsonb("final_payload"),
  resultEntryId: uuid("result_entry_id"),
```
Replace them with:
```ts
  proposed: jsonb("proposed"),
  finalPayload: jsonb("final_payload"),
  // What retrieval put in front of the model when this suggestion was built.
  // Deliberately NOT inside `proposed`: `proposed` is diffed against
  // `final_payload` to record Martin's edits (golden rule), and retrieval
  // context in that column would make every diff noisy and untruthful.
  retrievedRefs: jsonb("retrieved_refs"),
  resultEntryId: uuid("result_entry_id"),
```

- [ ] **Step 4 — generate and apply migration `0018`, then prove the grants cover the new column.**
```bash
env -u NODE_ENV pnpm --filter @verder/db exec drizzle-kit generate --name=retrieved_refs
env -u NODE_ENV pnpm --filter @verder/db migrate
```
The generated `/Users/martin/Workspace/mp/verder/packages/db/drizzle/0018_retrieved_refs.sql` must contain exactly one statement:
```sql
ALTER TABLE "suggestions" ADD COLUMN "retrieved_refs" jsonb;
```
If drizzle-kit emits any other statement, a previous task's migration was not applied — stop and run `pnpm --filter @verder/db migrate` before regenerating. Then:
```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "SELECT grantee, privilege_type FROM information_schema.column_privileges WHERE table_name='suggestions' AND column_name='retrieved_refs' AND grantee IN ('verder_app','verder_worker') ORDER BY 1,2;"
```
Expected, exactly six rows — `verder_app` and `verder_worker` each with `INSERT`, `SELECT`, `UPDATE`. Table-level grants from `0001_grants.sql` / `0004_worker_role.sql` cover the new column, so no grants migration is written.

- [ ] **Step 5 — see the test pass, commit.**
```bash
env -u NODE_ENV pnpm --filter @verder/db test
git add -A && git commit -m "feat(db): retrieved_refs column on suggestions" \
  -m "Retrieval citations live beside proposed, never inside it: proposed is diffed against final_payload for the golden-rule edit diff, and context in that column would corrupt every diff." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6 — failing worker test for the citation helper.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/retrieval-refs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SearchHit } from "@verder/api/src/search/retrieve";
import { refsFromHits, retrieveRefsWith } from "./retrieval-refs";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  entityType: "document", entityId: "11111111-1111-1111-1111-111111111111",
  title: "Loonstrook juni", snippet: "x".repeat(500), occurredAt: null,
  status: "filed", score: 0.0312, matchedBy: "both", href: "/vault/11111111-1111-1111-1111-111111111111",
  ...over,
});

describe("refsFromHits", () => {
  it("keeps entityType, entityId, title, score and a snippet capped at 300 chars", () => {
    expect(refsFromHits([hit()])).toEqual([{
      entityType: "document", entityId: "11111111-1111-1111-1111-111111111111",
      title: "Loonstrook juni", score: 0.0312, snippet: "x".repeat(300),
    }]);
  });

  it("keeps at most five references", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      hit({ entityId: `2222222${i}-2222-2222-2222-222222222222`, title: `Doc ${i}` }));
    expect(refsFromHits(many)).toHaveLength(5);
    expect(refsFromHits(many)[4].title).toBe("Doc 4");
  });
});

describe("retrieveRefsWith", () => {
  it("returns an empty list rather than throwing when retrieval is unavailable", async () => {
    const refs = retrieveRefsWith(async () => { throw new Error("ollama down"); });
    expect(await refs("loonstroken juni")).toEqual([]);
  });

  it("passes the query through and maps the hits", async () => {
    const seen: string[] = [];
    const refs = retrieveRefsWith(async (q) => { seen.push(q); return { hits: [hit()] }; });
    expect(await refs("loonstroken juni")).toHaveLength(1);
    expect(seen).toEqual(["loonstroken juni"]);
  });
});
```

- [ ] **Step 7 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter worker test src/retrieval-refs.test.ts
```
Expected failure: `Failed to resolve import "./retrieval-refs" from "src/retrieval-refs.test.ts". Does the file exist?`

- [ ] **Step 8 — implement the helper.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/retrieval-refs.ts`:

```ts
import type { Db } from "@verder/db";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { retrieve, type SearchHit } from "@verder/api/src/search/retrieve";

/**
 * Retrieval citations for a suggestion: what the index put in front of the
 * model. Fast mode only — this runs inside the suggest.entry job, and the
 * rerank LLM call belongs to the queue-card path, not to every ingested email.
 *
 * Best-effort by construction: retrieval is context, not evidence. A dead
 * Ollama, an empty index or a slow query must never fail (and thereby retry)
 * the suggestion job, so every failure degrades to an empty citation list.
 */
export type RetrievedRef = {
  entityType: string; entityId: string; title: string; score: number; snippet: string;
};
export type RetrieveRefsFn = (query: string) => Promise<RetrievedRef[]>;

const SNIPPET_CHARS = 300;
const MAX_REFS = 5;

export function refsFromHits(hits: SearchHit[]): RetrievedRef[] {
  return hits.slice(0, MAX_REFS).map((h) => ({
    entityType: h.entityType,
    entityId: h.entityId,
    title: h.title,
    score: h.score,
    snippet: h.snippet.slice(0, SNIPPET_CHARS),
  }));
}

/** Injectable form: tests pass their own retrieve function. */
export function retrieveRefsWith(
  run: (query: string) => Promise<{ hits: SearchHit[] }>,
): RetrieveRefsFn {
  return async (query) => {
    try {
      const { hits } = await run(query);
      return refsFromHits(hits);
    } catch {
      return [];
    }
  };
}

export function realRetrieveRefs(db: Db): RetrieveRefsFn {
  const embed = realEmbedPort();
  return retrieveRefsWith((q) =>
    retrieve({ db, embed }, { q, mode: "fast", limit: MAX_REFS }));
}
```

- [ ] **Step 9 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter worker test src/retrieval-refs.test.ts
env -u NODE_ENV pnpm --filter worker typecheck
git add -A && git commit -m "feat(worker): fast-retrieval citation helper" \
  -m "Best-effort by construction: retrieval context must never fail the suggestion job it decorates." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 10 — failing test: `suggestEntry` stores the refs on both paths.** `/Users/martin/Workspace/mp/verder/apps/worker/src/ollama.test.ts` currently imports `{ desc, eq }` from `drizzle-orm` (line 2) and defines `insertEmail(db)` (line 8) whose fixture email has subject `"Huurcontract opsturen"` and body `"Beste Martin, stuur je huurcontract voor vrijdag op."`. Append these two `it(...)` blocks inside `describe("suggestEntry", …)`, directly after the existing `"falls back to needs-manual when the LLM fails"` block:

```ts
  it("stores retrieval citations alongside the proposal, never inside it", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => ({
      summary: "VerderGroep vraagt huurcontract",
      details: "Huurcontract voor vrijdag opsturen.",
      direction: "inbound", actionItems: [] }) };
    const queries: string[] = [];
    await suggestEntry({
      db, llm, sendPush: async () => {},
      retrieveRefs: async (q) => {
        queries.push(q);
        return [{ entityType: "document",
          entityId: "22222222-2222-2222-2222-222222222222",
          title: "Huurcontract 2024", score: 0.03, snippet: "…huurcontract…" }];
      },
    }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id));
    expect(s.retrievedRefs).toHaveLength(1);
    expect((s.retrievedRefs as { title: string }[])[0].title).toBe("Huurcontract 2024");
    expect((s.proposed as Record<string, unknown>).retrievedRefs).toBeUndefined();
    // Retrieval sees subject AND body — the subject alone is too thin a query.
    expect(queries[0]).toContain("Huurcontract opsturen");
    expect(queries[0]).toContain("stuur je huurcontract");
    await pool.end();
  });

  it("stores citations on the needs-manual fallback too", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await suggestEntry({
      db, llm, sendPush: async () => {},
      retrieveRefs: async () => [{ entityType: "entry",
        entityId: "33333333-3333-3333-3333-333333333333",
        title: "Gesprek met bewindvoerder", score: 0.02, snippet: "…leefgeld…" }],
    }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id))
      .orderBy(desc(schema.suggestions.createdAt)).limit(1);
    expect(s.status).toBe("needs-manual");
    expect(s.retrievedRefs).toHaveLength(1);
    await pool.end();
  });
```

- [ ] **Step 11 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter worker test src/ollama.test.ts
```
Expected failure: `AssertionError: expected null to have a length of 1 but got null` on `expect(s.retrievedRefs).toHaveLength(1)` — `suggestEntry` ignores the extra dep and never writes the column. `pnpm --filter worker typecheck` additionally reports `Object literal may only specify known properties, and 'retrieveRefs' does not exist in type '{ db: Db; llm: LlmPort; sendPush?: SendPushFn; }'`.

- [ ] **Step 12 — implement in `suggestEntry`.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/ollama.ts`, first add one import line directly below line 6 (`import { sendPush as realSendPush } from "./push";`):

```ts
import type { RetrievedRef, RetrieveRefsFn } from "./retrieval-refs";
```
Then replace the whole of `suggestEntry` (lines 45–76) with:

```ts
export async function suggestEntry(
  deps: { db: Db; llm: LlmPort; sendPush?: SendPushFn; retrieveRefs?: RetrieveRefsFn },
  rawEmailId: string,
): Promise<void> {
  const sendPush = deps.sendPush ?? realSendPush;
  const [email] = await deps.db.select().from(schema.rawEmails)
    .where(eq(schema.rawEmails.id, rawEmailId));
  if (!email) return;
  const attachmentDocs = await deps.db.select().from(schema.documents)
    .where(eq(schema.documents.sourceRef, email.gmailMessageId));
  const base = { occurredAt: email.sentAt.toISOString(), channel: "email" as const,
    participantNames: [email.fromAddr],
    attachmentDocumentIds: attachmentDocs.map((d) => d.id) };
  // What the index already knows about this email's subject matter. Computed
  // BEFORE the LLM call so both the parsed suggestion and the needs-manual
  // fallback carry the same provenance. realRetrieveRefs never throws; this
  // guard covers injected test doubles that might.
  let retrievedRefs: RetrievedRef[] = [];
  if (deps.retrieveRefs) {
    try {
      retrievedRefs = await deps.retrieveRefs(
        `${email.subject}\n${email.bodyText.slice(0, 2000)}`);
    } catch { retrievedRefs = []; }
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  try {
    const parsed = llmEntrySchema.parse(await deps.llm.chatJson(buildEntryPrompt({
      from: email.fromAddr, subject: email.subject, sentAt: email.sentAt, bodyText: email.bodyText })));
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      retrievedRefs,
      proposed: { ...base, direction: parsed.direction, summary: parsed.summary,
        details: parsed.details, actionItems: parsed.actionItems } });
    await notifyNewSuggestion(deps.db, email.subject, sendPush);
    await recordRun(deps.db, "ollama", "ok", { rawEmailId, refs: retrievedRefs.length });
  } catch (err) {
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      status: "needs-manual", retrievedRefs,
      proposed: { ...base, direction: "inbound", summary: email.subject,
        details: email.bodyText.slice(0, 2000), actionItems: [] } });
    await notifyNewSuggestion(deps.db, email.subject, sendPush);
    await recordRun(deps.db, "ollama", "error", { rawEmailId, message: String(err) });
  }
}
```
Task suggestions deliberately carry no refs: `suggestTask` runs on the *same* email inside the same `suggest.entry` job, so a second retrieval would re-embed a query we already ran — the entry card beside it shows the citations for that email.

- [ ] **Step 13 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter worker test src/ollama.test.ts
env -u NODE_ENV pnpm --filter worker typecheck
git add -A && git commit -m "feat(worker): store retrieval citations on entry suggestions" \
  -m "Both the parsed and the needs-manual path now record what the index put in front of the model, computed before the LLM call so the two paths can never disagree." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 14 — wire the real retriever into the worker.** In `/Users/martin/Workspace/mp/verder/apps/worker/src/index.ts`, add one import line directly below line 9 (`import { realLlmPort, suggestDocMeta, suggestEntry } from "./ollama";`):

```ts
import { realRetrieveRefs } from "./retrieval-refs";
```
Line 38 currently reads `const llm = realLlmPort();`. Replace that single line with:
```ts
const llm = realLlmPort();
const retrieveRefs = realRetrieveRefs(db);
```
Line 54 currently reads `  await suggestEntry({ db, llm, sendPush }, rawEmailId);`. Replace it with:
```ts
  await suggestEntry({ db, llm, sendPush, retrieveRefs }, rawEmailId);
```
Then:
```bash
env -u NODE_ENV pnpm --filter worker typecheck
git add -A && git commit -m "feat(worker): suggest.entry retrieves before it suggests" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 15 — failing API test: refs reach the queue and never move the edit diff.** Append inside `describe("suggestions router", …)` in `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.test.ts` (that file already imports `{ eq, inArray }` from `drizzle-orm` on line 2 and defines `makeTaskSuggestion()` on line 356 — no import change is needed for this test):

```ts
  it("list returns retrievedRefs and the refs never affect the edit diff", async () => {
    const s = await makeTaskSuggestion();
    await db.update(schema.suggestions).set({
      retrievedRefs: [{ entityType: "document",
        entityId: "44444444-4444-4444-4444-444444444444",
        title: "Loonstrook juni", score: 0.03, snippet: "…loonstrook…" }],
    }).where(eq(schema.suggestions.id, s.id));
    const listed = (await caller().suggestions.list({ status: "pending" }))
      .find((row) => row.id === s.id);
    expect(listed?.retrievedRefs).toHaveLength(1);

    const p = s.proposed as { title: string; details: string };
    await caller().suggestions.approveTask({
      id: s.id,
      task: { title: p.title, details: p.details, dueAt: new Date("2026-09-01") },
    });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    // Citations are provenance, not a proposal: an unedited approval stays
    // "approved" even though retrievedRefs is populated, and finalPayload
    // records only what was actually stored.
    expect(after.status).toBe("approved");
    expect((after.finalPayload as Record<string, unknown>).retrievedRefs).toBeUndefined();
  });
```

- [ ] **Step 16 — run it and see it pass; no implementation change is required.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/suggestions.test.ts
```
This is a **regression guard, not a red-then-green step**: `suggestions.list` already spreads `...s` (`packages/api/src/routers/suggestions.ts:54`), and `unchangedFromProposal` iterates `Object.keys(taskFields.shape)` — a set that contains no `retrievedRefs` key — so the new column is invisible to the diff by construction. The test exists to make that invisibility permanent. It must be green on the first run. If `after.status` comes back `"edited"`, a real bug was introduced in `approveTask` by an earlier task: fix it there, never by weakening this assertion.
```bash
git add -A && git commit -m "test(api): citations reach the queue without touching the edit diff" \
  -m "Regression guard for the golden rule: retrieved_refs must stay invisible to unchangedFromProposal." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 17 — the citations component.** Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/retrieved-refs.tsx`:

```tsx
import Link from "next/link";

// Entity type → the screen that shows that record. Types with no detail screen
// (raw emails, parties) render as plain text rather than a dead link.
export const ENTITY_LABEL: Record<string, string> = {
  document: "Document", entry: "Logbook entry", email: "Email",
  financial_item: "Subscription", debt: "Debt", task: "Task",
  milestone: "Milestone", timeline_event: "Key event", party: "Party",
};

export function hrefForEntity(entityType: string, entityId: string): string | null {
  if (entityType === "document") return `/vault/${entityId}`;
  if (entityType === "entry") return `/logbook/${entityId}`;
  if (entityType === "task") return `/tasks/${entityId}`;
  if (entityType === "financial_item") return `/registry/${entityId}`;
  if (entityType === "debt") return `/registry/debts/${entityId}`;
  if (entityType === "milestone") return "/milestones";
  if (entityType === "timeline_event") return "/timeline";
  return null;
}

type Ref = { entityType: string; entityId: string; title: string; score: number; snippet: string };

// The column is plain jsonb, so the client must not trust its shape.
function isRefArray(value: unknown): value is Ref[] {
  return Array.isArray(value) && value.every((r) =>
    typeof r === "object" && r !== null
    && typeof (r as Ref).entityType === "string"
    && typeof (r as Ref).entityId === "string"
    && typeof (r as Ref).title === "string"
    && typeof (r as Ref).score === "number");
}

/** What retrieval put in front of the model when this suggestion was built. */
export function RetrievedRefs({ refs }: { refs: unknown }) {
  if (!isRefArray(refs) || refs.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        The model saw these ({refs.length})
      </summary>
      <ul className="space-y-2 mt-2">
        {refs.map((r) => {
          const href = hrefForEntity(r.entityType, r.entityId);
          const title = <span className="font-medium">{r.title}</span>;
          return (
            <li key={`${r.entityType}:${r.entityId}`} className="text-xs text-slate-600">
              <span className="rounded px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-700">
                {ENTITY_LABEL[r.entityType] ?? r.entityType}
              </span>{" "}
              {href ? <Link href={href} className="underline">{title}</Link> : title}
              <span className="text-slate-400"> · score {r.score.toFixed(3)}</span>
              {r.snippet && <p className="text-slate-500 mt-0.5">{r.snippet}</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
```

- [ ] **Step 18 — widen the card's local `Suggestion` type.** In `/Users/martin/Workspace/mp/verder/apps/web/src/components/suggestion-card.tsx`, add one import line directly below line 5 (`import { formatEuro } from "@/components/registry-list";`):

```tsx
import { RetrievedRefs } from "@/components/retrieved-refs";
```
Then replace lines 24–26 (the hand-written local type — it is not inferred from the router):
```tsx
type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };
```
with:
```tsx
type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  retrievedRefs: unknown;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };
```

- [ ] **Step 19 — render it in all five cards, at the exact anchor for each.** The five card components are `TaskCard` (line 36), `EntryCard` (line 94), `RegistryItemCard` (line 142), `DebtCard` (line 193) and `DocMetaCard` (line 228). Two of them (`RegistryItemCard`, `DebtCard`) have **no** `s.rawEmail` disclosure block, and the `{s.rawEmail && <details>…` line is byte-identical in `TaskCard` and `EntryCard` — so each insertion is given below with unique surrounding context. In every case the new line is `      <RetrievedRefs refs={s.retrievedRefs} />`.

`TaskCard` — between the assignee `</div>` and the email disclosure (unique on the `<option key={party.id}` line):
```tsx
            <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
      </div>
      <RetrievedRefs refs={s.retrievedRefs} />
      {s.rawEmail && <details><summary className="cursor-pointer text-sm">Original email</summary>
```

`EntryCard` — between the Details textarea and the email disclosure (unique on `rows={3}`):
```tsx
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      <RetrievedRefs refs={s.retrievedRefs} />
      {s.rawEmail && <details><summary className="cursor-pointer text-sm">Original email</summary>
```

`RegistryItemCard` — no email block; above the action row (unique on `ITEM_CATEGORIES.map`):
```tsx
          {ITEM_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <RetrievedRefs refs={s.retrievedRefs} />
      <div className="flex gap-2">
```

`DebtCard` — no email block; above the action row (unique on the `Claimed:` paragraph):
```tsx
      <p className="text-sm text-slate-700">Claimed: {formatEuro(claimedCents)}</p>
      <RetrievedRefs refs={s.retrievedRefs} />
      <div className="flex gap-2">
```

`DocMetaCard` — above the action row (unique on `setDocType`):
```tsx
      <label className="block text-sm">Type<input className="w-full border rounded p-2"
        value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
      <RetrievedRefs refs={s.retrievedRefs} />
      <div className="flex gap-2">
```

- [ ] **Step 20 — build, verify by hand, commit.**
```bash
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
```
There is no jsdom, testing-library or Playwright anywhere in this repo (`apps/web/vitest.config.ts` is `environment: "node"`), so this component is verified by hand, as every prior UI slice in this project was. Manual verification: `docker compose up -d postgres`, `env -u NODE_ENV pnpm dev`, sign in as `martin@vanderpoel.pro` / `devpass`, open `/queue`. A suggestion whose `retrieved_refs` is populated shows a collapsed "The model saw these (N)" disclosure; expanding it links a `document` ref to `/vault/<id>` and an `entry` ref to `/logbook/<id>`; a suggestion whose `retrieved_refs` is NULL shows nothing at all — no empty box, no stray summary. To seed one by hand:
```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "UPDATE suggestions SET retrieved_refs = '[{\"entityType\":\"document\",\"entityId\":\"44444444-4444-4444-4444-444444444444\",\"title\":\"Loonstrook juni\",\"score\":0.031,\"snippet\":\"loonstrook juni 2026\"}]'::jsonb WHERE status = 'pending';"
```
```bash
git add -A && git commit -m "feat(web): show what retrieval put in front of the model" \
  -m "Every queue card gains a collapsed citation list linking to the records the model was shown, so an odd suggestion can be traced to its context." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: "Do we already have this?" on document-request queue cards

Detection is deterministic and server-side (`documentRequestText`), so deep retrieval — which spends a rerank LLM call with a 20 s ceiling — only ever runs for cards that actually ask for a document. Linking reuses paths that already exist: for a log-entry suggestion the picked document ids ride into `approveEntry` → `insertEntry` → `entry_documents` plus the `entry.created` ledger payload; for a task suggestion the picked id rides into `approveTask` → `tasks.documentId`. Nothing is emailed, drafted or sent in this sub-project.

**Honest note on the gating, replacing the draft's wrong rationale.** `alreadyHave` does **not** "return early so the card can call it unconditionally" — the early return happens exactly when `documentRequestText` is null, which is exactly when `suggestions.list` reports `documentRequest: null` and the parent card does not render the panel at all. So the early return costs nothing and protects nothing. The real protection is two-layered and both layers are built here: (1) the parent renders `<AlreadyHaveThis>` only when `s.documentRequest` is non-null, and (2) the component's `useQuery` is gated with `enabled: Boolean(request)` plus `refetchOnWindowFocus: false`, so no card can fire a 20 s rerank speculatively or re-fire one when Martin tabs back to the window.

**Why the retrieval lives in a helper, not inline in the router.** `search.alreadyHave` needs a real `EmbedPort` and a real `RerankPort`; a test that exercised the procedure directly would either hit Ollama (20 s per call, flaky) or need ports the tRPC context does not carry. The ranking logic therefore lives in `packages/api/src/search/already-have.ts` behind an explicit `deps` object and is tested with fake ports; the router is a two-line adapter.

**Files:**
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/document-request.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/document-request.test.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/already-have.ts`
- Create: `/Users/martin/Workspace/mp/verder/packages/api/src/search/already-have.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts` (add `alreadyHave`)
- Modify: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.ts` (`list` gains `documentRequest`)
- Create: `/Users/martin/Workspace/mp/verder/apps/web/src/components/already-have-this.tsx`
- Modify: `/Users/martin/Workspace/mp/verder/apps/web/src/components/suggestion-card.tsx` (`EntryCard`, `TaskCard`)
- Test: `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.test.ts` (created by Task 8; extend it), `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.test.ts`

**Interfaces:**

Consumes — `EmbedPort` / `realEmbedPort` from **Task 7** (`packages/api/src/search/embed.ts`); `retrieve` / `SearchHit` from **Task 8** (`packages/api/src/search/retrieve.ts`); `RerankPort` / `realRerankPort` from **Task 9** (`packages/api/src/search/rerank.ts`); `searchRouter` in `packages/api/src/routers/search.ts` and its test file from **Task 8**; `schema.searchChunks` from **Task 1**; grants from **Task 2** (`search_chunks` → `verder_app` SELECT only, `verder_worker` SELECT/INSERT/UPDATE/DELETE — which is why the test below opens a second, worker-role connection to seed chunks).

Existing, verified: `schema.suggestions` / `schema.documents` (`packages/db/src/schema.ts:135` / `:72`), `insertEntry` (`packages/api/src/routers/entries.ts:73`), `taskFields` with a `documentId` field (`packages/api/src/routers/tasks.ts:13–22`), `unchangedFromProposal` (`packages/api/src/routers/suggestions.ts:37`), `packages/api/vitest.config.ts` already sets `fileParallelism: false`.

Produces:
```ts
// packages/api/src/search/document-request.ts
export function documentRequestText(kind: string, proposed: unknown): string | null;

// packages/api/src/search/already-have.ts
export type AlreadyHaveDocument = {
  documentId: string; title: string; snippet: string; score: number;
  sha256: string; mime: string;
};
export type AlreadyHaveResult = {
  request: string | null; documents: AlreadyHaveDocument[]; reranked: boolean;
};
export async function alreadyHave(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort }, suggestionId: string,
): Promise<AlreadyHaveResult>;
export function realAlreadyHaveDeps(db: Db): { db: Db; embed: EmbedPort; rerank: RerankPort };

// packages/api/src/routers/search.ts — new procedure
search.alreadyHave({ suggestionId: string uuid }) => AlreadyHaveResult   // deep mode, top 3 documents

// packages/api/src/routers/suggestions.ts — list rows gain
documentRequest: string | null

// apps/web/src/components/already-have-this.tsx
export function AlreadyHaveThis(props: {
  suggestionId: string; request: string;
  selected: string[]; onToggle: (documentId: string) => void;
}): JSX.Element | null;
```

---

- [ ] **Step 1 — failing unit test for the detector.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/document-request.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { documentRequestText } from "./document-request";

describe("documentRequestText", () => {
  it("returns the action-item text when an entry suggestion asks for a document", () => {
    expect(documentRequestText("log-entry", {
      summary: "VerderGroep vraagt stukken",
      actionItems: [
        { description: "Even terugbellen", clarity: "clear" },
        { description: "Kopie paspoort opsturen", clarity: "clear" },
      ],
    })).toBe("Kopie paspoort opsturen");
  });

  it("treats an already-provided action item as a document request", () => {
    expect(documentRequestText("log-entry", {
      actionItems: [{ description: "Loonstroken juni en juli", clarity: "already-provided" }],
    })).toBe("Loonstroken juni en juli");
  });

  it("uses title + details for a task suggestion that asks for a document", () => {
    expect(documentRequestText("task", {
      title: "Huurcontract opsturen", details: "Voor vrijdag aanleveren.",
    })).toBe("Huurcontract opsturen Voor vrijdag aanleveren.");
  });

  it("returns null when nothing asks for a document", () => {
    expect(documentRequestText("log-entry", {
      actionItems: [{ description: "Even terugbellen", clarity: "clear" }],
    })).toBeNull();
    expect(documentRequestText("task", { title: "Bellen met bewindvoerder" })).toBeNull();
    expect(documentRequestText("registry-item", { name: "Ziggo" })).toBeNull();
    expect(documentRequestText("log-entry", null)).toBeNull();
  });
});
```

- [ ] **Step 2 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/document-request.test.ts
```
Expected failure: `Failed to load url ./document-request (resolved id: …/packages/api/src/search/document-request) in …/document-request.test.ts. Does the file exist?`

- [ ] **Step 3 — implement the detector.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/document-request.ts`:

```ts
/**
 * Does this suggestion ask Martin for a document? Deterministic and pure — it
 * decides whether a queue card spends a deep-retrieval (rerank) call, so it
 * must be cheap, and it must never be the model's own guess: `clarity:
 * "already-provided"` is exactly the field the miner guesses at today, and
 * that guess is what the panel exists to answer with evidence.
 *
 * Dutch + English vocabulary, deliberately narrow: a false negative costs a
 * missing panel, a false positive costs a 20 s rerank on every queue render.
 */
const DOC_WORDS = [
  "kopie", "kopieën", "afschrift", "bewijs", "bewijsstuk", "document", "documenten",
  "stukken", "loonstrook", "loonstroken", "jaaropgave", "bankafschrift",
  "bankafschriften", "huurcontract", "contract", "polis", "paspoort", "identiteitsbewijs",
  "id-kaart", "beschikking", "aanslag", "specificatie", "factuur", "rekening",
  "opsturen", "aanleveren", "toesturen", "upload", "uploaden", "aanvullen",
  "attachment", "payslip", "statement", "copy of",
];

function mentionsDocument(text: string): boolean {
  const lower = text.toLowerCase();
  return DOC_WORDS.some((w) => lower.includes(w));
}

export function documentRequestText(kind: string, proposed: unknown): string | null {
  if (proposed === null || typeof proposed !== "object") return null;
  const p = proposed as Record<string, unknown>;
  if (kind === "log-entry") {
    const items = Array.isArray(p.actionItems) ? p.actionItems : [];
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as { description?: unknown; clarity?: unknown };
      const description = typeof item.description === "string" ? item.description : "";
      if (!description) continue;
      if (item.clarity === "already-provided" || mentionsDocument(description))
        return description;
    }
    return null;
  }
  if (kind === "task") {
    const title = typeof p.title === "string" ? p.title : "";
    const details = typeof p.details === "string" ? p.details : "";
    const text = [title, details].filter(Boolean).join(" ");
    return text && mentionsDocument(text) ? text : null;
  }
  return null;
}
```

- [ ] **Step 4 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/document-request.test.ts
git add -A && git commit -m "feat(api): detect document requests on suggestions" \
  -m "Deterministic Dutch/English detector gates the deep-retrieval panel so only cards that actually ask for a document spend a rerank call." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5 — failing test for the ranking helper.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/already-have.test.ts`. It uses two connections on purpose: `search_chunks` grants `verder_app` **SELECT only** (Task 2), so fixtures are seeded through the worker role while `alreadyHave` itself runs on the app role — which also proves the read path Martin's browser actually uses.

```ts
import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import type { EmbedPort } from "./embed";
import type { RerankPort } from "./rerank";
import { alreadyHave } from "./already-have";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

// Ollama-down embed port: retrieval stays lexical, so this test asserts
// ranking and shape without a GPU and without admitting foreign chunks from
// the shared dev database into the semantic half.
const noEmbed: EmbedPort = { embed: async (texts) => texts.map(() => null) };
// Deterministic rerank: preserves the fused order and reports `reranked: true`.
const fakeRerank: RerankPort = {
  rerank: async (_q, candidates) =>
    candidates.map((c, i) => ({ id: c.id, score: 1 / (i + 1) })),
};

describe("alreadyHave", () => {
  it("ranks vault documents for a document request", async () => {
    const app = createDb(APP_URL);
    const worker = createDb(WORKER_URL);
    const marker = `alh${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const [doc] = await app.db.insert(schema.documents).values({
      sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"),
      sizeBytes: 1234, mime: "application/pdf",
      title: `Loonstrook juni ${marker}`, source: "upload", receivedAt: new Date(),
    }).returning();
    await worker.db.insert(schema.searchChunks).values({
      entityType: "document", entityId: doc.id, chunkIndex: 0,
      title: `Loonstrook juni ${marker}`,
      body: `Loonstrook juni 2026 salarisspecificatie ${marker} werkgever`,
      sourceHash: `test:${marker}`,
    });
    const [s] = await app.db.insert(schema.suggestions).values({
      kind: "log-entry", model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { summary: "VerderGroep vraagt stukken",
        actionItems: [{ description: `Loonstrook ${marker} opsturen`, clarity: "clear" }] },
    }).returning();

    const out = await alreadyHave(
      { db: app.db, embed: noEmbed, rerank: fakeRerank }, s.id);
    expect(out.request).toBe(`Loonstrook ${marker} opsturen`);
    expect(out.reranked).toBe(true);
    expect(out.documents.length).toBeGreaterThan(0);
    expect(out.documents.length).toBeLessThanOrEqual(3);
    expect(out.documents[0].documentId).toBe(doc.id);
    expect(out.documents[0].title).toContain(marker);
    expect(out.documents[0].sha256).toBe(doc.sha256);
    expect(out.documents[0].mime).toBe("application/pdf");
    expect(out.documents[0].snippet.length).toBeGreaterThan(0);
    await app.pool.end();
    await worker.pool.end();
  });

  it("returns nothing to render when the suggestion asks for no document", async () => {
    const app = createDb(APP_URL);
    const [s] = await app.db.insert(schema.suggestions).values({
      kind: "log-entry", model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { summary: "Status update",
        actionItems: [{ description: "Even terugbellen", clarity: "clear" }] },
    }).returning();
    const out = await alreadyHave(
      { db: app.db, embed: noEmbed, rerank: fakeRerank }, s.id);
    expect(out.request).toBeNull();
    expect(out.documents).toEqual([]);
    expect(out.reranked).toBe(false);
    await app.pool.end();
  });
});
```

- [ ] **Step 6 — see it fail.**
```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/api test src/search/already-have.test.ts
```
Expected failure: `Failed to load url ./already-have (resolved id: …/packages/api/src/search/already-have) in …/already-have.test.ts. Does the file exist?`

- [ ] **Step 7 — implement the helper.** Create `/Users/martin/Workspace/mp/verder/packages/api/src/search/already-have.ts`:

```ts
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { realEmbedPort, type EmbedPort } from "./embed";
import { realRerankPort, type RerankPort } from "./rerank";
import { retrieve } from "./retrieve";
import { documentRequestText } from "./document-request";

/**
 * "Do we already have this?" — deep retrieval over the vault for the document
 * a suggestion asks for. Read-only: it links nothing, drafts nothing and sends
 * nothing. Martin picks on the card and the existing approve path does the
 * linking.
 *
 * Degrades, never errors: `retrieve` falls back to the fused order when the
 * rerank times out, and to lexical-only results when the embedder is down.
 */
export type AlreadyHaveDocument = {
  documentId: string; title: string; snippet: string; score: number;
  sha256: string; mime: string;
};
export type AlreadyHaveResult = {
  request: string | null; documents: AlreadyHaveDocument[]; reranked: boolean;
};

const MAX_DOCUMENTS = 3;
const RERANK_CANDIDATES = 20;

export async function alreadyHave(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort },
  suggestionId: string,
): Promise<AlreadyHaveResult> {
  const [s] = await deps.db.select().from(schema.suggestions)
    .where(eq(schema.suggestions.id, suggestionId));
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });

  const request = documentRequestText(s.kind, s.proposed);
  // No document request → no retrieval, no rerank, no GPU time. The card is
  // not rendered in this case either (suggestions.list reports
  // documentRequest: null), so this branch is belt-and-braces, not the gate.
  if (!request) return { request: null, documents: [], reranked: false };

  const { hits, reranked } = await retrieve(deps, {
    q: request, mode: "deep", limit: RERANK_CANDIDATES, entityTypes: ["document"],
  });

  // Top 3 distinct documents, hydrated in ONE batched lookup — never one query
  // per hit (same rule as timeline.ts withLinks).
  const top = hits.filter((h) => h.entityType === "document").slice(0, MAX_DOCUMENTS);
  if (top.length === 0) return { request, documents: [], reranked };
  const rows = await deps.db.select().from(schema.documents)
    .where(inArray(schema.documents.id, top.map((h) => h.entityId)));
  const byId = new Map(rows.map((d) => [d.id, d]));
  const documents = top.flatMap((h): AlreadyHaveDocument[] => {
    const doc = byId.get(h.entityId);
    if (!doc) return [];
    return [{ documentId: doc.id, title: h.title, snippet: h.snippet,
      score: h.score, sha256: doc.sha256, mime: doc.mime }];
  });
  return { request, documents, reranked };
}

/**
 * Real ports, constructed here rather than in the router so the router needs
 * exactly one new import line and the helper stays the only place that knows
 * which ports this feature uses.
 */
export function realAlreadyHaveDeps(db: Db) {
  return { db, embed: realEmbedPort(), rerank: realRerankPort() };
}
```

- [ ] **Step 8 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/already-have.test.ts
git add -A && git commit -m "feat(api): already-have retrieval for document requests" \
  -m "Deep retrieval over the vault answers 'do we already have this?' with ranked evidence instead of the model's guess. Read-only: nothing is linked, drafted or sent here." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 9 — failing router test.** Append inside the top-level `describe(...)` of `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.test.ts` (created by Task 8; keep its existing `db` / `userId` / `caller()` setup). This case deliberately covers only the **no-request** path — it is the one that makes no network call at all, so the router test stays fast and Ollama-independent while the ranking itself is covered by `already-have.test.ts`:

```ts
  it("alreadyHave returns nothing to render when the suggestion asks for no document", async () => {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { summary: "Status update",
        actionItems: [{ description: "Even terugbellen", clarity: "clear" }] },
    }).returning();
    const out = await caller().search.alreadyHave({ suggestionId: s.id });
    expect(out.request).toBeNull();
    expect(out.documents).toEqual([]);
    expect(out.reranked).toBe(false);
  });
```

- [ ] **Step 10 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
```
Expected failure: `TypeError: caller(...).search.alreadyHave is not a function`.

- [ ] **Step 11 — add the procedure.** In `/Users/martin/Workspace/mp/verder/packages/api/src/routers/search.ts`, add exactly one import line immediately below the file's first import, `import { z } from "zod";` (every router in `packages/api/src/routers/` opens with that line — `suggestions.ts:1`, `tasks.ts:1`):

```ts
import { alreadyHave as runAlreadyHave, realAlreadyHaveDeps } from "../search/already-have";
```
Then add this procedure as the **last** entry of the `searchRouter` router object, directly above its closing `});`:

```ts
  /**
   * "Do we already have this?" — deep retrieval over the vault for the
   * document a suggestion asks for. Read-only. The ranking lives in
   * ../search/already-have.ts so it can be tested with fake ports instead of
   * a 20 s Ollama rerank.
   */
  alreadyHave: protectedProcedure
    .input(z.object({ suggestionId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      runAlreadyHave(realAlreadyHaveDeps(ctx.db), input.suggestionId)),
```
No other symbol is needed: the procedure body uses only `z`, `protectedProcedure` and the two names just imported, and `z` / `protectedProcedure` are already imported by Task 8's `search.query`.

- [ ] **Step 12 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/search.test.ts
git add -A && git commit -m "feat(api): search.alreadyHave procedure" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 13 — failing test: the queue list flags document requests, and approving links the picked document.** `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.test.ts` imports `{ eq, inArray }` from `drizzle-orm` on line 2. This test needs `and` as well, so first replace line 2:

```ts
import { eq, inArray } from "drizzle-orm";
```
with:
```ts
import { and, eq, inArray } from "drizzle-orm";
```
Then append this `it(...)` inside `describe("suggestions router", …)`:

```ts
  it("list flags a document request and approving links the picked document to the entry", async () => {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t-doc",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Loonstroken", sentAt: new Date(),
      rawRfc822Sha256: "c".repeat(64), bodyText: "Graag loonstroken opsturen.",
    }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { occurredAt: new Date().toISOString(), channel: "email",
        direction: "inbound", summary: "VerderGroep vraagt loonstroken",
        details: "Juni en juli.", participantNames: ["VerderGroep"],
        actionItems: [{ description: "Loonstroken opsturen", clarity: "clear" }],
        attachmentDocumentIds: [] },
    }).returning();
    const listed = (await caller().suggestions.list({ status: "pending" }))
      .find((row) => row.id === s.id);
    expect(listed?.documentRequest).toBe("Loonstroken opsturen");

    const [doc] = await db.insert(schema.documents).values({
      sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"),
      sizeBytes: 999, mime: "application/pdf", title: "Loonstrook juni",
      source: "upload", receivedAt: new Date(),
    }).returning();
    const { entryId } = await caller().suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "VerderGroep vraagt loonstroken", details: "Juni en juli.",
        source: "gmail-watch", participantPartyIds: [], documentIds: [doc.id],
        actionItems: [{ description: "Loonstroken opsturen", clarity: "clear" }] },
    });
    // The association goes through the existing linking path (insertEntry):
    // an entry_documents row AND the documentId inside the entry.created payload.
    const links = await db.select().from(schema.entryDocuments)
      .where(eq(schema.entryDocuments.entryId, entryId));
    expect(links.map((l) => l.documentId)).toContain(doc.id);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.entityId, entryId),
        eq(schema.ledgerEvents.eventType, "entry.created")));
    expect(ev).toBeTruthy();
    expect((ev.payload as { documentIds: string[] }).documentIds).toContain(doc.id);
  });
```

- [ ] **Step 14 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/suggestions.test.ts
```
Expected failure: `AssertionError: expected undefined to be 'Loonstroken opsturen'` on `expect(listed?.documentRequest)`.

- [ ] **Step 15 — add `documentRequest` to `suggestions.list`.** In `/Users/martin/Workspace/mp/verder/packages/api/src/routers/suggestions.ts`, add one import line directly below line 10 (`import { taskFields } from "./tasks";`):

```ts
import { documentRequestText } from "../search/document-request";
```
Then, in `list`, lines 53–55 currently read:
```ts
    return Promise.all(rows.map(async (s) => ({
      ...s,
      rawEmail: s.rawEmailId
```
Replace them with:
```ts
    return Promise.all(rows.map(async (s) => ({
      ...s,
      // Pure and cheap: decided here so the card only calls the deep-retrieval
      // procedure for suggestions that actually ask for a document.
      documentRequest: documentRequestText(s.kind, s.proposed),
      rawEmail: s.rawEmailId
```

- [ ] **Step 16 — see it pass, commit.**
```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/suggestions.test.ts
git add -A && git commit -m "feat(api): flag document requests on queue suggestions" \
  -m "One deterministic field on every listed suggestion decides whether the card is allowed to spend a deep-retrieval rerank." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 17 — the panel component.** Create `/Users/martin/Workspace/mp/verder/apps/web/src/components/already-have-this.tsx`:

```tsx
"use client";
import { trpc } from "@/lib/trpc-client";

/**
 * "We may already have this." Deep retrieval over the vault for the document
 * this suggestion asks for. Picking a document only marks it — the link is
 * made by the card's existing approve mutation, so nothing enters the record
 * without Martin's verdict. No email is drafted or sent.
 *
 * The query is gated twice. The parent renders this component only when
 * `s.documentRequest` is non-null, AND `enabled` keeps the hook from firing
 * even if a future caller forgets that; `refetchOnWindowFocus: false` plus a
 * five-minute `staleTime` stop a 20 s rerank from re-running every time Martin
 * tabs back to the queue.
 */
export function AlreadyHaveThis({ suggestionId, request, selected, onToggle }: {
  suggestionId: string; request: string;
  selected: string[]; onToggle: (documentId: string) => void;
}) {
  const q = trpc.search.alreadyHave.useQuery(
    { suggestionId },
    { enabled: Boolean(request), staleTime: 5 * 60_000, refetchOnWindowFocus: false },
  );
  if (!request) return null;
  if (q.isError) return (
    <p className="rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm p-2">
      Could not check the vault right now — you can still approve and link later.
    </p>
  );
  if (!q.data) return (
    <p className="text-sm text-slate-500">Checking the vault for “{request}”…</p>
  );
  if (q.data.documents.length === 0) return (
    <p className="text-sm text-slate-500">
      Nothing in the vault looks like “{request}” yet.
    </p>
  );
  return (
    <div className="rounded bg-slate-50 border p-3 space-y-2">
      <p className="text-sm font-semibold">You may already have this 📎</p>
      <ul className="space-y-2">
        {q.data.documents.map((d) => (
          <li key={d.documentId} className="text-sm">
            <label className="flex gap-2 items-start">
              <input type="checkbox" className="mt-1"
                checked={selected.includes(d.documentId)}
                onChange={() => onToggle(d.documentId)} />
              <span>
                <span className="font-medium">{d.title}</span>
                <span className="text-slate-400"> · score {d.score.toFixed(3)}</span>
                <span className="block text-xs text-slate-500">{d.snippet}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        Ticked documents are linked to the record when you approve this card.
      </p>
    </div>
  );
}
```

- [ ] **Step 18 — widen the card type and import the panel.** In `/Users/martin/Workspace/mp/verder/apps/web/src/components/suggestion-card.tsx`, add one import line directly below the `import { RetrievedRefs } from "@/components/retrieved-refs";` line added by Task 14:

```tsx
import { AlreadyHaveThis } from "@/components/already-have-this";
```
Then extend the local `Suggestion` type — after Task 14 it reads:
```tsx
type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  retrievedRefs: unknown;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };
```
Replace it with:
```tsx
type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  retrievedRefs: unknown; documentRequest: string | null;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };
```

- [ ] **Step 19 — wire the panel into `EntryCard`.** `useState` is already imported (line 2). Three edits, each anchored on a line unique to `EntryCard` (`const [details, setDetails] = useState(p?.details ?? "");` alone is **not** unique — the identical line exists in `TaskCard`).

19a — add the picked-ids state. `EntryCard` currently contains:
```tsx
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
```
Replace with:
```tsx
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const [pickedDocIds, setPickedDocIds] = useState<string[]>([]);
```

19b — render the panel above the citations. After Task 14, `EntryCard` contains:
```tsx
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      <RetrievedRefs refs={s.retrievedRefs} />
```
Replace with:
```tsx
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      {s.documentRequest && <AlreadyHaveThis suggestionId={s.id} request={s.documentRequest}
        selected={pickedDocIds}
        onToggle={(id) => setPickedDocIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />}
      <RetrievedRefs refs={s.retrievedRefs} />
```

19c — carry the picks into the approve mutation. `EntryCard`'s approve call contains this unique line:
```tsx
            participantPartyIds: [], documentIds: p.attachmentDocumentIds,
```
Replace with:
```tsx
            participantPartyIds: [],
            documentIds: [...new Set([...p.attachmentDocumentIds, ...pickedDocIds])],
```

- [ ] **Step 20 — wire the panel into `TaskCard`.** A task links exactly one document (`tasks.documentId`), so the pick is single. Three edits, anchored on lines unique to `TaskCard`.

20a — add the picked-id state:
```tsx
  const [dueAt, setDueAt] = useState(p?.dueAt ?? ""); // YYYY-MM-DD or ""
```
Replace with:
```tsx
  const [dueAt, setDueAt] = useState(p?.dueAt ?? ""); // YYYY-MM-DD or ""
  const [pickedDocId, setPickedDocId] = useState<string | null>(null);
```

20b — render the panel. After Task 14, `TaskCard` contains:
```tsx
            <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
      </div>
      <RetrievedRefs refs={s.retrievedRefs} />
```
Replace with:
```tsx
            <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
      </div>
      {s.documentRequest && <AlreadyHaveThis suggestionId={s.id} request={s.documentRequest}
        selected={pickedDocId ? [pickedDocId] : []}
        onToggle={(id) => setPickedDocId((prev) => (prev === id ? null : id))} />}
      <RetrievedRefs refs={s.retrievedRefs} />
```

20c — carry the pick into the approve mutation. `TaskCard`'s approve call contains this unique line:
```tsx
            dueAt: dueAt ? new Date(dueAt) : undefined,
```
Replace with:
```tsx
            dueAt: dueAt ? new Date(dueAt) : undefined,
            documentId: pickedDocId ?? undefined,
```
`documentId` is a real field of `taskFields` (`packages/api/src/routers/tasks.ts:21`) and `approveTask` validates that the id exists before inserting (`suggestions.ts:222–224`). A mined task's `proposed` never carries a `documentId` key, and `unchangedFromProposal` skips keys absent from `proposed` (`suggestions.ts:43`) — so picking a document does **not** turn an otherwise-unedited approval into `"edited"`.

- [ ] **Step 21 — build, verify by hand, commit.**
```bash
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
env -u NODE_ENV pnpm --filter @verder/api test
```
Manual verification (dev, with Ollama reachable so the rerank actually runs): seed a document whose extracted text mentions "loonstrook" and let `search.drain` index it; insert a pending `log-entry` suggestion with an action item `"Loonstroken opsturen"`; open `/queue`. The entry card shows "You may already have this 📎" with up to three ranked documents and snippets. A card whose only action item is "Even terugbellen" shows **no panel at all** and — confirm this in the browser network tab — fires **no** `search.alreadyHave` request. Tick a document, approve, then open the new entry at `/logbook/[id]` and confirm the document is listed there.
```bash
git add -A && git commit -m "feat(web): 'do we already have this?' on document-request cards" \
  -m "The queue answers the question the miner can only guess at, with ranked vault evidence. The query is gated by the parent and by the hook so no card fires a 20 s rerank speculatively. Ticked documents ride into the existing approve path; no mail is drafted or sent." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Retrieval eval (golden rule)

Mirrors `run-registry-eval.ts` / `run-task-eval.ts` in shape — top-level await, fixed samples loaded via `new URL("./x.json", import.meta.url)`, one PASS/FAIL line per sample, a final score line naming model and prompt version, no non-zero exit.

**One deliberate and load-bearing difference: this eval runs against an isolated database it creates and destroys.** The other three evals are pure LLM calls; recall@5 and MRR are only meaningful against a *known* corpus. Measuring against the shared dev database — Martin's real records plus whatever other test suites left behind — and then filtering results down to fixture titles measures the wrong thing entirely: real records occupy result slots, so recall@5 sags by an amount that changes every week and the number is not reproducible. So the runner creates `verder_retrieval_eval`, applies the real migrations, inserts 40 fixture records (12 expected hits plus 28 deliberate distractors), indexes them with the **real `indexEntity`**, measures, and drops the database in a `finally`.

**Embedding symmetry is guaranteed, not hoped for.** Fixtures are embedded by `indexEntity`, which applies `asDocument(...)` (`"search_document: "`), and queries go through `retrieve`, which applies `asQuery(...)` (`"search_query: "`). The eval never embeds a fixture itself — that is exactly how the draft acquired an asymmetry that silently halves nomic recall. It *does* call `embedPort.embed(...)` once, as a port object, in a pre-flight probe: `asDocument`-prefixed, checked for 768 dimensions, so a dead or wrong-model Ollama is reported in the banner instead of being mistaken for bad retrieval.

**Files:**
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/eval/samples-retrieval.json`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/eval/run-retrieval-eval.ts`
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/package.json` (script `retrieval-eval`)

**Interfaces:**

Consumes: `createDb(url)` (`packages/db/src/client.ts:7`), `schema` (`packages/db/src/index.ts`), `assertSafeToTruncate(url)` (`packages/api/src/test-db-guard.ts`) — reused verbatim as the guard on `CREATE`/`DROP DATABASE`; `realEmbedPort` / `asDocument` / `EMBED_DIMENSIONS` from **Task 7** (`packages/api/src/search/embed.ts`); `indexEntity` from **Task 5** (`packages/api/src/search/index-entity.ts`); `retrieve` from **Task 8** (`packages/api/src/search/retrieve.ts`); `realRerankPort` and `RERANK_PROMPT_VERSION` from **Task 9** (`packages/api/src/search/rerank.ts`); `SEARCH_ENTITY_TYPES` / `SearchEntityType` from **Task 4** (`packages/core/src/search/entity-types.ts`, re-exported from `@verder/core`); the migration set `0014`–`0018` from **Tasks 1, 2, 6, 14**. `migrate` comes from `drizzle-orm/node-postgres/migrator` (present in the installed `drizzle-orm@0.38.4`).

Produces:
```jsonc
// apps/worker/package.json scripts
"retrieval-eval": "tsx src/eval/run-retrieval-eval.ts"
```
```ts
// sample + corpus shape (samples-retrieval.json)
type Corpus = { entityType: string; title: string; body: string; stage?: string };
type Sample =
  | { q: string; expect: { entityType: string; titleContains: string } }
  | { q: string; negative: true };
```

---

- [ ] **Step 1 — the fixture corpus and samples.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/eval/samples-retrieval.json`. Forty corpus records: twelve that samples expect, twenty-eight distractors chosen to share vocabulary with the queries so recall is actually earned. `financial_item` and `debt` appear as distractors only — their rendering is assembled from structured columns rather than free text, so making a sample depend on their body would measure the renderer, not retrieval.

```json
{
  "corpus": [
    { "entityType": "document", "title": "Beschikking rechtbank dossier 24-1187",
      "body": "Rechtbank Midden-Nederland, beschikking inzake de aanvraag schuldsanering. Dossiernummer 24-1187. De rechter-commissaris heeft de bewindvoerder benoemd en de toelating uitgesproken." },
    { "entityType": "document", "title": "Opzeggingsbrief Ziggo abonnement",
      "body": "Hierbij zeg ik mijn abonnement op per 1 oktober 2026. Ik verzoek u de opzegging schriftelijk te bevestigen en de laatste factuur te sturen." },
    { "entityType": "email", "title": "Bevestiging beeindiging abonnement",
      "body": "Beste heer Van der Poel, wij bevestigen de beeindiging van uw abonnement per 1 oktober. De laatste factuur ontvangt u eind september." },
    { "entityType": "document", "title": "Gescande brief VerderGroep 12 juni",
      "body": "Geachte heer Van der Poel, voor de volledigheid van uw dossier ontvangen wij graag een kopie van uw paspoort en de loonstroken van juni en juli." },
    { "entityType": "party", "title": "VerderGroep Bewindvoering",
      "body": "Organisatie. Bewindvoerder in het WSNP-traject. Contact via casemanager@verdergroep.nl." },
    { "entityType": "entry", "title": "Telefoongesprek met bewindvoerder over leefgeld",
      "body": "Gebeld over het beheer van de rekening en de maandelijkse leefgeldbetaling. Afgesproken dat het budgetplan volgende week volgt." },
    { "entityType": "task", "title": "Kopie paspoort opsturen naar VerderGroep",
      "body": "Actiepunt uit de mail van 12 juni: kopie identiteitsbewijs aanleveren voor het dossier." },
    { "entityType": "milestone", "title": "Toelating WSNP uitgesproken", "stage": "wsnp-start",
      "body": "De rechtbank heeft de toelating tot de wettelijke schuldsanering uitgesproken." },
    { "entityType": "timeline_event", "title": "Intakegesprek bewindvoering",
      "body": "Eerste gesprek met de bewindvoerder over inkomsten, vaste lasten en de postblokkade." },
    { "entityType": "document", "title": "Jaaropgave 2025 werkgever Dytech",
      "body": "Jaaropgave 2025. Fiscaal loon 41250 euro. Ingehouden loonheffing 9820 euro. Werkgever Dytech Solutions." },
    { "entityType": "document", "title": "Huurcontract Kanaalstraat 14",
      "body": "Huurovereenkomst voor onbepaalde tijd. Kale huur 985 euro per maand. Opzegtermijn een maand." },
    { "entityType": "entry", "title": "Brief van de rechtbank ontvangen over de zitting",
      "body": "Zitting gepland op 14 september. Aanwezigheid verplicht. De brief is gescand en in het dossier opgenomen." },

    { "entityType": "document", "title": "Beschikking gemeente bijzondere bijstand",
      "body": "De gemeente wijst de aanvraag bijzondere bijstand voor inrichtingskosten toe." },
    { "entityType": "document", "title": "Opzeggingsbrief sportschool",
      "body": "Hierbij zeg ik mijn lidmaatschap van de sportschool op per 1 december." },
    { "entityType": "document", "title": "Bevestiging afspraak tandarts",
      "body": "Uw afspraak is bevestigd op 3 juli om negen uur." },
    { "entityType": "document", "title": "Gescande brief zorgverzekeraar",
      "body": "Uw polis is gewijzigd per 1 januari. Het eigen risico blijft 385 euro." },
    { "entityType": "document", "title": "Loonstrook mei 2026",
      "body": "Salarisspecificatie mei. Bruto 3450 euro. Werkgever Dytech Solutions." },
    { "entityType": "document", "title": "Loonstrook augustus 2026",
      "body": "Salarisspecificatie augustus. Bruto 3450 euro. Werkgever Dytech Solutions." },
    { "entityType": "document", "title": "Aanslag inkomstenbelasting 2024",
      "body": "Te betalen 412 euro voor het belastingjaar 2024." },
    { "entityType": "document", "title": "Bankafschrift juli 2026",
      "body": "Rekeningafschrift met beginsaldo en eindsaldo van juli." },
    { "entityType": "document", "title": "Polisblad autoverzekering 2026",
      "body": "Dekking WA plus casco. Premie 42 euro per maand." },
    { "entityType": "document", "title": "Zorgpolis 2026",
      "body": "Basisverzekering met een eigen risico van 385 euro." },
    { "entityType": "entry", "title": "E-mail aan de gemeente over de aanvraag",
      "body": "Aanvraag bijzondere bijstand ingediend met bijlagen." },
    { "entityType": "entry", "title": "Gesprek met de werkgever over het contract",
      "body": "Contractverlenging besproken voor twaalf maanden." },
    { "entityType": "entry", "title": "Post opgehaald bij het oude adres",
      "body": "Twee enveloppen van de belastingdienst en een reclamefolder." },
    { "entityType": "email", "title": "Herinnering betaling energienota",
      "body": "Wij missen uw betaling van de nota van juni." },
    { "entityType": "email", "title": "Nieuwsbrief woningcorporatie",
      "body": "Onderhoud aan de liften in september." },
    { "entityType": "email", "title": "Wachtwoord opnieuw instellen",
      "body": "Klik op de link om uw wachtwoord opnieuw in te stellen." },
    { "entityType": "task", "title": "Bankafschriften juli downloaden",
      "body": "Voor het budgetplan van de bewindvoerder." },
    { "entityType": "task", "title": "Adreswijziging doorgeven aan de zorgverzekeraar",
      "body": "Nieuw adres per 1 augustus." },
    { "entityType": "task", "title": "Sportschool opzeggen voor 1 november",
      "body": "De opzegtermijn is een maand." },
    { "entityType": "party", "title": "Gemeente Utrecht",
      "body": "Organisatie. Afdeling Werk en Inkomen." },
    { "entityType": "party", "title": "Intrum Nederland",
      "body": "Organisatie. Incassobureau." },
    { "entityType": "party", "title": "Dytech Solutions",
      "body": "Organisatie. Werkgever sinds 2019." },
    { "entityType": "party", "title": "Mr. J. de Vries",
      "body": "Persoon. Rechter-commissaris bij de rechtbank." },
    { "entityType": "milestone", "title": "Aanvraag ingediend bij de rechtbank", "stage": "application",
      "body": "Verzoekschrift schuldsanering ingediend." },
    { "entityType": "milestone", "title": "Schone lei verwacht", "stage": "clean-slate",
      "body": "Verwachte einddatum van het traject." },
    { "entityType": "timeline_event", "title": "Eerste betaling leefgeld ontvangen",
      "body": "Leefgeld komt wekelijks op de leefgeldrekening." },
    { "entityType": "financial_item", "title": "Ziggo internet en televisie",
      "body": "Telecomabonnement, maandelijks per incasso." },
    { "entityType": "debt", "title": "Intrum Nederland",
      "body": "Openstaande telefoonrekening uit 2024." }
  ],
  "samples": [
    { "q": "dossiernummer 24-1187", "expect": { "entityType": "document", "titleContains": "Beschikking rechtbank" } },
    { "q": "beschikking rechtbank schuldsanering", "expect": { "entityType": "document", "titleContains": "Beschikking rechtbank" } },
    { "q": "abonnement opzeggen", "expect": { "entityType": "document", "titleContains": "Opzeggingsbrief Ziggo" } },
    { "q": "beeindiging abonnement bevestigd", "expect": { "entityType": "email", "titleContains": "Bevestiging beeindiging" } },
    { "q": "gescande brief met verzoek om kopie paspoort", "expect": { "entityType": "document", "titleContains": "Gescande brief VerderGroep" } },
    { "q": "loonstroken juni en juli aanleveren", "expect": { "entityType": "document", "titleContains": "Gescande brief VerderGroep" } },
    { "q": "VerderGroep bewindvoering", "expect": { "entityType": "party", "titleContains": "VerderGroep Bewindvoering" } },
    { "q": "gesprek met de bewindvoerder over leefgeld", "expect": { "entityType": "entry", "titleContains": "Telefoongesprek met bewindvoerder" } },
    { "q": "identiteitsbewijs opsturen actiepunt", "expect": { "entityType": "task", "titleContains": "Kopie paspoort opsturen" } },
    { "q": "toelating tot de wettelijke schuldsanering", "expect": { "entityType": "milestone", "titleContains": "Toelating WSNP" } },
    { "q": "jaaropgave fiscaal loon werkgever", "expect": { "entityType": "document", "titleContains": "Jaaropgave 2025" } },
    { "q": "huurovereenkomst kale huur opzegtermijn", "expect": { "entityType": "document", "titleContains": "Huurcontract Kanaalstraat" } },
    { "q": "recept lasagne bolognese", "negative": true },
    { "q": "trainingsschema hardlopen halve marathon", "negative": true },
    { "q": "xyzzy quux 99887766", "negative": true }
  ]
}
```
The paraphrase pair the spec asks for is samples 3 and 4 (`opzeggen` ↔ `beeindiging`, written without the diaeresis exactly as the corpus writes it, so the sample measures stemming and embeddings rather than accent folding). The dossier number is sample 1, the scanned-letter query is sample 5, the party-name query is sample 7. Negatives carry **no** `forbidTitleContains` list: they assert an empty result set, which is the only assertion that means "returns nothing".

- [ ] **Step 2 — the runner.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/eval/run-retrieval-eval.ts`:

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema, type Db } from "@verder/db";
import { assertSafeToTruncate } from "@verder/api/src/test-db-guard";
import { asDocument, realEmbedPort, EMBED_DIMENSIONS } from "@verder/api/src/search/embed";
import { indexEntity } from "@verder/api/src/search/index-entity";
import { realRerankPort, RERANK_PROMPT_VERSION } from "@verder/api/src/search/rerank";
import { retrieve } from "@verder/api/src/search/retrieve";
import type { SearchEntityType } from "@verder/core";

// Golden-rule eval for hybrid retrieval. Mirrors run-registry-eval.ts and
// run-task-eval.ts: fixed samples, one PASS/FAIL line each, a final score line
// naming model and prompt version, no non-zero exit.
//
// ONE deliberate difference: this eval owns a DATABASE. recall@5 and MRR are
// only meaningful against a known corpus, so it creates verder_retrieval_eval,
// migrates it, seeds 40 fixture records (12 expected hits + 28 distractors),
// indexes them with the real indexEntity, measures, and drops the database in a
// finally. Measuring against the shared dev database and filtering afterwards
// would let Martin's real records occupy result slots and make recall@5
// unreproducible.
//
// Embedding symmetry is structural: indexEntity applies asDocument() and
// retrieve applies asQuery(), so document and query prefixes can never drift.
//
// Usage (from the Mac, dev postgres + homelab GPU):
//   OLLAMA_URL=http://192.168.188.148:11434 pnpm --filter worker retrieval-eval

const EVAL_DB = "verder_retrieval_eval";
const K = 5;

const fileSchema = z.object({
  corpus: z.array(z.object({
    entityType: z.string(),
    title: z.string(),
    body: z.string(),
    stage: z.string().optional(),
  })),
  samples: z.array(z.union([
    z.object({ q: z.string(),
      expect: z.object({ entityType: z.string(), titleContains: z.string() }) }),
    z.object({ q: z.string(), negative: z.literal(true) }),
  ])),
});
type CorpusRecord = z.infer<typeof fileSchema>["corpus"][number];

const { corpus, samples } = fileSchema.parse(JSON.parse(
  await readFile(new URL("./samples-retrieval.json", import.meta.url), "utf8")));

const ADMIN_URL = process.env.EVAL_ADMIN_URL
  ?? "postgres://verder:verder@localhost:5432/postgres";
// Same guard the destructive API tests use: CREATE/DROP DATABASE only ever
// runs against localhost, never against the homelab deployment.
assertSafeToTruncate(ADMIN_URL);
const evalUrl = new URL(ADMIN_URL);
evalUrl.pathname = `/${EVAL_DB}`;

const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url));

const admin = createDb(ADMIN_URL);
await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${EVAL_DB} WITH (FORCE)`));
await admin.db.execute(sql.raw(`CREATE DATABASE ${EVAL_DB}`));
await admin.pool.end();

const { db, pool } = createDb(evalUrl.toString());
const embed = realEmbedPort();
const rerank = realRerankPort();

function sha256Fixture(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}

/**
 * One fixture record → one real row in its real table, so `indexEntity` reads
 * and renders exactly what production reads and renders. Only entity types
 * with a free-text field are given discriminating text; financial_item and
 * debt exist as distractors carried by their name alone.
 */
async function insertFixture(
  db: Db, userId: string, c: CorpusRecord,
): Promise<{ entityType: SearchEntityType; entityId: string }> {
  const at = new Date("2026-06-12T10:00:00Z");
  switch (c.entityType) {
    case "document": {
      const sha = sha256Fixture();
      const [doc] = await db.insert(schema.documents).values({
        sha256: sha, title: c.title, mime: "application/pdf", sizeBytes: c.body.length,
        source: "upload", receivedAt: at,
      }).returning();
      await db.insert(schema.documentTexts).values({
        documentId: doc.id, sha256: sha, text: c.body,
        extractor: "pdf-parse", charCount: c.body.length, truncated: false,
      });
      return { entityType: "document", entityId: doc.id };
    }
    case "entry": {
      const [e] = await db.insert(schema.logEntries).values({
        occurredAt: at, channel: "letter", direction: "inbound",
        summary: c.title, details: c.body, source: "manual", createdBy: userId,
      }).returning();
      return { entityType: "entry", entityId: e.id };
    }
    case "email": {
      const [m] = await db.insert(schema.rawEmails).values({
        gmailMessageId: `eval-${crypto.randomUUID()}`, gmailThreadId: "eval",
        fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
        subject: c.title, sentAt: at, rawRfc822Sha256: sha256Fixture(), bodyText: c.body,
      }).returning();
      return { entityType: "email", entityId: m.id };
    }
    case "task": {
      const [t] = await db.insert(schema.tasks).values({
        title: c.title, details: c.body, createdBy: userId,
      }).returning();
      return { entityType: "task", entityId: t.id };
    }
    case "party": {
      const [p] = await db.insert(schema.parties).values({
        kind: c.body.startsWith("Persoon") ? "person" : "organization",
        name: c.title, notes: c.body,
      }).returning();
      return { entityType: "party", entityId: p.id };
    }
    case "milestone": {
      const [m] = await db.insert(schema.milestones).values({
        stage: (c.stage ?? "application") as "application",
        title: c.title, note: c.body, happenedAt: at, done: true,
      }).returning();
      return { entityType: "milestone", entityId: m.id };
    }
    case "timeline_event": {
      const [t] = await db.insert(schema.timelineEvents).values({
        title: c.title, happenedAt: at, kind: "process", note: c.body,
      }).returning();
      return { entityType: "timeline_event", entityId: t.id };
    }
    case "financial_item": {
      const [f] = await db.insert(schema.financialItems).values({
        name: c.title, category: "telecom", amountCents: 6250,
        billingCycle: "monthly", paymentChannel: "direct-debit", discoveredVia: "bank",
      }).returning();
      return { entityType: "financial_item", entityId: f.id };
    }
    case "debt": {
      const [d] = await db.insert(schema.debts).values({
        creditorName: c.title, claimedCents: 184200, originStory: c.body,
      }).returning();
      return { entityType: "debt", entityId: d.id };
    }
    default:
      throw new Error(`Unknown fixture entityType: ${c.entityType}`);
  }
}

function rankOf(
  hits: { entityType: string; title: string }[],
  want: { entityType: string; titleContains: string },
): number | null {
  const i = hits.findIndex((h) =>
    h.entityType === want.entityType && h.title.includes(want.titleContains));
  return i === -1 ? null : i + 1;
}

try {
  await migrate(db, { migrationsFolder: MIGRATIONS });

  // Pre-flight the embedder as a PORT OBJECT, with the same document prefix the
  // indexer uses. A dead or wrong-sized model is reported here rather than
  // being mistaken for bad retrieval 40 fixtures later.
  const probe = await embed.embed([asDocument("nomic embedding probe")]);
  const dims = probe[0]?.length ?? 0;
  const semantic = probe[0] !== null && dims === EMBED_DIMENSIONS;
  console.log(semantic
    ? `embedder OK (${dims} dims) — hybrid retrieval\n`
    : `embedder UNAVAILABLE (got ${probe[0] === null ? "null" : `${dims} dims`}) `
      + `— LEXICAL ONLY, semantic samples will fail\n`);

  const [user] = await db.insert(schema.users)
    .values({ email: "eval@verder.local", name: "Retrieval eval" }).returning();

  let indexed = 0;
  for (const c of corpus) {
    const { entityType, entityId } = await insertFixture(db, user.id, c);
    const res = await indexEntity({ db, embed }, entityType, entityId);
    indexed += res.chunks;
  }
  console.log(`seeded ${corpus.length} fixture records → ${indexed} chunks\n`);

  for (const mode of ["fast", "deep"] as const) {
    let positives = 0, recallHits = 0, rrSum = 0, negativesOk = 0, negatives = 0;
    for (const s of samples) {
      const { hits } = await retrieve(
        { db, embed, rerank: mode === "deep" ? rerank : undefined },
        { q: s.q, mode, limit: K });
      if ("negative" in s) {
        negatives++;
        const ok = hits.length === 0;
        if (ok) negativesOk++;
        console.log(`${ok ? "PASS" : "FAIL"} [${mode}] neg — ${s.q}`
          + (ok ? "" : ` → ${hits.length} hit(s): ${hits.map((h) => h.title).join(" | ")}`));
        continue;
      }
      positives++;
      const rank = rankOf(hits, s.expect);
      if (rank !== null) { recallHits++; rrSum += 1 / rank; }
      console.log(`${rank !== null ? "PASS" : "FAIL"} [${mode}] rank=${rank ?? "-"} — ${s.q}`
        + (rank !== null ? "" : ` → ${hits.map((h) => h.title).join(" | ") || "(no hits)"}`));
    }
    const recall = positives ? recallHits / positives : 0;
    const mrr = positives ? rrSum / positives : 0;
    console.log(`\n${mode}: recall@${K} ${recallHits}/${positives} (${recall.toFixed(2)})`
      + ` · MRR ${mrr.toFixed(3)} · negatives ${negativesOk}/${negatives}\n`);
  }
  console.log(`model=${process.env.OLLAMA_MODEL ?? "qwen3.5:9b"}`
    + ` embed=${process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"}`
    + ` prompt=${RERANK_PROMPT_VERSION}`);
} finally {
  await pool.end();
  const cleanup = createDb(ADMIN_URL);
  await cleanup.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${EVAL_DB} WITH (FORCE)`));
  await cleanup.pool.end();
}
```
Negatives assert `hits.length === 0` on purpose. If a negative FAILs with a non-empty set, that is a genuine finding about the pipeline's semantic floor — cosine ANN always returns *something* unless the candidate set is cut off — and it belongs in the recorded baseline, not in a weakened assertion.

- [ ] **Step 3 — register the script.** In `/Users/martin/Workspace/mp/verder/apps/worker/package.json`, the `scripts` block currently contains:
```json
    "task-eval": "tsx src/eval/run-task-eval.ts",
```
Replace that line with:
```json
    "task-eval": "tsx src/eval/run-task-eval.ts",
    "retrieval-eval": "tsx src/eval/run-retrieval-eval.ts",
```

- [ ] **Step 4 — typecheck, then smoke-run with Ollama unreachable.**
```bash
env -u NODE_ENV pnpm --filter worker typecheck
docker compose up -d postgres
OLLAMA_URL=http://127.0.0.1:1 env -u NODE_ENV pnpm --filter worker retrieval-eval
```
Expected: the script does **not** crash. The banner reads `embedder UNAVAILABLE (got null) — LEXICAL ONLY, semantic samples will fail`; the corpus still seeds (`seeded 40 fixture records → … chunks`); the lexical half still scores, so the dossier-number, party-name and jaaropgave samples PASS while the `opzeggen`/`beeindiging` paraphrase pair likely FAILs; `deep` matches `fast` because the rerank port is also unreachable and `retrieve` falls back to the fused order. Then confirm the isolated database is gone:
```bash
docker compose exec -T postgres psql -U verder -d postgres -c \
  "SELECT count(*) FROM pg_database WHERE datname = 'verder_retrieval_eval';"
```
Expected: `0`. Also confirm the eval left the dev database untouched — it must never have connected to it:
```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "SELECT count(*) FROM users WHERE email = 'eval@verder.local';"
```
Expected: `0`.

- [ ] **Step 5 — three honest runs against the homelab GPU.** Run it three times from the Mac against the local dev postgres and the homelab Ollama (LAN IP as in `.env.prod`):
```bash
for i in 1 2 3; do OLLAMA_URL=http://192.168.188.148:11434 \
  env -u NODE_ENV pnpm --filter worker retrieval-eval; done
```
Record the **range** across the three completed runs, for `fast` and `deep` separately: recall@5, MRR, negatives. Rules, non-negotiable:
- A run that aborts on an Ollama timeout is **not** a run — rerun it. `apps/worker/src/ollama.ts:26` hard-codes `AbortSignal.timeout(120_000)` and CLAUDE.md records six aborted attempts in one baseline round under GPU contention.
- Never record the best run. If `deep` gives 12/12, 11/12, 11/12, the baseline is **11–12/12**, not 12/12.
- If `deep` is not better than `fast` on this corpus, write that down as the finding. A rerank that does not earn its 20 s is a result, not a failure to hide.
- Note which sample types are the known misses (paraphrase pair? scanned letter? a negative that returns hits?) — that sentence goes into CLAUDE.md in Task 17.

- [ ] **Step 6 — commit with the measured range in the subject**, matching the repo's eval commits (`449b845 feat(worker): action-item eval (baseline: 7/7 over 3 runs)`). Substitute the four numbers you measured for `A`–`D` before running this:
```bash
git add -A && git commit -m "feat(worker): retrieval eval (baseline: fast recall@5 A–B/12, deep C–D/12 over 3 runs)" \
  -m "Fifteen Dutch samples over an isolated fixture database: 40 records (12 expected hits, 28 distractors) inserted as real rows and indexed with the real indexEntity, so recall@5 and MRR are reproducible instead of depending on whatever else is in the dev corpus. Dossier number, opzeggen/beeindiging paraphrase pair, scanned-letter query, party name, and three negatives that must return an empty set. Fast and deep scored separately so the rerank's value is visible. The database is created and dropped by the runner." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: Deploy, backfill, and docs

**Files:**
- Modify: `/Users/martin/Workspace/mp/verder/ops/nightly.sh` (exclude `search_chunks` data from the dump)
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/model-targets.ts`
- Create: `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/model-targets.test.ts`
- Modify: `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/check-model-updates.ts` (check the embedding model too)
- Modify: `/Users/martin/Workspace/mp/verder/docs/deploy.md` (migration count + list, pgvector image requirement, `reindex` step in the restore procedure)
- Modify: `/Users/martin/Workspace/mp/verder/CLAUDE.md` (deploy note + retrieval eval baseline)
- No other application code changes.

**Interfaces:** none (ops). Read `/Users/martin/Workspace/mp/verder/CLAUDE.md` and `/Users/martin/Workspace/mp/verder/docs/deploy.md` in full before starting.

**Pre-condition to check first.** Task 1 swapped both compose files to the pgvector image. Verify before touching anything:
```bash
grep -n "image: " /Users/martin/Workspace/mp/verder/docker-compose.yml /Users/martin/Workspace/mp/verder/docker-compose.prod.yml
```
Expected: `pgvector/pgvector:pg17` in **both** files. Before this sub-project both said `image: postgres:17` (verified). If only one was swapped, stop and fix that first — a bare `docker compose up -d postgres` on the homelab would otherwise attach a non-pgvector Postgres to a database containing `vector` columns.

---

- [ ] **Step 1 — nightly backup excludes the derived chunk data.** In `/Users/martin/Workspace/mp/verder/ops/nightly.sh`, lines 19–22 currently read:

```bash
# 1. Postgres dump (30-day retention).
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U verder verder | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete
```
Replace them with:
```bash
# 1. Postgres dump (30-day retention). search_chunks DATA is excluded: it is
#    the largest table, fully derived, and rebuildable with `reindex` — the
#    table DDL and its GIN/HNSW indexes are still in the dump, only the rows
#    are dropped. A restore therefore yields an empty index, which is why the
#    restore procedure in docs/deploy.md ends in a reindex step.
#    --exclude-table-data is schema-qualified on purpose: a bare
#    `search_chunks` is a pattern that would match across schemas.
#    document_texts is deliberately KEPT — OCR is expensive and its rows are
#    not cheaply rebuildable.
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U verder --exclude-table-data=public.search_chunks verder \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete
```

- [ ] **Step 2 — prove the exclusion pattern LOCALLY, before it ever touches production.** A wrong `--exclude-table-data` pattern silently produces a smaller dump that nobody notices until a restore, so the pattern is verified against the dev database first, on the Mac, with the same flag the script now uses:
```bash
bash -n /Users/martin/Workspace/mp/verder/ops/nightly.sh
docker compose up -d postgres
docker compose exec -T postgres psql -U verder -d verder -c \
  "INSERT INTO search_chunks (entity_type, entity_id, chunk_index, title, body, source_hash) VALUES ('party', gen_random_uuid(), 0, 'DUMPCHECK party', 'dumpcheck body text', 'dumpcheck');"
docker compose exec -T postgres pg_dump -U verder \
  --exclude-table-data=public.search_chunks verder | gzip > /tmp/verder-dumpcheck.sql.gz
zcat /tmp/verder-dumpcheck.sql.gz | grep -c "CREATE TABLE public.search_chunks"
zcat /tmp/verder-dumpcheck.sql.gz | grep -c "COPY public.search_chunks"
zcat /tmp/verder-dumpcheck.sql.gz | grep -c "DUMPCHECK party"
zcat /tmp/verder-dumpcheck.sql.gz | grep -c "COPY public.document_texts"
```
Expected, in order: `1` (the table DDL survives), `0` (its data block is gone), `0` (the sentinel row is gone), `1` (`document_texts` data is kept). Then clean up:
```bash
docker compose exec -T postgres psql -U verder -d verder -c \
  "DELETE FROM search_chunks WHERE source_hash = 'dumpcheck';"
rm /tmp/verder-dumpcheck.sql.gz
```

- [ ] **Step 3 — failing test for the model-check target list.** Nightly `model-check` currently pulls only `process.env.OLLAMA_MODEL` (`apps/worker/src/ops/check-model-updates.ts:8`), which leaves the new embedding model outside nightly freshness checking entirely. The script is a top-level-await module with no exports, so the testable part is extracted. Create `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/model-targets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { modelTargets } from "./model-targets";

describe("modelTargets", () => {
  it("checks the chat model and the embedding model, with the project defaults", () => {
    expect(modelTargets({})).toEqual(["qwen3.5:9b", "nomic-embed-text"]);
  });

  it("honours both environment overrides", () => {
    expect(modelTargets({ OLLAMA_MODEL: "qwen3.5:14b", OLLAMA_EMBED_MODEL: "bge-m3" }))
      .toEqual(["qwen3.5:14b", "bge-m3"]);
  });

  it("deduplicates when both variables name the same tag", () => {
    expect(modelTargets({ OLLAMA_MODEL: "same:1", OLLAMA_EMBED_MODEL: "same:1" }))
      .toEqual(["same:1"]);
  });
});
```

- [ ] **Step 4 — see it fail.**
```bash
env -u NODE_ENV pnpm --filter worker test src/ops/model-targets.test.ts
```
Expected failure: `Failed to resolve import "./model-targets" from "src/ops/model-targets.test.ts". Does the file exist?`

- [ ] **Step 5 — implement, wire it into the nightly check, see it pass.** Create `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/model-targets.ts`:

```ts
/**
 * Every Ollama tag the nightly model-check must keep fresh. The chat model and
 * the embedding model are pulled by the same job: an embedding model that
 * silently goes stale changes the vector space under an index that was built
 * with the old weights, which degrades recall without any error anywhere.
 */
export function modelTargets(env: {
  OLLAMA_MODEL?: string; OLLAMA_EMBED_MODEL?: string;
}): string[] {
  const chat = env.OLLAMA_MODEL ?? "qwen3.5:9b";
  const embed = env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  return chat === embed ? [chat] : [chat, embed];
}
```
Then rewrite `/Users/martin/Workspace/mp/verder/apps/worker/src/ops/check-model-updates.ts` in full (it is 30 lines today; this replaces all of it):

```ts
// Nightly Ollama model freshness check. Ollama pulls are idempotent — pulling
// an up-to-date tag is a no-op, an updated tag downloads the new weights.
// Records what happened to worker_runs so the dashboard heartbeat list shows
// when a model last changed. Covers the chat model AND the embedding model:
// stale embedding weights silently degrade search recall.
import { createDb } from "@verder/db";
import { recordRun } from "../heartbeat";
import { modelTargets } from "./model-targets";

const base = process.env.OLLAMA_URL ?? "http://localhost:11434";
const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";

const { db, pool } = createDb(url);
try {
  for (const model of modelTargets(process.env)) {
    const local = await fetch(`${base}/api/show`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) })
      .then((r) => r.json()) as { details?: { parameter_size?: string }; modified_at?: string };
    const pull = await fetch(`${base}/api/pull`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }) }).then((r) => r.json()) as { status?: string };
    await recordRun(db, "model-check", "ok", {
      model, localModifiedAt: local.modified_at, pullStatus: pull.status });
    console.log(`model-check: ${model} → ${pull.status}`);
  }
} catch (err) {
  await recordRun(db, "model-check", "error", { message: String(err) }).catch(() => {});
  console.error(`model-check: failed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
```
```bash
env -u NODE_ENV pnpm --filter worker test src/ops/model-targets.test.ts
env -u NODE_ENV pnpm --filter worker typecheck
```

- [ ] **Step 6 — correct the migration count and list in `docs/deploy.md`.** `docs/deploy.md:74–78` currently reads:

```markdown
Migrations run from the host checkout as the admin role (`verder`), never
from the containers. The drizzle journal currently contains twelve
migrations — `0000` (schema) through `0011` — and covers everything
in one pass:
```
That sentence was already wrong before this sub-project (the journal held 14 entries, `0000`–`0013`). Replace those four lines with:
```markdown
Migrations run from the host checkout as the admin role (`verder`), never
from the containers. The drizzle journal currently contains nineteen
migrations — `0000` (schema) through `0018` — and covers everything
in one pass:
```
Then append these five bullets to the end of the existing bullet list, directly after the `- \`0011_task_grants\` — task grants: …` bullet (the last one today):
```markdown
- `0012_lively_scarlet_witch` — curated key events (`timeline_events` +
  `timeline_event_kind` enum)
- `0013_timeline_grants` — `timeline_events` grants (editable display aid:
  UPDATE allowed, DELETE never)
- `0014_vector_extension` — `CREATE EXTENSION IF NOT EXISTS vector`. Requires
  the `pgvector/pgvector:pg17` image; a stock `postgres:17` fails here and
  every later migration cascades
- `0015_knowledge_base` — `document_texts`, `search_chunks`, `search_outbox`,
  the GIN index on `tsv` and the HNSW cosine index on `embedding`
- `0016_search_grants` — index grants. FIRST tables in this project with
  DELETE: the index is DERIVED, not evidence — fully rebuildable by `reindex`,
  it appends no ledger events, and index health is surfaced on `/verify`.
  Neither role gets INSERT on `search_outbox`; rows arrive only through the
  SECURITY DEFINER trigger function owned by `verder`
- `0017_search_triggers` — `search_enqueue()` plus fourteen
  `AFTER INSERT OR UPDATE` triggers: nine entity tables and five
  parent-refresh tables (`document_status_changes`, `task_status_changes`,
  `registry_decisions`, `entry_participants`, `entry_documents`)
- `0018_retrieved_refs` — `suggestions.retrieved_refs` (retrieval citations;
  table-level grants already cover the new column)
```
Confirm the tags match the journal exactly before committing:
```bash
docker compose exec -T postgres psql -U verder -d verder -c "SELECT 1" >/dev/null
node -e "const j=require('/Users/martin/Workspace/mp/verder/packages/db/drizzle/meta/_journal.json');console.log(j.entries.length);j.entries.forEach(e=>console.log(e.idx,e.tag))"
```
Expected: `19`, then `0` … `18` with tags ending `0014_vector_extension`, `0015_knowledge_base`, `0016_search_grants`, `0017_search_triggers`, `0018_retrieved_refs`. If a tag differs, correct the bullet to the journal — the journal is the truth.

- [ ] **Step 7 — the restore procedure gains a reindex step.** `docs/deploy.md:186` starts `## Restore procedure`, with numbered steps 1–4 at lines 188–211. Add this paragraph directly under the `## Restore procedure` heading, before step 1:

```markdown
Both the dump and the restore must run on a **pgvector-capable image**
(`pgvector/pgvector:pg17`): the dump contains `CREATE EXTENSION IF NOT EXISTS
vector`, and a stock `postgres:17` fails on that line and cascades.
```
Then insert a new step between the current step 3 (`Restore the vault files`) and the current step 4 (`Start everything and verify`):
```markdown
4. Rebuild the search index. The nightly dump excludes `search_chunks` data
   (`--exclude-table-data=public.search_chunks`), so a restored database has
   the table, its GIN/HNSW indexes and no rows — search would silently return
   nothing:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker
   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
     pnpm --filter worker reindex
   ```
   This is GPU-bound and not instant. To rebuild only part of the corpus use
   the flags `--entity=document`, `--since=2026-01-01`, `--prune`; there is no
   environment-variable form. Check `/verify` afterwards: chunk count non-zero,
   outbox depth draining, embedding failures at zero.
```
Renumber the old step 4 ("Start everything and verify") to **5**.

- [ ] **Step 8 — commit the local ops/docs changes, gated on a fully green suite.**
```bash
env -u NODE_ENV pnpm -r --if-present test
env -u NODE_ENV pnpm --filter web build
env -u NODE_ENV pnpm --filter @verder/api typecheck
env -u NODE_ENV pnpm --filter worker typecheck
bash -n /Users/martin/Workspace/mp/verder/ops/nightly.sh
git add -A && git commit -m "docs: backup excludes derived chunks, restore rebuilds the index" \
  -m "search_chunks is the largest table and fully derived, so the nightly dump drops its rows — which means a restore is only correct if it ends in a reindex. Records the pgvector image requirement for dump and restore alike, corrects the stale migration count, and puts the embedding model inside the nightly model-check." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Everything must be green on `main` before touching the homelab. Do not start the deploy with a red suite.

- [ ] **Step 9 — pre-flight the pgvector image and disk (before touching the stack).** The image is not on the homelab yet, and a Postgres **minor downgrade** against an existing data directory is not something to discover mid-deploy:
```bash
ssh homelab 'docker pull pgvector/pgvector:pg17 && docker run --rm pgvector/pgvector:pg17 postgres --version'
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres postgres --version'
ssh homelab 'df -h / /mnt/nas-download'
```
Require the pgvector image's version to be **≥** the running one. If it is lower, stop and pin a matching tag instead — do not proceed.

- [ ] **Step 10 — pull the embedding model and verify it answers.** The backfill embeds every chunk; a missing tag would fail silently into NULL embeddings and a search that only ever matches keywords:
```bash
ssh homelab 'ollama pull nomic-embed-text'
ssh homelab 'ollama list | grep nomic-embed-text'
ssh homelab "curl -s http://127.0.0.1:11434/api/embed -d '{\"model\":\"nomic-embed-text\",\"input\":\"search_document: proefzin\"}' | head -c 200"
```
Expected: `ollama list` shows a `nomic-embed-text` row, and the curl returns JSON beginning `{"model":"nomic-embed-text","embeddings":[[` with float values. Then confirm the dimension is the 768 the schema declares:
```bash
ssh homelab "curl -s http://127.0.0.1:11434/api/embed -d '{\"model\":\"nomic-embed-text\",\"input\":\"search_document: proefzin\"}' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)[\"embeddings\"][0]))'"
```
Expected: `768`. Anything else means the schema's `vector(768)` and the model disagree — stop and resolve that before deploying.

- [ ] **Step 11 — add `OLLAMA_EMBED_MODEL` to the production env file.** Secrets and env live only on the homelab (`~/apps/verder/.env.prod`, never committed, and excluded from rsync):
```bash
ssh homelab "grep -q '^OLLAMA_EMBED_MODEL=' ~/apps/verder/.env.prod || echo 'OLLAMA_EMBED_MODEL=nomic-embed-text' >> ~/apps/verder/.env.prod"
ssh homelab 'grep -n "^OLLAMA" ~/apps/verder/.env.prod'
```
Expected: `OLLAMA_URL=…`, `OLLAMA_MODEL=…` and a new `OLLAMA_EMBED_MODEL=nomic-embed-text` line.

- [ ] **Step 12 — sync the repo (same exclude list as every prior deploy).**
```bash
cd /Users/martin/Workspace/mp/verder && rsync -a --delete --exclude node_modules --exclude .next --exclude .turbo \
  --exclude vault-files --exclude '.env' --exclude '.env.local' --exclude '.env.prod' \
  --exclude secrets ./ homelab:~/apps/verder/
ssh homelab 'cd ~/apps/verder && pnpm install --frozen-lockfile'
```
If `--frozen-lockfile` fails, a dependency was added without regenerating `pnpm-lock.yaml` on the Mac — fix it there and rsync again; never edit the lockfile on the homelab. Commit nothing on the homelab, ever.

- [ ] **Step 13 — fresh backup FIRST (this step exists solely to make the next one reversible).**
```bash
ssh homelab 'cd ~/apps/verder && set -a && source ./.env.prod && set +a && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U verder verder | gzip > /mnt/nas-download/verder-backups/db-preswap-$(date +%F-%H%M).sql.gz'
ssh homelab 'ls -lh /mnt/nas-download/verder-backups/ | tail -5'
```
This dump is taken by the **old** image, so it contains no `CREATE EXTENSION vector` and restores into either image. It is named `db-preswap-*`, which the `find … -name 'db-*.sql.gz' -mtime +30 -delete` prune in `ops/nightly.sh` also matches, so it is retained for 30 days and then cleaned up like any other dump. Verify it is non-trivially sized before continuing.

- [ ] **Step 14 — the image swap, as its own careful step.**
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml stop web worker && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml ps'
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_isready -U verder -d verder'
```
Web and worker stay stopped: `packages/db/src/client.ts` builds a plain `new pg.Pool` with no retry policy, so they would otherwise sit on dead sockets. Then create the extension as the bootstrap superuser (`POSTGRES_USER: verder`) and confirm:
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U verder -d verder -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "SELECT extname, extversion FROM pg_extension ORDER BY 1;"'
```
Expected: `plpgsql` and `vector` listed. (Migration `0014` also creates it idempotently; doing it here proves the image is right *before* the migration run.)

- [ ] **Step 15 — migrations as the admin role, from the host checkout.**
```bash
ssh homelab 'cd ~/apps/verder && set -a && source ./.env.prod && set +a && \
  DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate'
```
Never from a container.

- [ ] **Step 16 — verify the grants, with the exact expected privilege strings.** This sub-project introduces the project's **first** `DELETE` grants, so check them explicitly rather than trusting the migration. `\dp` prints aclitem strings in the fixed privilege order `arwdDxt` (`a`=INSERT, `r`=SELECT, `w`=UPDATE, `d`=DELETE):
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U verder -d verder -c "\dp document_texts" -c "\dp search_chunks" \
    -c "\dp search_outbox" -c "\dp suggestions" -c "\dp log_entries"'
```
Expected `Access privileges` strings, exactly:
- `document_texts` → `verder_app=r/verder` and `verder_worker=arwd/verder`
- `search_chunks` → `verder_app=r/verder` and `verder_worker=arwd/verder`
- `search_outbox` → `verder_app=r/verder` and `verder_worker=rd/verder` (**no `a`** for either role — rows arrive only through the `SECURITY DEFINER` function owned by `verder`)
- `suggestions` → `verder_app=arw/verder` and `verder_worker=arw/verder` (unchanged; the table-level grant covers the new `retrieved_refs` column)
- `log_entries` → `verder_app=ar/verder` and `verder_worker=ar/verder`

**If `log_entries` shows `w` or `d` for either role, stop and roll back** — an evidence table lost its append-only guarantee. A mismatch on the three index tables means migration `0016` did not apply as written: re-read `packages/db/drizzle/0016_search_grants.sql` and fix it on the Mac, do not patch grants by hand on the homelab.

- [ ] **Step 17 — bring the app back up (worker image rebuilt for `poppler-utils`).**
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker'
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pdftoppm -v'
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml logs --tail=80 worker'
```
Expected: `pdftoppm version …` — the worker Dockerfile's `apt-get` layer is the first in this repo, so a Debian-mirror failure at build time is a genuinely new way for a deploy to break and is checked explicitly — and the logs show the worker up with the `search.drain` queue registered alongside `heartbeat`, `gmail.poll`, `nas.scan`, `registry.mine`. Then confirm the worker sees the embedding model:
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  printenv OLLAMA_EMBED_MODEL'
```
Expected: `nomic-embed-text`. Empty output means Step 11's line was added after the container was created — re-run `up -d web worker`.

- [ ] **Step 18 — chain verification before anything else touches the database.**
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker nightly-verify'
```
Expected: exit 0, chain green. Indexing appends no ledger events, so the head hash must be unchanged from before the swap. If this is red, stop: restore from the `db-preswap-*` dump per the restore procedure and investigate on the Mac.

- [ ] **Step 19 — the nightly model check, now covering both models.**
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker model-check'
```
Expected: two lines — `model-check: qwen3.5:9b → success` and `model-check: nomic-embed-text → success` — and two fresh rows:
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U verder -d verder -c "SELECT status, detail->>'\''model'\'' AS model, ran_at FROM worker_runs WHERE worker = '\''model-check'\'' ORDER BY ran_at DESC LIMIT 2;"'
```

- [ ] **Step 20 — off-peak, resumable backfill.** Run it when nothing else wants the GPU — not while an eval or a Gmail poll burst is running. `reindex` is batched, idempotent by `source_hash` and safe to interrupt: a killed run resumes because already-embedded chunks whose hash is unchanged are skipped.
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker reindex'
```
Realistic expectations, stated up front:
- The corpus is small in absolute terms (prod: ~18 documents, ~50 raw emails, ~6 log entries, plus the registry/task/timeline/party records), so this is minutes, not hours — **unless** OCR kicks in. Scanned PDFs go through `pdftoppm` at 200 DPI plus `tesseract.js`, which is CPU-heavy and slow per page.
- Embedding shares one Ollama with `suggest.entry`, `registry.mine`, `receipts.resolve` and the evals. CLAUDE.md records six aborted eval runs from GPU contention in a single baseline round; the same contention starves and is starved by this backfill. Expect an interrupted run; rerun it rather than trusting a crashed one.
- Do **not** run the evals concurrently with the backfill. Wait for the drain to be empty first.
- To reindex only part of the corpus, pass **flags** — `reindex` parses `--entity=`, `--since=` and `--prune` and throws on unknown arguments. There is no environment-variable form:
  ```bash
  ssh homelab 'cd ~/apps/verder && \
    docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
    pnpm --filter worker reindex -- --entity=document --since=2026-01-01'
  ```

Progress lands in `worker_runs`; watch it:
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U verder -d verder \
    -c "SELECT worker, status, detail, ran_at FROM worker_runs WHERE worker IN ('\''reindex'\'','\''search-drain'\'') ORDER BY ran_at DESC LIMIT 10;" \
    -c "SELECT count(*) AS chunks, count(embedding) AS embedded FROM search_chunks;" \
    -c "SELECT count(*) AS outbox_depth FROM search_outbox;"'
```

- [ ] **Step 21 — verify the live surfaces through the tunnel.** With a session at https://verder.vanderpoel.pro: `/search?q=opzeggen` returns results server-rendered (check with JS disabled too); ⌘K opens the palette and arrow keys move the selection; `/verify` shows the index-health card with a non-zero chunk count, an outbox depth that drains within a minute, zero embedding failures and a recent drain time; `/queue` shows citations on suggestion cards, and a document-request card shows the "You may already have this 📎" panel. Then confirm the freshness loop end-to-end: add a key event on `/timeline`, wait ~60 s, and search for its title — it must be findable without a manual reindex. Then confirm the parent-refresh triggers: approve a document-meta card on `/queue` (which writes `document_status_changes`, never `documents`), wait ~60 s, and search for the new title — it must be findable under the *new* title.

- [ ] **Step 22 — nightly script end-to-end, with the new exclusion.**
```bash
ssh homelab 'cd ~/apps/verder && ./ops/nightly.sh'
ssh homelab 'zcat /mnt/nas-download/verder-backups/db-$(date +%F).sql.gz | grep -c "CREATE TABLE public.search_chunks"'
ssh homelab 'zcat /mnt/nas-download/verder-backups/db-$(date +%F).sql.gz | grep -c "COPY public.search_chunks"'
ssh homelab 'zcat /mnt/nas-download/verder-backups/db-$(date +%F).sql.gz | grep -c "COPY public.document_texts"'
```
Expected: exit 0; the `search_chunks` **table** is present (`1`); its `COPY` data block is **absent** (`0`); `document_texts` data **is** present (`1` — OCR is expensive and deliberately kept). These three greps are the production confirmation of what Step 2 already proved locally; do not skip them.

- [ ] **Step 23 — evals after the drain, three runs each, honest ranges.** Only once the outbox is empty and the backfill has finished:
```bash
ssh homelab 'cd ~/apps/verder && for i in 1 2 3; do \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pnpm --filter worker eval; done'
ssh homelab 'cd ~/apps/verder && for i in 1 2 3; do \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pnpm --filter worker registry-eval; done'
ssh homelab 'cd ~/apps/verder && for i in 1 2 3; do \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pnpm --filter worker task-eval; done'
ssh homelab 'cd ~/apps/verder && for i in 1 2 3; do \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pnpm --filter worker retrieval-eval; done'
```
Aborted runs (120 s Ollama timeout) do not count — rerun them. Record the range across the three *completed* runs of each eval, never the best one. The retrieval eval creates and drops its own `verder_retrieval_eval` database; confirm none survives and that production is untouched:
```bash
ssh homelab 'cd ~/apps/verder && \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U verder -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '\''verder_retrieval_eval'\'';"'
```
Expected: `0`. If the eval's `EVAL_ADMIN_URL` is not set in the container it defaults to `postgres://verder:verder@localhost:5432/postgres`, whose password will not match production — in that case run the retrieval eval from the Mac against the dev postgres (Task 16, Step 5) and record that range instead, noting in CLAUDE.md that it was measured on the Mac. The number is about the retrieval pipeline, not about which host ran it.

- [ ] **Step 24 — update CLAUDE.md on the Mac, commit and push.** Two edits, both appends.

24a — append this sentence to the end of the "Production stack DEPLOYED" bullet (`CLAUDE.md:5`), immediately after `… (migrations 0012–0013, \`/timeline\` + dashboard section).`:

```markdown
Searchable knowledge base (sub-project 4) deployed 2026-08-20 (migrations 0014–0018; postgres image swapped to `pgvector/pgvector:pg17` + `CREATE EXTENSION vector`, worker image gained `poppler-utils` for scanned-PDF OCR, `OLLAMA_EMBED_MODEL=nomic-embed-text` in .env.prod and covered by the nightly model-check; `search.drain` every 60 s; `/search` + ⌘K palette + index health on `/verify`; citations and the "do we already have this?" panel on `/queue`). Nightly dump now excludes `search_chunks` data (`--exclude-table-data=public.search_chunks`) — a restore is only correct if it ends in `pnpm --filter worker reindex` (see docs/deploy.md restore procedure; `reindex` takes FLAGS `--entity= --since= --prune`, there is no env-var form).
```

24b — append this sentence to the end of the "Eval baselines" bullet (`CLAUDE.md:6`). It contains **exactly one blank**, marked `<<<FILL>>>`. Before committing, replace that one token — and nothing else — with the honest summary built from the three completed retrieval-eval runs of Step 23:

```markdown
Retrieval eval `pnpm --filter worker retrieval-eval` prompt rerank-v1 (isolated verder_retrieval_eval database, 40 fixtures, 12 positive + 3 negative samples): <<<FILL>>>.
```
What goes in the blank, in prose so there is no second slot to guess at: write the fast range, then the deep range, then the negatives range, then one sentence on whether deep actually beat fast and which sample types are the known misses. Take the lowest and highest value across the three completed runs for each figure — never the best run. A correctly filled line looks like this (illustrative numbers, do **not** copy them):

> Retrieval eval `pnpm --filter worker retrieval-eval` prompt rerank-v1 (isolated verder_retrieval_eval database, 40 fixtures, 12 positive + 3 negative samples): fast recall@5 9–10/12 (MRR 0.712–0.781), deep recall@5 10–11/12 (MRR 0.804–0.851), negatives 2–3/3 over 3 completed runs. Deep beat fast by one sample on two of three runs; the known misses are the `opzeggen`/`beëindiging` paraphrase pair, which the distractor "Opzeggingsbrief sportschool" outranks, and the third negative, which returns nearest-neighbour chunks rather than an empty set.

If deep did **not** beat fast, say so plainly — a rerank that does not earn its 20 s is a result, not a failure to hide.

```bash
git add -A && git commit -m "docs: sub-project 4 deploy + retrieval eval baseline" \
  -m "pgvector swap, extension, migrations 0014-0018, poppler in the worker image, nomic-embed-text pulled and inside the nightly model-check, search.drain live, backfill drained. Baselines recorded as honest ranges over three completed runs." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```
Report status. Commit nothing on the homelab.
