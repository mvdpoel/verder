import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { asc, eq, isNull, sql } from "drizzle-orm";
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

/** The main line and its first anchor, as migration 0023 seeded them into this
 *  freshly created eval database. Every track and stop fixture hangs off it —
 *  a second root is refused by tracks_single_root_uq, and rightly so. */
let mainLineCache: { rootId: string; anchorId: string } | null = null;
async function mainLine(db: Db): Promise<{ rootId: string; anchorId: string }> {
  if (mainLineCache) return mainLineCache;
  const [root] = await db.select().from(schema.tracks)
    .where(isNull(schema.tracks.parentTrackId));
  const [anchor] = await db.select({ id: schema.stops.id }).from(schema.stops)
    .where(eq(schema.stops.trackId, root.id)).orderBy(asc(schema.stops.orderIndex));
  mainLineCache = { rootId: root.id, anchorId: anchor.id };
  return mainLineCache;
}

/** Well past the seeded anchors (0…18 and 1000000), so a fixture halte never
 *  lands between two of them and changes the seeded line's reading order. */
let nextStopOrder = 2000000;

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
    case "track": {
      const { rootId, anchorId } = await mainLine(db);
      // A side track that ENDED: a clean outcome, and the shape the renderer
      // has to describe without making it sound like a failure.
      const [t] = await db.insert(schema.tracks).values({
        title: c.title, note: c.body, status: "ended",
        parentTrackId: rootId, branchesAtStopId: anchorId,
      }).returning();
      return { entityType: "track", entityId: t.id };
    }
    case "stop": {
      // Fixture haltes hang off the main line the migration seeded, so the
      // renderer resolves a real spoor title instead of an empty string.
      const { rootId } = await mainLine(db);
      const [s] = await db.insert(schema.stops).values({
        trackId: rootId, orderIndex: nextStopOrder++, title: c.title, note: c.body,
        kind: "process", state: "done", happenedAt: at,
        stage: (c.stage ?? null) as "application" | null,
      }).returning();
      return { entityType: "stop", entityId: s.id };
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
  // EVAL_KEEP=1 leaves the fixture database behind. The whole point of this
  // corpus is that it is clean — real nomic embeddings, no test stubs — so it is
  // the only honest place to measure ranking behaviour by hand.
  if (process.env.EVAL_KEEP === "1") {
    console.log(`\nkept ${EVAL_DB} (EVAL_KEEP=1) — drop it with:`
      + `\n  docker exec verder-postgres-1 psql -U verder -d postgres -c 'DROP DATABASE ${EVAL_DB} WITH (FORCE)'`);
  } else {
    const cleanup = createDb(ADMIN_URL);
    await cleanup.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${EVAL_DB} WITH (FORCE)`));
    await cleanup.pool.end();
  }
}
