import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { scanNasFolder } from "./nas";
import { pdfPageCount } from "./reorder-pdf";
import type { OcrPort } from "./extract";
import { makePdf } from "./test-support/make-pdf";
import { settleDocumentTexts } from "./test-support/document-texts";

const run = promisify(execFile);
const DB = "postgres://verder_worker:verder_worker@localhost:5432/verder";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const age = async (file: string, m: number) => { const d = minutesAgo(m); await utimes(file, d, d); };

// Whole sentences, because ocrPageUpright rotates anything that does not read
// as language and would consume the script out of step.
const LETTER = (n: number, y: number) =>
  `Geachte heer Van der Poel, hierbij bevestigen wij de ontvangst van uw brief en de bijlagen. Pagina ${n} van ${y}`;
const PLAIN = (what: string) =>
  `Geachte heer Van der Poel, hierbij bevestigen wij de afspraak over ${what} en danken u voor uw medewerking.`;

/** Answers OCR calls from a script, in call order. Fails loudly when over- or under-used. */
function scripted(texts: string[]): OcrPort & { left: () => number } {
  const q = [...texts];
  return {
    async ocrImage() {
      const t = q.shift();
      if (t === undefined) throw new Error("OCR called more often than scripted");
      return t;
    },
    left: () => q.length,
  };
}
const noOcr = (): OcrPort => ({ async ocrImage() { throw new Error("OCR must not run here"); } });

async function pdfText(file: string): Promise<string[]> {
  const { stdout } = await run("pdftotext", [file, "-"]);
  return stdout.split("\f").map((p) => p.trim()).filter(Boolean);
}

const shareDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, ".verder-nas"), "");
  return dir;
};

const setup = (prefix: string) => {
  const { db, pool } = createDb(DB);
  return { db, pool, scanDir: shareDir(`${prefix}-`), vaultDir: mkdtempSync(join(tmpdir(), `${prefix}-v-`)) };
};

describe("duplex pairs in the NAS sweep", () => {
  it("merges fronts + reversed backs into ONE document and parks the originals", async () => {
    const { db, pool, scanDir, vaultDir } = setup("dx-merge");
    const tag = `T${Date.now()}`;
    // Sheet 0: front is page 1 of 3, its back (LAST page of the backs file) is page 2.
    // Sheet 1: front is the closing page, its back (FIRST page of the backs file) is blank.
    const fronts = makePdf([`${tag} F0`, `${tag} F1`]);
    const backs = makePdf([`${tag} B1`, `${tag} B0`]);
    await writeFile(join(scanDir, "scan0101.pdf"), fronts);
    await writeFile(join(scanDir, "scan0102.pdf"), backs);
    await age(join(scanDir, "scan0101.pdf"), 30);
    await age(join(scanDir, "scan0102.pdf"), 29);
    const ocr = scripted([LETTER(1, 3), PLAIN("de afrekening"), "", LETTER(2, 3)]);
    const pushed: { title: string; body: string }[] = [];
    const enq: string[] = [];
    const deps = { db, scanDir, vaultDir, ocr, enqueueDocMeta: async (d: string) => { enq.push(d); },
      push: async (_db: unknown, p: { title: string; body: string }) => { pushed.push(p); } };

    // The merged file is brand new, so it waits out the 10 s settle window.
    expect((await scanNasFolder(deps as never)).ingested).toBe(0);
    expect(ocr.left()).toBe(0);
    expect((await readdir(scanDir)).filter((n) => n !== ".verder-nas").sort()).toEqual(["duplex-originals", "duplex-scan0101-scan0102.pdf"]);
    expect((await readdir(join(scanDir, "duplex-originals"))).sort()).toEqual(["scan0101.pdf", "scan0102.pdf"]);
    expect(pushed).toEqual([{
      title: "Dubbelzijdige scan samengevoegd",
      body: "scan0101.pdf + scan0102.pdf → één document, 3 pagina's (1 lege achterkanten weggelaten)" }]);

    const merged = join(scanDir, "duplex-scan0101-scan0102.pdf");
    expect(await pdfPageCount(await readFile(merged))).toBe(3);
    expect(await pdfText(merged)).toEqual([`${tag} F0`, `${tag} B0`, `${tag} F1`]);

    await age(merged, 1);
    expect((await scanNasFolder(deps as never)).ingested).toBe(1);
    expect(enq).toHaveLength(1);
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sourceRef, "duplex-scan0101-scan0102.pdf"));
    expect(doc.source).toBe("nas-scan");
    await settleDocumentTexts(db, "duplex-scan0101-scan0102.pdf");
    await pool.end();
  });

  it("leaves two unrelated one-page letters alone and ingests both", async () => {
    const { db, pool, scanDir, vaultDir } = setup("dx-nomerge");
    const tag = `T${Date.now()}`;
    await writeFile(join(scanDir, "scan0111.pdf"), makePdf([`${tag} brief een`]));
    await writeFile(join(scanDir, "scan0112.pdf"), makePdf([`${tag} brief twee`]));
    await age(join(scanDir, "scan0111.pdf"), 30);
    await age(join(scanDir, "scan0112.pdf"), 29);
    const ocr = scripted([PLAIN("de huur"), PLAIN("de verzekering")]);
    const deps = { db, scanDir, vaultDir, ocr, enqueueDocMeta: async () => {} };
    expect((await scanNasFolder(deps)).ingested).toBe(2);
    expect(ocr.left()).toBe(0);
    expect((await readdir(scanDir)).filter((n) => n !== ".verder-nas").sort()).toEqual(["scan0111.pdf", "scan0112.pdf"]);
    // Refused once, not re-judged: a second sweep must not touch OCR again.
    expect((await scanNasFolder({ ...deps, ocr: noOcr() })).ingested).toBe(0);
    await settleDocumentTexts(db, "scan0111.pdf");
    await settleDocumentTexts(db, "scan0112.pdf");
    await pool.end();
  });

  it("holds a lone scanner file until the pairing window has passed", async () => {
    const { db, pool, scanDir, vaultDir } = setup("dx-hold");
    const file = join(scanDir, "scan0121.pdf");
    await writeFile(file, makePdf([`T${Date.now()} alleen`]));
    await age(file, 5);
    const deps = { db, scanDir, vaultDir, ocr: noOcr(), enqueueDocMeta: async () => {} };
    expect((await scanNasFolder(deps)).ingested).toBe(0);
    await age(file, 13);
    expect((await scanNasFolder(deps)).ingested).toBe(1);
    await settleDocumentTexts(db, "scan0121.pdf");
    await pool.end();
  });

  it("finishes a merge that crashed before the originals were parked, without a second merged file", async () => {
    const { db, pool, scanDir, vaultDir } = setup("dx-idem");
    const tag = `T${Date.now()}`;
    await writeFile(join(scanDir, "scan0131.pdf"), makePdf([`${tag} F0`]));
    await writeFile(join(scanDir, "scan0132.pdf"), makePdf([`${tag} B0`]));
    await age(join(scanDir, "scan0131.pdf"), 30);
    await age(join(scanDir, "scan0132.pdf"), 29);
    const merged = join(scanDir, "duplex-scan0131-scan0132.pdf");
    await writeFile(merged, makePdf([`${tag} F0`]));
    await age(merged, 1);
    const enq: string[] = [];
    const deps = { db, scanDir, vaultDir, ocr: noOcr(), enqueueDocMeta: async (d: string) => { enq.push(d); } };
    expect((await scanNasFolder(deps)).ingested).toBe(1);
    expect((await readdir(scanDir)).filter((n) => n !== ".verder-nas").sort()).toEqual(["duplex-originals", "duplex-scan0131-scan0132.pdf"]);
    expect((await readdir(join(scanDir, "duplex-originals"))).sort()).toEqual(["scan0131.pdf", "scan0132.pdf"]);
    expect((await scanNasFolder(deps)).ingested).toBe(0);
    expect(enq).toHaveLength(1);
    await settleDocumentTexts(db, "duplex-scan0131-scan0132.pdf");
    await pool.end();
  });

  it("does not hide a recurring scanner name behind a STALE merged file", async () => {
    const { db, pool, scanDir, vaultDir } = setup("dx-stale");
    const tag = `T${Date.now()}`;
    // The scanner's counter restarted: a merged file from an earlier life of
    // scan0141/scan0142 is OLDER than the new scans.
    const stale = join(scanDir, "duplex-scan0141-scan0142.pdf");
    await writeFile(stale, makePdf([`${tag} oud`]));
    await age(stale, 600);
    await writeFile(join(scanDir, "scan0141.pdf"), makePdf([`${tag} nieuw een`]));
    await writeFile(join(scanDir, "scan0142.pdf"), makePdf([`${tag} nieuw twee`]));
    await age(join(scanDir, "scan0141.pdf"), 30);
    await age(join(scanDir, "scan0142.pdf"), 29);
    const deps = { db, scanDir, vaultDir, ocr: noOcr(), enqueueDocMeta: async () => {} };
    const res = await scanNasFolder(deps);
    expect(res.ingested).toBe(3); // stale merged + both new scans, nothing parked or overwritten
    expect((await readdir(scanDir)).filter((n) => n !== ".verder-nas").sort()).toEqual(
      ["duplex-scan0141-scan0142.pdf", "scan0141.pdf", "scan0142.pdf"]);
    for (const n of ["duplex-scan0141-scan0142.pdf", "scan0141.pdf", "scan0142.pdf"]) await settleDocumentTexts(db, n);
    await pool.end();
  });
});
