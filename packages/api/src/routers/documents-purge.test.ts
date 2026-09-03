import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor, readFilePath } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// document_texts/search_chunks are worker-owned (0016_search_grants.sql):
// verder_app holds SELECT and, since 0034, DELETE — never INSERT. In
// production the worker's extractor and search drain write these rows;
// makeDoc below simulates that with the same WORKER_URL connection
// search.test.ts already uses for the identical reason.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const RUN_REF = `documents-purge-test-${crypto.randomUUID()}`;

const exists = (p: string) => access(p).then(() => true, () => false);

describe("documents.purge", () => {
  let db: Db; let writer: Db; let close: () => Promise<void>; let userId: string;
  let vaultDir: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    db = c.db;
    writer = createDb(WORKER_URL).db;
    close = () => c.pool.end();
    vaultDir = mkdtempSync(join(tmpdir(), "vault-purge-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  /** A document whose bytes really are on disk, plus an extracted-text row and
   *  a search chunk — the three things a purge has to destroy. */
  async function makeDoc(label: string) {
    const c = caller();
    const buf = Buffer.from(`${label}-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({
      sha256: sha, sizeBytes: buf.length, mime: "text/plain", title: label,
      source: "upload", sourceRef: RUN_REF, receivedAt: new Date() });
    await writer.execute(sql`INSERT INTO document_texts
      (document_id, sha256, text, extractor, char_count)
      VALUES (${doc.id}, ${sha}, ${'geheime inhoud'}, 'none', 14)`);
    await writer.execute(sql`INSERT INTO search_chunks
      (entity_type, entity_id, chunk_index, title, body, source_hash)
      VALUES ('document', ${doc.id}, 0, ${label}, ${'geheime inhoud'}, 'h')`);
    return { doc, sha, abs, buf };
  }

  it("destroys the bytes, the text and the chunks, and records one purge", async () => {
    const c = caller();
    const { doc, sha, abs } = await makeDoc("Te vernietigen");
    const before = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.ledgerEvents);

    const res = await c.documents.purge({ id: doc.id, reason: "per ongeluk gescand" });

    expect(res.purge).toMatchObject({ sha256: sha, reason: "per ongeluk gescand" });
    expect(await exists(abs)).toBe(false);
    const texts = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(texts).toHaveLength(0);
    const chunks = await db.select().from(schema.searchChunks)
      .where(and(eq(schema.searchChunks.entityType, "document"),
        eq(schema.searchChunks.entityId, doc.id)));
    expect(chunks).toHaveLength(0);

    // Exactly ONE event. A purge is one decision.
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    expect(after[0].n - before[0].n).toBe(1);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.eventType, "document.purged"),
        eq(schema.ledgerEvents.entityId, doc.id)));
    expect(ev).toBeTruthy();
  });

  // The documents row is the ledger's anchor and must survive. Its title and
  // sha256 are what the tombstone shows.
  it("keeps the documents row", async () => {
    const c = caller();
    const { doc } = await makeDoc("Rij blijft");
    await c.documents.purge({ id: doc.id });
    const got = await c.documents.get({ id: doc.id });
    expect(got.id).toBe(doc.id);
    expect(got.effectiveTitle).toBe("Rij blijft");
    expect(got.purge).not.toBeNull();
  });

  // One decision, one row, one event — the law documents.update already
  // follows for a repeated discard. The UNIQUE constraint would otherwise
  // turn a double click into a 500.
  it("is a no-op the second time", async () => {
    const c = caller();
    const { doc } = await makeDoc("Twee keer");
    const first = await c.documents.purge({ id: doc.id, reason: "eerste" });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    const second = await c.documents.purge({ id: doc.id, reason: "tweede" });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents);
    expect(after[0].n).toBe(before[0].n);
    // The FIRST reason stands. A second call must not rewrite the record.
    expect(second.purge?.reason).toBe("eerste");
    expect(second.purge?.at).toEqual(first.purge?.at);
  });

  // The unlink runs AFTER the commit, so its failure leaves a purge record
  // whose bytes are still on disk. That state must be visible, or it is
  // silent and permanent.
  it("reports bytes still on disk, and a repeat purge clears them", async () => {
    const c = caller();
    const { doc, sha, buf } = await makeDoc("Achtergebleven bytes");
    await c.documents.purge({ id: doc.id });
    // Simulate the failed unlink by putting the file back — the ORIGINAL bytes,
    // which is what a failed unlink actually leaves. Arbitrary bytes would now
    // be refused by the pre-purge hash check, and would be testing that instead.
    const abs = readFilePath(vaultDir, sha);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const stale = await c.documents.get({ id: doc.id });
    expect(stale.purge?.bytesStillOnDisk).toBe(true);
    const retried = await c.documents.purge({ id: doc.id });
    expect(retried.purge?.bytesStillOnDisk).toBe(false);
    expect(await exists(abs)).toBe(false);
  });

  /**
   * THE RETRY BUTTON IS THE REPAIR FOR ALL THREE KINDS OF LEFTOVER, not only
   * for bytes. Both guards that keep a concurrent writer out of these tables
   * (storeDocumentText, indexEntity's re-check after the embed) are
   * check-then-act, so the window is narrow and not zero — and a purge writes
   * neither `documents` nor `document_status_changes`, so nothing re-enqueues
   * the document afterwards and nothing notices on its own. A second click has
   * to sweep whatever landed, which is why both DELETEs run on the no-op path.
   */
  it("re-runs both deletes on a repeat purge, not only the unlink", async () => {
    const c = caller();
    const { doc, sha } = await makeDoc("Nagekomen tekst");
    await c.documents.purge({ id: doc.id });

    // A writer that was already running when the purge committed.
    await writer.execute(sql`INSERT INTO document_texts
      (document_id, sha256, text, extractor, char_count)
      VALUES (${doc.id}, ${sha}, ${'teruggekomen inhoud'}, 'none', 19)`);
    await writer.execute(sql`INSERT INTO search_chunks
      (entity_type, entity_id, chunk_index, title, body, source_hash)
      VALUES ('document', ${doc.id}, 0, 'Nagekomen tekst', ${'teruggekomen inhoud'}, 'h2')`);

    await c.documents.purge({ id: doc.id });

    expect(await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id))).toHaveLength(0);
    expect(await db.select().from(schema.searchChunks)
      .where(and(eq(schema.searchChunks.entityType, "document"),
        eq(schema.searchChunks.entityId, doc.id)))).toHaveLength(0);
  });

  it("reports purge: null for a document nobody purged", async () => {
    const c = caller();
    const { doc } = await makeDoc("Nog springlevend");
    const got = await c.documents.get({ id: doc.id });
    expect(got.purge).toBeNull();
  });

  /**
   * A PURGE MUST NOT SILENCE A file-hash-mismatch. /verify re-hashes every
   * vault file, so altered bytes turn it red; the purged branch then compares
   * two DATABASE columns and never touches the disk, so purging the document
   * would turn /verify green again and the record would say only "destroyed",
   * never "altered, then destroyed".
   *
   * Refused rather than recorded: bytes that do not match the ledger are
   * evidence of tampering, and destroying them is worse than leaving them
   * where /verify keeps pointing at them. Recording the mismatch instead would
   * need a column, and migration 0034 is already applied.
   */
  it("refuses to destroy bytes that do not match what the dossier recorded", async () => {
    const c = caller();
    const { doc, abs } = await makeDoc("Aangetast in de kluis");
    await writeFile(abs, Buffer.from("iemand heeft hieraan gezeten"));

    await expect(c.documents.purge({ id: doc.id })).rejects.toThrow(/kluis/i);

    // Nothing at all happened: no record, no event, and above all the bytes
    // are still there for /verify to keep reporting.
    expect(await exists(abs)).toBe(true);
    expect(await db.select().from(schema.documentPurges)
      .where(eq(schema.documentPurges.documentId, doc.id))).toHaveLength(0);
    expect(await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.eventType, "document.purged"),
        eq(schema.ledgerEvents.entityId, doc.id)))).toHaveLength(0);
    expect(await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id))).toHaveLength(1);
  });

  it("purges normally when the bytes still match", async () => {
    const c = caller();
    const { doc, abs } = await makeDoc("Ongeschonden");
    const res = await c.documents.purge({ id: doc.id });
    expect(res.purge).not.toBeNull();
    expect(await exists(abs)).toBe(false);
  });

  // There is nothing left to protect, so the check must not stand in the way:
  // this is the repairable half-done state /verify already reports (a purge
  // whose ledger event exists and whose bytes are gone), and the second click
  // still has both DELETEs and the tombstone to write.
  it("purges normally when the file is already gone", async () => {
    const c = caller();
    const { doc, abs } = await makeDoc("Bestand al weg");
    await unlink(abs);
    const res = await c.documents.purge({ id: doc.id, reason: "handmatig opgeruimd" });
    expect(res.purge).toMatchObject({ reason: "handmatig opgeruimd" });
  });

  it("is NOT_FOUND for an unknown document", async () => {
    const c = caller();
    await expect(c.documents.purge({ id: crypto.randomUUID() })).rejects.toThrow(/not found/i);
  });
});
