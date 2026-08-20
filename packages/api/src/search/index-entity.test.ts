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
