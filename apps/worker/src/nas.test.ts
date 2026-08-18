import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { scanNasFolder } from "./nas";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("scanNasFolder", () => {
  it("ingests settled files once and enqueues docmeta suggestions", async () => {
    const { db, pool } = createDb(URL);
    const scanDir = mkdtempSync(join(tmpdir(), "nas-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "nas-vault-"));
    const content = Buffer.from(`scan-${Date.now()}`);
    const file = join(scanDir, "scan_0001.pdf");
    await writeFile(file, content);
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old); // settled
    const enq: string[] = [];
    const deps = { db, scanDir, vaultDir, enqueueDocMeta: async (d: string) => { enq.push(d); } };
    expect((await scanNasFolder(deps)).ingested).toBe(1);
    expect((await scanNasFolder(deps)).ingested).toBe(0); // idempotent
    expect(enq).toHaveLength(1);
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256Hex(content)));
    expect(doc.source).toBe("nas-scan");
    expect(doc.title).toBe("scan_0001.pdf");
    await pool.end();
  });
});
