import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { storeFile } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

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

  it("rejects an unauthenticated caller", async () => {
    // asserting the CODE, not merely "it threw": an unknown sha would throw
    // NOT_FOUND too, which would pass a bare toThrow() without proving auth.
    await expect(anonCaller().documents.sheetPreview({ sha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
