import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { type ChainEvent } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "./ledger";
import {
  documentStatusChangePayloadByVerder, documentStatusChangePayloadWithParty,
  makeLedgerRecompute, resolveDocumentUpdatedHashes,
} from "./verification";

// The verder actor (migration 0040) is a THIRD payload shape for
// document.updated. These tests drive every tamper through makeLedgerRecompute
// — the real dispatch /verify and nightly-verify use — never the resolver
// alone, because an untested dispatch line is the sub-project 2 lesson.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// Only the admin role can UPDATE an evidence table; tamper tests need it.
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("document.updated with the verder actor", () => {
  let db: Db; let admin: Db; let close: () => Promise<void>;
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "verder-actor-vault-"));
    const a = createDb(APP_URL); const b = createDb(ADMIN_URL);
    db = a.db; admin = b.db;
    close = async () => { await a.pool.end(); await b.pool.end(); };
  });
  afterAll(() => close());

  const sha = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

  async function seedDocument(): Promise<string> {
    const digest = sha();
    const [d] = await db.insert(schema.documents).values({
      sha256: digest, title: `Actor Testfixture ${crypto.randomUUID()}.pdf`,
      mime: "application/pdf", sizeBytes: 10, source: "upload",
      sourceRef: `actor-test-${crypto.randomUUID()}`, receivedAt: new Date(),
    }).returning();
    // Keep pendingDocMeta's backlog on the shared dev DB from growing.
    await admin.insert(schema.documentTexts).values({ documentId: d.id, sha256: digest,
      text: "", extractor: "none", charCount: 0 });
    return d.id;
  }

  async function seedSuggestion(documentId: string): Promise<string> {
    // Decided, so it never counts as waiting on Martin in other tests.
    const [s] = await db.insert(schema.suggestions).values({
      kind: "document-meta", status: "auto-applied", documentId,
      proposed: { title: "Loonstrook", docType: "loonstrook", confident: true },
    }).returning();
    return s.id;
  }

  /** Writes a verder row and its event the way Task 14's writers will. */
  async function writeVerderChange(documentId: string, suggestionId: string | null) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.documentStatusChanges).values({
        documentId, status: "filed", title: "Loonstrook 2026-10", docType: "loonstrook",
        actor: "verder", suggestionId,
      }).returning();
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: documentId,
        payload: documentStatusChangePayloadByVerder(row),
      });
      return row.id;
    });
  }

  /** A Martin row in the wide shape, as every writer produced before 0040. */
  async function writeWideChange(documentId: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.documentStatusChanges).values({
        documentId, status: "filed", title: "Oud.pdf", docType: "brief",
      }).returning();
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: documentId,
        payload: documentStatusChangePayloadWithParty(row),
      });
      return row.id;
    });
  }

  /** Recomputes the one document.updated event of `documentId`, as /verify does. */
  async function recompute(documentId: string): Promise<{ got: string; stored: string }> {
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const ev = rows.find((e) => e.eventType === "document.updated" && e.entityId === documentId)!;
    const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType,
      entityType: ev.entityType, entityId: ev.entityId,
      payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
    const fn = makeLedgerRecompute(db, vaultDir, {
      linkedLater: new Map(), resolvedLinkHash: new Map(),
      resolvedStatusHash: await resolveDocumentUpdatedHashes(db, rows) });
    return { got: await fn(event), stored: ev.payloadHash };
  }

  it("the verder shape is the wide shape plus actor and suggestionId, always present", () => {
    const base = { documentId: "d", status: "filed", title: "t", docType: null, partyId: null };
    expect(documentStatusChangePayloadByVerder({ ...base, suggestionId: null })).toEqual({
      id: "d", status: "filed", title: "t", docType: null, partyId: null,
      actor: "verder", suggestionId: null });
  });

  it("verder row verifies", async () => {
    const doc = await seedDocument();
    await writeVerderChange(doc, await seedSuggestion(doc));
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });

  it("verder row without a suggestion (auto-name) verifies", async () => {
    const doc = await seedDocument();
    await writeVerderChange(doc, null);
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });

  it("old row still verifies", async () => {
    const doc = await seedDocument();
    await writeWideChange(doc);
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });

  it("setting actor on an old row is detected", async () => {
    const doc = await seedDocument();
    const id = await writeWideChange(doc);
    try {
      await admin.execute(sql`UPDATE document_status_changes SET actor = 'verder' WHERE id = ${id}`);
      const { got, stored } = await recompute(doc);
      expect(got).not.toBe(stored);
    } finally {
      // The dev DB is shared and never truncated: a row left tampered would be
      // a permanent mismatch for every later whole-chain recompute.
      await admin.execute(sql`UPDATE document_status_changes SET actor = NULL WHERE id = ${id}`);
    }
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });

  it("clearing actor on a verder row is detected", async () => {
    const doc = await seedDocument();
    // An auto-name row (no suggestion): the only verder row the second CHECK
    // allows to lose its actor, so it is the one an attacker could relabel.
    const id = await writeVerderChange(doc, null);
    try {
      await admin.execute(sql`UPDATE document_status_changes SET actor = NULL WHERE id = ${id}`);
      const { got, stored } = await recompute(doc);
      expect(got).not.toBe(stored);
    } finally {
      await admin.execute(sql`UPDATE document_status_changes SET actor = 'verder' WHERE id = ${id}`);
    }
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });

  it("changing suggestion_id on a verder row is detected", async () => {
    const doc = await seedDocument();
    const original = await seedSuggestion(doc);
    const other = await seedSuggestion(doc);
    const id = await writeVerderChange(doc, original);
    try {
      await admin.execute(sql`UPDATE document_status_changes SET suggestion_id = ${other} WHERE id = ${id}`);
      expect((await recompute(doc)).got).not.toBe((await recompute(doc)).stored);
      await admin.execute(sql`UPDATE document_status_changes SET suggestion_id = NULL WHERE id = ${id}`);
      expect((await recompute(doc)).got).not.toBe((await recompute(doc)).stored);
    } finally {
      await admin.execute(sql`UPDATE document_status_changes SET suggestion_id = ${original} WHERE id = ${id}`);
    }
    const { got, stored } = await recompute(doc);
    expect(got).toBe(stored);
  });
});
