import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { documentIdsByTitle } from "./seed-documents";

// The admin role: this helper is called from the backfill scripts, which run as
// `verder`, and `documents`/`document_status_changes` are append-only for the
// app and worker roles anyway.
const URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("documentIdsByTitle", () => {
  const { db, pool } = createDb(URL);
  afterAll(() => pool.end());

  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  /**
   * A vault document with a title unique to this test run, so the shared dev
   * database's existing contents can never satisfy an assertion for us.
   *
   * It also gets a `document_texts` row with extractor "none", and that is not
   * incidental. `documents` is append-only and this dev database is shared and
   * never truncated by this suite, so these fixtures are permanent — and a
   * document with no `document_texts` row is what `pendingDocMeta` hands the
   * docmeta sweep. Without this the file quietly grew the sweep's backlog by
   * ten every run: measured at 50 of the dev database's 100 pending documents
   * after five runs, which is enough to push a real document off the sweep's
   * LIMIT 50 and fail `docmeta-sweep.test.ts`. Writing the row is exactly what
   * production does for a document it cannot read — `storeDocumentText` records
   * every attempt including extractor "none", which is what makes the sweep
   * converge — so the fixture leaves the queue as it found it.
   */
  const seed = async (title: string, receivedAt = new Date()) => {
    const doc = await db.transaction((tx) => ingestDocument(tx, {
      sha256: sha(), sizeBytes: 10, mime: "application/pdf",
      source: "email-attachment", title, receivedAt,
    }));
    await db.insert(schema.documentTexts).values({
      documentId: doc.id, sha256: doc.sha256, text: "",
      extractor: "none", charCount: 0, truncated: false,
    }).onConflictDoNothing();
    return doc;
  };

  // The real discard path writes an APPENDED row and never touches
  // documents.status — which is the whole trap this helper exists to survive.
  const discard = (id: string) => db.transaction(async (tx) => {
    await tx.insert(schema.documentStatusChanges).values({ documentId: id, status: "discarded" });
    await appendLedgerEvent(tx, {
      eventType: "document.updated", entityType: "document", entityId: id,
      payload: { id, status: "discarded", title: null, docType: null },
    });
  });

  const file = (id: string) => db.transaction(async (tx) => {
    await tx.insert(schema.documentStatusChanges).values({ documentId: id, status: "filed" });
    await appendLedgerEvent(tx, {
      eventType: "document.updated", entityType: "document", entityId: id,
      payload: { id, status: "filed", title: null, docType: null },
    });
  });

  it("resolves a title to its document", async () => {
    const title = `Beschikking ${crypto.randomUUID()}.pdf`;
    const doc = await seed(title);
    expect((await documentIdsByTitle(db)).get(title)).toBe(doc.id);
  });

  it("keeps a document that has no status change at all", async () => {
    // Most of the vault: nobody has ever filed or discarded it. What keeps it
    // is the COALESCE onto documents.status, which is NOT NULL DEFAULT 'inbox'
    // — NOT the IS DISTINCT FROM. Measured: swapping that for `<>` leaves this
    // test green, because the expression never evaluates to NULL here. The
    // NULL trap CLAUDE.md records is real in search/retrieve.ts, where the
    // status column itself is NULL for entity types that have none; it does not
    // bite through a COALESCE. Said plainly so nobody "hardens" this into a
    // guarantee it never made.
    const title = `Onaangeraakt ${crypto.randomUUID()}.pdf`;
    const doc = await seed(title);
    const changes = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id));
    expect(changes).toHaveLength(0);
    expect((await documentIdsByTitle(db)).get(title)).toBe(doc.id);
  });

  it("refuses a discarded document", async () => {
    // A discard is APPENDED and never written back, so documents.status still
    // reads "inbox" here. Reading the raw column would link a document Martin
    // threw away.
    const title = `Weggegooid ${crypto.randomUUID()}.pdf`;
    const doc = await seed(title);
    await discard(doc.id);
    const [raw] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, doc.id));
    expect(raw.status).toBe("inbox");
    expect((await documentIdsByTitle(db)).has(title)).toBe(false);
  });

  it("takes the document back once the discard is undone", async () => {
    // Undo appends another row rather than deleting the discard, so only the
    // LATEST change may count. Reading any earlier one keeps the document
    // invisible forever.
    const title = `Teruggehaald ${crypto.randomUUID()}.pdf`;
    const doc = await seed(title);
    await discard(doc.id);
    await file(doc.id);
    expect((await documentIdsByTitle(db)).get(title)).toBe(doc.id);
  });

  it("lets the oldest copy win when a title was filed twice", async () => {
    const title = `Dubbel ${crypto.randomUUID()}.pdf`;
    const first = await seed(title, new Date("2026-01-01T10:00:00Z"));
    await seed(title, new Date("2026-02-01T10:00:00Z"));
    expect((await documentIdsByTitle(db)).get(title)).toBe(first.id);
  });

  it("falls through to the newer copy when the oldest one was discarded", async () => {
    // THE ORDER OF THE TWO RULES, and it is not the obvious one: filter first,
    // THEN take the oldest. Taking the oldest first and rejecting it afterwards
    // resolves the title to nothing and reports it missing, while a perfectly
    // good document sits in the vault — which is exactly what happens to a
    // Beschikking discarded by mistake and then mailed again.
    const title = `Opnieuw gestuurd ${crypto.randomUUID()}.pdf`;
    const older = await seed(title);
    const newer = await seed(title);
    await discard(older.id);
    const got = await documentIdsByTitle(db);
    expect(got.get(title)).toBe(newer.id);
    expect(got.get(title)).not.toBe(older.id);
  });

  it("drops the title entirely when every copy is discarded", async () => {
    const title = `Allemaal weg ${crypto.randomUUID()}.pdf`;
    const a = await seed(title);
    const b = await seed(title);
    await discard(a.id);
    await discard(b.id);
    expect((await documentIdsByTitle(db)).has(title)).toBe(false);
    // And the rows are still there — a discard is never a delete.
    expect(await db.select().from(schema.documents)
      .where(inArray(schema.documents.id, [a.id, b.id]))).toHaveLength(2);
  });
});
