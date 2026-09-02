import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tiff": "image/tiff" };

// Anything larger is not a scan. The cap is a MEMORY bound, not a policy:
// ingest reads the whole file to hash it, and the share this now points at
// holds a 21.8 GB Downloads.zip — past Node's ~2 GiB Buffer ceiling, where
// readFile throws ERR_FS_FILE_TOO_LARGE and takes the whole sweep down with
// it. 100 MB is ~8x the largest real document on the share.
const MAX_BYTES = 100 * 1024 * 1024;

// Polling via cron, not fs-events: inotify is unreliable on a NAS mount, so a
// periodic non-recursive scan is the boring correct choice. The NAS original is
// never deleted or moved — the vault gets its own content-addressed copy.
export async function scanNasFolder(deps: {
  db: Db; scanDir: string; vaultDir: string;
  maxBytes?: number;
  enqueueDocMeta: (documentId: string) => Promise<void>;
}): Promise<{ ingested: number; skipped: number; read: number }> {
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  let ingested = 0, skipped = 0, read = 0;
  try {
    for (const name of await readdir(deps.scanDir)) {
      const abs = join(deps.scanDir, name);
      const st = await stat(abs);
      // Skip files modified <10s ago — the scanner may still be writing them.
      if (!st.isFile() || Date.now() - st.mtimeMs < 10_000) continue;
      // Extension allowlist, checked BEFORE any read. The old code mapped an
      // unknown extension to application/octet-stream and ingested it anyway,
      // which was harmless for a folder holding only scans and is not for a
      // 22 GB general archive of zips and disk images.
      const mime = MIME[extname(name).toLowerCase()];
      if (!mime || st.size > maxBytes) { skipped++; continue; }
      // Recognise an already-ingested file from its stat alone. The dedup that
      // matters is still sha256 below, but reaching it costs a full read, and
      // this sweep runs every 2 minutes over NFS against a folder measured in
      // gigabytes: hashing every byte of every file on every tick never
      // finishes. name+size+mtime is exact enough to skip the read, and a miss
      // only falls through to the hash, which is the authority.
      const [known] = await deps.db.select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(
          eq(schema.documents.source, "nas-scan"),
          eq(schema.documents.sourceRef, name),
          eq(schema.documents.sizeBytes, st.size),
          eq(schema.documents.receivedAt, st.mtime),
        ));
      if (known) continue;
      const buf = await readFile(abs);
      read++;
      const sha = sha256Hex(buf);
      const [seen] = await deps.db.select().from(schema.documents)
        .where(eq(schema.documents.sha256, sha));
      if (seen) continue;
      await storeFile(deps.vaultDir, buf);
      const doc = await deps.db.transaction((tx) => ingestDocument(tx, {
        sha256: sha, sizeBytes: buf.length, mime,
        title: name, source: "nas-scan", sourceRef: name, receivedAt: st.mtime }));
      await deps.enqueueDocMeta(doc.id);
      ingested++;
    }
    await recordRun(deps.db, "nas", "ok", { ingested, skipped, read });
  } catch (err) {
    await recordRun(deps.db, "nas", "error", { message: String(err) });
    throw err;
  }
  return { ingested, skipped, read };
}
