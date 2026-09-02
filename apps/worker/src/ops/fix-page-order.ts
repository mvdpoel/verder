/**
 * Put already-scanned multi-page PDFs on the share back in page order.
 *
 * The sweep does this for new arrivals; this is for the ones that landed
 * before it could. Reordering changes the bytes and therefore the sha256, so
 * a file corrected here is INGESTED AS A NEW DOCUMENT on the next sweep — the
 * shuffled original stays in the dossier until it is discarded, which is a
 * deliberate choice: two documents visible is recoverable, silently replacing
 * evidence is not.
 *
 *   pnpm --filter worker fix-page-order [--dry-run] [--only <name>]
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { realOcrPort } from "../extract";
import { reorderIfShuffled } from "../nas";

export async function fixPageOrder(deps: {
  scanDir: string; dryRun?: boolean; only?: string; log?: (s: string) => void;
}): Promise<{ scanned: number; fixed: number }> {
  const log = deps.log ?? (() => {});
  const ocr = realOcrPort();
  let scanned = 0, fixed = 0;
  try {
    for (const name of await readdir(deps.scanDir)) {
      if (extname(name).toLowerCase() !== ".pdf") continue;
      if (deps.only && name !== deps.only) continue;
      const abs = join(deps.scanDir, name);
      if (!(await stat(abs)).isFile()) continue;
      scanned++;
      const buf = await readFile(abs);
      let out: Awaited<ReturnType<typeof reorderIfShuffled>>;
      try { out = await reorderIfShuffled(buf, "application/pdf", ocr); }
      catch (err) { log(`  ! ${name}: ${String(err)}`); continue; }
      if (!out) continue;
      log(`  ${name}: pages ${out.order.map((i) => i + 1).join(",")} -> 1..${out.order.length}`);
      if (!deps.dryRun) await writeFile(abs, out.bytes);
      fixed++;
    }
  } finally { await ocr.close?.(); }
  return { scanned, fixed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--only");
  const res = await fixPageOrder({
    scanDir: process.env.NAS_SCAN_DIR ?? "/scans",
    dryRun: argv.includes("--dry-run"),
    only: i >= 0 ? argv[i + 1] : undefined,
    log: (l) => console.log(l),
  });
  console.log(`fix-page-order: scanned ${res.scanned}, fixed ${res.fixed}`);
}
