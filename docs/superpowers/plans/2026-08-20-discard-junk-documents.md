# Discarding Junk Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop email signature logos becoming vault documents, and give Martin a Discard button for the ones that already did.

**Architecture:** Prevention at the Gmail port (skip `inline` parts carrying a `Content-ID`), plus a third value on the existing `doc_status` enum so discard rides the status-change path that `filed` already uses — no new table, no new ledger event type, no new concept. Hiding is three `WHERE` clauses.

**Tech Stack:** TypeScript, Drizzle + Postgres enums, tRPC 11, Next.js 15, Vitest, pnpm 10 workspaces.

**Spec:** `docs/superpowers/specs/2026-08-20-discard-signature-images-design.md`

## Global Constraints

- Run every build/test with `env -u NODE_ENV` — the shell exports `NODE_ENV=development`, which breaks `next build`.
- **Evidence tables are append-only**, enforced by Postgres grants. Discard is an INSERT into `document_status_changes`, never an UPDATE or DELETE on `documents`. Every evidence mutation appends a `ledger_events` row **in the same transaction**.
- **Nothing is deleted from the vault.** No file is unlinked, no document row is removed. Purge is explicitly out of scope.
- Migration 0021 is **additive only** (`ALTER TYPE ... ADD VALUE`), matching `0020_abn_xls_tx_source.sql`. It carries the same deploy-ordering requirement: migrate from the homelab host BEFORE the new images go up.
- **A part with malformed or absent headers is KEPT, never skipped.** Over-ingesting produces noise; over-skipping loses evidence, and only one of those is recoverable.
- Do NOT deploy, rsync, or ssh to homelab. Production is Martin's call.
- `documents.update` already exists and already appends both the status change and the ledger event (`documents.ts:130-143`). Discard extends its enum; it does not get a parallel procedure.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema.ts:8` | `docStatusEnum` gains `"discarded"` |
| `packages/db/drizzle/0021_discarded_doc_status.sql` *(new)* | Additive enum migration |
| `packages/api/src/routers/documents.ts:130-143` | `update` accepts `discarded`; `list` excludes it by default |
| `packages/api/src/search/retrieve.ts:178` | Search excludes discarded chunks |
| `packages/api/src/routers/suggestions.ts:48-66` | Queue drops suggestions for discarded documents |
| `apps/worker/src/gmail-parts.ts` *(new)* | `isInlineBodyImage` — the pure skip decision |
| `apps/worker/src/gmail-auth.ts:61-71` | The `walk` consults it |
| `apps/web/src/components/document-meta-form.tsx` | Discard / Undo discard buttons |
| `apps/worker/src/ops/discard-signature-images.ts` *(new)* | One-time idempotent backfill |

---

### Task 1: `discarded` document status

**Files:**
- Modify: `packages/db/src/schema.ts:8`
- Create: `packages/db/drizzle/0021_discarded_doc_status.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/api/src/routers/documents.ts:131`
- Test: `packages/api/src/routers/documents.test.ts`

**Interfaces:**
- Consumes: the existing `documents.update` procedure and `appendLedgerEvent`.
- Produces: `docStatusEnum` = `["inbox", "filed", "discarded"]`; `documents.update({ id, status: "discarded" })`.

- [ ] **Step 1: Write the failing test**

Add to `packages/api/src/routers/documents.test.ts`, following the file's existing `caller()` helper:

```ts
it("discards a document by appending a status change and a ledger event", async () => {
  const doc = await seedDocument({ title: "image.png", mime: "image/png" });

  const before = await db.select().from(schema.ledgerEvents);
  const updated = await caller().documents.update({ id: doc.id, status: "discarded" });
  expect(updated.effectiveStatus).toBe("discarded");

  const after = await db.select().from(schema.ledgerEvents);
  expect(after.length).toBe(before.length + 1);

  // The bytes and the row are untouched — discard is not deletion.
  const [row] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, doc.id));
  expect(row).toBeDefined();
  expect(row.sha256).toBe(doc.sha256);
});

it("undoes a discard by appending another status change", async () => {
  const doc = await seedDocument({ title: "image.png", mime: "image/png" });
  await caller().documents.update({ id: doc.id, status: "discarded" });
  const restored = await caller().documents.update({ id: doc.id, status: "inbox" });
  expect(restored.effectiveStatus).toBe("inbox");

  // Both transitions survive as history; nothing is overwritten.
  const changes = await db.select().from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, doc.id));
  expect(changes.map((c) => c.status)).toEqual(["discarded", "inbox"]);
});

it("leaves the ledger chain verifying after a discard", async () => {
  const doc = await seedDocument({ title: "image.png", mime: "image/png" });
  await caller().documents.update({ id: doc.id, status: "discarded" });
  await expect(verifyLedger(db)).resolves.toMatchObject({ ok: true });
});
```

Import `verifyLedger` from `../verification` — check its exported name there and use the real one.

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test documents`
Expected: FAIL — zod rejects `"discarded"`, which is not in the `update` input enum.

- [ ] **Step 3: Widen the schema enum**

In `packages/db/src/schema.ts` line 8:

```ts
export const docStatusEnum = pgEnum("doc_status", ["inbox", "filed", "discarded"]);
```

- [ ] **Step 4: Write the migration**

Create `packages/db/drizzle/0021_discarded_doc_status.sql`:

```sql
-- Signature logos from email footers arrive as real documents. Discarding one
-- must not delete it: documents is append-only and already carries a
-- document.ingested ledger event, so removal would break the hash chain.
-- Discard is therefore a third status, appended through
-- document_status_changes exactly as "filed" is.
--
-- Additive only: ALTER TYPE ... ADD VALUE never rewrites or invalidates an
-- existing row, so the append-only evidence guarantee is untouched.
ALTER TYPE "public"."doc_status" ADD VALUE 'discarded';
```

Register it in `packages/db/drizzle/meta/_journal.json` following the exact shape of the `0020_abn_xls_tx_source` entry (same keys, `idx` incremented, new `tag`, and a `when` timestamp). Generate the snapshot the way 0020's was produced rather than hand-writing it — check whether `pnpm --filter @verder/db generate` produces `meta/0021_snapshot.json`, and use it if so.

- [ ] **Step 5: Accept the new status in the API**

In `packages/api/src/routers/documents.ts` line 131:

```ts
    id: z.string().uuid(), status: z.enum(["inbox", "filed", "discarded"]),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test documents && env -u NODE_ENV pnpm --filter @verder/db test`
Expected: PASS, including the pre-existing document tests.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/ \
  packages/api/src/routers/documents.ts packages/api/src/routers/documents.test.ts
git commit -m "feat(db): discarded document status, appended not deleted

A signature logo in the vault is noise, but deleting it would break the
hash chain the vault exists to provide. Discard is a third status on the
path filed already uses, so the record says Martin discarded it and when.

Migration 0021 is additive, like 0020 — migrate before the images."
```

---

### Task 2: Stop ingesting inline body images

**Files:**
- Create: `apps/worker/src/gmail-parts.ts`
- Modify: `apps/worker/src/gmail-auth.ts:60-72`
- Test: `apps/worker/src/gmail-parts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isInlineBodyImage(headers: { name?: string | null; value?: string | null }[] | null | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/gmail-parts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isInlineBodyImage } from "./gmail-parts";

const h = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

describe("isInlineBodyImage", () => {
  it("skips an inline part that the HTML body references by cid", () => {
    // This is the LinkedIn badge: 56% of what the watcher has filed.
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'inline; filename="image.png"',
      "Content-ID": "<ii_abc123>",
      "Content-Type": "image/png",
    }))).toBe(true);
  });

  it("keeps a real attachment", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'attachment; filename="Beschikking.pdf"',
      "Content-Type": "application/pdf",
    }))).toBe(false);
  });

  it("keeps an inline part with NO Content-ID — it is not a cid reference", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'inline; filename="scan.pdf"',
    }))).toBe(false);
  });

  it("keeps a part with a Content-ID but no inline disposition", () => {
    expect(isInlineBodyImage(h({
      "Content-Disposition": 'attachment; filename="logo.png"',
      "Content-ID": "<ii_xyz>",
    }))).toBe(false);
  });

  it("matches header names case-insensitively, as they occur in the wild", () => {
    expect(isInlineBodyImage(h({
      "content-disposition": "INLINE",
      "content-id": "<ii_abc>",
    }))).toBe(true);
  });

  it("KEEPS a part with absent or malformed headers", () => {
    // Over-ingesting is noise; over-skipping loses evidence. Only one of
    // those is recoverable, so uncertainty always keeps the part.
    expect(isInlineBodyImage(undefined)).toBe(false);
    expect(isInlineBodyImage(null)).toBe(false);
    expect(isInlineBodyImage([])).toBe(false);
    expect(isInlineBodyImage([{ name: null, value: null }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter worker test gmail-parts`
Expected: FAIL — cannot resolve `./gmail-parts`.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/gmail-parts.ts`:

```ts
/**
 * Is this message part an image the HTML body embeds, rather than something
 * the sender attached?
 *
 * Every signature logo in every footer was becoming a vault document with a
 * Title field and a "File it" button, sitting in the evidence record next to a
 * court decision — 56% of everything the watcher had filed. The walk in
 * gmail-auth.ts took any part with a filename and never read the disposition.
 *
 * A body image is `Content-Disposition: inline` AND carries a `Content-ID`
 * that the HTML references as `cid:…`. BOTH are required: an inline part
 * without a Content-ID is not a cid reference and might be a real document.
 *
 * Skipping one loses nothing — ingestRawEmail stores the full RFC822 original
 * in the vault first, so the bytes stay verifiable forever.
 *
 * Uncertainty always KEEPS the part. Over-ingesting is noise Martin can
 * discard; over-skipping is evidence he never learns arrived.
 */
export function isInlineBodyImage(
  headers: { name?: string | null; value?: string | null }[] | null | undefined,
): boolean {
  if (!headers) return false;
  const get = (want: string) =>
    headers.find((x) => x.name?.toLowerCase() === want)?.value ?? null;
  const disposition = get("content-disposition");
  const contentId = get("content-id");
  if (!disposition || !contentId) return false;
  return disposition.trim().toLowerCase().startsWith("inline");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `env -u NODE_ENV pnpm --filter worker test gmail-parts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Consult it in the walk**

In `apps/worker/src/gmail-auth.ts`, add the import:

```ts
import { isInlineBodyImage } from "./gmail-parts";
```

and change the condition inside `walk` (line 63) from:

```ts
          if (p.filename && p.body?.attachmentId) {
```

to:

```ts
          if (p.filename && p.body?.attachmentId && !isInlineBodyImage(p.headers)) {
```

Leave the recursion (`if (p.parts) await walk(p)`) exactly as it is — a skipped part may still have children.

- [ ] **Step 6: Prove the port skips it end to end**

Add to `apps/worker/src/gmail.test.ts`, using the file's existing fake `GmailPort` pattern — a message carrying one signature logo and one real PDF must produce exactly one document:

```ts
it("ingests the real attachment and not the signature logo", async () => {
  const msg = fakeMessage({
    attachments: [
      { filename: "Beschikking.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4 real") },
    ],
  });
  await ingestRawEmail({ db, vaultDir }, msg);

  const docs = await db.select().from(schema.documents);
  expect(docs.map((d) => d.title)).toEqual(["Beschikking.pdf"]);

  // The raw email is still vaulted, so nothing is actually lost.
  const [raw] = await db.select().from(schema.rawEmails);
  expect(raw.rawRfc822Sha256).toHaveLength(64);
});
```

Note the skip happens in the real Gmail port (`gmail-auth.ts`), not in `ingestRawEmail`, so this test asserts the *contract* the port now upholds: what reaches `ingestRawEmail` no longer contains body images. If `gmail.test.ts` has no `fakeMessage` helper, follow whatever construction the existing tests in that file use.

- [ ] **Step 7: Run the worker suite**

Run: `env -u NODE_ENV pnpm --filter worker test`
Expected: PASS — all pre-existing gmail tests included.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/gmail-parts.ts apps/worker/src/gmail-parts.test.ts \
  apps/worker/src/gmail-auth.ts apps/worker/src/gmail.test.ts
git commit -m "fix(worker): stop filing every signature logo as evidence

gmail-auth took any part with a filename and never read
Content-Disposition, so every LinkedIn badge in every footer became a
vault document. Inline + Content-ID is the cid: body reference.

Skipping loses nothing: the RFC822 original is vaulted first. A part
with malformed headers is kept — over-skipping loses evidence."
```

---

### Task 3: Hide discarded documents from the vault list

**Files:**
- Modify: `packages/api/src/routers/documents.ts:50-60`
- Test: `packages/api/src/routers/documents.test.ts`

**Interfaces:**
- Consumes: Task 1's `discarded` status.
- Produces: `documents.list({ status?, limit?, includeDiscarded?: boolean })` — discarded excluded unless `includeDiscarded` is true.

- [ ] **Step 1: Write the failing test**

```ts
it("omits discarded documents from the vault list by default", async () => {
  const keep = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf" });
  const junk = await seedDocument({ title: "image.png", mime: "image/png" });
  await caller().documents.update({ id: junk.id, status: "discarded" });

  const list = await caller().documents.list({ limit: 100 });
  expect(list.map((d) => d.id)).toContain(keep.id);
  expect(list.map((d) => d.id)).not.toContain(junk.id);
});

it("returns discarded documents when explicitly asked", async () => {
  const junk = await seedDocument({ title: "image.png", mime: "image/png" });
  await caller().documents.update({ id: junk.id, status: "discarded" });

  const list = await caller().documents.list({ limit: 100, includeDiscarded: true });
  expect(list.map((d) => d.id)).toContain(junk.id);
});

it("still filters by an explicit status", async () => {
  const filed = await seedDocument({ title: "Plan.pdf", mime: "application/pdf" });
  await caller().documents.update({ id: filed.id, status: "filed" });
  const list = await caller().documents.list({ status: "filed", limit: 100 });
  expect(list.map((d) => d.id)).toEqual([filed.id]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test documents`
Expected: FAIL — the discarded document appears in the default list.

- [ ] **Step 3: Implement**

In `packages/api/src/routers/documents.ts`, change the `list` procedure:

```ts
  list: protectedProcedure.input(z.object({
    status: z.enum(["inbox", "filed", "discarded"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    // Discarded documents stay reachable by direct URL and by asking for them
    // here; they are only kept out of the surfaces Martin scans.
    includeDiscarded: z.boolean().default(false),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.documents)
      .orderBy(desc(schema.documents.createdAt)).limit(input.limit);
    const effective = await Promise.all(rows.map((r) => effectiveDocument(ctx.db, r.id)));
    if (input.status) return effective.filter((d) => d.effectiveStatus === input.status);
    return input.includeDiscarded
      ? effective
      : effective.filter((d) => d.effectiveStatus !== "discarded");
  }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test documents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/documents.ts packages/api/src/routers/documents.test.ts
git commit -m "feat(api): keep discarded documents out of the vault list

Also covers the registry and debt evidence pickers, which call
documents.list with no status filter."
```

---

### Task 4: Hide discarded documents from search

**Files:**
- Modify: `packages/api/src/search/retrieve.ts:178`
- Test: `packages/api/src/search/retrieve.test.ts`

**Interfaces:**
- Consumes: Task 1's `discarded` status.
- Produces: no signature change — the SQL gains one predicate.

**Freshness note (verified, no work needed):** `document_status_changes` already has a `search_outbox` trigger (`0017_search_triggers.sql`, `search_enqueue('document', 'document_id')`), so appending a discard enqueues a reindex and `search.drain` rewrites `search_chunks.status` within 60 s. This task only adds the filter.

- [ ] **Step 1: Write the failing test**

Follow the harness the existing `retrieve.test.ts` uses to seed chunks:

```ts
it("never returns chunks belonging to a discarded document", async () => {
  await seedChunk({ entityType: "document", title: "image.png",
    text: "linkedin signature logo", status: "discarded" });
  await seedChunk({ entityType: "document", title: "Beschikking.pdf",
    text: "linkedin signature logo", status: "filed" });

  const hits = await retrieve(db, { q: "linkedin signature logo" });
  expect(hits.map((h) => h.title)).toEqual(["Beschikking.pdf"]);
});

it("still returns chunks whose status is null", async () => {
  // Most entity types have no status at all; they must not be filtered out.
  await seedChunk({ entityType: "email", title: "Mail from VerderGroep",
    text: "unieke zoekterm", status: null });
  const hits = await retrieve(db, { q: "unieke zoekterm" });
  expect(hits.map((h) => h.title)).toContain("Mail from VerderGroep");
});
```

That second test is the one that matters: `status = 'discarded'` is false for NULL, but a careless `!=` would drop every statusless entity. `IS DISTINCT FROM` is what keeps NULLs.

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test retrieve`
Expected: FAIL — the discarded chunk is returned.

- [ ] **Step 3: Implement**

In `packages/api/src/search/retrieve.ts`, beside the existing status predicate at line 178, add:

```sql
    AND c.status IS DISTINCT FROM 'discarded'
```

`IS DISTINCT FROM` rather than `<>` is deliberate: `NULL <> 'discarded'` is NULL, which would silently drop every entity type that has no status.

Apply it to every branch of the query that selects candidate chunks — check whether the file builds more than one statement (fast path and rerank path) and cover each.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test retrieve`
Expected: PASS, plus the pre-existing retrieval tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/search/retrieve.ts packages/api/src/search/retrieve.test.ts
git commit -m "feat(search): exclude discarded documents from results

IS DISTINCT FROM, not <>: NULL <> 'discarded' is NULL, which would drop
every entity type that has no status at all."
```

---

### Task 5: Drop discarded documents from the queue

**Files:**
- Modify: `packages/api/src/routers/suggestions.ts:48-66`
- Test: `packages/api/src/routers/suggestions.test.ts`

**Interfaces:**
- Consumes: Task 1's `discarded` status.
- Produces: `suggestions.list` omits suggestions whose linked document is discarded.

- [ ] **Step 1: Write the failing test**

```ts
it("omits suggestions whose document has been discarded", async () => {
  const junk = await seedDocument({ title: "image.png", mime: "image/png" });
  await seedSuggestion({ kind: "document-meta", documentId: junk.id });
  const keep = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf" });
  await seedSuggestion({ kind: "document-meta", documentId: keep.id });

  await caller().documents.update({ id: junk.id, status: "discarded" });

  const list = await caller().suggestions.list({});
  expect(list.map((s) => s.documentId)).toEqual([keep.id]);
});

it("keeps suggestions that have no document at all", async () => {
  await seedSuggestion({ kind: "entry", documentId: null });
  const list = await caller().suggestions.list({});
  expect(list).toHaveLength(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter @verder/api test suggestions`
Expected: FAIL — the discarded document's suggestion is still listed.

- [ ] **Step 3: Implement**

In `packages/api/src/routers/suggestions.ts`, the `list` procedure already resolves each suggestion's `document`. After the `Promise.all` that builds the enriched rows, filter out any row whose document is discarded — resolve the *effective* status with `effectiveDocument`, not the raw `documents.status` column, because discard is recorded in `document_status_changes` and never written back to `documents`.

That last point is the trap in this task: `s.document.status` is the ingest-time default and will read `"inbox"` forever.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter @verder/api test suggestions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/suggestions.ts packages/api/src/routers/suggestions.test.ts
git commit -m "feat(queue): stop asking Martin to file a discarded document

Resolves the EFFECTIVE status: discard lives in document_status_changes,
so documents.status still reads inbox forever."
```

---

### Task 6: Discard and Undo in the UI

**Files:**
- Modify: `apps/web/src/components/document-meta-form.tsx`
- Modify: `apps/web/src/app/(app)/vault/[id]/page.tsx`
- Test: `apps/web/src/components/document-meta-form.test.ts` *(new, pure logic only)*

**Interfaces:**
- Consumes: `documents.update` accepting `discarded` (Task 1).
- Produces: `export function discardAction(status: "inbox" | "filed" | "discarded"): { label: string; next: "inbox" | "discarded" }`

**Testing note:** this repo has no component render tests and no testing-library (`apps/web/vitest.config.ts` sets `environment: "node"`). Lift the decision into a pure function and test that — the pattern used by `preview-kind.ts`, `search-kinds.ts`, `palette.ts`. Do not add a component-testing stack.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/document-meta-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { discardAction } from "./document-meta-form-actions";

describe("discardAction", () => {
  it("offers Discard on a document still in the inbox", () => {
    expect(discardAction("inbox")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Discard on a filed document too", () => {
    expect(discardAction("filed")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Undo discard on an already-discarded document", () => {
    expect(discardAction("discarded")).toEqual({ label: "Undo discard", next: "inbox" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter web test document-meta-form`
Expected: FAIL — cannot resolve `./document-meta-form-actions`.

- [ ] **Step 3: Write the pure module**

Create `apps/web/src/components/document-meta-form-actions.ts`:

```ts
export type DocStatus = "inbox" | "filed" | "discarded";

/**
 * Discard is always reversible, so the same button does both jobs: it reads
 * the current status and offers the opposite move.
 */
export function discardAction(status: DocStatus): { label: string; next: DocStatus } {
  return status === "discarded"
    ? { label: "Undo discard", next: "inbox" }
    : { label: "Discard", next: "discarded" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `env -u NODE_ENV pnpm --filter web test document-meta-form`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the button**

In `apps/web/src/components/document-meta-form.tsx`:

- Widen the `doc.status` prop type from `"inbox" | "filed"` to the `DocStatus` union.
- Import `discardAction`.
- Beside the existing "File it ✔" button (line 23), add a second button using `discardAction(doc.status)`, calling `update.mutate({ id: doc.id, status: action.next })`. Style it as a quiet secondary action — a bordered button, not a filled one; this is not the primary path.
- When `doc.status === "discarded"`, render a plain line above the form reading `Discarded — kept in the vault, hidden from lists and search.` and do not render the "File it" button.

In `apps/web/src/app/(app)/vault/[id]/page.tsx`, the form already receives `status: d.effectiveStatus`; confirm the prop type change compiles and that `effectiveStatus` is passed rather than `d.status`.

- [ ] **Step 6: Typecheck and build**

Run: `env -u NODE_ENV pnpm --filter web typecheck && env -u NODE_ENV pnpm --filter web build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/document-meta-form-actions.ts \
  apps/web/src/components/document-meta-form.test.ts \
  apps/web/src/components/document-meta-form.tsx \
  "apps/web/src/app/(app)/vault/[id]/page.tsx"
git commit -m "feat(web): Discard and Undo discard on a vault document

One button that reads the current status and offers the opposite move,
because discard is always reversible."
```

---

### Task 7: Backfill the nine that already landed

**Files:**
- Create: `apps/worker/src/ops/discard-signature-images.ts`
- Modify: `apps/worker/package.json` (scripts)
- Test: `apps/worker/src/ops/discard-signature-images.test.ts`

**Interfaces:**
- Consumes: `documents.update` semantics — the script appends a status change and a ledger event in one transaction, exactly as the router does.
- Produces: `pnpm --filter worker discard-signature-images`, and an exported `discardSignatureImages(db): Promise<{ scanned: number; discarded: number; skipped: number }>` so it is testable.

- [ ] **Step 1: Write the failing test**

```ts
it("discards email-attachment images named image.png, one ledger event each", async () => {
  const junkA = await seedDocument({ title: "image.png", mime: "image/png",
    source: "email-attachment" });
  const junkB = await seedDocument({ title: "image.png", mime: "image/png",
    source: "email-attachment" });
  const real = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf",
    source: "email-attachment" });
  const upload = await seedDocument({ title: "image.png", mime: "image/png",
    source: "upload" });

  const before = (await db.select().from(schema.ledgerEvents)).length;
  const out = await discardSignatureImages(db);

  expect(out.discarded).toBe(2);
  expect((await db.select().from(schema.ledgerEvents)).length).toBe(before + 2);

  expect((await effectiveDocument(db, junkA.id)).effectiveStatus).toBe("discarded");
  expect((await effectiveDocument(db, junkB.id)).effectiveStatus).toBe("discarded");
  // A real attachment and a hand-uploaded file are never touched.
  expect((await effectiveDocument(db, real.id)).effectiveStatus).toBe("inbox");
  expect((await effectiveDocument(db, upload.id)).effectiveStatus).toBe("inbox");
});

it("is idempotent — a second run appends nothing", async () => {
  await seedDocument({ title: "image.png", mime: "image/png", source: "email-attachment" });
  await discardSignatureImages(db);
  const after = (await db.select().from(schema.ledgerEvents)).length;

  const second = await discardSignatureImages(db);
  expect(second.discarded).toBe(0);
  expect(second.skipped).toBe(1);
  expect((await db.select().from(schema.ledgerEvents)).length).toBe(after);
});

it("leaves the ledger chain verifying", async () => {
  await seedDocument({ title: "image.png", mime: "image/png", source: "email-attachment" });
  await discardSignatureImages(db);
  await expect(verifyLedger(db)).resolves.toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_ENV pnpm --filter worker test discard-signature-images`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the script**

Create `apps/worker/src/ops/discard-signature-images.ts`. It must:

1. Select documents where `source = 'email-attachment'` AND `title = 'image.png'`.
2. Resolve each one's **effective** status and skip any already `discarded` — this is what makes it idempotent.
3. For each remaining one, in a single transaction: insert a `document_status_changes` row with status `discarded`, and append a `document.updated` ledger event with the same payload shape `documents.update` uses.
4. Print every document it is about to touch (id, title, size, source) before touching it, then print the totals.
5. Return `{ scanned, discarded, skipped }`.

Follow the structure of an existing ops script — `apps/worker/src/ops/extract-texts.ts` — for the db bootstrap, logging style, and the module-entry guard.

Add a doc comment recording *why* the title is the key: the disposition header is not retained on already-ingested documents, so post-hoc `title = 'image.png'` is the honest available signal, and it matched all nine in production on 2026-08-20.

- [ ] **Step 4: Register the script**

In `apps/worker/package.json` scripts, alongside `extract-texts`:

```json
"discard-signature-images": "tsx src/ops/discard-signature-images.ts"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u NODE_ENV pnpm --filter worker test discard-signature-images`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ops/discard-signature-images.ts \
  apps/worker/src/ops/discard-signature-images.test.ts apps/worker/package.json
git commit -m "feat(worker): backfill discard for the signature images already filed

One ledger event each, individually undoable, idempotent on re-run.
Matches on title because the disposition header is gone post-hoc."
```

---

### Task 8: Full verification and documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/deploy.md`

- [ ] **Step 1: Run everything**

```bash
env -u NODE_ENV pnpm -r test
env -u NODE_ENV pnpm -r typecheck
env -u NODE_ENV pnpm -r build
```
Expected: all green. Do not proceed on a failure.

- [ ] **Step 2: Prove the append-only law was not weakened**

Run: `git diff main...HEAD -- packages/db/drizzle/ | grep -iE "DROP|DELETE|REVOKE|UPDATE .*documents"`
Expected: no matches. The only schema change is the additive `ALTER TYPE`.

Run: `git diff main...HEAD | grep -nE "\.delete\(|DROP TABLE|unlink|rm -rf"`
Expected: no matches in source. Nothing is deleted anywhere in this change.

- [ ] **Step 3: Confirm the migration is additive and registered**

Run: `cat packages/db/drizzle/0021_discarded_doc_status.sql`
Expected: a single `ALTER TYPE ... ADD VALUE 'discarded';` plus comments.

Run: `python3 -c "import json;print([e['tag'] for e in json.load(open('packages/db/drizzle/meta/_journal.json'))['entries']][-2:])"`
Expected: ends with `0021_discarded_doc_status`.

- [ ] **Step 4: Update the docs**

Add to `CLAUDE.md`, in the homelab bullet after the spreadsheet-support sentence:

```
Junk-document discard (migration 0021, additive `doc_status` value `discarded` —
migrate from the host BEFORE deploying web/worker): `gmail-auth.ts` no longer
promotes message parts that are `Content-Disposition: inline` AND carry a
`Content-ID` (the `cid:` images an HTML body embeds), which were 56% of all
filed attachments; the decision is the pure `isInlineBodyImage` in
`apps/worker/src/gmail-parts.ts`, and a part with malformed headers is KEPT,
never skipped. Discard is a third `doc_status`, appended through
`document_status_changes` with its ledger event — never a delete, because
`documents` is append-only and already carries a `document.ingested` event.
Vault bytes are NEVER purged: it would reclaim ~1% of the vault, the image
stays inside the archived `.eml` anyway, and it would teach `nightly-verify`
that some missing files are acceptable. "Always discard" needs no rule table —
`ingestDocument` dedups on sha256, so a discarded document stays discarded for
those bytes forever. Backfill the ones already filed with `pnpm --filter worker
discard-signature-images` (idempotent).
```

Add to `docs/deploy.md` §7, after the spreadsheet backfill block:

```
After deploying junk-document discard, backfill the signature images that were
filed before it:
  pnpm --filter worker discard-signature-images   # idempotent; one ledger event each
Then check /verify: the hash chain must still verify.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/deploy.md
git commit -m "docs: junk-document discard notes and backfill step"
```

---

## Self-Review

**Spec coverage:** Prevention at the Gmail port → Task 2. `discarded` status + migration 0021 → Task 1. Hiding: vault list → Task 3, search → Task 4, queue → Task 5. UI Discard/Undo + banner → Task 6. Backfill → Task 7. Docs and the append-only proof → Task 8. Error handling: malformed headers keep the part (Task 2 Step 1), discard-twice is a no-op and the backfill is idempotent (Task 7 Step 1).

**Explicitly not implemented, per the spec:** purging vault bytes; any size/filename auto-discard heuristic; bulk discard; a discarded-browsing view.

**Type consistency checked:** `DocStatus = "inbox" | "filed" | "discarded"` is the same union in the schema enum (Task 1), the `update` and `list` inputs (Tasks 1, 3), and `discardAction` (Task 6). `isInlineBodyImage` takes the Gmail header array shape and returns a boolean in both its definition and its call site. `discardSignatureImages(db)` returns `{ scanned, discarded, skipped }` in both the test and the script description.

**The trap worth repeating:** discard lives in `document_status_changes`; `documents.status` keeps reading `"inbox"` forever. Tasks 3, 5, and 7 must all resolve the effective status, never the column. Task 5's step calls this out explicitly because `suggestions.list` already has `s.document` in hand and reading `.status` off it is the obvious wrong move.
