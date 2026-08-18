import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";
import { runFullVerification } from "../verification";
import { assertSafeToTruncate } from "../test-db-guard";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("verify router", () => {
  let db: Db; let userId: string; let vaultDir: string;
  beforeAll(async () => {
    // Whole-chain verification needs a coherent chain. Other test files
    // register documents whose vault files never existed on disk, so wipe the
    // evidence tables first (admin role — the app role has no DELETE grants).
    // vitest.config.ts disables file parallelism so this cannot race them.
    // Never truncate a non-local database (DATABASE_URL could point at the
    // real evidence ledger) — fail loudly instead.
    assertSafeToTruncate(ADMIN_URL);
    const admin = createDb(ADMIN_URL);
    await admin.db.execute(sql`TRUNCATE ledger_events, log_entries, documents, parties CASCADE`);
    await admin.pool.end();
    db = createDb(APP_URL).db;
    vaultDir = mkdtempSync(join(tmpdir(), "vault-verify-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await db.insert(schema.users)
      .values({ email: `v${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("verifies the whole chain including document files", async () => {
    const c = caller();
    const buf = Buffer.from(`evidence-${Date.now()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verify me", source: "upload", receivedAt: new Date() });
    const res = await c.verify.run();
    expect(res.ok).toBe(true);
    expect(res.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.checkedFiles).toBeGreaterThan(0);
  });

  it("exportRange returns entries with joined context", async () => {
    const c = caller();
    const p = await c.parties.create({ kind: "person", name: "Case Manager" });
    await c.entries.create({ occurredAt: new Date(), channel: "meeting",
      direction: "internal", summary: "Export test entry",
      participantPartyIds: [p.id], documentIds: [], actionItems: [] });
    const exp = await c.verify.exportRange({
      from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
    expect(exp.headHash).toBeTruthy();
    expect(exp.entries.some((e) => e.summary === "Export test entry")).toBe(true);
    const found = exp.entries.find((e) => e.summary === "Export test entry");
    expect(found?.participants).toContain("Case Manager");
  });

  it("stays green after documents.linkToEntry adds a doc to an existing entry", async () => {
    const c = caller();
    const mkDoc = async (label: string) => {
      const buf = Buffer.from(`${label}-${Date.now()}`);
      const sha = sha256Hex(buf);
      const abs = join(vaultDir, relPathFor(sha));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      return c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
        mime: "text/plain", title: label, source: "upload", receivedAt: new Date() });
    };
    const docA = await mkDoc("linked-at-creation");
    const docB = await mkDoc("linked-later");
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "email",
      direction: "inbound", summary: "Entry that gains a document later",
      participantPartyIds: [], documentIds: [docA.id], actionItems: [] });
    expect((await c.verify.run()).ok).toBe(true);
    await c.documents.linkToEntry({ documentId: docB.id, entryId: entry.id });
    const res = await c.verify.run();
    expect(res).toMatchObject({ ok: true });
  });

  it("detects a document link added directly to the DB without a ledger event", async () => {
    const c = caller();
    const buf = Buffer.from(`sneaky-${Date.now()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Sneaky doc", source: "upload", receivedAt: new Date() });
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "letter",
      direction: "inbound", summary: "Entry targeted by direct link tampering",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`INSERT INTO entry_documents (entry_id, document_id)
        VALUES (${entry.id}, ${doc.id})`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      await admin.db.execute(sql`DELETE FROM entry_documents
        WHERE entry_id = ${entry.id} AND document_id = ${doc.id}`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("router and runFullVerification report identical results (green and tampered)", async () => {
    const c = caller();
    // Green case: same result object from both entry points.
    const viaRouter = await c.verify.run();
    const direct = await runFullVerification(db, vaultDir);
    expect(direct).toEqual(viaRouter);
    expect(direct.ok).toBe(true);
    // Tampered case: both must flag the same seq for the same reason.
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "other",
      direction: "internal", summary: "Parity check entry",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'parity-tampered' WHERE id = ${entry.id}`);
      const brokenRouter = await c.verify.run();
      const brokenDirect = await runFullVerification(db, vaultDir);
      expect(brokenDirect).toEqual(brokenRouter);
      expect(brokenDirect.ok).toBe(false);
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'Parity check entry' WHERE id = ${entry.id}`);
      expect((await runFullVerification(db, vaultDir)).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("detects tampering with a stored log entry row", async () => {
    const c = caller();
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "call",
      direction: "inbound", summary: "Original untampered summary",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'tampered' WHERE id = ${entry.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      // Restore so the chain is coherent again for later tests.
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'Original untampered summary' WHERE id = ${entry.id}`);
      const restored = await c.verify.run();
      expect(restored.ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });
});
