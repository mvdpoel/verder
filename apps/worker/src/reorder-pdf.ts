/**
 * Rewrite a PDF with its pages in a given order, using poppler's pdfseparate
 * and pdfunite — both already in the worker image for rasterizing, so page
 * reordering costs no new dependency in a path that handles attacker-shaped
 * input.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Refuses beyond this: a reorder is for a letter, not for a book. */
export const MAX_REORDER_PAGES = 60;

/**
 * `order[i]` is the 0-based source page that belongs at position i.
 *
 * Every page must appear exactly once. A reorder that dropped or duplicated a
 * page would produce a document that is not the one that was scanned, which is
 * worse than leaving the pages shuffled.
 */
export async function reorderPdf(pdf: Buffer, order: number[]): Promise<Buffer> {
  const n = order.length;
  if (n < 2 || n > MAX_REORDER_PAGES) throw new Error(`reorderPdf: refusing ${n} pages`);
  const seen = new Set(order);
  if (seen.size !== n || order.some((v) => !Number.isInteger(v) || v < 0 || v >= n)) {
    throw new Error("reorderPdf: order is not a permutation");
  }
  const dir = await mkdtemp(join(tmpdir(), "verder-reorder-"));
  try {
    const input = join(dir, "in.pdf");
    await (await import("node:fs/promises")).writeFile(input, pdf);
    // pdfseparate writes 1-based, unpadded names for the %d placeholder.
    await run("pdfseparate", [input, join(dir, "p-%d.pdf")], { timeout: 120_000 });
    const parts = order.map((src) => join(dir, `p-${src + 1}.pdf`));
    const out = join(dir, "out.pdf");
    await run("pdfunite", [...parts, out], { timeout: 120_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


/**
 * Pages in a PDF, or null when it cannot be read at all.
 *
 * A flatbed scanner driven page by page writes its output progressively, so a
 * file can sit still for more than the sweep's ten-second settle window and
 * still be half a PDF. One arrived that way in production: 589 850 bytes,
 * "Couldn't find trailer dictionary", ingested and unreadable forever, because
 * ingestion is append-only and the bytes had already been hashed into the
 * ledger. A file that is not yet a document must not become one.
 */
export async function pdfPageCount(pdf: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "verder-pdfinfo-"));
  try {
    const input = join(dir, "in.pdf");
    await (await import("node:fs/promises")).writeFile(input, pdf);
    const { stdout } = await run("pdfinfo", [input], { timeout: 60_000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
