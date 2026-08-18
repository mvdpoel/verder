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

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("verify router", () => {
  let db: Db; let userId: string; let vaultDir: string;
  beforeAll(async () => {
    // Whole-chain verification needs a coherent chain. Other test files
    // register documents whose vault files never existed on disk, so wipe the
    // evidence tables first (admin role — the app role has no DELETE grants).
    // vitest.config.ts disables file parallelism so this cannot race them.
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
});
