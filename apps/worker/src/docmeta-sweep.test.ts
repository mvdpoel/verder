import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { makeEnqueueGuard, pendingDocMeta } from "./docmeta-sweep";
import { settleDocumentTexts } from "./test-support/document-texts";

// The worker role, not the app role: document_texts is the worker's table
// (0016 grants verder_app SELECT only, deliberately — the web app searches the
// index and never maintains it), and the sweep itself runs on this connection
// in production, so the test exercises the grants it will actually meet.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

/**
 * One source_ref for every fixture this run creates, so afterAll can settle
 * them all with settleDocumentTexts — the append-only spelling of cleanup, and
 * the only one available: `documents` is evidence and no test gets a DELETE
 * grant. Without it this file was its own worst squatter: thirteen runs had
 * left thirteen "Loonstrook mei" rows permanently at the head of the sweep's
 * page. A test that breaks itself a little more every time it passes.
 */
const RUN_REF = `docmeta-sweep-test-${crypto.randomUUID()}`;

/**
 * A limit past any plausible backlog, and the reason this file no longer passes
 * the production batch size here.
 *
 * WHAT WENT WRONG WITH 50. pendingDocMeta is `ORDER BY created_at ASC LIMIT n`
 * over a SHARED dev database that is never truncated, so `pendingDocMeta(db,
 * 50)` answers a question about a page whose first forty-nine entries belong to
 * other test files and to whatever a developer ingested last week. The
 * assertion "my brand-new document is in there" is then really "the backlog is
 * smaller than 50 today", which is a fact about the machine and not about the
 * query — and it went false, with the fixtures this very file leaks.
 *
 * The limit is a separate property with its own test below. Everything else
 * here is about WHICH ROWS QUALIFY — no text row, not discarded — and that is
 * what a limit nothing can fill measures. It does not weaken anything: a
 * pendingDocMeta that stopped returning untreated documents, or started
 * returning discarded ones, still fails every assertion in this describe.
 */
const NO_PAGE_LIMIT = 1_000_000;

async function mkDoc(db: Db, title: string) {
  const [d] = await db.insert(schema.documents).values({
    sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    title, mime: "application/pdf", sizeBytes: 1234,
    source: "email-attachment", sourceRef: RUN_REF, receivedAt: new Date(),
  }).returning();
  return d;
}

describe("pendingDocMeta", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    const c = createDb(WORKER_URL);
    db = c.db;
    close = () => c.pool.end();
  });
  // Settle every fixture, then prove there is nothing left owing. The second
  // call returning 0 is the part that keeps this file honest: a fixture created
  // through some future path that forgets RUN_REF makes it fail here rather
  // than three weeks later in somebody else's suite.
  afterAll(async () => {
    await settleDocumentTexts(db, RUN_REF);
    expect(await settleDocumentTexts(db, RUN_REF)).toBe(0);
    await close();
  });

  it("returns a document that has no document_texts row", async () => {
    const d = await mkDoc(db, "Loonstrook mei");
    expect(await pendingDocMeta(db, NO_PAGE_LIMIT)).toContain(d.id);
  });

  it("does not return a document once its text has been stored", async () => {
    const d = await mkDoc(db, "Loonstrook juni");
    await db.insert(schema.documentTexts).values({
      documentId: d.id, sha256: d.sha256, text: "", charCount: 0,
      extractor: "none", truncated: false,
    });
    expect(await pendingDocMeta(db, NO_PAGE_LIMIT)).not.toContain(d.id);
  });

  it("does not return a discarded document", async () => {
    const d = await mkDoc(db, "image.png");
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: d.id, status: "discarded" });
    expect(await pendingDocMeta(db, NO_PAGE_LIMIT)).not.toContain(d.id);
  });

  // The limit, on its own and without borrowing anyone else's rows. The old
  // spelling was `expect(length).toBeLessThanOrEqual(2)`, which a pendingDocMeta
  // returning nothing at all passes. Three untreated fixtures of this run's own
  // make "at least three qualify" true whatever the shared database holds, so a
  // LIMIT that stopped bounding the page returns more than two and fails.
  it("honours the limit", async () => {
    await mkDoc(db, "Loonstrook juli");
    await mkDoc(db, "Loonstrook augustus");
    await mkDoc(db, "Loonstrook september");
    expect(await pendingDocMeta(db, 2)).toHaveLength(2);
    expect(await pendingDocMeta(db, 1)).toHaveLength(1);
  });
});

describe("makeEnqueueGuard", () => {
  it("admits a document the first time and refuses it on the next tick", () => {
    const admit = makeEnqueueGuard(60_000);
    expect(admit(["a", "b"], 0)).toEqual(["a", "b"]);
    expect(admit(["a", "b"], 1_000)).toEqual([]);
  });

  it("admits a document that is new on a later tick", () => {
    const admit = makeEnqueueGuard(60_000);
    admit(["a"], 0);
    expect(admit(["a", "b"], 1_000)).toEqual(["b"]);
  });

  it("admits a document again once the cool-down has passed", () => {
    const admit = makeEnqueueGuard(60_000);
    admit(["a"], 0);
    expect(admit(["a"], 60_001)).toEqual(["a"]);
  });
});
