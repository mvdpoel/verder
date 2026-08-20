import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeDocumentText } from "./document-text";

// NOT named URL: the fixture helper below constructs a real URL, and a const
// named URL would shadow the global and blow up with "URL is not a constructor".
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

async function insertDoc(db: Db, buf: Buffer) {
  // Unique bytes per run: the vault is content-addressed and documents.sha256
  // is unique, so a fixed fixture would collide with the previous run.
  const unique = Buffer.concat([buf, Buffer.from(`\n% ${crypto.randomUUID()}\n`)]);
  return { doc: await db.transaction((tx) => ingestDocument(tx, {
    sha256: sha256Hex(unique), sizeBytes: unique.length, mime: "application/pdf",
    title: `brief-${Date.now()}.pdf`, source: "nas-scan", receivedAt: new Date() })), unique };
}

describe("storeDocumentText", () => {
  it("extracts once and never re-extracts the same sha256", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));

    const first = await storeDocumentText({ db }, doc, unique);
    expect(first.reused).toBe(false);
    expect(first.extractor).toBe("pdf-parse");
    expect(first.text).toContain("dossiernummer");

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.sha256).toBe(doc.sha256);
    expect(row.extractor).toBe("pdf-parse");
    expect(row.charCount).toBe(Array.from(row.text).length);
    expect(row.truncated).toBe(false);

    let calls = 0;
    const second = await storeDocumentText(
      { db, extract: async () => { calls++; return { text: "", charCount: 0, extractor: "none" as const, truncated: false }; } },
      doc, unique);
    expect(calls).toBe(0);
    expect(second.reused).toBe(true);
    expect(second.text).toContain("dossiernummer");
    await pool.end();
  });

  it("re-extracts when the stored sha256 no longer matches the document", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));
    await db.insert(schema.documentTexts).values({ documentId: doc.id,
      sha256: "stale".padEnd(64, "0"), text: "verouderd", extractor: "none", charCount: 9 });

    const out = await storeDocumentText({ db }, doc, unique);
    expect(out.reused).toBe(false);
    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.sha256).toBe(doc.sha256);
    expect(row.text).toContain("dossiernummer");
    await pool.end();
  });

  it("stores the pre-cap char_count and the truncated flag", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("text-letter.pdf"));
    await storeDocumentText({ db, extract: async () => ({
      text: "é".repeat(1_000_000), charCount: 1_000_050,
      extractor: "ocr-pdf" as const, truncated: true }) }, doc, unique);

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.truncated).toBe(true);
    expect(row.charCount).toBe(1_000_050);
    expect(Array.from(row.text)).toHaveLength(1_000_000);
    await pool.end();
  });

  it("records an extraction failure in worker_runs and still stores a row", async () => {
    const { db, pool } = createDb(DB_URL);
    const { doc, unique } = await insertDoc(db, await fixture("scanned-letter.pdf"));
    await storeDocumentText({ db, extract: async () => ({
      text: "", charCount: 0, extractor: "none" as const, truncated: false,
      error: "Error: pdftoppm ENOENT" }) }, doc, unique);

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.extractor).toBe("none");

    // Scoped by the unique documentId in detail, not by time: ran_at is the DB
    // clock while new Date() is the host clock.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "extract"));
    expect(runs.some((r) => r.status === "error"
      && (r.detail as Record<string, unknown> | null)?.documentId === doc.id)).toBe(true);
    await pool.end();
  });
});
