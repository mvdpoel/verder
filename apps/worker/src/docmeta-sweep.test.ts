import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { makeEnqueueGuard, pendingDocMeta } from "./docmeta-sweep";

// The worker role, not the app role: document_texts is the worker's table
// (0016 grants verder_app SELECT only, deliberately — the web app searches the
// index and never maintains it), and the sweep itself runs on this connection
// in production, so the test exercises the grants it will actually meet.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

async function mkDoc(db: Db, title: string, sha: string) {
  const [d] = await db.insert(schema.documents).values({
    sha256: sha, title, mime: "application/pdf", sizeBytes: 1234,
    source: "email-attachment", receivedAt: new Date(),
  }).returning();
  return d;
}
const sha = (n: string) => n.padEnd(64, "0");

describe("pendingDocMeta", () => {
  let db: Db;
  beforeAll(() => { db = createDb(WORKER_URL).db; });

  it("returns a document that has no document_texts row", async () => {
    const d = await mkDoc(db, "Loonstrook mei", sha(`a${Date.now()}`));
    expect(await pendingDocMeta(db, 50)).toContain(d.id);
  });

  it("does not return a document once its text has been stored", async () => {
    const d = await mkDoc(db, "Loonstrook juni", sha(`b${Date.now()}`));
    await db.insert(schema.documentTexts).values({
      documentId: d.id, sha256: d.sha256, text: "", charCount: 0,
      extractor: "none", truncated: false,
    });
    expect(await pendingDocMeta(db, 50)).not.toContain(d.id);
  });

  it("does not return a discarded document", async () => {
    const d = await mkDoc(db, "image.png", sha(`c${Date.now()}`));
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: d.id, status: "discarded" });
    expect(await pendingDocMeta(db, 50)).not.toContain(d.id);
  });

  it("honours the limit", async () => {
    expect((await pendingDocMeta(db, 2)).length).toBeLessThanOrEqual(2);
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
