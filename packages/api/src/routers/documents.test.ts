import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("documents router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `d${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
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
});
