import { describe, expect, it } from "vitest";
import { parseReindexArgs } from "./reindex";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import type { EmbedPort } from "@verder/api/src/search/embed";
import { runReindex } from "./reindex";

describe("parseReindexArgs", () => {
  it("defaults to the whole corpus with no pruning", () => {
    expect(parseReindexArgs([])).toEqual({ entity: null, since: null, prune: false });
  });

  it("reads --entity, --since and --prune", () => {
    expect(parseReindexArgs(["--entity=document", "--since=2026-01-31", "--prune"])).toEqual({
      entity: "document", since: new Date("2026-01-31T00:00:00Z"), prune: true,
    });
  });

  it("rejects an unknown entity type with a message naming the valid ones", () => {
    expect(() => parseReindexArgs(["--entity=invoice"]))
      .toThrow(/unknown entity type "invoice"/);
  });

  it("rejects a malformed --since", () => {
    expect(() => parseReindexArgs(["--since=yesterday"])).toThrow(/--since must be YYYY-MM-DD/);
    expect(() => parseReindexArgs(["--since=2026-02-30"])).toThrow(/not a real date/);
  });

  it("rejects an unknown flag instead of silently ignoring it", () => {
    // There is no env-var form of this CLI: an unrecognised argument must be loud,
    // or a partial backfill silently becomes a full one.
    expect(() => parseReindexArgs(["--dry-run"])).toThrow(/unknown argument "--dry-run"/);
    expect(() => parseReindexArgs(["REINDEX_ENTITY=document"]))
      .toThrow(/unknown argument "REINDEX_ENTITY=document"/);
  });
});

const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

/** Records every text handed to the embedder; returns a valid 768-dim vector so the
 * chunks really do get embeddings and the second pass has something to skip. */
function countingEmbed() {
  const seen: string[] = [];
  const port: EmbedPort = {
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
    },
  };
  return { port, seen };
}

const chunkCount = async (db: Db, entityId: string): Promise<number> =>
  ((await db.execute(sql`
    SELECT count(*)::int AS n FROM search_chunks WHERE entity_id = ${entityId}::uuid`))
    .rows as [{ n: number }])[0].n;

describe("runReindex", () => {
  it("re-embeds nothing on the second pass (idempotent by source_hash)", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const nonce = `rix${crypto.randomUUID().slice(0, 8)}`;
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Incasso ${nonce}` }).returning();

      const first = countingEmbed();
      const r1 = await runReindex({ db, embed: first.port },
        { entity: "party", since: null, prune: false });
      expect(r1.scanned).toBeGreaterThan(0);
      expect(first.seen.filter((t) => t.includes(nonce))).toHaveLength(1);
      expect(await chunkCount(db, party.id)).toBe(1);

      const second = countingEmbed();
      const r2 = await runReindex({ db, embed: second.port },
        { entity: "party", since: null, prune: false });
      expect(second.seen.filter((t) => t.includes(nonce))).toHaveLength(0);
      expect(r2.unchanged).toBeGreaterThan(0);
      expect(await chunkCount(db, party.id)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("finishes the corpus after an interrupted run", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const nonce = `rix${crypto.randomUUID().slice(0, 8)}`;
      const created = [];
      for (let i = 0; i < 3; i++) {
        const [p] = await db.insert(schema.parties)
          .values({ kind: "organization", name: `Deurwaarder ${nonce} ${i}` }).returning();
        created.push(p);
      }
      const mine = new Set(created.map((p) => p.id));

      // Simulate a kill -9: blow up from the progress hook once two of OUR parties are
      // done. Everything already indexed is committed, because every entity commits on
      // its own.
      const first = countingEmbed();
      let mineDone = 0;
      await expect(runReindex({
        db, embed: first.port,
        onProgress: ({ entityId }) => {
          if (mine.has(entityId) && ++mineDone === 2) throw new Error("simulated kill");
        },
      }, { entity: "party", since: null, prune: false })).rejects.toThrow(/simulated kill/);
      const afterCrash = await Promise.all(created.map((p) => chunkCount(db, p.id)));
      expect(afterCrash.filter((n) => n > 0)).toHaveLength(2);

      const second = countingEmbed();
      await runReindex({ db, embed: second.port },
        { entity: "party", since: null, prune: false });
      expect(await Promise.all(created.map((p) => chunkCount(db, p.id)))).toEqual([1, 1, 1]);
      // The rerun re-embedded exactly the one entity the crash left undone.
      expect(second.seen.filter((t) => t.includes(nonce))).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("--prune deletes chunks whose source row is gone, and nothing else", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const orphanId = crypto.randomUUID();
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Levend ${crypto.randomUUID().slice(0, 8)}` })
        .returning();
      await db.execute(sql`
        INSERT INTO search_chunks (entity_type, entity_id, chunk_index, title, body, source_hash)
        VALUES ('party', ${orphanId}::uuid, 0, 'wees', 'chunk zonder bronrij',
                ${`test-${crypto.randomUUID()}`})`);

      const embed = countingEmbed();
      await runReindex({ db, embed: embed.port }, { entity: "party", since: null, prune: false });
      expect(await chunkCount(db, orphanId)).toBe(1);

      const pruned = await runReindex({ db, embed: embed.port },
        { entity: "party", since: null, prune: true });
      expect(pruned.pruned).toBeGreaterThan(0);
      expect(await chunkCount(db, orphanId)).toBe(0);
      expect(await chunkCount(db, party.id)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("records every pass in worker_runs so a backfill is visible in system health", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const embed = countingEmbed();
      await runReindex({ db, embed: embed.port },
        { entity: "milestone", since: null, prune: false });
      const runs = await db.select().from(schema.workerRuns)
        .where(eq(schema.workerRuns.worker, "reindex"));
      expect(runs.some((r) => r.status === "ok"
        && (r.detail as Record<string, unknown> | null)?.entityType === "milestone")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
