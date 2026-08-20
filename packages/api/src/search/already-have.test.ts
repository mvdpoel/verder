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
      // Every term of the request must appear: websearch_to_tsquery ANDs its
      // terms, and with the embedder down the lexical half is the only half.
      body: `Loonstrook juni 2026 salarisspecificatie ${marker} werkgever opsturen`,
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
