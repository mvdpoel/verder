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
import { settleDocumentTexts } from "./test-support/document-texts";

// NOT named URL: the fixture helper constructs a real URL below.
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
// Every fixture this file ingests is tagged with it, so the guard at the bottom
// can ask "did this run leave anything owing?" about THIS run and nothing else.
// New per run, because `documents` is append-only and the dev database is never
// truncated: a fixed tag would answer for every run this file has ever had.
const RUN_REF = `test:extract-texts:${crypto.randomUUID()}`;

/** A document whose bytes really live in `vaultDir`, as after a NAS scan. */
async function seedDoc(db: Db, vaultDir: string, buf: Buffer) {
  // Unique bytes per run: the vault is content-addressed and documents.sha256
  // is unique, so fixed fixture bytes would collide with the previous run.
  const unique = Buffer.concat([buf, Buffer.from(`\n% ${crypto.randomUUID()}\n`)]);
  const { sha256 } = await storeFile(vaultDir, unique);
  return db.transaction((tx) => ingestDocument(tx, {
    sha256, sizeBytes: unique.length, mime: "application/pdf",
    title: `backfill-${Date.now()}-${Math.random()}.pdf`,
    source: "nas-scan", sourceRef: RUN_REF, receivedAt: new Date(),
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
      title: `abn-${Date.now()}.xlsx`, source: "email-attachment",
      sourceRef: RUN_REF, receivedAt: new Date(),
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
      title: `orphan-${Date.now()}.pdf`, source: "upload",
      sourceRef: RUN_REF, receivedAt: new Date(),
    }));

    const res = await extractMissingTexts({ db, vaultDir });
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, orphan.id));
    expect(rows).toHaveLength(0);

    // ...which is correct for the backfill and a permanent debt for the docmeta
    // sweep. `documents` is append-only and this dev database is never
    // truncated, so this unreadable fixture would sit at the FRONT of
    // `pendingDocMeta`'s `ORDER BY created_at ASC LIMIT 50` for ever, one more
    // squatter per run. Measured before this line: running this file moved the
    // backlog 14 -> 15 every time. Settling it writes the row a real failed
    // extraction writes — extractor "none" — which is exactly how the sweep
    // converges in production.
    expect(await settleDocumentTexts(db, RUN_REF)).toBe(1);
    await pool.end();
  });

  /**
   * The backfill's pending query is pendingDocMeta's twin — "no document_texts
   * row, or extractor 'none' on a retryable mime" — and a purge deletes exactly
   * that row, so a purged document qualifies forever. Two harms, not one: every
   * future run counts it as `failed` (the vault file is gone), and on the
   * repairable state this design leans on, where the unlink did not land, the
   * bytes are still readable and the purged text is extracted and stored again.
   */
  it("never offers a purged document to the extractor", async () => {
    const { db, pool } = createDb(DB_URL);
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-backfill-"));
    // No document in the shared dev database has bytes in this throwaway vault,
    // so a run changes nothing and `scanned` is a stable population count —
    // which is what makes the assertion below about the QUERY and not about
    // whatever else is pending on this machine today.
    const baseline = await extractMissingTexts({ db, vaultDir });

    const doc = await seedDoc(db, vaultDir, await fixture("text-letter.pdf"));
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}-purger@test.local`, name: "Martin" }).returning();
    await db.insert(schema.documentPurges).values({
      documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes,
      reason: null, createdBy: u.id });

    const after = await extractMissingTexts({ db, vaultDir });
    // Not selected at all — not selected and then failed, which is the shape
    // that quietly inflates `failed` on every run from here on.
    expect(after.scanned).toBe(baseline.scanned);
    expect(after.failed).toBe(baseline.failed);
    // Its bytes ARE readable here (seedDoc wrote them), so this is the
    // dangerous half: without the filter the destroyed text comes straight back.
    const rows = await db.select().from(schema.documentTexts)
      .where(eq(schema.documentTexts.documentId, doc.id));
    expect(rows).toHaveLength(0);
    await pool.end();
  });

  it("leaves the docmeta sweep's backlog exactly as it found it", async () => {
    // The guard, not a formality: it FAILS if any test above starts ingesting a
    // fixture whose text row nobody writes. Zero means every document this run
    // created is accounted for — most of them because extraction really ran.
    const { db, pool } = createDb(DB_URL);
    expect(await settleDocumentTexts(db, RUN_REF)).toBe(0);
    await pool.end();
  });
});
