import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { scanNasFolder } from "./nas";
import { settleDocumentTexts } from "./test-support/document-texts";

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
    // Shared-dev-DB hygiene, the same debt gmail.test.ts and poll.test.ts
    // settle. The scan's content is stamped per run, so every run of this file
    // ingested a NEW document and none of them ever got a document_texts row:
    // thirteen scan_0001.pdf rows were sitting at the head of pendingDocMeta's
    // `ORDER BY created_at ASC LIMIT 50` page. source_ref is the FILENAME here
    // (nas.ts:36) and the filename is fixed, so this settles the predecessors
    // too — hence "at least one" rather than exactly one.
    expect(await settleDocumentTexts(db, "scan_0001.pdf"))
      .toBeGreaterThanOrEqual(1);
    expect(await settleDocumentTexts(db, "scan_0001.pdf")).toBe(0);
    await pool.end();
  });

  it("skips files it cannot ingest, and never reads their bytes", async () => {
    const { db, pool } = createDb(URL);
    const scanDir = mkdtempSync(join(tmpdir(), "nas-skip-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "nas-skip-vault-"));
    const old = new Date(Date.now() - 60_000);
    // A .zip is not a document: the real share holds a 21.8 GB Downloads.zip,
    // and readFile on it throws ERR_FS_FILE_TOO_LARGE and kills the sweep.
    const zip = join(scanDir, "Downloads.zip");
    await writeFile(zip, Buffer.from("PK\u0003\u0004 not a scan"));
    await utimes(zip, old, old);
    // Over the byte cap, right extension.
    const fat = join(scanDir, "huge.pdf");
    await writeFile(fat, Buffer.alloc(1024));
    await utimes(fat, old, old);
    const enq: string[] = [];
    const res = await scanNasFolder({ db, scanDir, vaultDir, maxBytes: 512,
      enqueueDocMeta: async (d: string) => { enq.push(d); } });
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(2);
    expect(enq).toHaveLength(0);
    await pool.end();
  });

  it("does not re-read a file it has already ingested", async () => {
    const { db, pool } = createDb(URL);
    const scanDir = mkdtempSync(join(tmpdir(), "nas-reread-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "nas-reread-vault-"));
    const content = Buffer.from(`reread-${Date.now()}`);
    const name = `reread_${Date.now()}.pdf`;
    const file = join(scanDir, name);
    await writeFile(file, content);
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    const deps = { db, scanDir, vaultDir, enqueueDocMeta: async () => {} };
    expect((await scanNasFolder(deps)).ingested).toBe(1);
    // Second pass must recognise it from stat alone. On a 22 GB share the
    // old code read and hashed every byte of every file on every 2-minute
    // tick, which never finishes; `read` is what proves it does not.
    const second = await scanNasFolder(deps);
    expect(second.ingested).toBe(0);
    expect(second.read).toBe(0);
    await settleDocumentTexts(db, name);
    await pool.end();
  });
});
