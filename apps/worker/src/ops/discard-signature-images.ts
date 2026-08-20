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
import { and, eq, lt, sql } from "drizzle-orm";
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
 *
 * Two guards keep the query honest about that:
 *
 * - `created_at < SIGNATURE_IMAGE_INGESTED_BEFORE`. `image.png` is also the
 *   filename Gmail, Apple Mail and Outlook give a pasted-from-clipboard image —
 *   a screenshot of a payment overview, a photo of a letter — sent as a genuine
 *   `Content-Disposition: attachment` part, which is exactly what the port
 *   filter now KEEPS. Without a bound, a re-run after a restore (this is a
 *   registered pnpm script and a documented deploy step, so it WILL run again)
 *   would sweep up every one of those that arrived since.
 * - Only a document still sitting in the inbox is touched. `filed` is an
 *   explicit human judgement that the document matters, and a title match must
 *   never override it.
 */
const SIGNATURE_IMAGE_TITLE = "image.png";

/** The nine were measured in production on 2026-08-20; the population this
 *  script is about ends that day. */
export const SIGNATURE_IMAGE_INGESTED_BEFORE = new Date("2026-08-21T00:00:00.000Z");

export interface DiscardBackfillResult {
  scanned: number; discarded: number; skipped: number;
}

export async function discardSignatureImages(
  db: Db,
  opts: { log?: (line: string) => void; before?: Date } = {},
): Promise<DiscardBackfillResult> {
  const log = opts.log ?? (() => {});
  const before = opts.before ?? SIGNATURE_IMAGE_INGESTED_BEFORE;
  const rows = await db.select().from(schema.documents)
    .where(and(eq(schema.documents.source, "email-attachment"),
      eq(schema.documents.title, SIGNATURE_IMAGE_TITLE),
      lt(schema.documents.createdAt, before)));

  let discarded = 0;
  let skipped = 0;
  for (const row of rows) {
    // The EFFECTIVE status, never row.status: discard lives in
    // document_status_changes and the column keeps reading 'inbox' forever, so
    // reading it here would re-discard every document on every run.
    //
    // Anything but 'inbox' is left alone. 'discarded' is what makes a second
    // run append nothing; 'filed' is Martin saying this one matters, and no
    // title match outranks that.
    const eff = await effectiveDocument(db, row.id);
    if (eff.effectiveStatus !== "inbox") {
      skipped++;
      continue;
    }
    const wrote = await db.transaction(async (tx) => {
      // The check above ran OUTSIDE this transaction, which is a TOCTOU: two
      // runs at once — or one run racing Martin clicking Discard — both read
      // "inbox" and both append, and the evidence record then claims the
      // document was discarded twice. Reproduced with two connection pools.
      // The advisory lock serializes writers per document, and READ COMMITTED
      // means the re-read below sees whatever the other writer committed.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${row.id}::text, 0))`);
      const fresh = await effectiveDocument(tx, row.id);
      if (fresh.effectiveStatus !== "inbox") return false;
      // Say what is about to be touched before touching it — this writes to
      // the evidence record, and Martin should be able to read back exactly
      // what it did from the log alone.
      log(`discard-signature-images: discarding ${row.id} — ${fresh.effectiveTitle}`
        + ` (${row.sizeBytes} bytes, ${row.mime}, ${row.source})`);
      // Carry the effective title/docType forward. effectiveDocument reads them
      // from the LATEST status change only, so writing this row without them
      // would silently revert a correction made when the document was filed.
      await tx.insert(schema.documentStatusChanges).values({
        documentId: row.id, status: "discarded",
        title: fresh.effectiveTitle, docType: fresh.effectiveDocType ?? undefined });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: row.id,
        payload: { id: row.id, status: "discarded",
          title: fresh.effectiveTitle ?? null, docType: fresh.effectiveDocType ?? null } });
      return true;
    });
    if (wrote) discarded++; else skipped++;
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
    // No heartbeat on success, deliberately — reindex.ts is the precedent, not
    // extract-texts.ts. The dashboard marks any worker unseen for 15 minutes
    // red, so a one-time job that records "ok" becomes a permanent red row for
    // something that is never supposed to run again, and degrades the one panel
    // whose value is that red means something.
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
