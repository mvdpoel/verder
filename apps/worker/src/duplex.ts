/**
 * Two single-sided passes through a sheet feeder, merged into one document.
 *
 * Martin feeds the stack (fronts), turns it over along the long edge and feeds
 * it again (backs). The scanner writes scanNNNN.pdf and scan(NNNN+1).pdf, and
 * the backs file holds the last sheet's back FIRST, upright. Sheet i of n
 * therefore pairs front page i with backs-file page n-1-i.
 *
 * A WRONG MERGE IS WORSE THAN A MISSED ONE. Ingest is append-only and
 * permanent, and a merged PDF that interleaves two unrelated documents
 * misrepresents both. Everything here refuses on doubt and leaves both files to
 * the ordinary path.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@verder/db";
import { isKnownNasFile } from "./nas-known";
import { ocrPageUpright, rasterizePdf, type OcrPort } from "./extract";
import { recordRun } from "./heartbeat";
import { findPageMarkers } from "./page-order";
import type { NotifyFn } from "./notify/notify";
import { MAX_REORDER_PAGES, pdfPageCount } from "./reorder-pdf";

const run = promisify(execFile);

/** `scan_0001.pdf` and every renamed file are deliberately NOT this. */
export const SCANNER_NAME = /^scan(\d+)\.pdf$/i;

export const DUPLEX_WINDOW_MS = 10 * 60_000;
/** Window plus margin: a fronts file must never be ingested before its backs can arrive. */
export const DUPLEX_HOLD_MS = 12 * 60_000;
export const MAX_DUPLEX_PAGES = MAX_REORDER_PAGES / 2;

// Alphanumeric characters BELOW which a back counts as blank. Measured with the
// real tesseract (nld+eng) through ocrPageUpright on A4 at 200 dpi, synthetic
// ImageMagick pages: pristine white 0, sparse dust 0, "Sla om" alone in a corner
// 5, the footer "Paginanummer 2 van 2" alone 17, a one-line letter 60. 8 drops
// "Sla om" and keeps the footer-only page, which carries a page marker. LIMIT:
// dense paper grain is not blank to tesseract at all (2800 and 3193 garbage
// characters, ~110 s per page), so a grainy back reads "neutral" -- the safe
// direction, it only costs the merge.
export const BLANK_MAX_ALNUM = 8;

export type SheetEvidence = "blank" | "marker" | "neutral" | "contradiction";

export interface DuplexJudgement {
  merge: boolean;
  evidence: SheetEvidence[];
  /** Indices into [fronts 0..n-1, backs 0..n-1], interleaved, blank backs omitted. */
  order: number[];
  reason: string;
}

const alnum = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;

function keywordMarkers(text: string) {
  return findPageMarkers(text).filter((m) => m.keyword && m.total !== null);
}

function sheetEvidence(front: string, back: string): SheetEvidence {
  if (alnum(back) < BLANK_MAX_ALNUM) return "blank";
  const f = keywordMarkers(front), b = keywordMarkers(back);
  if (f.length === 0 || b.length === 0) return "neutral";
  return f.some((fm) => b.some((bm) => bm.total === fm.total && bm.page === fm.page + 1))
    ? "marker" : "contradiction";
}

export function judgeDuplexPair(frontTexts: string[], backTexts: string[]): DuplexJudgement {
  const n = frontTexts.length;
  const refuse = (reason: string, evidence: SheetEvidence[] = []): DuplexJudgement =>
    ({ merge: false, evidence, order: [], reason });
  if (n < 1 || n !== backTexts.length) return refuse("page counts differ");
  const evidence = frontTexts.map((f, i) => sheetEvidence(f, backTexts[n - 1 - i]));
  if (evidence.includes("contradiction")) return refuse("a back page numbers itself against its front", evidence);
  if (!evidence.some((e) => e === "blank" || e === "marker")) return refuse("no evidence the files belong together", evidence);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push(i);
    if (evidence[i] !== "blank") order.push(2 * n - 1 - i);
  }
  return { merge: true, evidence, order, reason: "merged" };
}

export interface ScanCandidate { name: string; seq: number; mtimeMs: number; pages: number }

/** Greedy, lowest first: B must directly follow A in sequence and in time. */
export function pairCandidates<T extends ScanCandidate>(cands: T[]): [T, T][] {
  const sorted = [...cands].sort((a, b) => a.seq - b.seq);
  const pairs: [T, T][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const dt = b.mtimeMs - a.mtimeMs;
    if (b.seq === a.seq + 1 && dt >= 0 && dt <= DUPLEX_WINDOW_MS
      && a.pages === b.pages && a.pages <= MAX_DUPLEX_PAGES) {
      pairs.push([a, b]);
      i++;
    }
  }
  return pairs;
}

/** pdfunite of arbitrary pages of two PDFs; `order` indexes [a pages, b pages]. */
export async function mergePdfPages(a: Buffer, b: Buffer, pages: number, order: number[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "verder-duplex-"));
  try {
    await writeFile(join(dir, "a.pdf"), a);
    await writeFile(join(dir, "b.pdf"), b);
    await run("pdfseparate", [join(dir, "a.pdf"), join(dir, "a-%d.pdf")], { timeout: 120_000 });
    await run("pdfseparate", [join(dir, "b.pdf"), join(dir, "b-%d.pdf")], { timeout: 120_000 });
    const parts = order.map((i) => i < pages ? join(dir, `a-${i + 1}.pdf`) : join(dir, `b-${i - pages + 1}.pdf`));
    const out = join(dir, "out.pdf");
    await run("pdfunite", [...parts, out], { timeout: 120_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const mergedName = (a: string, b: string) =>
  `duplex-${a.replace(/\.pdf$/i, "").toLowerCase()}-${b.replace(/\.pdf$/i, "").toLowerCase()}.pdf`;

export const ORIGINALS_DIR = "duplex-originals";

const exists = (p: string) => stat(p).then(() => true, () => false);

/** The scanner's counter can restart, so an old scan0001.pdf may already be parked. */
async function parkOriginal(scanDir: string, name: string, mtimeMs: number) {
  const dir = join(scanDir, ORIGINALS_DIR);
  await mkdir(dir, { recursive: true });
  let dest = join(dir, name);
  if (await exists(dest)) dest = join(dir, name.replace(/\.pdf$/i, `-${Math.round(mtimeMs)}.pdf`));
  await rename(join(scanDir, name), dest);
}

// Rejected pairs, so a pair that is not a duplex pair is not re-OCRed every
// two minutes for the twelve minutes it spends held. In-process on purpose: a
// restart costs one repeated OCR, and a table would be a migration.
const rejected = new Set<string>();
const pairKey = (a: ScanCandidate & { size: number }, b: ScanCandidate & { size: number }) =>
  `${a.name}:${a.size}:${a.mtimeMs}|${b.name}:${b.size}:${b.mtimeMs}`;

export interface DuplexDeps {
  db: Db; scanDir: string; ocr: OcrPort;
  maxBytes: number;
  /** Required: a merge Martin is not told about is a merge he cannot check. */
  notify: NotifyFn;
}

/** Settled, parseable, not yet ingested scanner-named files. */
async function candidates(deps: DuplexDeps): Promise<(ScanCandidate & { size: number; buf: Buffer })[]> {
  const out: (ScanCandidate & { size: number; buf: Buffer })[] = [];
  for (const name of await readdir(deps.scanDir)) {
    const m = SCANNER_NAME.exec(name);
    if (!m) continue;
    const st = await stat(join(deps.scanDir, name));
    if (!st.isFile() || st.size > deps.maxBytes || Date.now() - st.mtimeMs < 10_000) continue;
    if (await isKnownNasFile(deps.db, name, st)) continue;
    const buf = await readFile(join(deps.scanDir, name));
    // A half-written PDF is not a candidate: the ordinary path refuses it too.
    const pages = await pdfPageCount(buf);
    if (pages === null) continue;
    out.push({ name, seq: Number(m[1]), mtimeMs: st.mtimeMs, pages, size: st.size, buf });
  }
  return out;
}

async function ocrAll(ocr: OcrPort, pdf: Buffer, pages: number): Promise<string[]> {
  const pngs = await rasterizePdf(pdf, { maxPages: pages });
  if (pngs.length !== pages) throw new Error(`rasterized ${pngs.length} of ${pages} pages`);
  const texts: string[] = [];
  for (const png of pngs) texts.push((await ocrPageUpright(ocr, png)).text);
  return texts;
}

/**
 * Files already folded into a merged document whose originals were not yet
 * parked when the process died. "Fresh" is the guard: the scanner's counter
 * restarts, so scan0001.pdf can recur months later, and a merged file OLDER than
 * the candidate belongs to a previous life of that name -- parking the new scan
 * on its account would hide a document that was never ingested.
 */
async function parkAlreadyMerged<T extends ScanCandidate>(scanDir: string, cands: T[]): Promise<T[]> {
  const merged = (await readdir(scanDir)).filter((n) => /^duplex-.*\.pdf$/.test(n));
  const rest: T[] = [];
  for (const c of cands) {
    const stem = c.name.replace(/\.pdf$/i, "").toLowerCase();
    let folded = false;
    for (const m of merged) {
      if (!(m.startsWith(`duplex-${stem}-`) || m.endsWith(`-${stem}.pdf`))) continue;
      if ((await stat(join(scanDir, m))).mtimeMs >= c.mtimeMs) { folded = true; break; }
    }
    if (folded) await parkOriginal(scanDir, c.name, c.mtimeMs);
    else rest.push(c);
  }
  return rest;
}

export async function duplexPass(deps: DuplexDeps): Promise<{ merged: number }> {
  const { db, scanDir } = deps;
  let merged = 0;
  const cands = await parkAlreadyMerged(scanDir, await candidates(deps));
  for (const [A, B] of pairCandidates(cands)) {
    const outName = mergedName(A.name, B.name);
    const outPath = join(scanDir, outName);
    // A merged file of that name that survived the freshness test above is a
    // previous life of the counter: never overwrite it, never guess -- leave
    // both scans to the ordinary path.
    if (await exists(outPath)) continue;
    const key = pairKey(A, B);
    if (rejected.has(key)) continue;
    const front = await ocrAll(deps.ocr, A.buf, A.pages);
    const back = await ocrAll(deps.ocr, B.buf, B.pages);
    const j = judgeDuplexPair(front, back);
    if (!j.merge) {
      rejected.add(key);
      await recordRun(db, "duplex", "ok", { fronts: A.name, backs: B.name, merged: null, reason: j.reason, evidence: j.evidence });
      continue;
    }
    const bytes = await mergePdfPages(A.buf, B.buf, A.pages, j.order);
    // An extension outside the sweep's allowlist, so a half-renamed file is
    // never ingested; rename within one directory is atomic.
    await writeFile(`${outPath}.partial`, bytes);
    await rename(`${outPath}.partial`, outPath);
    await parkOriginal(scanDir, A.name, A.mtimeMs);
    await parkOriginal(scanDir, B.name, B.mtimeMs);
    merged++;
    const droppedBlank = j.evidence.filter((e) => e === "blank").length;
    await recordRun(db, "duplex", "ok", {
      fronts: A.name, backs: B.name, merged: outName, pages: j.order.length, droppedBlank, evidence: j.evidence });
    // Passive: verder's own filing action, worth knowing, never an interruption.
    // notify never throws, but an injected one might, and the merge happened:
    // a missing notification must not undo the record.
    try {
      await deps.notify({ kind: "filing", level: "passive",
        title: "Dubbelzijdige scan samengevoegd",
        body: `${A.name} + ${B.name} → één document, ${j.order.length} pagina's (${droppedBlank} lege achterkanten weggelaten)`,
      });
    } catch { /* see above */ }
  }
  return { merged };
}
