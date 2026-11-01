import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

// Plan 3 Task 10: the docmeta verdict has to tell the truth before anything is
// measured against it. The auto-apply threshold (Task 13) reads this history,
// so an approve that always wrote "approved" — even when Martin retyped the
// title — would have made the model look better than it is.

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// Only to give a fixture document its extractor-`none` text row, which the app
// role cannot write (it would otherwise grow pendingDocMeta's backlog).
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("suggestions.approveDocumentMeta verdict", () => {
  let db: Db; let admin: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    admin = createDb(ADMIN_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `dm${crypto.randomUUID()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const randomSha = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

  async function makeDocument() {
    const [doc] = await db.insert(schema.documents).values({
      sha256: randomSha(), sizeBytes: 4096, mime: "application/pdf",
      title: `scan ${crypto.randomUUID()}.pdf`, source: "email-attachment", receivedAt: new Date(),
    }).returning();
    await admin.insert(schema.documentTexts).values({ documentId: doc.id, sha256: doc.sha256,
      text: "", extractor: "none", charCount: 0 });
    return doc;
  }

  async function makeSuggestion(documentId: string, proposed: { title: string; docType: string | null }) {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model: "qwen3.5:9b", promptVersion: "docmeta-v1",
      proposed,
    }).returning();
    return s;
  }

  const verdict = async (id: string) => (await db.select().from(schema.suggestions)
    .where(eq(schema.suggestions.id, id)))[0];
  // Scoped to the document: other packages' suites may append to the shared
  // dev ledger while this file runs (pnpm -r runs packages concurrently).
  const ledgerCount = async (documentId: string) => (await db.select()
    .from(schema.ledgerEvents).where(eq(schema.ledgerEvents.entityId, documentId))).length;
  const changeCount = async (documentId: string) => (await db.select()
    .from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, documentId))).length;

  it("edited title records edited", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Beschikking rechtbank", docType: "Beschikking" });
    await caller().suggestions.approveDocumentMeta({
      id: s.id, title: "Beschikking rechtbank Midden-Nederland", docType: "Beschikking" });
    const after = await verdict(s.id);
    expect(after.status).toBe("edited");
    expect(after.finalPayload).toEqual({
      title: "Beschikking rechtbank Midden-Nederland", docType: "Beschikking" });
  });

  it("edited soort records edited", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Loonstrook juli", docType: "Loonstrook" });
    await caller().suggestions.approveDocumentMeta({
      id: s.id, title: "Loonstrook juli", docType: "Salarisspecificatie" });
    expect((await verdict(s.id)).status).toBe("edited");
  });

  it("unchanged records approved", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Loonstrook juli", docType: "Loonstrook" });
    // The soort key folds case and whitespace (docTypeKey), so a trailing
    // space or a lower-case retype is the same soort, not an edit.
    await caller().suggestions.approveDocumentMeta({
      id: s.id, title: "Loonstrook juli", docType: "loonstrook " });
    expect((await verdict(s.id)).status).toBe("approved");
  });

  it("unchanged with no soort records approved", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Brief", docType: null });
    // The web card sends undefined for a cleared Soort box; null and absent
    // and "" are all "Zonder soort".
    await caller().suggestions.approveDocumentMeta({ id: s.id, title: "Brief" });
    expect((await verdict(s.id)).status).toBe("approved");
  });

  it("second approve of a decided suggestion is refused and appends nothing", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Brief", docType: null });
    await caller().suggestions.approveDocumentMeta({ id: s.id, title: "Brief" });
    const before = await ledgerCount(doc.id);
    const changes = await changeCount(doc.id);
    await expect(caller().suggestions.approveDocumentMeta({ id: s.id, title: "Brief anders" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ledgerCount(doc.id)).toBe(before);
    expect(await changeCount(doc.id)).toBe(changes);
    expect((await verdict(s.id)).status).toBe("approved");
  });

  it("approve on a purged document is refused", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Brief", docType: null });
    await db.insert(schema.documentPurges).values({
      documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes, createdBy: userId });
    const before = await ledgerCount(doc.id);
    await expect(caller().suggestions.approveDocumentMeta({ id: s.id, title: "Brief" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ledgerCount(doc.id)).toBe(before);
    expect(await changeCount(doc.id)).toBe(0);
    expect((await verdict(s.id)).status).toBe("pending");
  });

  it("approve on a discarded document is refused", async () => {
    const doc = await makeDocument();
    const s = await makeSuggestion(doc.id, { title: "Brief", docType: null });
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const before = await ledgerCount(doc.id);
    await expect(caller().suggestions.approveDocumentMeta({ id: s.id, title: "Brief" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ledgerCount(doc.id)).toBe(before);
    // Still discarded: the refused approve did not quietly file it again.
    expect(await changeCount(doc.id)).toBe(1);
    expect((await verdict(s.id)).status).toBe("pending");
  });
});
