import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tiff": "image/tiff" };

// Polling via cron, not fs-events: inotify is unreliable on a NAS mount, so a
// periodic non-recursive scan is the boring correct choice. The NAS original is
// never deleted or moved — the vault gets its own content-addressed copy.
export async function scanNasFolder(deps: {
  db: Db; scanDir: string; vaultDir: string;
  enqueueDocMeta: (documentId: string) => Promise<void>;
}): Promise<{ ingested: number }> {
  let ingested = 0;
  try {
    for (const name of await readdir(deps.scanDir)) {
      const abs = join(deps.scanDir, name);
      const st = await stat(abs);
      // Skip files modified <10s ago — the scanner may still be writing them.
      if (!st.isFile() || Date.now() - st.mtimeMs < 10_000) continue;
      const buf = await readFile(abs);
      const sha = sha256Hex(buf);
      const [seen] = await deps.db.select().from(schema.documents)
        .where(eq(schema.documents.sha256, sha));
      if (seen) continue;
      await storeFile(deps.vaultDir, buf);
      const doc = await deps.db.transaction((tx) => ingestDocument(tx, {
        sha256: sha, sizeBytes: buf.length,
        mime: MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
        title: name, source: "nas-scan", sourceRef: name, receivedAt: st.mtime }));
      await deps.enqueueDocMeta(doc.id);
      ingested++;
    }
    await recordRun(deps.db, "nas", "ok", { ingested });
  } catch (err) {
    await recordRun(deps.db, "nas", "error", { message: String(err) });
    throw err;
  }
  return { ingested };
}
