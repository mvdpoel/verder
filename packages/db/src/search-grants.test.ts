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

    // SETTLE THE DOCUMENT the delete above just un-settled. `documents` is
    // append-only evidence and no role here may delete one, so the fixture is
    // permanent — and a document with no document_texts row is a permanent
    // entry in pendingDocMeta's `ORDER BY created_at ASC LIMIT 50` page on a
    // dev database nothing truncates. Seven "Gescande brief" rows had
    // accumulated at the head of it, crowding freshly created documents off the
    // page and turning docmeta-sweep.test.ts red for reasons with nothing to do
    // with the sweep. Restoring the "none" row an unreadable file would have
    // earned costs this test nothing: the DELETE grant is already proven above.
    await worker.insert(schema.documentTexts).values({
      documentId: doc.id, sha256: sha, text: "", extractor: "none", charCount: 0,
    });
  });

  it("lets the app role read the index but never write it", async () => {
    const entityId = crypto.randomUUID();
    // A LIVE entity kind. entity_type is opaque to a grant, but this suite runs
    // in parallel with tracks-schema.test.ts, which asserts that no chunk of a
    // retired kind ('milestone', 'timeline_event') is left anywhere — a fixture
    // labelled with one of those would fail that test on timing alone.
    const [chunk] = await worker.insert(schema.searchChunks).values({
      entityType: "stop", entityId, chunkIndex: 0,
      title: "Toelating WSNP", body: "Zitting gepland.", sourceHash: "c".repeat(64),
    }).returning();

    const seen = await app.select({ title: schema.searchChunks.title })
      .from(schema.searchChunks).where(eq(schema.searchChunks.id, chunk.id));
    expect(seen.map((r) => r.title)).toEqual(["Toelating WSNP"]);

    // The web app still never MAINTAINS the index: no INSERT, no UPDATE, on
    // either table. But since migration 0034 it may DESTROY an entry — that
    // is what "definitief verwijderen" needs in order to take a purged
    // document's extracted text and search chunks down with it — and that is
    // lawful precisely because neither table is evidence: both are derived
    // and rebuildable (`pnpm --filter worker reindex`), so a DELETE here is
    // not the same act as a DELETE on `documents` would be.
    await expect(
      app.insert(schema.searchChunks).values({
        entityType: "stop", entityId, chunkIndex: 1,
        title: "Verboden", body: "verboden", sourceHash: "d".repeat(64),
      }),
    ).rejects.toThrow(/permission denied for table search_chunks/);
    await expect(
      app.update(schema.searchChunks).set({ title: "tampered" })
        .where(eq(schema.searchChunks.id, chunk.id)),
    ).rejects.toThrow(/permission denied for table search_chunks/);
    await expect(
      app.insert(schema.documentTexts).values({
        documentId: crypto.randomUUID(), sha256: "e".repeat(64),
        text: "verboden", extractor: "none", charCount: 8,
      }),
    ).rejects.toThrow(/permission denied for table document_texts/);
    await expect(
      app.update(schema.documentTexts).set({ text: "tampered" })
        .where(eq(schema.documentTexts.documentId, crypto.randomUUID())),
    ).rejects.toThrow(/permission denied for table document_texts/);

    // The purge path itself: the app role CAN delete a chunk...
    const deletedChunk = await app.delete(schema.searchChunks)
      .where(eq(schema.searchChunks.id, chunk.id)).returning();
    expect(deletedChunk).toHaveLength(1);

    // ...and a document_texts row.
    const purgeSha = `kbg${crypto.randomUUID().replace(/-/g, "")}`.padEnd(64, "0").slice(0, 64);
    const [purgedDoc] = await worker.insert(schema.documents).values({
      sha256: purgeSha,
      title: "Te vernietigen document",
      mime: "application/pdf",
      sizeBytes: 1234,
      source: "nas-scan",
      receivedAt: new Date("2026-08-02T00:00:00Z"),
    }).returning();
    await worker.insert(schema.documentTexts).values({
      documentId: purgedDoc.id, sha256: purgeSha, text: "geheim", extractor: "pdf-parse", charCount: 6,
    });
    const deletedText = await app.delete(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, purgedDoc.id)).returning();
    expect(deletedText).toHaveLength(1);

    // SETTLE THE DOCUMENT the delete above just un-settled, for the same
    // reason the worker-role test above does it: `documents` is append-only
    // evidence nobody here may delete, so this fixture is permanent, and a
    // document with no document_texts row is a permanent entry in
    // pendingDocMeta's LIMIT 50 page on a dev database nothing truncates.
    await worker.insert(schema.documentTexts).values({
      documentId: purgedDoc.id, sha256: purgeSha, text: "", extractor: "none", charCount: 0,
    });
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
