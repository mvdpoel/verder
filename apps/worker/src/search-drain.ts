import { asc, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from "@verder/core";
import { type EmbedPort } from "@verder/api/src/search/embed";
import { indexEntity } from "@verder/api/src/search/index-entity";
import { DRAIN_WORKER_NAME } from "@verder/api/src/search/health";
import { recordRun } from "./heartbeat";

/**
 * search.drain (cron, every 60 s): outbox rows -> deduped entities ->
 * indexEntity (re-render, re-chunk, re-embed only what changed, upsert) ->
 * delete the rows that are fully done.
 *
 * The index is DERIVED, not evidence: it appends no ledger events, and it may
 * UPDATE and DELETE its own rows. Nothing here can corrupt the record; the
 * worst it can do is fail to find something, which index health on /verify
 * makes visible.
 */

const DEFAULT_LIMIT = 500;

/** entity_type is a plain text column, and a kind can be retired out from under
 *  a queued row — 'milestone' and 'timeline_event' were, in sub-project 6.
 *  Anything outside this set is not indexable by this build. */
const INDEXABLE = new Set<string>(SEARCH_ENTITY_TYPES);

export interface DrainResult {
  claimed: number;
  indexed: number;
  failed: number;
  /** Rows for an entity type this build cannot index. Dropped, not retried. */
  skipped: number;
}

export async function drainOnce(
  deps: { db: Db; embed: EmbedPort },
  opts: { limit?: number; entityIds?: string[] } = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // entityIds exists for the tests: the dev database is shared, so a suite that
  // drained the whole outbox would index — and with a stub embedder, mangle —
  // every other suite's records.
  if (opts.entityIds && opts.entityIds.length === 0) {
    return { claimed: 0, indexed: 0, failed: 0, skipped: 0 };
  }

  // Claim by id, ascending. Anything enqueued while this sweep runs gets a
  // higher id and stays in the outbox, so a write during the sweep is never
  // lost.
  const claimed = opts.entityIds
    ? await deps.db.select().from(schema.searchOutbox)
        .where(inArray(schema.searchOutbox.entityId, opts.entityIds))
        .orderBy(asc(schema.searchOutbox.id)).limit(limit)
    : await deps.db.select().from(schema.searchOutbox)
        .orderBy(asc(schema.searchOutbox.id)).limit(limit);

  const result: DrainResult = { claimed: claimed.length, indexed: 0, failed: 0, skipped: 0 };
  if (claimed.length === 0) {
    await recordRun(deps.db, DRAIN_WORKER_NAME, "ok",
      { ...result, retained: 0, skippedTypes: [], failures: [] });
    return result;
  }

  const done: number[] = [];
  const failures: { scope: string; message: string }[] = [];

  // Dedupe: an entity touched ten times between sweeps is re-indexed once.
  const entities = new Map<string,
    { entityType: SearchEntityType; entityId: string; rowIds: number[] }>();
  // A row for an entity type this build does not know — a retired kind whose
  // trigger is still installed, or a newer build's kind after a rollback.
  // indexEntity's exhaustive default THROWS on it, and before this check that
  // threw once per row per sweep: the row was retained, retried every 60 s, and
  // every single drain run recorded as `error` forever. It is DERIVED data with
  // nothing to derive, so it is dropped and counted, never retried and never
  // allowed to fail the sweep around it.
  const skippedTypes = new Set<string>();
  for (const row of claimed) {
    if (!INDEXABLE.has(row.entityType)) {
      skippedTypes.add(row.entityType);
      done.push(row.id);
      result.skipped++;
      continue;
    }
    const key = `${row.entityType}:${row.entityId}`;
    const seen = entities.get(key);
    if (seen) seen.rowIds.push(row.id);
    else entities.set(key, {
      entityType: row.entityType as SearchEntityType,
      entityId: row.entityId,
      rowIds: [row.id],
    });
  }

  for (const entity of entities.values()) {
    try {
      const { chunks, embedded, unchanged } = await indexEntity(
        { db: deps.db, embed: deps.embed }, entity.entityType, entity.entityId);
      if (embedded + unchanged === chunks) {
        // Every chunk has a vector (or the entity is gone and has no chunks at
        // all): the outbox rows can go.
        done.push(...entity.rowIds);
        result.indexed++;
      }
      // Otherwise some chunk landed with a NULL embedding — Ollama is down. The
      // chunks are written and lexically searchable, and the rows stay enqueued
      // so the next sweep retries the vectors. That is the spec's degraded
      // mode; the backlog is visible as outbox depth on /verify.
    } catch (err) {
      // One broken entity must never stop the sweep (same discipline as
      // registry.mine). Its rows stay enqueued and the failure is recorded.
      failures.push({ scope: `${entity.entityType}:${entity.entityId}`, message: String(err) });
      result.failed++;
    }
  }

  if (done.length > 0) {
    await deps.db.delete(schema.searchOutbox).where(inArray(schema.searchOutbox.id, done));
  }

  // A skipped row is not a failure: nothing is broken, there is simply no such
  // record to index. The run stays `ok` and names the types it dropped, so
  // /verify shows it once instead of an error every minute.
  await recordRun(deps.db, DRAIN_WORKER_NAME, failures.length > 0 ? "error" : "ok",
    { ...result, entities: entities.size, retained: claimed.length - done.length,
      skippedTypes: [...skippedTypes].sort(), failures });
  return result;
}
