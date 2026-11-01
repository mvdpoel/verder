import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { docTypeKeySql } from "../effective-status";
import { documentStatusChangePayloadByVerder, documentStatusChangePayloadWithParty } from "../verification";
import { effectiveDocument } from "./documents";
import { stateAfter } from "./verder-actions";

// Plan 3 Task 15: "Door verder gedaan" and its one-tap undo. Every fixture is
// a fresh document with a random title on the shared dev DB, and every count
// is scoped to that document, because other suites append concurrently.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// Only to give a fixture document its extractor-`none` text row, which the app
// role cannot write (it would otherwise grow pendingDocMeta's backlog).
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("verderActions", () => {
  let db: Db; let admin: Db; let userId: string; let close: () => Promise<void>;
  beforeAll(async () => {
    const a = createDb(APP_URL); const b = createDb(ADMIN_URL);
    db = a.db; admin = b.db;
    close = async () => { await a.pool.end(); await b.pool.end(); };
    const [u] = await db.insert(schema.users)
      .values({ email: `va${crypto.randomUUID()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const randomSha = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

  async function makeDocument(docType: string | null = null) {
    const title = `VerderActions Testfixture ${crypto.randomUUID()}.pdf`;
    const [doc] = await db.insert(schema.documents).values({
      sha256: randomSha(), sizeBytes: 4096, mime: "application/pdf", title,
      docType: docType ?? undefined, source: "email-attachment", receivedAt: new Date(),
    }).returning();
    await admin.insert(schema.documentTexts).values({ documentId: doc.id, sha256: doc.sha256,
      text: "", extractor: "none", charCount: 0 });
    return doc;
  }

  /** An auto-file as auto-file.ts writes it: row, verder-shape event, decided suggestion. */
  async function autoFile(documentId: string, docType: string, proposedTitle = "Loonstrook juli") {
    return db.transaction(async (tx) => {
      const current = await effectiveDocument(tx, documentId);
      const [s] = await tx.insert(schema.suggestions).values({
        kind: "document-meta", status: "auto-applied", documentId, promptVersion: "docmeta-v2",
        proposed: { title: proposedTitle, docType, confident: true },
      }).returning();
      const [row] = await tx.insert(schema.documentStatusChanges).values({
        documentId, status: "filed", title: current.effectiveTitle, docType,
        actor: "verder", suggestionId: s.id }).returning();
      await appendLedgerEvent(tx, { eventType: "document.updated", entityType: "document",
        entityId: documentId, payload: documentStatusChangePayloadByVerder(row) });
      await tx.update(schema.suggestions).set({ finalPayload: {
        title: current.effectiveTitle, docType, changeId: row.id } })
        .where(eq(schema.suggestions.id, s.id));
      return { change: row, suggestionId: s.id };
    });
  }

  /** An auto-name as auto-name.ts writes it: no suggestion. */
  async function autoName(documentId: string, to: string) {
    return db.transaction(async (tx) => {
      const current = await effectiveDocument(tx, documentId);
      const [row] = await tx.insert(schema.documentStatusChanges).values({
        documentId, status: current.effectiveStatus, title: to,
        actor: "verder", suggestionId: null }).returning();
      await appendLedgerEvent(tx, { eventType: "document.updated", entityType: "document",
        entityId: documentId, payload: documentStatusChangePayloadByVerder(row) });
      return row;
    });
  }

  const listed = async (changeId: string) =>
    (await caller().verderActions.list({ sinceDays: 7 })).find((a) => a.changeId === changeId);
  const ledgerCount = async (documentId: string) => (await db.select()
    .from(schema.ledgerEvents).where(eq(schema.ledgerEvents.entityId, documentId))).length;
  const changeCount = async (documentId: string) => (await db.select()
    .from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, documentId))).length;

  it("stateAfter resolves by the newest opinion, as effectiveDocument does", () => {
    const base = { status: "inbox", title: "a.pdf", docType: null };
    expect(stateAfter(base, [
      { status: "filed", title: null, docType: "Brief" },
      { status: "inbox", title: "b.pdf", docType: null },
    ])).toEqual({ status: "inbox", title: "b.pdf", docType: "Brief" });
  });

  it("list shows before and after", async () => {
    const doc = await makeDocument();
    const { change } = await autoFile(doc.id, "Loonstrook");
    const a = await listed(change.id);
    expect(a).toMatchObject({
      documentId: doc.id, documentTitle: doc.title, kind: "auto-file",
      before: { status: "inbox", title: doc.title, docType: null },
      after: { status: "filed", title: doc.title, docType: "Loonstrook" },
      proposedTitle: "Loonstrook juli", undone: false, undoable: true, notUndoableReason: null,
    });
    expect(a?.at).toBe(change.createdAt.toISOString());
  });

  it("undo restores title, soort and inbox", async () => {
    const doc = await makeDocument("Brief");
    // auto-name first, then auto-file: the undo of the FILE restores the
    // state between the two — the name auto-name gave it stays.
    const named = `Loonstrook.MP.${crypto.randomUUID()}.pdf`;
    await autoName(doc.id, named);
    const { change, suggestionId } = await autoFile(doc.id, "Loonstrook");
    const events = await ledgerCount(doc.id);

    await caller().verderActions.undo({ changeId: change.id });

    const after = await effectiveDocument(db, doc.id);
    expect(after.effectiveStatus).toBe("inbox");
    expect(after.effectiveTitle).toBe(named);
    expect(after.effectiveDocType).toBe("Brief");
    expect(await ledgerCount(doc.id)).toBe(events + 1);

    // The appended row is MARTIN's (actor NULL), ledgered in the wide shape.
    const rows = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id))
      .orderBy(asc(schema.documentStatusChanges.createdAt));
    const undoRow = rows[rows.length - 1];
    expect(undoRow.actor).toBeNull();
    expect(undoRow.suggestionId).toBeNull();
    const [event] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, doc.id))
      .orderBy(sql`${schema.ledgerEvents.seq} desc`).limit(1);
    expect(event.eventType).toBe("document.updated");
    expect(event.payloadHash)
      .toBe(sha256Hex(canonicalJson(documentStatusChangePayloadWithParty(undoRow))));

    // The learning signal on the suggestion, and the list says it is undone.
    const [s] = await db.select().from(schema.suggestions).where(eq(schema.suggestions.id, suggestionId));
    expect((s.finalPayload as { undo?: { changeId: string } }).undo?.changeId).toBe(change.id);
    expect(s.status).toBe("auto-applied");
    expect(await listed(change.id)).toMatchObject({
      undone: true, undoable: false, notUndoableReason: "al aangepast" });
  });

  it("undo refuses when a newer change exists", async () => {
    const doc = await makeDocument();
    const { change } = await autoFile(doc.id, "Loonstrook");
    // Martin renames it after verder filed it.
    await caller().documents.update({ id: doc.id, status: "filed", title: `Hernoemd ${crypto.randomUUID()}` });
    const events = await ledgerCount(doc.id);
    const rows = await changeCount(doc.id);

    await expect(caller().verderActions.undo({ changeId: change.id }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "al aangepast" });
    expect(await ledgerCount(doc.id)).toBe(events);
    expect(await changeCount(doc.id)).toBe(rows);
    expect(await listed(change.id)).toMatchObject({
      undone: false, undoable: false, notUndoableReason: "al aangepast" });
  });

  it("undo refuses a purged document and appends nothing", async () => {
    const doc = await makeDocument();
    const { change } = await autoFile(doc.id, "Loonstrook");
    // The real purge: its bytes are not on disk (ENOENT proceeds), and it
    // writes no change row — so only the purge check can refuse.
    await caller().documents.purge({ id: doc.id, reason: "test" });
    const events = await ledgerCount(doc.id);
    const rows = await changeCount(doc.id);

    await expect(caller().verderActions.undo({ changeId: change.id }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "vernietigd" });
    expect(await ledgerCount(doc.id)).toBe(events);
    expect(await changeCount(doc.id)).toBe(rows);
    expect(await listed(change.id)).toMatchObject({ undoable: false, notUndoableReason: "vernietigd" });
  });

  it("auto-name changes are listed but not undoable, with the reason", async () => {
    const doc = await makeDocument();
    const named = `Beschikking.${crypto.randomUUID()}.pdf`;
    const row = await autoName(doc.id, named);
    expect(await listed(row.id)).toMatchObject({
      kind: "auto-name", documentTitle: named,
      before: { status: "inbox", title: doc.title }, after: { status: "inbox", title: named },
      proposedTitle: null, undoable: false, notUndoableReason: "naam staat ook op de NAS",
    });
    const events = await ledgerCount(doc.id);
    await expect(caller().verderActions.undo({ changeId: row.id }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await ledgerCount(doc.id)).toBe(events);
  });

  it("double undo appends one event", async () => {
    const doc = await makeDocument();
    const { change } = await autoFile(doc.id, "Loonstrook");
    const events = await ledgerCount(doc.id);
    // Two taps landing together: the advisory lock serialises them, and the
    // second sees the first's row as newer.
    const results = await Promise.allSettled([
      caller().verderActions.undo({ changeId: change.id }),
      caller().verderActions.undo({ changeId: change.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await ledgerCount(doc.id)).toBe(events + 1);
    await expect(caller().verderActions.undo({ changeId: change.id }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ledgerCount(doc.id)).toBe(events + 1);
  });

  it("undo of null soort writes empty soort and the tree shows Zonder soort", async () => {
    const doc = await makeDocument(null);
    const { change } = await autoFile(doc.id, "Loonstrook");
    await caller().verderActions.undo({ changeId: change.id });
    const rows = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id))
      .orderBy(asc(schema.documentStatusChanges.createdAt));
    expect(rows[rows.length - 1].docType).toBe("");
    // The key the /files tree groups on: "" is "Zonder soort".
    const [k] = await db.select({ key: docTypeKeySql }).from(schema.documents)
      .where(eq(schema.documents.id, doc.id));
    expect(k.key).toBe("");
  });

  it("a Martin change is never listed and cannot be undone here", async () => {
    const doc = await makeDocument();
    await caller().documents.update({ id: doc.id, status: "filed", docType: "Brief" });
    const [row] = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id));
    expect(await listed(row.id)).toBeUndefined();
    await expect(caller().verderActions.undo({ changeId: row.id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
