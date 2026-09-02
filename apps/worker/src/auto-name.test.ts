import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { autoNameDocument } from "./auto-name";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const PROSE = ("Geachte heer Van der Poel wij bevestigen de ontvangst van uw verzoek "
  + "en wij hebben dat in behandeling genomen bij de rechtbank in het arrondissement ").repeat(3);

async function makeDoc(db: ReturnType<typeof createDb>["db"], title: string) {
  const sha = Array.from({ length: 64 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  return await db.transaction((tx) => ingestDocument(tx, {
    sha256: sha, sizeBytes: 10, mime: "application/pdf",
    title, source: "nas-scan", sourceRef: title, receivedAt: new Date() }));
}

describe("autoNameDocument", () => {
  it("renames the document and the file on the share, and journals it", async () => {
    const { db, pool } = createDb(URL);
    const scanDir = mkdtempSync(join(tmpdir(), "an-"));
    const journalPath = join(mkdtempSync(join(tmpdir(), "anj-")), "j.jsonl");
    const name = `scan${Date.now()}.pdf`;
    writeFileSync(join(scanDir, name), "x");
    const doc = await makeDoc(db, name);
    const newStem = `Huurcontract.Woonhave.Test${Date.now()}`;
    const out = await autoNameDocument({
      db, scanDir, journalPath,
      nameLlm: async () => ({ filename: newStem, confident: true }),
    }, doc.id, PROSE);
    expect(out).toEqual({ renamed: true, from: name, to: `${newStem}.pdf` });
    expect(existsSync(join(scanDir, `${newStem}.pdf`))).toBe(true);
    expect(existsSync(join(scanDir, name))).toBe(false);
    expect((await effectiveDocument(db, doc.id)).effectiveTitle).toBe(`${newStem}.pdf`);
    await pool.end();
  });

  it("refuses garbled OCR without calling the model at all", async () => {
    const { db, pool } = createDb(URL);
    let called = 0;
    const out = await autoNameDocument({
      db, scanDir: mkdtempSync(join(tmpdir(), "an2-")),
      journalPath: join(mkdtempSync(join(tmpdir(), "anj2-")), "j.jsonl"),
      nameLlm: async () => { called++; return { filename: "X", confident: true }; },
    }, "00000000-0000-0000-0000-000000000000", "uorpoIpsin SAISN Xe BABY IM LNOD YIJNG");
    expect(out).toEqual({ renamed: false, reason: "text-not-readable" });
    expect(called).toBe(0);
    await pool.end();
  });

  it("believes a model that says it is not confident", async () => {
    const { db, pool } = createDb(URL);
    const doc = await makeDoc(db, `scan${Date.now()}b.pdf`);
    const out = await autoNameDocument({
      db, scanDir: mkdtempSync(join(tmpdir(), "an3-")),
      journalPath: join(mkdtempSync(join(tmpdir(), "anj3-")), "j.jsonl"),
      nameLlm: async () => ({ filename: "Iets.Anders", confident: false }),
    }, doc.id, PROSE);
    expect(out).toEqual({ renamed: false, reason: "model-not-confident" });
    await pool.end();
  });

  // The guard that matters most for an UNATTENDED rename: the bulk run lost
  // "carolien" from machtiging.carolien.pdf five times before this existed.
  it("refuses a name that drops a distinguishing detail", async () => {
    const { db, pool } = createDb(URL);
    const doc = await makeDoc(db, `machtiging.carolien${Date.now()}.pdf`);
    const out = await autoNameDocument({
      db, scanDir: mkdtempSync(join(tmpdir(), "an4-")),
      journalPath: join(mkdtempSync(join(tmpdir(), "anj4-")), "j.jsonl"),
      nameLlm: async () => ({ filename: "Machtiging", confident: true }),
    }, doc.id, PROSE);
    expect(out.renamed).toBe(false);
    await pool.end();
  });

  it("does not fail when the LLM is unreachable", async () => {
    const { db, pool } = createDb(URL);
    const doc = await makeDoc(db, `scan${Date.now()}c.pdf`);
    const out = await autoNameDocument({
      db, scanDir: mkdtempSync(join(tmpdir(), "an5-")),
      journalPath: join(mkdtempSync(join(tmpdir(), "anj5-")), "j.jsonl"),
      nameLlm: async () => { throw new Error("ECONNREFUSED"); },
    }, doc.id, PROSE);
    expect(out.renamed).toBe(false);
    expect((out as { reason: string }).reason).toContain("llm-failed");
    await pool.end();
  });
});
