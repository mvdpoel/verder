import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { extractMissingTexts } from "./extract-texts";

// NOT named URL: the fixture helper constructs a real URL below.
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

/** A document whose bytes really live in `vaultDir`, as after a NAS scan. */
async function seedDoc(db: Db, vaultDir: string, buf: Buffer) {
  // Unique bytes per run: the vault is content-addressed and documents.sha256
  // is unique, so fixed fixture bytes would collide with the previous run.
  const unique = Buffer.concat([buf, Buffer.from(`\n% ${crypto.randomUUID()}\n`)]);
  const { sha256 } = await storeFile(vaultDir, unique);
  return db.transaction((tx) => ingestDocument(tx, {
    sha256, sizeBytes: unique.length, mime: "application/pdf",
    title: `backfill-${Date.now()}-${Math.random()}.pdf`,
    source: "nas-scan", receivedAt: new Date(),
  }));
}

describe("extractMissingTexts", () => {
  it("extracts documents that have no text, and re-reads nothing on a second pass", async () => {
    const { db, pool } = createDb(DB_URL);
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-backfill-"));
    const doc = await seedDoc(db, vaultDir, await fixture("text-letter.pdf"));

    // The dev database is shared and full of documents whose bytes live in the
    // real vault, not this throwaway one, so the run totals are meaningless
    // here: every assertion is scoped to the document this test just seeded.
    await extractMissingTexts({ db, vaultDir });

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.extractor).toBe("pdf-parse");
    expect(row.text).toContain("dossiernummer");

    // Second pass: this document now HAS text, so it is not selected at all —
    // proven by its extraction timestamp not moving. OCR is expensive and a
    // resumable backfill that silently redid finished work would be useless.
    await extractMissingTexts({ db, vaultDir });
    const [again] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(again.extractedAt).toEqual(row.extractedAt);
    await pool.end();
  });

  it("retries a spreadsheet that an earlier version of the extractor gave up on", async () => {
    // The exact production document this feature exists for: ABN's "Excel"
    // export, recorded as application/octet-stream, extracted BEFORE the
    // spreadsheet reader existed and therefore stored as extractor 'none' with
    // zero characters. storeDocumentText short-circuits on an unchanged
    // sha256, so unless the backfill picks this row up again it stays
    // invisible to search forever — and docs/deploy.md tells the operator this
    // command is what fixes it.
    const { db, pool } = createDb(DB_URL);
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-backfill-sheet-"));
    const raw = await readFile(
      new URL("../../../packages/parsers/fixtures/abn.xlsx", import.meta.url));
    // Unique bytes per run, in the ZIP's end-of-central-directory comment.
    const note = Buffer.from(`run-${crypto.randomUUID()}`);
    const buf = Buffer.concat([raw, note]);
    buf.writeUInt16LE(note.length, buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 20);
    const { sha256 } = await storeFile(vaultDir, buf);
    const doc = await db.transaction((tx) => ingestDocument(tx, {
      sha256, sizeBytes: buf.length, mime: "application/octet-stream",
      title: `abn-${Date.now()}.xlsx`, source: "email-attachment", receivedAt: new Date(),
    }));
    await db.insert(schema.documentTexts).values({
      documentId: doc.id, sha256, text: "", charCount: 0,
      extractor: "none", truncated: false,
    });

    await extractMissingTexts({ db, vaultDir });

    const [row] = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(row.extractor).toBe("sheet");
    expect(row.text).toContain("Ziggo Services BV");
    await pool.end();
  });

  it("counts a missing vault file as failed and keeps going", async () => {
    const { db, pool } = createDb(DB_URL);
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-backfill-"));
    // Ingested, but its bytes were never written to THIS vault directory: one
    // unreadable scan must never strand the rest of the corpus.
    const orphan = await db.transaction((tx) => ingestDocument(tx, {
      sha256: sha256Hex(Buffer.from(`missing-${crypto.randomUUID()}`)),
      sizeBytes: 10, mime: "application/pdf",
      title: `orphan-${Date.now()}.pdf`, source: "upload", receivedAt: new Date(),
    }));

    const res = await extractMissingTexts({ db, vaultDir });
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, orphan.id));
    expect(rows).toHaveLength(0);
    await pool.end();
  });
});
