import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

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
