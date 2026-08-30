// Backfill: record the RFC 5322 Message-ID of every email the dossier already
// holds, so the first sync over the imported mailbox can recognise them.
//
//   pnpm --filter worker backfill-message-ids
//
// In production it runs inside the worker container, like extract-texts:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker backfill-message-ids
//
// WHY IT IS NEEDED. Migration 0030 added `raw_emails.message_id` because it is
// the only identity that spans the two ingest namespaces — a Stalwart Email id
// is not a Gmail message id, and Takeout's mbox bytes are not the bytes Gmail's
// API returned for the same message, measured at 130 relevant messages matching
// 0 of the 107 rows already in the dossier. But a dedup can only skip a message
// it RECOGNISES, and every one of those 107 rows has no Message-ID recorded:
// until they do, the first sync still sees them as new and writes ~114
// permanent duplicate rows into an append-only table, plus ~114 redundant LLM
// jobs on the shared GPU. This script closes that gap.
//
// The bytes are already here: `ingestRawEmail` stores the canonical RFC822
// original in the content-addressed vault before anything else happens, so
// every row's `raw_rfc822_sha256` locates its own `.eml` and the Message-ID is
// re-read from the message itself rather than re-fetched from any mail server.
//
// Idempotent: only rows with `message_id IS NULL` are selected, so a second run
// re-reads nothing it already answered and rewrites nothing.
//
// Appends NO ledger events. `message_id` is DERIVED — it is a header copied out
// of an original the vault keeps forever, recoverable by running this again —
// so recording it asserts no new fact about the case. The evidence is the
// stored `.eml`, and this touches none of it.
import { readFile } from "node:fs/promises";
import { eq, isNull, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { recordRun } from "../heartbeat";
import { extractMessageId } from "../mail/message-id";

/**
 * What one row's stored original turned out to say.
 *
 * THREE OUTCOMES AND NOT TWO, because the operator has to be able to tell them
 * apart. "This message carries no Message-ID header" is an ordinary — if
 * unusual — legal message, and the row simply stays NULL with the dedup falling
 * back to the content hash for it. "The vault has no file for this row" is a
 * gap in the archive itself, which is what `nightly-verify` exists to shout
 * about. Reporting them as one "failed" number would bury the second inside the
 * first and make a damaged vault look like ordinary mail.
 *
 * Pure by construction: it takes bytes or null, never a path and never a row,
 * so the decision is testable without a database and without a filesystem.
 * `null` is the caller's word for "the vault does not hold these bytes" — the
 * I/O and its two distinct failure modes (no file at all vs. a read that threw)
 * stay in `backfillMessageIds`, where they belong.
 */
export type BackfillRowOutcome =
  | { kind: "filled"; messageId: string }
  | { kind: "no-header" }
  | { kind: "missing" };

export function classifyBackfillRow(raw: Buffer | null): BackfillRowOutcome {
  if (raw === null) return { kind: "missing" };
  const messageId = extractMessageId(raw);
  return messageId === null ? { kind: "no-header" } : { kind: "filled", messageId };
}

/** A Message-ID that ended up on more than one row — see `findDuplicates`. */
export interface DuplicateMessageId { messageId: string; rawEmailIds: string[] }

export interface MessageIdBackfillResult {
  considered: number;
  filled: number;
  noHeader: number;
  vaultFileMissing: number;
  readError: number;
  duplicates: DuplicateMessageId[];
}

/**
 * Every Message-ID currently sitting on more than one row, with the rows.
 *
 * DIAGNOSTIC, NEVER A FAILURE. Two rows sharing a Message-ID means the dossier
 * ALREADY holds the same message twice — the likeliest cause being exactly what
 * this slice is about, a Takeout mbox copy and a Gmail API copy of one mail
 * that hash differently and so slipped past the content dedup. That is a fact
 * about the table before this script ran, not something it caused, and it is
 * unrepairable from here: `raw_emails` has no DELETE grant. So the run reports
 * it and completes. Aborting on it would leave every remaining row unfilled —
 * i.e. would guarantee the duplicate flood this backfill exists to prevent —
 * over a condition nobody can act on in the moment.
 *
 * The operator wants it BEFORE trusting the dedup, because these are precisely
 * the ids where "skip, we already have it" will skip one of two rows and leave
 * the other's attachments and suggestions untouched.
 *
 * Whole-table and not run-scoped: a second, no-op run must still report the
 * duplicates, since the question ("what does the table look like now?") is the
 * same one whether or not this run wrote anything.
 */
async function findDuplicates(db: Db): Promise<DuplicateMessageId[]> {
  const rows = await db.execute<{ message_id: string; ids: string[] }>(sql`
    SELECT message_id, array_agg(id::text ORDER BY fetched_at) AS ids
      FROM raw_emails
     WHERE message_id IS NOT NULL
     GROUP BY message_id
    HAVING count(*) > 1
     ORDER BY message_id`);
  return rows.rows.map((r) => ({ messageId: r.message_id, rawEmailIds: r.ids }));
}

/**
 * Fill `raw_emails.message_id` from each row's archived RFC822 original.
 *
 * ONE ROW MUST NEVER FAIL THE RUN. There are 107 rows and any of them can be
 * unreadable for reasons that say nothing about the other 106 — a vault file
 * lost to a bad restore, a permissions problem, a stored hash that predates the
 * content-addressed layout. A run that throws on the first of those leaves
 * every row after it NULL, which is the duplicate flood this script exists to
 * prevent, caused by the script meant to prevent it. So each row is isolated
 * and counted, and a row left NULL is a perfectly acceptable outcome: the dedup
 * falls back to the content hash for it, exactly as it did before 0030.
 *
 * `gmail_message_id` IS NOT TOUCHED HERE, and the temptation to "correct" it
 * for a JMAP-sourced row while the original is open in front of us must be
 * refused: that column is also `documents.source_ref`, and the case map's third
 * level — the mail and its files hanging off a stop — is DERIVED from the
 * equality of the two. Rewriting it would silently unlink every attachment of
 * that mail from the map. Only `message_id` is written, ever.
 *
 * Writing it fires `raw_emails_search_outbox_trg`, so each filled row re-enters
 * `search_outbox`. That is cheap and correct rather than something to suppress:
 * `renderEmail` does not include the Message-ID, so the chunk's `source_hash`
 * is unchanged, `indexEntity` counts it `unchanged` and re-embeds nothing.
 */
export async function backfillMessageIds(
  deps: { db: Db; vaultDir: string; log?: (line: string) => void },
  opts: { limit?: number } = {},
): Promise<MessageIdBackfillResult> {
  const log = deps.log ?? (() => {});
  // `message_id IS NULL` is the whole idempotency story: a row this script has
  // already answered is never selected again, so a second run re-reads nothing
  // and rewrites nothing. A row it could NOT answer — no header, no vault file
  // — stays NULL and IS offered again next time, which is deliberate: a vault
  // file restored later must get its chance, and one failed read per run is a
  // stat() call.
  const rows = await deps.db.select({
    id: schema.rawEmails.id, sha256: schema.rawEmails.rawRfc822Sha256,
    gmailMessageId: schema.rawEmails.gmailMessageId,
  })
    .from(schema.rawEmails)
    .where(isNull(schema.rawEmails.messageId))
    .orderBy(sql`${schema.rawEmails.fetchedAt} ASC`)
    .limit(opts.limit ?? 100_000);

  const out: MessageIdBackfillResult = {
    considered: rows.length, filled: 0, noHeader: 0,
    vaultFileMissing: 0, readError: 0, duplicates: [],
  };

  for (const row of rows) {
    let raw: Buffer | null = null;
    try {
      // `readFilePath` also VALIDATES the stored hash (64 lowercase hex) and
      // throws on anything else, which lands in the read-error branch below
      // rather than the missing one — right, because a row whose hash is not a
      // hash is a different problem from a file that is not there.
      raw = await readFile(readFilePath(deps.vaultDir, row.sha256));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        out.vaultFileMissing++;
        log(`backfill-message-ids: no vault file for ${row.id} (${row.sha256})`);
      } else {
        out.readError++;
        log(`backfill-message-ids: unreadable ${row.id} (${row.sha256}) — ${String(err)}`);
      }
      continue;
    }

    const outcome = classifyBackfillRow(raw);
    if (outcome.kind !== "filled") {
      // Only 'no-header' can reach here: 'missing' needs a null buffer and the
      // read above either produced bytes or took the branch that skips.
      out.noHeader++;
      log(`backfill-message-ids: no Message-ID header in ${row.id} (${row.sha256})`);
      continue;
    }
    await deps.db.update(schema.rawEmails)
      .set({ messageId: outcome.messageId })
      .where(eq(schema.rawEmails.id, row.id));
    out.filled++;
  }

  out.duplicates = await findDuplicates(deps.db);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
  const { db, pool } = createDb(url);
  try {
    console.log("backfill-message-ids: start"
      + " — only rows with no Message-ID recorded are considered,"
      + " so a second run is a no-op for everything already filled");
    const res = await backfillMessageIds({ db, vaultDir, log: (l) => console.log(l) });
    // The four outcomes stay four numbers. Folding them into one "failed"
    // figure would hide a vault that has started losing files behind a count
    // that reads like ordinary mail without a Message-ID header.
    console.log(`backfill-message-ids: done — considered ${res.considered},`
      + ` filled ${res.filled}, no Message-ID header ${res.noHeader},`
      + ` vault file missing ${res.vaultFileMissing}, read errors ${res.readError}`);
    if (res.duplicates.length > 0) {
      // Reported, never fatal: this is a duplicate that was ALREADY in the
      // table, it cannot be repaired from here (no DELETE grant on raw_emails),
      // and the operator needs to see it before trusting the dedup to skip one
      // of the two rows.
      console.log(`backfill-message-ids: ${res.duplicates.length} Message-ID(s)`
        + ` now on more than one row — pre-existing duplicates in the dossier:`);
      for (const d of res.duplicates) {
        console.log(`  ${d.messageId} — ${d.rawEmailIds.join(", ")}`);
      }
    }
    // No heartbeat on success, for the reason discard-signature-images spells
    // out: the dashboard marks any worker unseen for 15 minutes red, so a
    // one-time job recording "ok" becomes a permanent red row for something
    // that is never supposed to run again.
  } catch (err) {
    await recordRun(db, "backfill-message-ids", "error", { message: String(err) })
      .catch(() => {});
    console.error(`backfill-message-ids: failed — ${String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
