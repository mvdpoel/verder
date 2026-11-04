import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@grip/db";
import { loadDocMetaSamples, writeDocMetaSamples } from "./export-docmeta-samples";

const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";
const RUN = crypto.randomUUID();

describe("loadDocMetaSamples", () => {
  const { db, pool } = createDb(URL);
  afterAll(async () => { await pool.end(); });
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "d");

  /** A document with the document_texts row a real extraction leaves behind. */
  async function doc(title = `scan-${RUN}-${crypto.randomUUID()}.pdf`, text = "Loonstrook juli 2026 Saurens") {
    const s = sha();
    const [d] = await db.insert(schema.documents).values({
      sha256: s, sizeBytes: 10, mime: "application/pdf", title,
      source: "upload", sourceRef: `test:export-docmeta:${RUN}`, receivedAt: new Date() }).returning();
    await db.insert(schema.documentTexts).values({
      documentId: d.id, sha256: s, text, extractor: "pdf-parse", charCount: text.length });
    return d;
  }
  async function decided(documentId: string, status: "approved" | "edited" | "rejected",
    proposed: Record<string, unknown>, finalPayload: Record<string, unknown> | null) {
    await db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, status, model: "qwen3.5:9b", promptVersion: "docmeta-v1",
      proposed, finalPayload, verdictAt: new Date() });
  }
  const mine = async (ids: string[]) => {
    const all = await loadDocMetaSamples(db);
    return all.filter((s) => ids.includes(s.documentId));
  };

  it("exports an edited verdict with its text and Martin's answer", async () => {
    const d = await doc();
    await decided(d.id, "edited", { title: "Loonstrook", docType: "invoice" },
      { title: "Loonstrook juli", docType: "Loonstrook" });
    const [s] = await mine([d.id]);
    expect(s).toEqual({ documentId: d.id, verdict: "edited", text: "Loonstrook juli 2026 Saurens",
      promptTitle: d.title, expected: { title: "Loonstrook juli", docType: "Loonstrook" } });
  });

  it("tells an approved row that was really edited apart from an unchanged one", async () => {
    const a = await doc();
    const b = await doc();
    await decided(a.id, "approved", { title: "Brief", docType: "letter" }, { title: "Brief", docType: "Letter " });
    await decided(b.id, "approved", { title: "Brief", docType: "letter" }, { title: "Brief", docType: "brief" });
    const out = await mine([a.id, b.id]);
    expect(out.find((s) => s.documentId === a.id)?.verdict).toBe("approved-unchanged");
    expect(out.find((s) => s.documentId === b.id)?.verdict).toBe("approved-differs");
  });

  it("leaves out needs-manual-origin, rejected, discarded and purged rows", async () => {
    const manual = await doc();
    await decided(manual.id, "approved", { title: manual.title, docType: null, confident: false },
      { title: "Iets", docType: "brief" });
    const rejected = await doc();
    await decided(rejected.id, "rejected", { title: "x", docType: "letter" }, null);
    const discarded = await doc();
    await decided(discarded.id, "approved", { title: "x", docType: "letter" }, { title: "x", docType: "letter" });
    await db.insert(schema.documentStatusChanges).values({ documentId: discarded.id, status: "discarded" });
    const purged = await doc();
    await decided(purged.id, "approved", { title: "x", docType: "letter" }, { title: "x", docType: "letter" });
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN}-purger@test.local`, name: "Martin" }).returning();
    await db.insert(schema.documentPurges).values({
      documentId: purged.id, sha256: purged.sha256, sizeBytes: purged.sizeBytes, createdBy: u.id });
    expect(await mine([manual.id, rejected.id, discarded.id, purged.id])).toEqual([]);
  });

  // The prompt must show what the MODEL saw, never Martin's verdict: once he
  // approved a title it is the current effective title, and handing it back to
  // the model as the "filename" would leak the expected answer into the prompt.
  it("promptTitle is the effective title as it stood when the suggestion was made", async () => {
    const d = await doc();
    const autoNamed = `Loonstrook.mp.2026-07.Test${RUN}.pdf`;
    await db.insert(schema.documentStatusChanges).values({ documentId: d.id, status: "inbox", title: autoNamed });
    await decided(d.id, "edited", { title: "Loonstrook", docType: "payslip" },
      { title: "Martins eigen titel", docType: "Loonstrook" });
    await db.insert(schema.documentStatusChanges).values({
      documentId: d.id, status: "filed", title: "Martins eigen titel", docType: "Loonstrook" });
    const [s] = await mine([d.id]);
    expect(s.promptTitle).toBe(autoNamed);
  });

  it("caps the text at 4000 characters", async () => {
    const d = await doc(undefined, "x".repeat(5000));
    await decided(d.id, "edited", { title: "a", docType: "letter" }, { title: "b", docType: "brief" });
    const [s] = await mine([d.id]);
    expect(s.text).toHaveLength(4000);
  });
});

describe("writeDocMetaSamples", () => {
  it("refuses a path inside the repository, where the real text could be committed", async () => {
    await expect(writeDocMetaSamples(join(import.meta.dirname, "docmeta-samples.json"), []))
      .rejects.toThrow(/repository/);
  });

  it("writes the file readable by its owner only", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dms-")), "s.json");
    await writeDocMetaSamples(path, []);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
