/**
 * Discard named documents. Blank pages, duplicate scans, a page the feeder
 * pulled twice — things that are in the vault and should not be in the file
 * list.
 *
 * A discard is an APPEND to document_status_changes with its ledger event,
 * never a delete: `documents` is append-only and already carries a
 * document.ingested event for these bytes. The vault copy is kept, so an
 * Undo in the app is always possible.
 *
 *   pnpm --filter worker discard-documents <uuid> [uuid...]
 */
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument } from "@verder/api/src/routers/documents";

export async function discardDocuments(
  db: ReturnType<typeof createDb>["db"],
  ids: string[],
  log: (s: string) => void = () => {},
): Promise<{ discarded: number; skipped: number }> {
  let discarded = 0, skipped = 0;
  for (const id of ids) {
    const wrote = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 0))`);
      const [doc] = await tx.select().from(schema.documents)
        .where(eq(schema.documents.id, id));
      if (!doc) { log(`  ? ${id}: not found`); return false; }
      const fresh = await effectiveDocument(tx, id);
      // Discarding an already-discarded document is a no-op, not a second
      // decision: the record would otherwise claim it was discarded twice.
      if (fresh.effectiveStatus === "discarded") {
        log(`  = ${fresh.effectiveTitle}: already discarded`); return false;
      }
      // Carry title/docType/partyId forward. effectiveDocument resolves each
      // from the newest row that has an opinion, so omitting them here is
      // safe today -- but the discard-signature-images precedent writes them,
      // and two spellings of one rule is how they come to disagree.
      await tx.insert(schema.documentStatusChanges).values({
        documentId: id, status: "discarded",
        title: fresh.effectiveTitle, docType: fresh.effectiveDocType ?? undefined,
        partyId: fresh.effectivePartyId ?? undefined });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: id,
        payload: { id, status: "discarded",
          title: fresh.effectiveTitle ?? null, docType: fresh.effectiveDocType ?? null,
          partyId: fresh.effectivePartyId ?? null } });
      log(`  discarded ${fresh.effectiveTitle}`);
      return true;
    });
    if (wrote) discarded++; else skipped++;
  }
  return { discarded, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (ids.length === 0) { console.error("usage: discard-documents <uuid>..."); process.exit(1); }
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    const res = await discardDocuments(db, ids, (l) => console.log(l));
    console.log(`discard-documents: discarded ${res.discarded}, skipped ${res.skipped}`);
  } finally { await pool.end(); }
}
