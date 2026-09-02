# Definitief verwijderen (document purge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Definitief verwijderen` button on `/files/[id]` that destroys a document's vault bytes, extracted text and search chunks, records the destruction as ledgered evidence, and leaves `/verify` green and honest.

**Architecture:** The `documents` row survives as a tombstone — it is the anchor of the un-removable `document.ingested` ledger event. What is destroyed is everything carrying the document's *content*. One `document_purges` row plus one `document.purged` ledger event record the act; `/verify` verifies a purged document against that record instead of against bytes that are gone on purpose. Every ledgered citation (`entry_documents`, `debt_documents`, `registry_decisions`, `stops`, `tasks`) is left untouched, so no other event's payload changes.

**Tech Stack:** TypeScript, Next.js 15 (App Router, RSC), tRPC v11, drizzle-orm, PostgreSQL 17 (pgvector), vitest, pnpm 10, Node 22.

**Spec:** `docs/superpowers/specs/2026-09-02-document-purge-design.md` — read it before Task 1. It carries the three findings that rule out a plain DELETE and the reasoning behind every decision below.

## Global Constraints

- **Run every build and test with `env -u NODE_ENV`.** The shell exports `NODE_ENV=development`, which breaks `next build`.
- **The app is Dutch.** Every label, notice and button in `apps/web` is Dutch. Code comments, commit messages and this plan are English.
- **Evidence tables are append-only.** `document_purges` gets `SELECT, INSERT` and nothing else. No task in this plan may grant `UPDATE` or `DELETE` on `documents`, `document_status_changes`, `entry_documents`, `ledger_events`, or any other evidence table.
- **The only grant widening permitted by this plan** is `GRANT DELETE ON document_texts, search_chunks TO verder_app`. Both are derived, rebuildable, non-evidence tables on which `verder_worker` already holds `DELETE`.
- **Migration number is 0034.** The last applied migration is `0033_sender_backfill`.
- **Dev database:** `docker compose up -d postgres`. Admin URL `postgres://verder:verder@localhost:5432/verder`, app role `postgres://verder_app:verder_app@localhost:5432/verder`, worker role `postgres://verder_worker:verder_worker@localhost:5432/verder`.
- **Never `TRUNCATE` outside `verify.test.ts`'s existing guarded block.** Other test files clean up by appending, because no test role holds a `DELETE` grant on evidence.
- **Worker tests need poppler:** `brew install poppler`.
- **`documents.sha256` is `UNIQUE` and `ingestDocument` dedups on it.** A purge is therefore irreversible: those bytes can never re-enter the vault. This is intended and must not be "fixed".

---

### Task 1: Migration 0034 — the `document_purges` table and its grants

**Files:**
- Create: `packages/db/drizzle/0034_document_purge.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append one entry)
- Modify: `packages/db/src/schema.ts` (add `documentPurges` after `documentStatusChanges`, ~line 105)
- Modify: `packages/api/src/effective-status.ts` (add `purgedSql` and `notPurgedSql` after `notDiscardedSql`, line 25)
- Test: `packages/db/src/purge-grants.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `schema.documentPurges` — drizzle table with columns `id: string`, `documentId: string`, `sha256: string`, `sizeBytes: number`, `reason: string | null`, `createdBy: string`, `createdAt: Date`.
  - `purgedSql: SQL` and `notPurgedSql: SQL` from `packages/api/src/effective-status.ts`. Both assume the query selects `FROM documents` unaliased, exactly like `effectiveDocStatusSql`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/purge-grants.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";

// Both application roles, because both must obey the same law: document_purges
// is EVIDENCE. INSERT records a purge; UPDATE would rewrite one and DELETE
// would launder one, and neither may be possible through an app connection.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const RUN_REF = `purge-grants-test-${crypto.randomUUID()}`;

describe("document_purges grants", () => {
  let db: Db; let close: () => Promise<void>;
  let documentId: string; let userId: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    db = c.db;
    close = () => c.pool.end();
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [d] = await db.insert(schema.documents).values({
      sha256: "a".repeat(63) + "1", title: "Purge grant fixture", mime: "text/plain",
      sizeBytes: 12, source: "upload", sourceRef: RUN_REF, receivedAt: new Date(),
    }).returning();
    documentId = d.id;
  });
  afterAll(() => close());

  it("lets the app role INSERT a purge", async () => {
    const [row] = await db.insert(schema.documentPurges).values({
      documentId, sha256: "a".repeat(63) + "1", sizeBytes: 12,
      reason: "verkeerd gescand", createdBy: userId,
    }).returning();
    expect(row.documentId).toBe(documentId);
    expect(row.reason).toBe("verkeerd gescand");
  });

  it("refuses a second purge of the same document", async () => {
    await expect(db.insert(schema.documentPurges).values({
      documentId, sha256: "a".repeat(63) + "1", sizeBytes: 12, createdBy: userId,
    })).rejects.toThrow();
  });

  // The append-only law, spelled as the grants enforce it. A purge that can be
  // edited is not evidence, and a purge that can be deleted is a way to make a
  // document's bytes vanish with no record of who did it.
  it("refuses UPDATE and DELETE through the app role", async () => {
    await expect(db.execute(
      sql`UPDATE document_purges SET reason = 'rewritten' WHERE document_id = ${documentId}`
    )).rejects.toThrow(/permission denied/i);
    await expect(db.execute(
      sql`DELETE FROM document_purges WHERE document_id = ${documentId}`
    )).rejects.toThrow(/permission denied/i);
  });

  // The one widening this whole sub-project permits: both tables are DERIVED
  // and rebuildable by `reindex`, and verder_worker already holds DELETE here.
  // Without it a purge leaves the document's full OCR'd text in the database.
  it("lets the app role DELETE from document_texts and search_chunks", async () => {
    await expect(db.execute(
      sql`DELETE FROM document_texts WHERE document_id = ${documentId}`)).resolves.toBeDefined();
    await expect(db.execute(
      sql`DELETE FROM search_chunks WHERE entity_type = 'document' AND entity_id = ${documentId}`
    )).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter @verder/db test src/purge-grants.test.ts
```

Expected: FAIL — `schema.documentPurges` does not exist (TypeScript/runtime error).

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/0034_document_purge.sql`:

```sql
-- Definitief verwijderen (sub-project 11): a document's CONTENT can be
-- destroyed; its RECORD cannot.
--
-- Additive. Nothing is dropped, and no grant on an evidence table is weakened.
--
-- WHY THE `documents` ROW SURVIVES. /verify re-derives every document.ingested
-- event from the live row and the live vault bytes (verification.ts), and that
-- event can never leave the hash chain. Deleting the row leaves one
-- permanently failing seq, reported by nightly-verify every night forever.
-- Worse, a document cited by a logbook entry appears in that entry's ledgered
-- payload via entryEventPayload.documentIds, so removing the link rewrites the
-- ENTRY's recomputed hash and reads as tampering with the logbook. Keeping the
-- row and destroying the content leaves every ledgered citation intact.

-- EVIDENCE: SELECT, INSERT and nothing else. A purge that can be edited is not
-- a record, and a purge that can be deleted is a way to make bytes vanish
-- untraceably.
CREATE TABLE "document_purges" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- UNIQUE: a document is purged once. A second purge is a no-op in the
  -- router, not an error — the same law documents.update follows for a
  -- repeated discard, and for the same reason: one decision must not appear
  -- in the record twice.
  "document_id" uuid NOT NULL UNIQUE REFERENCES "documents"("id"),
  -- Copied, not read back off `documents`. This is the record of WHAT WAS
  -- DESTROYED, and it must not depend on another table still agreeing.
  "sha256"      text NOT NULL,
  "size_bytes"  bigint NOT NULL,
  -- Nullable: the button offers the field and does not demand it.
  "reason"      text,
  "created_by"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

GRANT SELECT, INSERT ON "document_purges" TO verder_app, verder_worker;
--> statement-breakpoint

-- THE ONE GRANT WIDENING, and the reason it is lawful. verder_app holds SELECT
-- only on these two (0016, deliberately: "the web app searches the index and
-- never maintains it"). Without DELETE, a purge leaves the document's full
-- OCR'd text in the database and in search, and the button is a lie. Both
-- tables are DERIVED and documented as non-evidence — "they hold no facts:
-- only a rebuildable lookup" — and verder_worker already holds DELETE on them.
-- Widening the app's grant on two rebuildable tables is not the same act as
-- widening it on `documents`.
GRANT DELETE ON "document_texts", "search_chunks" TO verder_app;
```

- [ ] **Step 4: Append the journal entry**

In `packages/db/drizzle/meta/_journal.json`, add after the `0033_sender_backfill` object (keep the trailing `]` and `}`):

```json
    {
      "idx": 34,
      "version": "7",
      "when": 1788361200000,
      "tag": "0034_document_purge",
      "breakpoints": true
    }
```

Note 0033 has no snapshot file either — these are hand-written migrations with hand-appended journal entries. Do not run `drizzle-kit generate`.

- [ ] **Step 5: Add the drizzle table**

In `packages/db/src/schema.ts`, immediately after the `documentStatusChanges` table (before `entryDocuments`):

```ts
/**
 * A destroyed document's obituary. EVIDENCE: SELECT, INSERT only.
 *
 * The `documents` row it points at SURVIVES — it anchors the document.ingested
 * event, which can never leave the hash chain. What a purge destroys is the
 * content: the vault file, the extracted text and the search chunks. Every
 * ledgered citation (entry_documents, debt_documents, registry_decisions,
 * stops, tasks) is deliberately left intact, so no other event's payload
 * changes.
 *
 * NOT a fourth doc_status. A `purged` value appended through
 * document_status_changes would need either its own document.updated event
 * (two events for one action) or a status row with no event — and an unmatched
 * row is exactly what resolveDocumentUpdatedHashes consumes when it looks for
 * one, so a stray row could later vouch for an event it has nothing to do with.
 */
export const documentPurges = pgTable("document_purges", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().unique().references(() => documents.id),
  // Copied rather than joined: the record of what was destroyed must not
  // depend on another table still saying the same thing.
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 6: Add the SQL fragments**

In `packages/api/src/effective-status.ts`, after `notDiscardedSql` (line 25):

```ts
/**
 * Whether a document's content has been destroyed.
 *
 * A purge is a row in its own table rather than a status, so it needs its own
 * predicate — and it needs one everywhere `notDiscardedSql` is used, because a
 * purged document is gone in a stronger sense than a discarded one: its bytes,
 * its extracted text and its chunks no longer exist. Like every expression in
 * this file it assumes the query selects FROM documents, unaliased.
 */
export const purgedSql: SQL = sql`EXISTS (
  SELECT 1 FROM document_purges p WHERE p.document_id = documents.id)`;

export const notPurgedSql: SQL = sql`NOT ${purgedSql}`;
```

- [ ] **Step 7: Apply the migration and run the test**

```bash
docker compose up -d postgres
env -u NODE_ENV pnpm --filter @verder/db migrate
env -u NODE_ENV pnpm --filter @verder/db test src/purge-grants.test.ts
```

Expected: PASS, all four tests.

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/0034_document_purge.sql packages/db/drizzle/meta/_journal.json \
  packages/db/src/schema.ts packages/db/src/purge-grants.test.ts packages/api/src/effective-status.ts
git commit -m "feat(db): document_purges, the record a destroyed document leaves behind

Migration 0034. Evidence table: SELECT, INSERT, UNIQUE per document. The one
grant widening is DELETE on document_texts and search_chunks for verder_app —
both derived and rebuildable, both already DELETE-able by verder_worker —
without which a purge leaves the document's full OCR'd text in the database."
```

---

### Task 2: `documents.purge` — the mutation

**Files:**
- Modify: `packages/api/src/routers/documents.ts` (`effectiveDocument` ~line 35-81; add `purge` mutation after `update`, ~line 437)
- Test: `packages/api/src/routers/documents-purge.test.ts` (create)

**Interfaces:**
- Consumes: `schema.documentPurges` (Task 1), `appendLedgerEvent` from `../ledger`, `readFilePath` from `../storage`.
- Produces:
  - `effectiveDocument(db, id)` gains `purge: { at: Date; reason: string | null; sha256: string; sizeBytes: number; bytesStillOnDisk: boolean } | null`.
  - `documents.purge({ id: string, reason?: string })` → the same shape `effectiveDocument` returns.
  - Exported `documentPurgePayload(p: { documentId: string; sha256: string; sizeBytes: number; reason: string | null })` → the canonical ledger payload, so Task 3 can recompute it.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routers/documents-purge.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor, readFilePath } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const RUN_REF = `documents-purge-test-${crypto.randomUUID()}`;

const exists = (p: string) => access(p).then(() => true, () => false);

describe("documents.purge", () => {
  let db: Db; let close: () => Promise<void>; let userId: string; let vaultDir: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    db = c.db;
    close = () => c.pool.end();
    vaultDir = mkdtempSync(join(tmpdir(), "vault-purge-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  /** A document whose bytes really are on disk, plus an extracted-text row and
   *  a search chunk — the three things a purge has to destroy. */
  async function makeDoc(label: string) {
    const c = caller();
    const buf = Buffer.from(`${label}-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({
      sha256: sha, sizeBytes: buf.length, mime: "text/plain", title: label,
      source: "upload", sourceRef: RUN_REF, receivedAt: new Date() });
    await db.execute(sql`INSERT INTO document_texts
      (document_id, sha256, text, extractor, char_count)
      VALUES (${doc.id}, ${sha}, ${'geheime inhoud'}, 'none', 14)`);
    await db.execute(sql`INSERT INTO search_chunks
      (entity_type, entity_id, chunk_index, title, body, source_hash)
      VALUES ('document', ${doc.id}, 0, ${label}, ${'geheime inhoud'}, 'h')`);
    return { doc, sha, abs };
  }

  it("destroys the bytes, the text and the chunks, and records one purge", async () => {
    const c = caller();
    const { doc, sha, abs } = await makeDoc("Te vernietigen");
    const before = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.ledgerEvents);

    const res = await c.documents.purge({ id: doc.id, reason: "per ongeluk gescand" });

    expect(res.purge).toMatchObject({ sha256: sha, reason: "per ongeluk gescand" });
    expect(await exists(abs)).toBe(false);
    const texts = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(texts).toHaveLength(0);
    const chunks = await db.select().from(schema.searchChunks)
      .where(and(eq(schema.searchChunks.entityType, "document"),
        eq(schema.searchChunks.entityId, doc.id)));
    expect(chunks).toHaveLength(0);

    // Exactly ONE event. A purge is one decision.
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    expect(after[0].n - before[0].n).toBe(1);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.eventType, "document.purged"),
        eq(schema.ledgerEvents.entityId, doc.id)));
    expect(ev).toBeTruthy();
  });

  // The documents row is the ledger's anchor and must survive. Its title and
  // sha256 are what the tombstone shows.
  it("keeps the documents row", async () => {
    const c = caller();
    const { doc } = await makeDoc("Rij blijft");
    await c.documents.purge({ id: doc.id });
    const got = await c.documents.get({ id: doc.id });
    expect(got.id).toBe(doc.id);
    expect(got.effectiveTitle).toBe("Rij blijft");
    expect(got.purge).not.toBeNull();
  });

  // One decision, one row, one event — the law documents.update already
  // follows for a repeated discard. The UNIQUE constraint would otherwise
  // turn a double click into a 500.
  it("is a no-op the second time", async () => {
    const c = caller();
    const { doc } = await makeDoc("Twee keer");
    const first = await c.documents.purge({ id: doc.id, reason: "eerste" });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    const second = await c.documents.purge({ id: doc.id, reason: "tweede" });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    expect(after[0].n).toBe(before[0].n);
    // The FIRST reason stands. A second call must not rewrite the record.
    expect(second.purge?.reason).toBe("eerste");
    expect(second.purge?.at).toEqual(first.purge?.at);
  });

  // The unlink runs AFTER the commit, so its failure leaves a purge record
  // whose bytes are still on disk. That state must be visible, or it is
  // silent and permanent.
  it("reports bytes still on disk, and a repeat purge clears them", async () => {
    const c = caller();
    const { doc, sha } = await makeDoc("Achtergebleven bytes");
    await c.documents.purge({ id: doc.id });
    // Simulate the failed unlink by putting the file back.
    const abs = readFilePath(vaultDir, sha);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from("resurrected"));
    const stale = await c.documents.get({ id: doc.id });
    expect(stale.purge?.bytesStillOnDisk).toBe(true);
    const retried = await c.documents.purge({ id: doc.id });
    expect(retried.purge?.bytesStillOnDisk).toBe(false);
    expect(await exists(abs)).toBe(false);
  });

  it("reports purge: null for a document nobody purged", async () => {
    const c = caller();
    const { doc } = await makeDoc("Nog springlevend");
    const got = await c.documents.get({ id: doc.id });
    expect(got.purge).toBeNull();
  });

  it("is NOT_FOUND for an unknown document", async () => {
    const c = caller();
    await expect(c.documents.purge({ id: crypto.randomUUID() })).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/documents-purge.test.ts
```

Expected: FAIL — `documents.purge` is not a function / `purge` is not a property of the result.

- [ ] **Step 3: Teach `effectiveDocument` about the tombstone**

In `packages/api/src/routers/documents.ts`, add to the imports at the top:

```ts
import { access, readFile, unlink } from "node:fs/promises";
```

(replacing the existing `import { readFile } from "node:fs/promises";`), and add `notPurgedSql, purgedSql` to the existing import from `../effective-status`.

Then inside `effectiveDocument`, after the `changes` query and before the `newest` helper, add:

```ts
  const [purged] = await db.select().from(schema.documentPurges)
    .where(eq(schema.documentPurges.documentId, id));
```

and add to the returned object, after `previousStatus`:

```ts
    /**
     * The tombstone, or null. `bytesStillOnDisk` is a live `access` check, not
     * a stored flag: the unlink runs after the transaction commits (see the
     * purge mutation), so a crash or an EACCES between the two leaves a purge
     * record whose bytes are still there. Storing "we deleted it" would record
     * an intention as a fact; asking the filesystem records what is true.
     */
    purge: purged ? {
      at: purged.createdAt, reason: purged.reason,
      sha256: purged.sha256, sizeBytes: purged.sizeBytes,
      bytesStillOnDisk: await access(
        readFilePath(process.env.VAULT_DIR ?? "./vault-files", purged.sha256),
      ).then(() => true, () => false),
    } : null };
```

Remember to move the closing `};` — the object now ends with `purge`.

- [ ] **Step 4: Add the payload helper and the mutation**

In `packages/api/src/routers/documents.ts`, above `documentsRouter`:

```ts
/**
 * The canonical payload a document.purged event carries. Exported because
 * verification.ts recomputes it from the live document_purges row — editing a
 * stored reason must surface as a payload_hash_mismatch, the same discipline
 * registryDecisionPayload and taskStatusPayload already follow.
 */
export function documentPurgePayload(p: {
  documentId: string; sha256: string; sizeBytes: number; reason: string | null;
}) {
  return { id: p.documentId, sha256: p.sha256, sizeBytes: p.sizeBytes,
    reason: p.reason };
}
```

And after the `update` mutation, before `linkToEntry`:

```ts
  /**
   * Definitief verwijderen: destroy a document's CONTENT and record that we did.
   *
   * What is destroyed: the vault file, the extracted text, the search chunks.
   * What survives: the `documents` row (it anchors the document.ingested event,
   * which can never leave the hash chain) and every ledgered citation —
   * entry_documents, debt_documents, registry_decisions, stops, tasks. Removing
   * an entry_documents row would change that ENTRY's recomputed payload hash,
   * because entryEventPayload carries documentIds, and read as tampering with
   * the logbook.
   *
   * Irreversible, and doubly so: documents.sha256 is UNIQUE and ingestDocument
   * dedups on it, so those bytes can never re-enter the vault. That is the rule
   * discard already carries ("a discarded document stays discarded for those
   * bytes forever"), applied to a stronger action.
   */
  purge: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().trim().min(1).optional(),
  })).mutation(async ({ ctx, input }) => {
    const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
    const sha = await ctx.db.transaction(async (tx) => {
      // The same per-document serialisation `update` uses: two clicks landing
      // together would otherwise both find no purge row and both insert, and
      // the UNIQUE constraint would turn the loser into a 500.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.id}::text, 0))`);
      const [doc] = await tx.select().from(schema.documents)
        .where(eq(schema.documents.id, input.id));
      if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      const [already] = await tx.select().from(schema.documentPurges)
        .where(eq(schema.documentPurges.documentId, input.id));
      // A no-op, not an error: one decision must not appear in the record
      // twice, and the button is one click Martin can land twice. The FIRST
      // reason stands — a second call may not rewrite the record. It still
      // falls through to the unlink below, which is the repair path for a
      // purge whose bytes survived the first attempt.
      if (already) return already.sha256;
      await tx.insert(schema.documentPurges).values({
        documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes,
        reason: input.reason ?? null, createdBy: ctx.userId });
      await appendLedgerEvent(tx, {
        eventType: "document.purged", entityType: "document", entityId: doc.id,
        payload: documentPurgePayload({ documentId: doc.id, sha256: doc.sha256,
          sizeBytes: doc.sizeBytes, reason: input.reason ?? null }) });
      // The derived layer, destroyed in the same transaction as the record.
      // These are the two tables that hold the document's CONTENT outside the
      // vault: without this the button is a lie, and `reindex` would rebuild
      // the chunk from the text on its next run.
      await tx.delete(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, doc.id));
      await tx.delete(schema.searchChunks)
        .where(and(eq(schema.searchChunks.entityType, "document"),
          eq(schema.searchChunks.entityId, doc.id)));
      return doc.sha256;
    });
    /*
     * THE UNLINK IS AFTER THE COMMIT AND THAT ORDERING IS NOT INTERCHANGEABLE.
     * unlink is not transactional. Inside the transaction, a rollback after a
     * successful unlink destroys the bytes with NO RECORD of it — permanently
     * red on /verify with nothing explaining why, which is the one outcome
     * this whole design exists to prevent. After the commit, the failure mode
     * is the harmless one: a purge record whose bytes are still on disk, which
     * effectiveDocument reports as bytesStillOnDisk, /verify counts, and a
     * second click repairs.
     *
     * ENOENT is success, not an error: the file is gone, which is the goal.
     */
    await unlink(readFilePath(vaultDir, sha)).catch(() => {});
    return effectiveDocument(ctx.db, input.id);
  }),
```

- [ ] **Step 5: Run the test**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/documents-purge.test.ts
```

Expected: PASS, all six tests.

- [ ] **Step 6: Run the neighbouring suites for regressions**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/documents.test.ts src/routers/documents-browse.test.ts
```

Expected: PASS. `effectiveDocument` gained a field; nothing should read it yet.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routers/documents.ts packages/api/src/routers/documents-purge.test.ts
git commit -m "feat(api): documents.purge destroys a document's content and records it

One document_purges row and one document.purged event, then the vault file is
unlinked AFTER the commit — a rollback following a successful unlink would
destroy bytes with no record, which is worse than not deleting. The surviving
failure mode is a purge whose bytes are still on disk; effectiveDocument
reports it and a second click repairs it."
```

---

### Task 3: `/verify` learns what a purge is

**Files:**
- Modify: `packages/api/src/verification.ts` (`FullVerificationResult` line 10-13, `LedgerRecomputeContext` line 155-160, `runFullVerification` line 168-203, `makeLedgerRecompute`'s `document.ingested` branch line 258-266)
- Modify: `apps/web/src/components/verify-panel.tsx:44`
- Modify: `apps/worker/src/ops/verify-nightly.ts:19`
- Test: `packages/api/src/routers/verify.test.ts` (append cases)

**Interfaces:**
- Consumes: `schema.documentPurges` (Task 1), `documentPurgePayload` from `./routers/documents` (Task 2).
- Produces: `FullVerificationResult` gains `purgedFiles: number` and `purgedFilesOnDisk: number`. `LedgerRecomputeContext` gains `onFilePurged?: (stillOnDisk: boolean) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/src/routers/verify.test.ts`, inside the existing `describe("verify router", …)`:

```ts
  /** A document with bytes on disk, ready to be purged. */
  async function mkVaultDoc(label: string) {
    const c = caller();
    const buf = Buffer.from(`${label}-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: label, source: "upload", receivedAt: new Date() });
  }

  it("stays green after a purge, and counts it instead of hashing it", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge and verify");
    const before = await c.verify.run();
    expect(before.ok).toBe(true);
    await c.documents.purge({ id: doc.id, reason: "dubbel gescand" });
    const after = await c.verify.run();
    expect(after.ok).toBe(true);
    // The file is no longer hashed, and the deletion is DISCLOSED rather than
    // silently absorbed. A design where files vanish without /verify saying so
    // is the hole this whole sub-project avoids.
    expect(after.checkedFiles).toBe(before.checkedFiles - 1);
    expect(after.purgedFiles).toBe(before.purgedFiles + 1);
    expect(after.purgedFilesOnDisk).toBe(0);
  });

  it("counts a purge whose bytes survived the unlink", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge that left bytes");
    await c.documents.purge({ id: doc.id });
    const fresh = await c.documents.get({ id: doc.id });
    const abs = join(vaultDir, relPathFor(fresh.sha256));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from("leftover"));
    const res = await c.verify.run();
    expect(res.ok).toBe(true);
    expect(res.purgedFilesOnDisk).toBeGreaterThan(0);
  });

  // The whole reason this shape was chosen over deleting the row: an entry's
  // ledgered payload carries documentIds, and entry_documents is untouched.
  it("stays green when the purged document is cited by a logbook entry", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Cited then purged");
    await c.entries.create({ occurredAt: new Date(), channel: "email",
      direction: "inbound", summary: "Entry citing a document that gets purged",
      participantPartyIds: [], documentIds: [doc.id], actionItems: [] });
    expect((await c.verify.run()).ok).toBe(true);
    await c.documents.purge({ id: doc.id });
    const res = await c.verify.run();
    expect(res).toMatchObject({ ok: true });
  });

  it("detects an edited purge reason", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge to be tampered");
    await c.documents.purge({ id: doc.id, reason: "de echte reden" });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE document_purges SET reason = 'herschreven'
        WHERE document_id = ${doc.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      await admin.db.execute(sql`UPDATE document_purges SET reason = 'de echte reden'
        WHERE document_id = ${doc.id}`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  // A purge cannot be laundered by removing its record: without the purge row
  // the ingested branch falls through to the file read and reports the bytes
  // missing, exactly as it does for any other vanished file.
  it("detects a purge record deleted to hide a destroyed file", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge record to be deleted");
    await c.documents.purge({ id: doc.id });
    const admin = createDb(ADMIN_URL);
    try {
      const [row] = (await admin.db.execute(
        sql`SELECT sha256, size_bytes, reason FROM document_purges
            WHERE document_id = ${doc.id}`)).rows as
        { sha256: string; size_bytes: string; reason: string | null }[];
      await admin.db.execute(sql`DELETE FROM document_purges WHERE document_id = ${doc.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      // Restore, so the rest of this file's chain stays green.
      await admin.db.execute(sql`INSERT INTO document_purges
        (document_id, sha256, size_bytes, reason, created_by)
        VALUES (${doc.id}, ${row.sha256}, ${row.size_bytes}, ${row.reason}, ${userId})`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/verify.test.ts
```

Expected: FAIL — `purgedFiles` is `undefined`, and the tamper cases report `ok: true` because nothing recomputes `document.purged`.

- [ ] **Step 3: Widen the result type and the context**

In `packages/api/src/verification.ts`, change the result type (line 10-13) to:

```ts
export type FullVerificationResult = VerifyResult & {
  headHash: string | null;
  checkedFiles: number;
  /**
   * Documents whose bytes were destroyed on purpose. Counted SEPARATELY from
   * checkedFiles — a purged document is not a file that was checked — and
   * surfaced on /verify, because a design where files can vanish without the
   * verification page saying so is exactly the hole this avoids.
   */
  purgedFiles: number;
  /**
   * Of those, how many still have bytes on disk. The unlink runs after the
   * purge transaction commits, so this is normally 0 and a non-zero value means
   * an unlink failed — repairable by purging the document again.
   */
  purgedFilesOnDisk: number;
};
```

And add to `LedgerRecomputeContext`:

```ts
  onFilePurged?: (stillOnDisk: boolean) => void;
```

- [ ] **Step 4: Add the recompute helper**

In `packages/api/src/verification.ts`, beside `registryDecisionPayloadHash`:

```ts
/**
 * Recomputes the payload hash of a document.purged event from the live
 * document_purges row — editing a stored reason surfaces as a
 * payload_hash_mismatch at that event's seq. The same discipline
 * registryDecisionPayloadHash and taskStatusPayloadHash follow.
 */
export async function documentPurgePayloadHash(db: Db, documentId: string): Promise<string> {
  const [p] = await db.select().from(schema.documentPurges)
    .where(eq(schema.documentPurges.documentId, documentId));
  if (!p) return "missing-purge-row".padEnd(64, "0");
  return sha256Hex(canonicalJson(documentPurgePayload({
    documentId: p.documentId, sha256: p.sha256, sizeBytes: p.sizeBytes,
    reason: p.reason })));
}
```

Add `documentPurgePayload` to the existing import from `./routers/documents`, and `access` to the `node:fs/promises` import.

- [ ] **Step 5: Wire the two branches**

In `makeLedgerRecompute`, add beside the other event-type branches (before the `document.ingested` check):

```ts
    if (e.eventType === "document.purged")
      return documentPurgePayloadHash(db, e.entityId);
```

and replace the `document.ingested` tail with:

```ts
    if (e.eventType !== "document.ingested") return e.payloadHash;
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, e.entityId));
    if (!doc) return "missing-document-row".padEnd(64, "0");
    const [purged] = await db.select().from(schema.documentPurges)
      .where(eq(schema.documentPurges.documentId, e.entityId));
    if (purged) {
      /*
       * The bytes are gone ON PURPOSE and the document.purged event is the
       * record of it. Verify against that record instead: the sha256 the purge
       * names must still be the sha256 the ingest recorded, or the tombstone is
       * describing a different document than the one it is attached to.
       *
       * Deleting the purge row does NOT launder the deletion: this branch is
       * simply not taken, and the file read below reports file-missing exactly
       * as it does for any other vanished file.
       */
      ctx.onFilePurged?.(await access(readFilePath(vaultDir, purged.sha256))
        .then(() => true, () => false));
      return purged.sha256 === doc.sha256
        ? e.payloadHash : "purge-sha-mismatch".padEnd(64, "0");
    }
    try {
      const buf = await readFile(readFilePath(vaultDir, doc.sha256));
      ctx.onFileChecked?.();
      return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
    } catch { return "file-missing".padEnd(64, "0"); }
```

- [ ] **Step 6: Count them in `runFullVerification`**

In `runFullVerification`, beside `let checkedFiles = 0;`:

```ts
  let purgedFiles = 0;
  let purgedFilesOnDisk = 0;
```

change the `makeLedgerRecompute` call's context to add:

```ts
    onFilePurged: (stillOnDisk) => { purgedFiles++; if (stillOnDisk) purgedFilesOnDisk++; },
```

and the return to:

```ts
  return { ...res, headHash: rows.at(-1)?.eventHash ?? null,
    checkedFiles, purgedFiles, purgedFilesOnDisk };
```

- [ ] **Step 7: Run the tests**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/verify.test.ts
```

Expected: PASS, including the pre-existing cases.

- [ ] **Step 8: Show it on both surfaces**

In `apps/web/src/components/verify-panel.tsx:44`, extend the success line so the purges are disclosed (Dutch, and only when there are any — a zero adds noise to the normal case):

```tsx
                  ✔ Alles klopt. <span className="font-mono">{run.data.count}</span> gebeurtenissen gecontroleerd, <span className="font-mono">{run.data.checkedFiles}</span> bestanden opnieuw gehasht{run.data.purgedFiles > 0 && <>, <span className="font-mono">{run.data.purgedFiles}</span> definitief verwijderd</>}.
                  {run.data.purgedFilesOnDisk > 0 && <> <span className="text-attn">{run.data.purgedFilesOnDisk} daarvan staan nog op schijf — verwijder ze opnieuw.</span></>}
```

In `apps/worker/src/ops/verify-nightly.ts:19`:

```ts
    console.log(`nightly-verify: OK — ${result.count} events, ${result.checkedFiles} files checked, ${result.purgedFiles} purged (${result.purgedFilesOnDisk} still on disk), head=${result.headHash}`);
```

- [ ] **Step 9: Typecheck and commit**

```bash
env -u NODE_ENV pnpm --filter @verder/api typecheck
env -u NODE_ENV pnpm --filter worker typecheck
env -u NODE_ENV pnpm --filter web typecheck
git add packages/api/src/verification.ts packages/api/src/routers/verify.test.ts \
  apps/web/src/components/verify-panel.tsx apps/worker/src/ops/verify-nightly.ts
git commit -m "feat(verify): a purged document verifies against its record, not its bytes

document.ingested checks for a purge before reading the file, and
document.purged is recomputed from the live row so an edited reason surfaces as
a payload_hash_mismatch. purgedFiles and purgedFilesOnDisk are counted apart
from checkedFiles and shown on /verify and in the nightly log — a design where
files vanish without the verification page saying so is the hole this avoids."
```

---

### Task 4: `indexEntity` — a purged document cannot be resurrected by `reindex`

**Files:**
- Modify: `packages/api/src/search/index-entity.ts` (`renderRow`'s `document` case, lines 80-104)
- Test: `packages/api/src/search/index-entity-purge.test.ts` (create)

**Interfaces:**
- Consumes: `schema.documentPurges` (Task 1).
- Produces: nothing new. `renderRow` returns `null` for a purged document, which `loadAndRender` already turns into `[]` — the existing "row is gone" path.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/search/index-entity-purge.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";
import { indexEntity } from "./index-entity";

// The WORKER role: indexEntity runs on the worker connection in production,
// and search_chunks is the worker's table (0016).
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const RUN_REF = `index-entity-purge-test-${crypto.randomUUID()}`;

describe("indexEntity on a purged document", () => {
  let app: Db; let worker: Db; let closers: (() => Promise<void>)[] = [];
  let userId: string; let vaultDir: string;

  beforeAll(async () => {
    const a = createDb(APP_URL); const w = createDb(WORKER_URL);
    app = a.db; worker = w.db;
    closers = [() => a.pool.end(), () => w.pool.end()];
    vaultDir = mkdtempSync(join(tmpdir(), "vault-index-purge-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await app.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(async () => { for (const c of closers) await c(); });

  const chunks = (id: string) => worker.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "document"),
      eq(schema.searchChunks.entityId, id)));

  /**
   * THE TRAP THIS TEST EXISTS FOR: `reindex` walks every document and calls
   * indexEntity, which rebuilds a chunk from title and metadata alone — the
   * extracted text is optional. So without a purge check, the nightly reindex
   * puts a definitief verwijderd document back into /search under its own name,
   * days after it was destroyed.
   */
  it("leaves zero chunks, and creates none on a second pass", async () => {
    const c = appRouter.createCaller(createContext({ db: app, userId }));
    const buf = Buffer.from(`resurrect-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verdwijnt uit zoeken", source: "upload",
      sourceRef: RUN_REF, receivedAt: new Date() });

    await indexEntity(worker, "document", doc.id);
    expect((await chunks(doc.id)).length).toBeGreaterThan(0);

    await c.documents.purge({ id: doc.id, reason: "hoort hier niet" });
    expect(await chunks(doc.id)).toHaveLength(0);

    // The reindex pass. This is the one that used to bring it back.
    await indexEntity(worker, "document", doc.id);
    expect(await chunks(doc.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity-purge.test.ts
```

Expected: FAIL on the last assertion — the reindex pass recreates a chunk (`expected length 1 to be 0`).

- [ ] **Step 3: Add the purge check**

In `packages/api/src/search/index-entity.ts`, inside `renderRow`'s `case "document":`, immediately after the existing existence check:

```ts
      const [row] = await db.select({ id: schema.documents.id }).from(schema.documents)
        .where(eq(schema.documents.id, entityId));
      if (!row) return null;
      /*
       * A purged document is gone from search in the strongest sense the app
       * has: its bytes, its extracted text and its chunks were destroyed on
       * purpose. Returning null here makes loadAndRender delete whatever chunks
       * exist and write none — the same path a deleted row takes.
       *
       * WITHOUT THIS, `reindex` resurrects it. indexEntity rebuilds a chunk
       * from title and metadata alone (the extracted text is optional, see
       * below), so the nightly walk would put a definitief verwijderd document
       * back into /search under its own name days after it was destroyed.
       */
      const [purged] = await db.select({ id: schema.documentPurges.id })
        .from(schema.documentPurges)
        .where(eq(schema.documentPurges.documentId, entityId));
      if (purged) return null;
```

- [ ] **Step 4: Run the test**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search/index-entity-purge.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the search suites for regressions**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/search src/routers/search.test.ts src/routers/search-recent.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/search/index-entity.ts packages/api/src/search/index-entity-purge.test.ts
git commit -m "fix(search): reindex must not resurrect a purged document

indexEntity rebuilds a document chunk from title and metadata alone, so without
a purge check the nightly reindex puts a destroyed document back into /search
under its own name."
```

---

### Task 5: `pendingDocMeta` — the sweep must not chase a file that no longer exists

**Files:**
- Modify: `apps/worker/src/docmeta-sweep.ts` (`pendingDocMeta`, lines 29-40)
- Test: `apps/worker/src/docmeta-sweep.test.ts` (append one case)

**Interfaces:**
- Consumes: `notPurgedSql` from `@verder/api/src/effective-status` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/docmeta-sweep.test.ts`, inside the existing `describe` that tests `pendingDocMeta` (follow the file's `RUN_REF` and `settleDocumentTexts` conventions — register the fixture with `sourceRef: RUN_REF` so `afterAll` settles it):

```ts
  /**
   * THE LOOP THIS CLOSES, and it is not a cosmetic miss. pendingDocMeta selects
   * documents with NO document_texts row, and a purge DELETES exactly that row.
   * So without the purge filter the destroyed document is pending forever and
   * the sweep sends it to OCR a file that no longer exists — every minute, on
   * the GPU that is shared with the evals.
   *
   * The sweep's documented convergence argument ("storeDocumentText writes a
   * row for EVERY attempt, including extractor 'none'") does NOT cover a row
   * that was deleted afterwards.
   */
  it("never returns a purged document", async () => {
    const [doc] = await db.insert(schema.documents).values({
      sha256: crypto.randomUUID().replace(/-/g, "") + "0".repeat(32),
      title: "Definitief verwijderd", mime: "text/plain", sizeBytes: 9,
      source: "upload", sourceRef: RUN_REF, receivedAt: new Date(),
    }).returning();
    // No document_texts row — exactly the state a purge leaves behind.
    expect(await pendingDocMeta(db, NO_PAGE_LIMIT)).toContain(doc.id);

    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}-purger@test.local`, name: "Martin" }).returning();
    await db.insert(schema.documentPurges).values({
      documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes,
      reason: null, createdBy: u.id });

    expect(await pendingDocMeta(db, NO_PAGE_LIMIT)).not.toContain(doc.id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter worker test src/docmeta-sweep.test.ts
```

Expected: FAIL on the last assertion — the purged document is still returned.

- [ ] **Step 3: Add the filter**

In `apps/worker/src/docmeta-sweep.ts`, change the import to:

```ts
import { notDiscardedSql, notPurgedSql } from "@verder/api/src/effective-status";
```

and the query's `WHERE` to:

```ts
    WHERE t.document_id IS NULL
      AND ${notDiscardedSql}
      AND ${notPurgedSql}
```

Extend the function's doc comment with:

```
 * PURGED documents are excluded for a stronger reason than discarded ones, and
 * it is a LOOP rather than a cosmetic miss: a purge deletes the document_texts
 * row this query looks for, so a purged document would be pending forever and
 * the sweep would send it to OCR a file that no longer exists, every minute,
 * on the shared GPU. The convergence argument above does not cover a row that
 * was deleted after it was written.
```

- [ ] **Step 4: Run the test**

```bash
env -u NODE_ENV pnpm --filter worker test src/docmeta-sweep.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/docmeta-sweep.ts apps/worker/src/docmeta-sweep.test.ts
git commit -m "fix(worker): the docmeta sweep chased purged documents forever

A purge deletes the document_texts row pendingDocMeta looks for, so without the
filter the destroyed document is pending every minute and the sweep OCRs a file
that no longer exists. The 'writes a row for EVERY attempt' convergence
argument does not cover a row deleted afterwards."
```

---

### Task 6: `/files` — purged documents leave the branches and get one of their own

**Files:**
- Modify: `packages/api/src/routers/documents.ts` (`branchSchema` line 93-104, `list` line 114-131, `tree` line 173-246, `browse` line 259-322)
- Modify: `packages/api/src/routers/bundles.ts` (`bundleWhere` line 80-88, `resolveBundleDocumentIds` line 100-116)
- Modify: `apps/web/src/lib/files-url.ts` (accept `status:purged`)
- Test: `packages/api/src/routers/documents-browse.test.ts` (append cases)

**Interfaces:**
- Consumes: `notPurgedSql`, `purgedSql` (Task 1); `documents.purge` (Task 2).
- Produces: `branchSchema`'s `status` kind accepts `"purged"`. `tree().status` may contain a row with `status: "purged"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/src/routers/documents-browse.test.ts` (reuse the file's existing fixture helper and caller):

```ts
  it("hides a purged document from every branch but its own", async () => {
    const c = caller();
    const doc = await makeDocument({ title: "Weg uit de takken", docType: "brief" });
    await c.documents.purge({ id: doc.id, reason: "test" });

    const inAlles = await c.documents.browse({ branch: { kind: "alles" } });
    expect(inAlles.rows.map((r) => r.id)).not.toContain(doc.id);

    const inSoort = await c.documents.browse({ branch: { kind: "soort", key: "brief" } });
    expect(inSoort.rows.map((r) => r.id)).not.toContain(doc.id);

    const inList = await c.documents.list({ limit: 200, includeDiscarded: true });
    expect(inList.map((r) => r.id)).not.toContain(doc.id);

    // Its own branch is where the record of what was destroyed stays findable.
    // A record reachable only by typing a UUID is not a record.
    const purged = await c.documents.browse({ branch: { kind: "status", status: "purged" } });
    expect(purged.rows.map((r) => r.id)).toContain(doc.id);
  });

  it("moves a document from its status branch to the purged one", async () => {
    const c = caller();
    const count = async (status: string) => (await c.documents.tree()).status
      .find((s) => s.status === status)?.n ?? 0;
    const purgedBefore = await count("purged");
    const doc = await makeDocument({ title: "Telt mee als verwijderd" });
    const inboxBefore = await count("inbox");
    await c.documents.purge({ id: doc.id });
    // Both sides of the move, measured against the same fixture — a purged
    // document must LEAVE its old branch, not merely appear in a new one.
    expect(await count("purged")).toBe(purgedBefore + 1);
    expect(await count("inbox")).toBe(inboxBefore - 1);
  });

  // THE INVARIANT documents-browse.test.ts already enforces for every branch:
  // the tree's count and browse's total are one definition. A purge that left
  // them disagreeing would show "12" over a table of 11.
  it("keeps every tree count equal to its branch total after a purge", async () => {
    const c = caller();
    const doc = await makeDocument({ title: "Invariant na purge", docType: "polis" });
    await c.documents.purge({ id: doc.id });
    const tree = await c.documents.tree();
    for (const s of tree.soort) {
      const got = await c.documents.browse({ branch: { kind: "soort", key: s.key } });
      expect(got.total).toBe(s.n);
    }
    for (const s of tree.status) {
      const got = await c.documents.browse({ branch: { kind: "status", status: s.status } });
      expect(got.total).toBe(s.n);
    }
  });

  it("drops a purged document out of its bundle", async () => {
    const c = caller();
    const doc = await makeDocument({ title: "Uit de bundel" });
    const bundle = await c.bundles.create({ name: `Purge bundel ${crypto.randomUUID()}`,
      kind: "manual" });
    await c.bundles.addDocument({ bundleId: bundle.id, documentId: doc.id });
    expect((await c.documents.browse({ branch: { kind: "bundel", id: bundle.id } }))
      .rows.map((r) => r.id)).toContain(doc.id);
    await c.documents.purge({ id: doc.id });
    const after = await c.documents.browse({ branch: { kind: "bundel", id: bundle.id } });
    expect(after.rows.map((r) => r.id)).not.toContain(doc.id);
    // The zip's membership must agree with the table's, or the card downloads
    // a file the page says is not there — and the zip route would 409 on it.
    const listed = (await c.bundles.list()).find((b) => b.id === bundle.id);
    expect(listed?.count).toBe(after.total);
  });
```

If `makeDocument`, `caller` or the bundle helpers are named differently in the existing file, use the file's own names — do not add duplicates.

- [ ] **Step 2: Run tests to verify they fail**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/documents-browse.test.ts
```

Expected: FAIL — `status: "purged"` is rejected by the zod enum, and the purged document is still in every branch.

- [ ] **Step 3: Widen `branchSchema`**

In `packages/api/src/routers/documents.ts`:

```ts
  // `purged` is not a doc_status — it is the presence of a document_purges row.
  // It sits in this union anyway because it is the same QUESTION the status
  // branch answers ("where is this document in its life?") and the tree renders
  // it in the same list.
  z.object({ kind: z.literal("status"),
    status: z.enum(["inbox", "filed", "discarded", "purged"]) }),
```

- [ ] **Step 4: Filter `list`**

In the `list` procedure, change the `where` expression to exclude purged in every case:

```ts
    const base = input.status
      ? sql`${effectiveDocStatusSql} = ${input.status}`
      : input.includeDiscarded ? undefined : notDiscardedSql;
    // A purged document is out of every list, including includeDiscarded and an
    // explicit status filter: it is gone in a stronger sense than a discard,
    // and the evidence pickers must never offer one.
    const where = base ? sql`${base} AND ${notPurgedSql}` : notPurgedSql;
```

- [ ] **Step 5: Filter `tree`**

In `tree`, change the first line to:

```ts
    const live = sql`${notDiscardedSql} AND ${notPurgedSql}`;
```

and the `statusRows` query — which deliberately has no `live` filter, because it exists to find the discarded ones — to exclude purged and then count them separately:

```ts
      ctx.db.select({ status: effectiveDocStatusSql, n: sql<number>`count(*)::int` })
        .from(schema.documents).where(notPurgedSql).groupBy(effectiveDocStatusSql),

      ctx.db.select({ n: sql<number>`count(*)::int` })
        .from(schema.documents).where(purgedSql),
```

Destructure the extra result (`statusRows, purgedRows`) and build the status list so a zero never renders a branch nobody can use:

```ts
      status: purgedRows[0].n > 0
        ? [...statusRows, { status: "purged", n: purgedRows[0].n }]
        : statusRows,
```

- [ ] **Step 6: Filter `browse`**

In `browse`, replace the `where` chain with one that adds `notPurgedSql` to every branch and gives `purged` its own:

```ts
    const where =
      b.kind === "bundel" ? await bundleWhere(ctx.db, b.id)
      // The one branch that LOOKS for purged documents. Everything else hides
      // them, including the other three status values.
      : b.kind === "status" ? (b.status === "purged"
          ? purgedSql
          : sql`${effectiveDocStatusSql} = ${b.status} AND ${notPurgedSql}`)
      : b.kind === "soort" ? sql`${notDiscardedSql} AND ${notPurgedSql} AND ${docTypeKeySql} = ${b.key}`
      : b.kind === "party" ? (b.id === null
          ? sql`${notDiscardedSql} AND ${notPurgedSql} AND ${effectivePartyIdSql} IS NULL`
          : sql`${notDiscardedSql} AND ${notPurgedSql} AND ${effectivePartyIdSql} = ${b.id}`)
      : b.kind === "periode" ? sql`${notDiscardedSql} AND ${notPurgedSql} AND ${receivedMonthSql} = ${b.month}`
      : b.kind === "bron" ? sql`${notDiscardedSql} AND ${notPurgedSql} AND documents.source = ${b.source}`
      : sql`${notDiscardedSql} AND ${notPurgedSql}`; // "alles"
```

- [ ] **Step 7: Filter both spellings of bundle membership**

In `packages/api/src/routers/bundles.ts`, in `bundleWhere`:

```ts
  if (!b) return sql`false`;
  // A purged document is out of every bundle, whichever kind. Applied HERE
  // rather than at each call site so the tree count, the table and the zip
  // cannot disagree — the drift that once showed 12 over an empty table.
  const membership = b.kind === "manual" ? manualMembershipSql(bundleId) : null;
  if (membership) return sql`${membership} AND ${notPurgedSql}`;
  const parsed = parseBundleRule(b.rule);
  return parsed.ok ? sql`${ruleWhere(parsed.rule)} AND ${notPurgedSql}` : sql`false`;
```

and in `resolveBundleDocumentIds`'s manual branch, which is the SECOND spelling of membership (only the order differs — see its doc comment):

```ts
  if (b.kind === "manual") {
    const rows = await db.select({ id: schema.bundleDocuments.documentId })
      .from(schema.bundleDocuments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.bundleDocuments.documentId))
      .where(and(eq(schema.bundleDocuments.bundleId, bundleId), notPurgedSql))
      .orderBy(schema.bundleDocuments.addedAt);
    return rows.map((r) => r.id);
  }
```

and in the rule branch's `where`:

```ts
    .from(schema.documents).where(sql`${ruleWhere(parsed.rule)} AND ${notPurgedSql}`)
```

Add `notPurgedSql` to the imports and `and` to the drizzle import if absent.

- [ ] **Step 8: Let the URL carry the branch**

In `apps/web/src/lib/files-url.ts`, add `"purged"` wherever the status values are enumerated for encoding/decoding, so `?tak=status:purged` round-trips. Run its unit test:

```bash
env -u NODE_ENV pnpm --filter web test src/lib/files-url.test.ts
```

Add a case to `files-url.test.ts` asserting `status:purged` decodes to `{ kind: "status", status: "purged" }` and encodes back.

- [ ] **Step 9: Run the tests**

```bash
env -u NODE_ENV pnpm --filter @verder/api test src/routers/documents-browse.test.ts src/routers/documents-tree.test.ts src/routers/documents.test.ts src/routers/bundles.test.ts
env -u NODE_ENV pnpm --filter web test src/lib/files-url.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/api/src/routers/documents.ts packages/api/src/routers/bundles.ts \
  packages/api/src/routers/documents-browse.test.ts apps/web/src/lib/files-url.ts \
  apps/web/src/lib/files-url.test.ts
git commit -m "feat(files): purged documents leave every branch and get one of their own

notPurgedSql joins notDiscardedSql in list, tree, browse and both spellings of
bundle membership, and a 'purged' status branch keeps the record of what was
destroyed findable. Applied inside bundleWhere so the tree count, the table and
the zip cannot disagree."
```

---

### Task 7: The download routes answer honestly

**Files:**
- Modify: `apps/web/src/app/api/files/[sha256]/route.ts`
- Modify: `apps/web/src/app/api/files/zip/route.ts` (the `gone` collection around line 89-98)
- Test: `apps/web/src/app/api/files/route.test.ts` (append a case)

**Interfaces:**
- Consumes: `documents.bySha` returning `purge` (Task 2).
- Produces: `GET /api/files/<sha256>` answers `410` with `{ error: "purged" }` for a purged document.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/app/api/files/route.test.ts`, following the file's existing mocking of `serverCaller`:

```ts
  /**
   * 410, not 404. The document exists and we know exactly what happened to it;
   * "not found" would be a smaller truth than the one the app can tell. The
   * body names the reason so the page can say it in Dutch.
   */
  it("answers 410 Gone for a purged document", async () => {
    const res = await GET(new Request("http://x/api/files/" + "b".repeat(64)),
      { params: Promise.resolve({ sha256: "b".repeat(64) }) });
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: "purged" });
  });
```

Arrange the mocked caller so `documents.bySha` resolves with `purge: { at: new Date(), reason: null, sha256: "b".repeat(64), sizeBytes: 3, bytesStillOnDisk: false }`.

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter web test src/app/api/files/route.test.ts
```

Expected: FAIL — the route reads the file, throws ENOENT, and the test sees a thrown error rather than a 410.

- [ ] **Step 3: Answer 410**

In `apps/web/src/app/api/files/[sha256]/route.ts`, immediately after `const doc = await caller.documents.bySha({ sha256 });`:

```ts
    // 410, not 404. The document exists and the app knows exactly what happened
    // to it — the bytes were destroyed on purpose and there is a ledgered
    // record saying so. Reading the file here would ENOENT into a 500.
    if (doc.purge) return NextResponse.json({ error: "purged" }, { status: 410 });
```

- [ ] **Step 4: Make the zip's 409 truthful**

In `apps/web/src/app/api/files/zip/route.ts`, where a missing file is collected into `gone`, distinguish the two causes so the message says which. Where the documents are loaded, before the `readFile`:

```ts
      // A purged document should never reach here — bundleWhere and browse both
      // exclude them — but a stale ?ids= list from an open tab can still name
      // one. Say what actually happened rather than "bestand ontbreekt".
      if (doc.purge) { gone.push({ title: doc.effectiveTitle, reason: "purged" }); continue; }
```

Match the existing shape of the `gone` array; if it currently holds bare titles, keep it holding bare titles and append `" (definitief verwijderd)"` to the title instead of changing the shape.

- [ ] **Step 5: Run the tests**

```bash
env -u NODE_ENV pnpm --filter web test src/app/api/files
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/files
git commit -m "feat(files): a purged document downloads as 410 Gone, never a 500

The route read the file and ENOENTed. 410 is the honest code: the document
exists and there is a ledgered record of its bytes being destroyed."
```

---

### Task 8: The button and the tombstone

**Files:**
- Create: `apps/web/src/components/document-purge.tsx`
- Modify: `apps/web/src/components/document-meta-form.tsx` (render the purge zone; hide the form when purged)
- Modify: `apps/web/src/app/(app)/files/[id]/page.tsx` (tombstone instead of preview + form)
- Test: `apps/web/src/components/document-purge-copy.test.ts` (create)

**Interfaces:**
- Consumes: `documents.purge` (Task 2), `documents.get` returning `purge` (Task 2).
- Produces:
  - `<DocumentPurge doc={{ id, purge }} />` — the two-step control.
  - `purgeTombstoneLine(purge: { at: Date; reason: string | null; sizeBytes: number }): string` — the Dutch sentence, pure and unit-tested (a client component cannot be tested directly; the copy that must be right can be, exactly as `discardAction` is).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/document-purge-copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { purgeTombstoneLine } from "./document-purge";

describe("purgeTombstoneLine", () => {
  const at = new Date("2026-09-03T14:05:00+02:00");

  it("names the date and the reason", () => {
    expect(purgeTombstoneLine({ at, reason: "per ongeluk gescand", sizeBytes: 2048 }))
      .toBe("Definitief verwijderd op 03-09-2026 — per ongeluk gescand");
  });

  // A missing reason must not render a dangling dash. The field is optional by
  // design, so the blank case is the normal one, not the edge one.
  it("omits the dash when no reason was given", () => {
    expect(purgeTombstoneLine({ at, reason: null, sizeBytes: 2048 }))
      .toBe("Definitief verwijderd op 03-09-2026");
  });

  // Dutch date order, and Amsterdam time. A purge at 00:30 CEST is the 3rd
  // here and the 2nd in UTC, and the tombstone is read by someone in Almere.
  it("renders the date in Amsterdam time", () => {
    expect(purgeTombstoneLine({
      at: new Date("2026-09-02T23:30:00Z"), reason: null, sizeBytes: 1 }))
      .toBe("Definitief verwijderd op 03-09-2026");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
env -u NODE_ENV pnpm --filter web test src/components/document-purge-copy.test.ts
```

Expected: FAIL — `./document-purge` does not exist.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/document-purge.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button, Field, Input, FormError, Micro } from "@/components/ui";

/**
 * The tombstone's first line. Pure and separate from the JSX for the reason
 * `discardAction` is: a client component cannot be unit-tested directly, but
 * the copy that must be right can be.
 *
 * Amsterdam, not UTC: a purge at 00:30 CEST is the 3rd here and the 2nd in UTC,
 * and this line is read by someone in Almere. The dash is omitted rather than
 * left dangling when no reason was given — the field is optional by design, so
 * the blank case is the normal one.
 */
export function purgeTombstoneLine(
  purge: { at: Date; reason: string | null; sizeBytes: number },
): string {
  const d = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(purge.at);
  const head = `Definitief verwijderd op ${d}`;
  return purge.reason ? `${head} — ${purge.reason}` : head;
}

/**
 * Definitief verwijderen: two-step, the shape BundleCardActions already uses.
 *
 * `danger`, not `signal`, for the reason button.tsx records — bordered amber is
 * the system's voice for "something you only want to do on purpose", while
 * `signal` reads as "this is the one to press", which is the wrong voice for a
 * destructive confirm.
 */
export function DocumentPurge({ doc }: { doc: { id: string } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const purge = trpc.documents.purge.useMutation({ onSuccess: () => router.refresh() });

  // Mirrors BundleCardActions' openDeleteConfirm: without the reset, a failed
  // attempt followed by "annuleren" and a second click shows the previous
  // error before this one has done anything.
  function open() { purge.reset(); setReason(""); setConfirming(true); }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
        <Button variant="ghost" onClick={open}>Definitief verwijderen</Button>
        <Micro>Het bestand zelf wordt vernietigd. Dit kan niet ongedaan worden gemaakt.</Micro>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
      <Micro>
        Het bestand, de uitgelezen tekst en de zoekresultaten worden vernietigd.
        De regel in het logboek blijft staan, met deze aantekening erbij.
        Dit kan niet ongedaan worden gemaakt.
      </Micro>
      <Field label="Reden (mag leeg)" htmlFor="purge-reason" className="w-full">
        <Input id="purge-reason" value={reason} placeholder="bijvoorbeeld: per ongeluk gescand"
          onChange={(e) => setReason(e.target.value)} />
      </Field>
      {purge.error && <FormError>{purge.error.message}</FormError>}
      <div className="flex gap-2">
        <Button variant="quiet" onClick={() => setConfirming(false)}>Annuleren</Button>
        <Button variant="danger" disabled={purge.isPending}
          onClick={() => purge.mutate({ id: doc.id, reason: reason.trim() || undefined })}>
          Ja, definitief verwijderen
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
env -u NODE_ENV pnpm --filter web test src/components/document-purge-copy.test.ts
```

Expected: PASS, all three cases.

- [ ] **Step 5: Mount it in the meta form**

In `apps/web/src/components/document-meta-form.tsx`, add to the props type:

```ts
  doc: { id: string; title: string; docType: string | null; partyId: string | null;
    status: DocStatus; previousStatus: DocStatus };
```

(unchanged) and render `<DocumentPurge doc={{ id: doc.id }} />` as the last child of the outer `<div>`, after the entry-link block. Import it at the top.

- [ ] **Step 6: Render the tombstone on the detail page**

In `apps/web/src/app/(app)/files/[id]/page.tsx`, after the `Promise.all`, branch on the purge. Replace the `<div className="grid gap-6 lg:grid-cols-2">` block with:

```tsx
      {d.purge ? (
        /*
          A tombstone, not a two-column editor. There is no preview (the bytes
          are gone), nothing to edit and no way back — so the page's whole job
          is to say what was destroyed, when, and why.
        */
        <Panel className="p-[26px] flex flex-col gap-4">
          <Notice tone="signal">{purgeTombstoneLine(d.purge)}</Notice>
          <dl className="flex flex-col gap-2">
            <div><dt className="micro">Soort</dt><dd>{d.effectiveDocType ?? "Zonder soort"}</dd></div>
            <div><dt className="micro">Grootte</dt><dd>{d.purge.sizeBytes} bytes</dd></div>
            <div><dt className="micro">sha256</dt><dd className="micro break-all">{d.purge.sha256}</dd></div>
          </dl>
          {/* Amber, and this one earns it: an unfinished action waiting on
              somebody. The unlink runs after the purge transaction commits, so
              this state means it failed and the bytes are still on disk. */}
          {d.purge.bytesStillOnDisk && (
            <Notice tone="attn">
              Het bestand staat nog op schijf — de vernietiging is niet afgerond.
              <DocumentPurgeRetry id={d.id} />
            </Notice>
          )}
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* …the existing preview Panel and DocumentMetaForm Panel, unchanged… */}
        </div>
      )}
```

Add a `DocumentPurgeRetry` export to `document-purge.tsx` — a single `danger` button calling the same mutation with no reason:

```tsx
/**
 * The repair path for a purge whose unlink failed. The mutation is a no-op on
 * the record (the first reason stands) and still retries the unlink, which is
 * exactly what is needed here.
 */
export function DocumentPurgeRetry({ id }: { id: string }) {
  const router = useRouter();
  const purge = trpc.documents.purge.useMutation({ onSuccess: () => router.refresh() });
  return (
    <Button variant="danger" disabled={purge.isPending}
      onClick={() => purge.mutate({ id })}>Opnieuw verwijderen</Button>
  );
}
```

Import `Notice` and `purgeTombstoneLine`/`DocumentPurgeRetry` on the page.

- [ ] **Step 7: Typecheck the web app and build it**

`apps/web` is only typechecked properly by `next build` — `packages/api` type changes have broken the deploy this way before.

```bash
env -u NODE_ENV pnpm --filter web typecheck
env -u NODE_ENV pnpm --filter web build
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/document-purge.tsx \
  apps/web/src/components/document-purge-copy.test.ts \
  apps/web/src/components/document-meta-form.tsx \
  'apps/web/src/app/(app)/files/[id]/page.tsx'
git commit -m "feat(web): Definitief verwijderen on the file detail page

Two-step with an optional reason, danger-toned per button.tsx's exception for
'something you only want to do on purpose'. A purged document renders as a
tombstone instead of a preview and an editor, with a retry when the unlink
failed and the bytes are still on disk."
```

---

### Task 9: Full suite, then deploy

**Files:** none changed by the first steps.

- [ ] **Step 1: Run everything**

```bash
env -u NODE_ENV pnpm -r test
env -u NODE_ENV pnpm -r typecheck
env -u NODE_ENV pnpm --filter web build
```

Expected: all green. If `packages/api` tests fail on chain state, `verify.test.ts` truncates and reseeds in its own `beforeAll` — run it alone to confirm it is not a cross-file leak.

- [ ] **Step 2: Deploy, in this order — it is not interchangeable**

```bash
# 1. rsync FIRST: the migration file does not exist on the homelab until you
#    send it. Dry run and READ EVERY `deleting` LINE first — plain --dry-run
#    without --info=del prints nothing, which reads as "no deletions".
rsync -av --delete --dry-run --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' --exclude 'secrets' \
  --exclude 'vault-files' --exclude '.env' --exclude '.env.local' --exclude '*.traineddata' \
  --exclude '.superpowers' --exclude '.gstack' --exclude '.claude' --exclude 'next-env.d.ts' \
  --exclude '*.tsbuildinfo' ./ homelab:~/apps/verder/
# then the same command without --dry-run --info=del
```

```bash
# 2. Migrate from the HOST, before any image is rebuilt. The bare command falls
#    back to the dev default and dies on 28P01 auth_failed.
ssh homelab 'cd ~/apps/verder && set -a && . ./.env.prod && set +a && \
  DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate'
```

```bash
# 3. Only now rebuild web + worker.
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml up -d --build web worker'
```

0034 is additive and nothing in the running images reads `document_purges`, so nothing breaks between steps 2 and 3.

- [ ] **Step 3: Verify in production, before touching the button**

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker verify-nightly'
```

Expected: `OK`, ledger head **unchanged**, 140 events, 75 files checked, **0 purged**. A moved head here would mean something wrote evidence during the deploy, which nothing in this sub-project may do.

- [ ] **Step 4: Purge one document by hand and re-verify**

Pick a document that genuinely should not be in the vault, purge it through the UI, then:

```bash
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker verify-nightly'
```

Expected: `OK`, ledger **141** events (exactly one `document.purged`), **74** files checked, **1 purged (0 still on disk)**.

- [ ] **Step 5: Record it in CLAUDE.md**

Add a paragraph to the sub-project list in `/Users/martin/Workspace/mp/verder/CLAUDE.md` with the MEASURED numbers from steps 3 and 4 — not the predicted ones. It must carry:
- the migration number and the host-first ordering;
- that this sub-project appends one event per purge and none otherwise;
- the four traps, each in one sentence: `pendingDocMeta`'s loop, `indexEntity`'s resurrection, the post-commit unlink, and the fact that a purge cannot be laundered by deleting its record;
- that the one grant widening is `DELETE` on `document_texts` and `search_chunks` for `verder_app`, and why that is not the same act as widening it on `documents`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the document purge deployment and its four traps"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: schema and grants → Task 1; the mutation and the post-commit unlink → Task 2; both verification branches, `purgedFiles`/`purgedFilesOnDisk` and the two display surfaces → Task 3; "the four places that must learn about purged" → Tasks 4 (indexEntity), 5 (pendingDocMeta), 6 (list/tree/browse/bundles), 7 (the two routes); the UI and the tombstone → Task 8; deploy ordering and the expected numbers → Task 9. The spec's nine tests all appear: 1-2 in Task 2, 3-5 and 9 in Task 3, 6 in Task 5, 7 in Task 4, 8 in Task 6.

**Type consistency.** `purge` is the same object shape everywhere it appears (`{ at, reason, sha256, sizeBytes, bytesStillOnDisk }`), produced once in `effectiveDocument` (Task 2) and consumed in Tasks 7 and 8. `documentPurgePayload` is defined in Task 2 and imported in Task 3. `notPurgedSql`/`purgedSql` are defined in Task 1 and used in Tasks 4, 5 and 6.

**Out of scope, deliberately** (from the spec): no bulk purge, no rule-driven purge, no worker script, and no purging of `raw_emails` bodies — the archived `.eml` of a mailed attachment still contains it, and the tombstone does not claim otherwise.
