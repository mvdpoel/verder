import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@verder/db";
import { retrieve } from "./retrieve";
import type { EmbedPort } from "./embed";
import { schema } from "@verder/db";
import { and, eq } from "drizzle-orm";
import type { RerankPort } from "./rerank";

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

  it("never returns chunks belonging to a discarded document", async () => {
    const w = testWindow();
    const junk = crypto.randomUUID();
    const keep = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId: junk, title: "image.png",
      body: "linkedin handtekening logo opzegging", occurredAt: w.start, status: "discarded" });
    await insertChunk(writer, { entityType: "document", entityId: keep, title: "Beschikking.pdf",
      body: "linkedin handtekening logo opzegging", occurredAt: w.start, status: "filed" });

    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "handtekening logo", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.title)).toEqual(["Beschikking.pdf"]);
  });

  it("still returns chunks whose status is null", async () => {
    // Most entity types have no status at all; they must not be filtered out.
    // `status = 'discarded'` is false for NULL, but a careless `<>` yields NULL and
    // would silently drop every statusless entity. IS DISTINCT FROM is what keeps them.
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "email", entityId, title: "Mail van VerderGroep",
      body: "een unieke zoekterm in een mailbericht", occurredAt: w.start, status: null });
    const out = await retrieve({ db, embed: fixedEmbed(null) },
      { q: "unieke zoekterm", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.title)).toContain("Mail van VerderGroep");
  });

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
    await insertChunk(writer, { entityType: "stop", entityId, title: "Zitting",
      body: "toelating tot de wettelijke schuldsanering", occurredAt: w.start,
      embedding: oneHot(23) });
    // The query shares no lexeme with the body, so only the vector branch can find it.
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(23)) },
      { q: "kadaster erfpachtcanon", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("semantic");
    expect(out.hits[0].snippet).toBe("toelating tot de wettelijke schuldsanering");
    expect(out.hits[0].snippet).not.toContain("«");
    expect(out.hits[0].href).toBe(`/timeline?stop=${entityId}`);
  });

  it("ignores a chunk left behind by a retired entity kind instead of crashing on it", async () => {
    // entity_type is TEXT, and the milestone/timeline_event chunks written before
    // sub-project 6 survive the swap: `reindex --prune` walks the CURRENT
    // vocabulary and never visits a kind that is no longer in it. HREF has no
    // entry for one, so a single such row reaching the hit loop would take the
    // WHOLE query down with "HREF[...] is not a function" — not one bad row.
    const w = testWindow();
    const retired = crypto.randomUUID();
    const kept = crypto.randomUUID();
    await insertChunk(writer, { entityType: "milestone", entityId: retired,
      title: "Zitting mijlpaal", body: "toelating tot de wettelijke schuldsanering",
      occurredAt: w.start, embedding: oneHot(31) });
    await insertChunk(writer, { entityType: "stop", entityId: kept,
      title: "Zitting halte", body: "toelating tot de wettelijke schuldsanering",
      occurredAt: w.start, embedding: oneHot(31) });

    const out = await retrieve({ db, embed: fixedEmbed(oneHot(31)) },
      { q: "toelating schuldsanering", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([kept]);
    expect(out.hits[0].href).toBe(`/timeline?stop=${kept}`);

    // Every other fixture here may be left behind — this one may not. The dev
    // database is shared, and tracks-schema.test.ts asserts that migration
    // 0023's DELETE holds: NO chunk of a retired kind anywhere. A probe that
    // outlives its own test would fail that assertion on the next run, which is
    // exactly what it did before this line existed. search_chunks is derived,
    // so deleting from it is legal.
    await writer.execute(sql`DELETE FROM search_chunks WHERE entity_id = ${retired}::uuid`);
  });

  it("returns nothing when no word matches and every vector is far away", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId, title: "Zorgpolis 2026",
      body: "polisblad zorgverzekering eigen risico", occurredAt: w.start,
      embedding: oneHot(5) });
    // Nothing we hold: no shared lexeme, and an orthogonal vector (cosine distance
    // 1.0). Nearest-neighbour search always returns SOMETHING, so without a
    // relevance floor this asks "do we have a lasagne recipe?" and gets back a
    // health-insurance policy stated with a straight face.
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(400)) },
      { q: "recept lasagne bolognese", from: w.from, to: w.to });
    expect(out.hits).toEqual([]);
  });

  it("keeps a keyword hit even when its vector is far from the query", async () => {
    const w = testWindow();
    const entityId = crypto.randomUUID();
    await insertChunk(writer, { entityType: "document", entityId, title: "Opzegbrief",
      body: "opzegging van het abonnement", occurredAt: w.start, embedding: oneHot(7) });
    // The floor gates the fuzzy branch only. A chunk that literally contains the
    // word is a real hit however far apart the vectors are — otherwise the floor
    // would quietly cost us exact-term recall, which is the one thing full text is for.
    const out = await retrieve({ db, embed: fixedEmbed(oneHot(400)) },
      { q: "opzegging", from: w.from, to: w.to });
    expect(out.hits.map((h) => h.entityId)).toEqual([entityId]);
    expect(out.hits[0].matchedBy).toBe("keyword");
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
});
