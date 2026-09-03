import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";
import { EMBED_DIMENSIONS, type EmbedPort } from "./embed";
import { indexEntity } from "./index-entity";

// Same fake embed port index-entity.test.ts uses: deterministic, no network.
function fakeEmbed(): EmbedPort {
  return {
    embed: async (texts: string[]) =>
      texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))),
  };
}

// The WORKER role: indexEntity runs on the worker connection in production,
// and search_chunks is the worker's table (0016).
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const RUN_REF = `index-entity-purge-test-${crypto.randomUUID()}`;

describe("indexEntity on a purged document", () => {
  let app: Db; let worker: Db; let closers: (() => Promise<void>)[] = [];
  let userId: string; let vaultDir: string;

  beforeAll(async () => {
    const a = createDb(APP_URL); const w = createDb(WORKER_URL);
    app = a.db; worker = w.db;
    closers = [() => a.pool.end(), () => w.pool.end()];
    vaultDir = mkdtempSync(join(tmpdir(), "vault-index-purge-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await app.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(async () => { for (const c of closers) await c(); });

  const chunks = (id: string) => worker.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "document"),
      eq(schema.searchChunks.entityId, id)));

  /**
   * THE TRAP THIS TEST EXISTS FOR: `reindex` walks every document and calls
   * indexEntity, which rebuilds a chunk from title and metadata alone — the
   * extracted text is optional. So without a purge check, the nightly reindex
   * puts a definitief verwijderd document back into /search under its own name,
   * days after it was destroyed.
   */
  it("leaves zero chunks, and creates none on a second pass", async () => {
    const c = appRouter.createCaller(createContext({ db: app, userId }));
    const buf = Buffer.from(`resurrect-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verdwijnt uit zoeken", source: "upload",
      sourceRef: RUN_REF, receivedAt: new Date() });

    await indexEntity({ db: worker, embed: fakeEmbed() }, "document", doc.id);
    expect((await chunks(doc.id)).length).toBeGreaterThan(0);

    await c.documents.purge({ id: doc.id, reason: "hoort hier niet" });
    expect(await chunks(doc.id)).toHaveLength(0);

    // The reindex pass. This is the one that used to bring it back.
    await indexEntity({ db: worker, embed: fakeEmbed() }, "document", doc.id);
    expect(await chunks(doc.id)).toHaveLength(0);
  });

  /**
   * THE WINDOW THE renderRow CHECK CANNOT SEE. renderRow asks about the purge,
   * then the EMBED runs — a network call to Ollama, seconds under load — and
   * only then are the chunks written. A purge committing inside that gap
   * deletes chunks that do not exist yet, and this function writes them back
   * afterwards.
   *
   * Nothing repairs it on its own: a purge writes neither `documents` nor
   * `document_status_changes`, so no search_outbox trigger fires and the
   * destroyed document sits in /search and the palette until somebody hand-runs
   * `reindex`. The purge lands INSIDE the fake port here, which is exactly the
   * ordering production produces.
   */
  it("writes no chunks when the purge commits during the embed", async () => {
    const c = appRouter.createCaller(createContext({ db: app, userId }));
    const buf = Buffer.from(`race-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verdwijnt tijdens het indexeren", source: "upload",
      sourceRef: RUN_REF, receivedAt: new Date() });

    const embedThenPurge: EmbedPort = {
      embed: async (texts: string[]) => {
        await c.documents.purge({ id: doc.id, reason: "tijdens het indexeren" });
        return texts.map(() =>
          Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)));
      },
    };
    const res = await indexEntity({ db: worker, embed: embedThenPurge }, "document", doc.id);

    expect(await chunks(doc.id)).toHaveLength(0);
    expect(res).toEqual({ chunks: 0, embedded: 0, unchanged: 0 });
  });
});
