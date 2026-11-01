import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// document_texts is worker-owned (0016): verder_app holds SELECT and DELETE,
// never INSERT, so the fixture text is written the way the extractor writes it.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const RUN_REF = `dossier-sync-test-${crypto.randomUUID()}`;

type Delta = Awaited<ReturnType<ReturnType<typeof appRouter.createCaller>["dossierSync"]["delta"]>>;

describe("dossierSync", () => {
  let db: Db; let writer: Db; let close: () => Promise<void>; let userId: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    db = c.db;
    const w = createDb(WORKER_URL);
    writer = w.db;
    close = async () => { await c.pool.end(); await w.pool.end(); };
    process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-dossier-"));
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  /** The newest seq right now: a delta from here sees only what a test does next. */
  async function head(): Promise<number> {
    const [r] = await db.select({ n: sql<string | null>`max(seq)` }).from(schema.ledgerEvents);
    return Number(r.n ?? 0);
  }

  /** A document with its bytes on disk and a document_texts row (extractor
   *  `none` unless text is given, so pendingDocMeta never sees it). */
  async function makeDoc(label: string, text = "") {
    const buf = Buffer.from(`${label}-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(process.env.VAULT_DIR!, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await caller().documents.registerUpload({
      sha256: sha, sizeBytes: buf.length, mime: "application/pdf", title: label,
      source: "upload", sourceRef: RUN_REF, receivedAt: new Date("2026-10-29T09:00:00Z") });
    await writer.execute(sql`INSERT INTO document_texts
      (document_id, sha256, text, extractor, char_count)
      VALUES (${doc.id}, ${sha}, ${text}, ${text ? "pdf-parse" : "none"}, ${text.length})`);
    return doc;
  }

  /** Every page from `cursor` to the end, at `limit` per page. */
  async function drain(cursor: number, limit = 50): Promise<Delta[]> {
    const pages: Delta[] = [];
    for (let i = 0; i < 1000; i++) {
      const page = await caller().dossierSync.delta({ cursor, limit });
      pages.push(page);
      if (!page.more) return pages;
      expect(page.cursor).toBeGreaterThan(cursor);
      cursor = page.cursor;
    }
    throw new Error("delta never ended");
  }

  it("new document arrives as an upsert", async () => {
    const from = await head();
    const doc = await makeDoc("Beschikking bewind", "Beschikking van de rechtbank");
    const pages = await drain(from);
    const ups = pages.flatMap((p) => p.upserts).filter((d) => d.id === doc.id);
    expect(ups).toEqual([{
      id: doc.id, title: "Beschikking bewind", docType: null, status: "inbox",
      receivedAt: "2026-10-29T09:00:00.000Z", mime: "application/pdf",
      sizeBytes: doc.sizeBytes, sha256: doc.sha256, hasText: true,
    }]);
    expect(pages.flatMap((p) => p.tombstones).map((t) => t.id)).not.toContain(doc.id);
    // The cursor of the last page is the newest seq: a second sync is empty.
    const again = await caller().dossierSync.delta({ cursor: pages.at(-1)!.cursor, limit: 50 });
    expect(again.upserts.map((d) => d.id)).not.toContain(doc.id);
  });

  it("a document without extracted text says so", async () => {
    const from = await head();
    const doc = await makeDoc("Scan zonder tekst");
    const ups = (await drain(from)).flatMap((p) => p.upserts).filter((d) => d.id === doc.id);
    expect(ups[0].hasText).toBe(false);
  });

  it("a rename travels as an upsert with the effective title", async () => {
    const doc = await makeDoc("scan_0042");
    const from = await head();
    await caller().documents.update({ id: doc.id, status: "filed", title: "Brief CAK", docType: "brief" });
    const ups = (await drain(from)).flatMap((p) => p.upserts).filter((d) => d.id === doc.id);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ title: "Brief CAK", docType: "brief", status: "filed" });
  });

  it("purged id comes back as a tombstone", async () => {
    const doc = await makeDoc("Te vernietigen");
    const from = await head();
    await caller().documents.purge({ id: doc.id, reason: "test" });
    const pages = await drain(from);
    expect(pages.flatMap((p) => p.tombstones).filter((t) => t.id === doc.id))
      .toEqual([{ id: doc.id, reason: "purged" }]);
    expect(pages.flatMap((p) => p.upserts).map((d) => d.id)).not.toContain(doc.id);
  });

  it("discarded id comes back as a tombstone", async () => {
    const doc = await makeDoc("Handtekening-logo");
    const from = await head();
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const pages = await drain(from);
    expect(pages.flatMap((p) => p.tombstones).filter((t) => t.id === doc.id))
      .toEqual([{ id: doc.id, reason: "discarded" }]);
    expect(pages.flatMap((p) => p.upserts).map((d) => d.id)).not.toContain(doc.id);
  });

  it("undone discard comes back as an upsert", async () => {
    const doc = await makeDoc("Per ongeluk weggegooid");
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const from = await head();
    await caller().documents.update({ id: doc.id, status: "inbox" });
    const pages = await drain(from);
    expect(pages.flatMap((p) => p.upserts).filter((d) => d.id === doc.id)).toHaveLength(1);
    expect(pages.flatMap((p) => p.tombstones).map((t) => t.id)).not.toContain(doc.id);
  });

  it("a purged and discarded document is tombstoned as purged", async () => {
    const doc = await makeDoc("Weg en vernietigd");
    const from = await head();
    await caller().documents.update({ id: doc.id, status: "discarded" });
    await caller().documents.purge({ id: doc.id, reason: "test" });
    const t = (await drain(from)).flatMap((p) => p.tombstones).filter((x) => x.id === doc.id);
    expect(t).toEqual([{ id: doc.id, reason: "purged" }]);
  });

  it("purged id resolves through the same predicate as /files", async () => {
    const doc = await makeDoc("Zelfde definitie");
    // A document_purges row WITHOUT its document.purged event: /verify's
    // definition (the event) says not purged, the display definition (the row)
    // says purged. The phone follows /files. The rename only moves the seq.
    await db.insert(schema.documentPurges).values({
      documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes, createdBy: userId });
    const from = await head();
    await caller().documents.update({ id: doc.id, status: "inbox", title: "Zelfde definitie 2" });
    const tomb = (await drain(from)).flatMap((p) => p.tombstones).filter((t) => t.id === doc.id);
    expect(tomb).toEqual([{ id: doc.id, reason: "purged" }]);
    const files = await caller().documents.browse({
      branch: { kind: "status", status: "purged" }, sort: "datum", dir: "desc", limit: 200 });
    expect(files.rows.map((r: { id: string }) => r.id)).toContain(doc.id);
  });

  it("cursor never skips", async () => {
    const from = await head();
    const a = await makeDoc("Eerste");
    const b = await makeDoc("Tweede");
    const pages = await drain(from, 1);
    for (const p of pages) expect(p.upserts.length + p.tombstones.length).toBeLessThanOrEqual(1);
    const order = pages.flatMap((p) => p.upserts.map((d) => d.id))
      .filter((id) => id === a.id || id === b.id);
    expect(order).toEqual([a.id, b.id]);
  });

  it("each id appears once per page with its newest seq", async () => {
    const from = await head();
    const doc = await makeDoc("Vaak gewijzigd");
    await caller().documents.update({ id: doc.id, status: "inbox", title: "Een" });
    await caller().documents.update({ id: doc.id, status: "inbox", title: "Twee" });
    const after = await head();
    const page = await caller().dossierSync.delta({ cursor: from, limit: 50 });
    expect(page.upserts.filter((d) => d.id === doc.id)).toEqual([
      expect.objectContaining({ id: doc.id, title: "Twee" })]);
    // Its newest seq is the page's cursor: three events, one row, the last seq.
    expect(page.cursor).toBe(after);
    expect(page.more).toBe(false);
  });

  it("an empty delta keeps the cursor", async () => {
    const now = await head();
    expect(await caller().dossierSync.delta({ cursor: now, limit: 50 }))
      .toEqual({ cursor: now, more: false, upserts: [], tombstones: [] });
  });

  it("refuses a page over 50 and a negative cursor", async () => {
    await expect(caller().dossierSync.delta({ cursor: 0, limit: 51 })).rejects.toThrow();
    await expect(caller().dossierSync.delta({ cursor: -1, limit: 10 })).rejects.toThrow();
  });

  it("texts returns readable text and never a discarded or purged document's", async () => {
    const read = await makeDoc("Leesbaar", "Uw aanvraag is ontvangen");
    const none = await makeDoc("Onleesbaar");
    const gone = await makeDoc("Weggegooid", "geheime inhoud");
    await caller().documents.update({ id: gone.id, status: "discarded" });
    const out = await caller().dossierSync.texts({ ids: [read.id, none.id, gone.id] });
    expect(out).toEqual([{ id: read.id, text: "Uw aanvraag is ontvangen", truncated: false }]);
  });

  it("texts refuses more than 20 ids", async () => {
    const ids = Array.from({ length: 21 }, () => crypto.randomUUID());
    await expect(caller().dossierSync.texts({ ids })).rejects.toThrow();
  });
});
