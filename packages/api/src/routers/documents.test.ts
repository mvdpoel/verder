import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { verifyChain, type ChainEvent } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { storeFile } from "../storage";
import { makeLedgerRecompute, resolveDocumentUpdatedHashes } from "../verification";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// The admin role is the only one that CAN update an evidence table — the app
// and worker grants forbid it. Tamper tests need it to prove verification bites.
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("documents router", () => {
  let db: Db; let userId: string; let vaultDir: string;
  beforeAll(async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "verder-docs-vault-"));
    process.env.VAULT_DIR = vaultDir;
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `d${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const anonCaller = () => appRouter.createCaller(createContext({ db, userId: null }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const seedDocument = (over: { title: string; mime: string }) =>
    caller().documents.registerUpload({ sha256: sha(), sizeBytes: 10,
      source: "upload", receivedAt: new Date(), ...over });
  const allEvents = async (): Promise<ChainEvent[]> => {
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    return rows.map((e) => ({ seq: e.seq, eventType: e.eventType,
      entityType: e.entityType, entityId: e.entityId,
      payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash }));
  };
  // Chain linkage only: other test files register documents whose vault files
  // never existed, so whole-chain runFullVerification cannot be asserted green
  // here without truncating — and evidence tables are never truncated by new
  // tests (the same reasoning as task-decide.test.ts / registry-decide.test.ts).
  const verifyLedger = async () => verifyChain(await allEvents(), (e) => e.payloadHash);

  it("registers an upload idempotently", async () => {
    const c = caller();
    const input = { sha256: sha(), sizeBytes: 10, mime: "application/pdf",
      title: "Payslip June", source: "upload" as const, receivedAt: new Date() };
    const one = await c.documents.registerUpload(input);
    const two = await c.documents.registerUpload(input);
    expect(two.id).toBe(one.id);
    expect(one.status).toBe("inbox");
  });

  it("rejects a sha256 that is not 64 lowercase hex chars", async () => {
    const c = caller();
    const base = { sizeBytes: 10, mime: "application/pdf", title: "Evil",
      source: "upload" as const, receivedAt: new Date() };
    // 64 chars long, but a path traversal escaping the vault
    const traversal = "../".repeat(18) + "etc/passwd";
    expect(traversal).toHaveLength(64);
    await expect(c.documents.registerUpload({ ...base, sha256: traversal }))
      .rejects.toThrow();
    // uppercase hex is also rejected (canonical form is lowercase)
    await expect(c.documents.registerUpload({ ...base, sha256: "A".repeat(64) }))
      .rejects.toThrow();
  });

  it("update() files a document via status-change row (original row untouched)", async () => {
    const c = caller();
    const doc = await c.documents.registerUpload({ sha256: sha(), sizeBytes: 5,
      mime: "image/png", title: "scan_001", source: "upload", receivedAt: new Date() });
    const updated = await c.documents.update({ id: doc.id, status: "filed",
      title: "Energy contract 2025", docType: "contract" });
    expect(updated.effectiveStatus).toBe("filed");
    expect(updated.effectiveTitle).toBe("Energy contract 2025");
    const [raw] = await db.select().from(schema.documents)
      .where((await import("drizzle-orm")).eq(schema.documents.id, doc.id));
    expect(raw.title).toBe("scan_001"); // evidence row never mutated
  });

  it("returns capped rows for a spreadsheet, and says it capped them", async () => {
    const buf = Buffer.from(readFileSync(
      new URL("../../../parsers/fixtures/abn.xls", import.meta.url)));
    const { sha256 } = await storeFile(vaultDir, buf);
    await caller().documents.registerUpload({
      sha256, sizeBytes: buf.length, mime: "application/vnd.ms-excel",
      title: "abn.xls", source: "upload", receivedAt: new Date() });

    const preview = await caller().documents.sheetPreview({ sha256, maxRows: 3 });
    expect(preview.sheetName).toBe("Sheet0");
    expect(preview.rows).toHaveLength(3);
    expect(preview.totalSheets).toBe(1);
    expect(preview.truncated).toBe(true);
    expect(preview.rows[0][0]).toBe("Rekeningnummer");
  });

  it("stops reading at the cap instead of parsing the whole workbook first", async () => {
    // The cap has to bound the WORK, not just the response: XLSX.read is
    // synchronous, so a hostile workbook parsed in full stalls every request
    // this server is handling. Asserting the row count is not enough — a
    // reader that parsed everything and sliced afterwards passes that. The
    // fixture declares a 20 000-row grid holding two cells; a reader that
    // honours the declaration materializes 20 000 rows.
    const bomb = Buffer.from(readFileSync(
      new URL("../../../parsers/fixtures/dimension-bomb.xlsx", import.meta.url)));
    const { sha256 } = await storeFile(vaultDir, bomb);
    await caller().documents.registerUpload({
      sha256, sizeBytes: 1, mime: "application/octet-stream",
      title: "bomb.xlsx", source: "upload", receivedAt: new Date() });
    const t0 = Date.now();
    const preview = await caller().documents.sheetPreview({ sha256, maxRows: 200 });
    expect(preview.rows).toHaveLength(2);
    expect(preview.truncated).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 20_000);

  it("says NOT_FOUND when the row exists but the bytes are gone", async () => {
    // An orphan row is a diagnosable 404, not a 500 with a masked message.
    const sha256 = sha();
    await caller().documents.registerUpload({
      sha256, sizeBytes: 10, mime: "application/vnd.ms-excel",
      title: "vanished.xls", source: "upload", receivedAt: new Date() });
    await expect(caller().documents.sheetPreview({ sha256 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a document that is not a spreadsheet", async () => {
    const buf = Buffer.from("%PDF-1.4\nnot a sheet");
    const { sha256 } = await storeFile(vaultDir, buf);
    await caller().documents.registerUpload({
      sha256, sizeBytes: buf.length, mime: "application/pdf",
      title: "letter.pdf", source: "upload", receivedAt: new Date() });
    await expect(caller().documents.sheetPreview({ sha256 }))
      .rejects.toThrow(/not a spreadsheet/i);
  });

  it("discards a document by appending a status change and a ledger event", async () => {
    const doc = await seedDocument({ title: "image.png", mime: "image/png" });

    const before = await db.select().from(schema.ledgerEvents);
    const updated = await caller().documents.update({ id: doc.id, status: "discarded" });
    expect(updated.effectiveStatus).toBe("discarded");

    const after = await db.select().from(schema.ledgerEvents);
    expect(after.length).toBe(before.length + 1);

    // The bytes and the row are untouched — discard is not deletion.
    const [row] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, doc.id));
    expect(row).toBeDefined();
    expect(row.sha256).toBe(doc.sha256);
  });

  it("undoes a discard by appending another status change", async () => {
    const doc = await seedDocument({ title: "image.png", mime: "image/png" });
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const restored = await caller().documents.update({ id: doc.id, status: "inbox" });
    expect(restored.effectiveStatus).toBe("inbox");

    // Both transitions survive as history; nothing is overwritten.
    const changes = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id))
      .orderBy(asc(schema.documentStatusChanges.createdAt));
    expect(changes.map((c) => c.status)).toEqual(["discarded", "inbox"]);
  });

  it("leaves the ledger chain verifying after a discard", async () => {
    const doc = await seedDocument({ title: "image.png", mime: "image/png" });
    await caller().documents.update({ id: doc.id, status: "discarded" });
    await expect(verifyLedger()).resolves.toMatchObject({ ok: true });
  });

  it("runFullVerification's recompute dispatch covers document.updated events", async () => {
    // Without this dispatch line the whole discard feature is unauditable:
    // an UPDATE on document_status_changes flips a document's EFFECTIVE status
    // — hiding a court decision from the vault list, the queue and search —
    // while /verify keeps reporting ok, because the recompute fell through to
    // `return e.payloadHash` and echoed the stored hash back. Same lesson as
    // task.status and registry.decision: an untested dispatch line is a hole.
    const doc = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf" });
    await caller().documents.update({ id: doc.id, status: "filed", title: "Beschikking.pdf" });
    const [change] = await db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, doc.id));
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const ev = rows.find((e) => e.eventType === "document.updated" && e.entityId === doc.id)!;
    const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType,
      entityType: ev.entityType, entityId: ev.entityId,
      payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
    const ctx = async () => ({ linkedLater: new Map<string, Set<string>>(),
      resolvedLinkHash: new Map<number, string>(),
      resolvedStatusHash: await resolveDocumentUpdatedHashes(db, rows) });

    // Green: the dispatch recomputes the exact stored payload hash.
    expect(await makeLedgerRecompute(db, vaultDir, await ctx())(event)).toBe(ev.payloadHash);

    // Tampered: the admin role edits the evidence row behind the ledger's back.
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE document_status_changes
        SET status = 'discarded' WHERE id = ${change.id}`);
      // The effective status really did change — this is the attack, not a
      // hypothetical: the document is now hidden from every surface.
      expect((await caller().documents.get({ id: doc.id })).effectiveStatus).toBe("discarded");
      expect(await makeLedgerRecompute(db, vaultDir, await ctx())(event)).not.toBe(ev.payloadHash);
      await admin.db.execute(sql`UPDATE document_status_changes
        SET status = ${change.status} WHERE id = ${change.id}`);
      expect(await makeLedgerRecompute(db, vaultDir, await ctx())(event)).toBe(ev.payloadHash);
    } finally {
      await admin.pool.end();
    }

    // An event whose status-change row cannot be resolved at all is flagged,
    // never silently passed through.
    const ghost: ChainEvent = { ...event, seq: -1 };
    expect(await makeLedgerRecompute(db, vaultDir, await ctx())(ghost)).not.toBe(ev.payloadHash);
  });

  it("omits discarded documents from the vault list by default", async () => {
    const keep = await seedDocument({ title: "Beschikking.pdf", mime: "application/pdf" });
    const junk = await seedDocument({ title: "image.png", mime: "image/png" });
    await caller().documents.update({ id: junk.id, status: "discarded" });

    const list = await caller().documents.list({ limit: 100 });
    expect(list.map((d) => d.id)).toContain(keep.id);
    expect(list.map((d) => d.id)).not.toContain(junk.id);
  });

  it("returns discarded documents when explicitly asked", async () => {
    const junk = await seedDocument({ title: "image.png", mime: "image/png" });
    await caller().documents.update({ id: junk.id, status: "discarded" });

    const list = await caller().documents.list({ limit: 100, includeDiscarded: true });
    expect(list.map((d) => d.id)).toContain(junk.id);
  });

  it("still filters by an explicit status", async () => {
    const filed = await seedDocument({ title: "Plan.pdf", mime: "application/pdf" });
    await caller().documents.update({ id: filed.id, status: "filed" });
    const list = await caller().documents.list({ status: "filed", limit: 100 });
    // Not toEqual([filed.id]): this suite shares one persistent database with
    // every other test file, and evidence tables are never truncated, so other
    // filed documents legitimately co-exist. What the filter must guarantee is
    // that ours is present and that nothing unfiled leaks through.
    expect(list.map((d) => d.id)).toContain(filed.id);
    expect(list.every((d) => d.effectiveStatus === "filed")).toBe(true);
  });

  it("rejects an unauthenticated caller", async () => {
    // asserting the CODE, not merely "it threw": an unknown sha would throw
    // NOT_FOUND too, which would pass a bare toThrow() without proving auth.
    await expect(anonCaller().documents.sheetPreview({ sha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
