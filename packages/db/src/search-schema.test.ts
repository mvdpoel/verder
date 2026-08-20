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
