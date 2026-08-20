import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from "@verder/core";
import { indexEntity } from "@verder/api/src/search/index-entity";
import type { EmbedPort } from "@verder/api/src/search/embed";
import { recordRun } from "./heartbeat";

/**
 * Full or partial rebuild of the search index. The index is DERIVED, so this is always
 * safe to run: it appends no ledger events, touches no evidence table, and is idempotent
 * by source_hash — unchanged text is never re-embedded. Every entity is committed on its
 * own, so a kill -9 loses at most one entity and a rerun picks up where it stopped.
 *
 * The indexing itself is indexEntity() from @verder/api: the same loader the search.drain
 * job uses, so a backfilled record and a trigger-refreshed record are byte-identical.
 */

/** Source table per entity type, plus the column --since filters on. Verified against
 * packages/db/src/schema.ts. */
const SOURCES: Record<SearchEntityType, { table: string; sinceColumn: string }> = {
  document:       { table: "documents",       sinceColumn: "received_at" },
  entry:          { table: "log_entries",     sinceColumn: "occurred_at" },
  email:          { table: "raw_emails",      sinceColumn: "sent_at" },
  financial_item: { table: "financial_items", sinceColumn: "created_at" },
  debt:           { table: "debts",           sinceColumn: "created_at" },
  task:           { table: "tasks",           sinceColumn: "created_at" },
  milestone:      { table: "milestones",      sinceColumn: "created_at" },
  timeline_event: { table: "timeline_events", sinceColumn: "happened_at" },
  party:          { table: "parties",         sinceColumn: "created_at" },
};

const PAGE = 500;

export type ReindexArgs = {
  entity: SearchEntityType | null;
  since: Date | null;
  prune: boolean;
};

const USAGE = "usage: reindex [--entity=<type>] [--since=YYYY-MM-DD] [--prune]";

/** Flags only — this CLI has no env-var form. An unrecognised argument throws rather
 * than being ignored, so a mistyped partial backfill can never silently become a full
 * one on the homelab. */
export function parseReindexArgs(argv: string[]): ReindexArgs {
  const args: ReindexArgs = { entity: null, since: null, prune: false };
  for (const raw of argv) {
    if (raw === "--prune") { args.prune = true; continue; }
    const m = /^--(entity|since)=(.+)$/.exec(raw);
    if (!m) throw new Error(`reindex: unknown argument "${raw}" (${USAGE})`);
    if (m[1] === "entity") {
      if (!(SEARCH_ENTITY_TYPES as readonly string[]).includes(m[2])) {
        throw new Error(
          `reindex: unknown entity type "${m[2]}" (one of ${SEARCH_ENTITY_TYPES.join(", ")})`);
      }
      args.entity = m[2] as SearchEntityType;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m[2])) {
        throw new Error(`reindex: --since must be YYYY-MM-DD, got "${m[2]}"`);
      }
      const d = new Date(`${m[2]}T00:00:00Z`);
      // V8 does NOT reject an out-of-range day: new Date("2026-02-30T00:00:00Z") rolls
      // over to March 2nd. Round-tripping the date back through toISOString() is what
      // actually catches it — a silently shifted --since would skip real rows.
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[2]) {
        throw new Error(`reindex: --since is not a real date: "${m[2]}"`);
      }
      args.since = d;
    }
  }
  return args;
}

export type ReindexResult = {
  scanned: number; chunks: number; embedded: number; unchanged: number; pruned: number;
};

/** Keyset page of source ids. Ordering by id keeps the walk stable while rows are being
 * inserted underneath it, which is exactly what a rerun after a crash relies on. */
async function pageIds(
  db: Db, entityType: SearchEntityType, since: Date | null, afterId: string | null,
): Promise<string[]> {
  const { table, sinceColumn } = SOURCES[entityType];
  // Both raw fragments come from the SOURCES map above — never from an argument.
  const rows = (await db.execute(sql`
    SELECT id FROM ${sql.raw(table)}
    WHERE (${since}::timestamptz IS NULL OR ${sql.raw(sinceColumn)} >= ${since}::timestamptz)
      AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
    ORDER BY id
    LIMIT ${sql.raw(String(PAGE))}`)).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/** Records are never deleted in this application, so orphans only appear if that ever
 * changes or if a chunk outlives a hand-rolled cleanup. --prune is the escape hatch. */
async function pruneOrphans(db: Db, entityType: SearchEntityType): Promise<number> {
  const { table } = SOURCES[entityType];
  const res = await db.execute(sql`
    DELETE FROM search_chunks c
    WHERE c.entity_type = ${entityType}
      AND NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} t WHERE t.id = c.entity_id)`);
  return res.rowCount ?? 0;
}

export async function runReindex(
  deps: {
    db: Db; embed: EmbedPort;
    onProgress?: (p: { entityType: SearchEntityType; entityId: string; done: number })
      => void | Promise<void>;
  },
  args: ReindexArgs,
): Promise<ReindexResult> {
  const types = args.entity ? [args.entity] : [...SEARCH_ENTITY_TYPES];
  const total: ReindexResult = { scanned: 0, chunks: 0, embedded: 0, unchanged: 0, pruned: 0 };

  for (const entityType of types) {
    const perType = { scanned: 0, chunks: 0, embedded: 0, unchanged: 0 };
    let afterId: string | null = null;
    for (;;) {
      const ids = await pageIds(deps.db, entityType, args.since, afterId);
      if (ids.length === 0) break;
      for (const id of ids) {
        // One entity, one commit: interrupting here loses at most this entity, and the
        // rerun skips everything whose source_hash is unchanged.
        const r = await indexEntity({ db: deps.db, embed: deps.embed }, entityType, id);
        perType.scanned++;
        perType.chunks += r.chunks;
        perType.embedded += r.embedded;
        perType.unchanged += r.unchanged;
        await deps.onProgress?.({ entityType, entityId: id, done: perType.scanned });
      }
      afterId = ids[ids.length - 1];
      if (ids.length < PAGE) break;
    }
    if (args.prune) total.pruned += await pruneOrphans(deps.db, entityType);
    total.scanned += perType.scanned;
    total.chunks += perType.chunks;
    total.embedded += perType.embedded;
    total.unchanged += perType.unchanged;
    await recordRun(deps.db, "reindex", "ok", { entityType, ...perType, prune: args.prune });
  }
  return total;
}
