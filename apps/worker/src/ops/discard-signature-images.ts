// Backfill: discard the signature logos that were filed as vault documents
// before gmail-auth learned to skip them.
//
//   pnpm --filter worker discard-signature-images
//
// In production it runs inside the worker container, like extract-texts:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker discard-signature-images
//
// Idempotent: a document whose EFFECTIVE status is already 'discarded' is
// skipped, so a second run appends nothing. Nothing is ever deleted — discard
// is an append to document_status_changes with its ledger event, exactly what
// documents.update does when Martin clicks the button himself, and every one of
// these stays individually undoable from its vault page.
import { and, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { recordRun } from "../heartbeat";

/**
 * The title is the key because nothing better survived ingestion.
 *
 * The skip in `gmail-parts.ts` reads `Content-Disposition: inline` plus a
 * `Content-ID` — but those headers belong to the message part, and a document
 * row keeps only what ingestion copied out of it: sha256, size, mime, title,
 * source. The disposition is gone. It is still in the archived RFC822 original,
 * but re-parsing every stored .eml to re-derive a header for nine rows buys
 * nothing over the signal that is already right there in the row.
 *
 * So `title = 'image.png'` is the honest available signal: it is the filename
 * Gmail assigns an inline body image that had no name of its own, and on
 * 2026-08-20 it matched all nine of the production junk documents and nothing
 * else. Narrowed by `source = 'email-attachment'`, so a file Martin uploaded
 * himself under that name is never in scope.
 *
 * Deliberately not a heuristic on size or mime: this is a one-time cleanup of a
 * known population, not a rule the system keeps applying. Anything it misses,
 * Martin discards with one click.
 */
const SIGNATURE_IMAGE_TITLE = "image.png";

export interface DiscardBackfillResult {
  scanned: number; discarded: number; skipped: number;
}

export async function discardSignatureImages(
  db: Db,
  opts: { log?: (line: string) => void } = {},
): Promise<DiscardBackfillResult> {
  const log = opts.log ?? (() => {});
  const rows = await db.select().from(schema.documents)
    .where(and(eq(schema.documents.source, "email-attachment"),
      eq(schema.documents.title, SIGNATURE_IMAGE_TITLE)));

  let discarded = 0;
  let skipped = 0;
  for (const row of rows) {
    // The EFFECTIVE status, never row.status: discard lives in
    // document_status_changes and the column keeps reading 'inbox' forever, so
    // reading it here would re-discard every document on every run.
    const eff = await effectiveDocument(db, row.id);
    if (eff.effectiveStatus === "discarded") {
      skipped++;
      continue;
    }
    // Say what is about to be touched before touching it — this writes to the
    // evidence record, and Martin should be able to read back exactly what it
    // did from the log alone.
    log(`discard-signature-images: discarding ${row.id} — ${eff.effectiveTitle}`
      + ` (${row.sizeBytes} bytes, ${row.mime}, ${row.source})`);
    await db.transaction(async (tx) => {
      // Carry the effective title/docType forward. effectiveDocument reads them
      // from the LATEST status change only, so writing this row without them
      // would silently revert a correction made when the document was filed.
      await tx.insert(schema.documentStatusChanges).values({
        documentId: row.id, status: "discarded",
        title: eff.effectiveTitle, docType: eff.effectiveDocType ?? undefined });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: row.id,
        payload: { id: row.id, status: "discarded",
          title: eff.effectiveTitle ?? null, docType: eff.effectiveDocType ?? null } });
    });
    discarded++;
  }
  return { scanned: rows.length, discarded, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    console.log("discard-signature-images: start");
    const res = await discardSignatureImages(db, { log: (line) => console.log(line) });
    await recordRun(db, "discard-signature-images", "ok", res);
    console.log(`discard-signature-images: done — scanned ${res.scanned},`
      + ` discarded ${res.discarded}, already discarded ${res.skipped}`);
  } catch (err) {
    await recordRun(db, "discard-signature-images", "error", { message: String(err) })
      .catch(() => {});
    console.error(`discard-signature-images: failed — ${String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
