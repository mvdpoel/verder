import { and, eq, or } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveTitleSql } from "@verder/api/src/effective-status";

/**
 * Recognise an already-ingested file from its stat alone. The dedup that
 * matters is still sha256, but reaching it costs a full read, and the sweep
 * runs every 2 minutes over NFS against a folder measured in gigabytes:
 * hashing every byte of every file on every tick never finishes.
 * name+size+mtime is exact enough to skip the read, and a miss only falls
 * through to the hash, which is the authority.
 *
 * source_ref is the name at INGEST and never changes -- documents has no
 * UPDATE grant -- so after auto-name renames a file on the share the two no
 * longer agree and this check misses every renamed file forever. It therefore
 * also accepts the EFFECTIVE title, which auto-name sets to exactly the new
 * filename. Measured: without this, 117 of 121 files were fully re-read from
 * the NAS on every single tick.
 */
export async function isKnownNasFile(
  db: Db, name: string, st: { size: number; mtime: Date },
): Promise<boolean> {
  const [known] = await db.select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(
      eq(schema.documents.source, "nas-scan"),
      or(eq(schema.documents.sourceRef, name), eq(effectiveTitleSql, name)),
      eq(schema.documents.sizeBytes, st.size),
      eq(schema.documents.receivedAt, st.mtime),
    ));
  return !!known;
}
