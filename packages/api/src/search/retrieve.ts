import { sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { rrfFuse, type SearchEntityType, type SearchStatus } from "@verder/core";
import { asQuery, type EmbedPort } from "./embed";
import { RERANK_PROMPT_VERSION, type RerankPort } from "./rerank";

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
/** The spec's deep budget: rerank the top 20 collapsed entities, never the whole page set. */
const RERANK_TOP_N = 20;
/** worker_runs.worker for a degraded rerank, so a silently degraded search is visible
 * beside the other jobs on the dashboard's system-health list. */
const RERANK_WORKER_NAME = "search-rerank";

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

export async function retrieve(
  deps: { db: Db; embed: EmbedPort; rerank?: RerankPort },
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
