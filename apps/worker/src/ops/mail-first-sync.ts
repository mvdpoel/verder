// The ONE-OFF first sync over the imported mailbox, run by hand, with a
// read-only preview.
//
//   pnpm --filter worker mail-first-sync              # preview, writes nothing
//   pnpm --filter worker mail-first-sync -- --commit  # the real ingest
//
// In production it runs inside the worker container, like extract-texts:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker mail-first-sync
//
// WHY IT IS A SCRIPT AND NOT A JOB. Stalwart holds 146 270 imported messages
// and makeJmapPort's DEFAULT_LIMITS enumerate pageSize 500 × firstSyncPages
// 100 = 50 000, so a first sync over this mailbox raises
// MailFirstSyncOverflowError — no job expiry makes that finish, and the port is
// right to refuse rather than to strand the remainder behind a cursor that
// claims to account for it. So the first sync happens ONCE, here, with
// MAIL_FIRST_SYNC_PAGES raised; the scheduled poll then only ever does deltas
// and KEEPS the defaults deliberately, so that an unattended full resync — a
// store rebuild, a rejected cursor — fails loudly and cheaply instead of
// grinding through the archive on its own.
//
// WHY THE DEFAULT IS PREVIEW. Ingestion is IRREVERSIBLE. Every attachment whose
// bytes the vault does not already hold appends a `document.ingested` row to
// `ledger_events`, and there is no DELETE grant on `documents` or on
// `ledger_events`: the chain head moves and the vault grows, permanently, for
// whatever the relevance filter let through. Nobody may authorise that without
// first reading how many messages it is and how many ledger events they imply,
// so the number comes first and the commit is an explicit second command.
//
// THE PREVIEW IS NOT FREE, and this is deliberate. It performs every read the
// commit performs — the same enumeration, the same batched headers, the same
// getMessage on every candidate — and only the writes are missing. A cheaper
// preview (headers only, attachments guessed) would be a preview of a different
// operation, and the figure it produced would be an estimate presented as an
// authorisation.
//
// RUN --commit TWICE. See the note on `throwingEnqueueSuggest` below: the first
// commit ingests everything and HOLDS the cursor, the second finds every
// message already known by id, fails nothing, and writes the cursor the
// scheduled poll then continues from. The script says so in its own output.
import { desc, eq, inArray } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { openMailPort } from "../mail/from-env";
import { MAIL_WORKER, pollMail } from "../mail/poll";
import { isRelevantMessage, relevanceFilter, type RejectedAddress } from "../mail/relevance";
import { MailFirstSyncOverflowError, type MailPort } from "../mail/port";

/** `Email/query` pages one hand-run first sync may walk. 2000 × 500 = 1 000 000
 *  messages, comfortably past the 146 270 the Takeout import left in the store,
 *  and nowhere near the DEFAULT_LIMITS the scheduled poll keeps. */
export const DEFAULT_FIRST_SYNC_PAGES = 2000;

/** Fresh messages listed individually. Forty is a screenful an operator will
 *  actually read; the counts above the table are the part he authorises on, and
 *  a thousand-row dump would bury them. */
export const SAMPLE_ROWS = 40;

/** Attachment shas per `documents.sha256` lookup.
 *
 *  One query for the lot would be simpler, but every sha is a bound parameter
 *  and Postgres refuses a statement with more than 65 535 of them. A mailbox
 *  with that many attachments is exactly the one this script exists for, and
 *  the failure would arrive as a driver error in the middle of the only report
 *  an irreversible ingest is authorised from. Chunking costs a few extra round
 *  trips against a local database and cannot fail. */
export const VAULT_LOOKUP_CHUNK = 500;

// --- the pure half ------------------------------------------------------------

/** What one preview walk observed, before any arithmetic. Every field is
 *  something the walk saw directly — a count it kept, or the shas it hashed —
 *  so the derivations below have one source and no second opinion. */
export interface PreviewWalk {
  /** Ids `Email/changes(null)` enumerated. */
  scanned: number;
  /** Headers the store actually returned for them. */
  headersReturned: number;
  /** Of those, the ones the relevance filter wants. */
  relevant: number;
  /** Relevant ids already in `raw_emails.gmail_message_id`. */
  knownById: number;
  /** Of the rest, the ones whose bytes are already in
   *  `raw_emails.raw_rfc822_sha256`. */
  knownByContent: number;
  /** Candidates whose blobs could not be read at all. */
  unreadable: number;
  /** The sha256 of every attachment of every genuinely-new message, AFTER the
   *  port's inline-image rule — one entry per message, including the empty
   *  ones, and in the order the ingest would write them.
   *
   *  SHAS AND NOT COUNTS, because `ingestDocument` dedups on exactly this hash:
   *  a count can only ever be an upper bound on the events it implies, and this
   *  is the figure the commit is authorised on. */
  attachmentShas: string[][];
  /** Of those shas, the ones `documents.sha256` ALREADY holds — the snapshot
   *  taken before the commit. Each one costs zero ledger events. */
  vaultShas: ReadonlySet<string>;
}

export interface FirstSyncPreview {
  scanned: number;
  /** Ids the enumeration named and the store no longer holds. NOT the same
   *  number as `irrelevant`, and folding the two together would hide a store
   *  dropping mail behind a figure that reads as ordinary housekeeping. */
  vanished: number;
  irrelevant: number;
  relevant: number;
  knownById: number;
  /** The Gmail-era overlap. A Stalwart Email id is a different namespace from a
   *  Gmail message id, so every message already ingested comes back under a
   *  fresh id and can only be recognised by its bytes — which makes this the
   *  number that says whether the content dedup is working at all. */
  knownByContent: number;
  unreadable: number;
  fresh: number;
  /** Attachments carried by the fresh messages, counted as they occur. NOT the
   *  number of ledger events: the three fields below partition exactly this
   *  total, and only the last of them appends anything. */
  attachments: number;
  /** Attachments whose bytes `documents` already holds. `ingestDocument`
   *  returns the existing row on a sha256 match and appends NO event, so these
   *  are free — and on this mailbox they are where the duplicates live: the
   *  Gmail-era overlap, a re-mailed Beschikking.pdf, a signature image. */
  attachmentsAlreadyInVault: number;
  /** Second and later copies, WITHIN this run, of bytes the vault does not yet
   *  hold. The first copy inserts the document; every later one meets the row
   *  that copy just wrote. One PDF mailed to two parties is one event. */
  attachmentsRepeatedInRun: number;
  /** Distinct attachment shas the vault does not hold: one `document.ingested`
   *  each. THE ONLY IRREVERSIBLE CONSEQUENCE of the commit, and the figure the
   *  commit is authorised on — exact, not an upper bound. */
  predictedLedgerEvents: number;
}

/**
 * The preview's arithmetic, with nothing else in it.
 *
 * Pure and exported so the numbers an irreversible ingest is authorised on can
 * be tested without a database and without a mail server — the same reason
 * money-series.ts holds its own arithmetic away from the query that feeds it.
 *
 * It THROWS on a walk that cannot have happened, rather than reporting a
 * plausible-looking summary. A negative derived count means the walk lost track
 * of itself, and a sample list whose length disagrees with `fresh` means the
 * headline figure and the table under it are describing different sets of
 * messages. Both are silent in a printed report and both destroy the only thing
 * this preview is for.
 *
 * THE ATTACHMENT ARITHMETIC IS A PARTITION, not a subtraction, and this is the
 * whole of the fix it carries. `ingestDocument` opens with a `documents.sha256`
 * lookup and RETURNS THE EXISTING ROW — no insert, no `document.ingested` — so
 * an attachment the vault already holds appends nothing, and neither does the
 * second copy of the same bytes inside this very run: the first copy inserts
 * the document and every later one meets the row it just wrote. Summing the
 * attachment counts therefore reported an UPPER BOUND as an exact figure, on
 * precisely the mailbox where duplicates cluster — the Gmail-era overlap, one
 * PDF mailed to two parties, the same footer image on every mail from a
 * creditor. Each attachment lands in exactly one of the three buckets, so the
 * three ADD UP to `attachments`: a reader who cannot reconcile "142
 * attachments" with "31 events" is entitled to assume something was dropped.
 */
export function summarisePreview(walk: PreviewWalk): FirstSyncPreview {
  const vanished = walk.scanned - walk.headersReturned;
  if (vanished < 0) {
    throw new Error(`preview walk is inconsistent: vanished would be ${vanished} `
      + "— the store returned headers for ids the enumeration never named");
  }
  const irrelevant = walk.headersReturned - walk.relevant;
  if (irrelevant < 0) {
    throw new Error(`preview walk is inconsistent: irrelevant would be ${irrelevant} `
      + "— more messages were judged relevant than had headers to judge");
  }
  const fresh = walk.relevant - walk.knownById - walk.knownByContent - walk.unreadable;
  if (fresh < 0) {
    throw new Error(`preview walk is inconsistent: fresh would be ${fresh} `
      + "— more messages were accounted for than were found relevant");
  }
  if (walk.attachmentShas.length !== fresh) {
    throw new Error(`preview walk is inconsistent: ${walk.attachmentShas.length} `
      + `message(s) were read for attachments but fresh is ${fresh}`);
  }

  let attachments = 0;
  let attachmentsAlreadyInVault = 0;
  let attachmentsRepeatedInRun = 0;
  // What the commit will have inserted by the time it reaches each attachment:
  // the vault as it stands now, plus everything this run would add before it.
  // Walked in ingest order rather than counted with a Set of the whole list,
  // because the buckets have to describe WHICH copy was free.
  const willExist = new Set(walk.vaultShas);
  for (const message of walk.attachmentShas) {
    for (const sha of message) {
      attachments++;
      if (walk.vaultShas.has(sha)) { attachmentsAlreadyInVault++; continue; }
      if (willExist.has(sha)) { attachmentsRepeatedInRun++; continue; }
      willExist.add(sha);
    }
  }

  return {
    scanned: walk.scanned, vanished, irrelevant, relevant: walk.relevant,
    knownById: walk.knownById, knownByContent: walk.knownByContent,
    unreadable: walk.unreadable, fresh,
    attachments, attachmentsAlreadyInVault, attachmentsRepeatedInRun,
    predictedLedgerEvents:
      attachments - attachmentsAlreadyInVault - attachmentsRepeatedInRun,
  };
}

export interface FirstSyncArgs { commit: boolean }

/**
 * Preview unless the operator typed exactly `--commit`.
 *
 * AN UNRECOGNISED FLAG IS AN ERROR, never a silent default, and this is the
 * single most important line in the script. Committing on something that merely
 * looks like the flag would append `document.ingested` rows nobody authorised,
 * to tables with no DELETE grant. Swallowing it into a silent preview is the
 * second-worst outcome rather than a safe one: the operator typed something and
 * believes it took effect, so `--commmit` reporting a clean preview reads as
 * "the ingest found nothing to do".
 *
 * The leading `--` is dropped for the same reason reindex.ts drops it: pnpm 10
 * forwards its own separator to the script, so `pnpm ... -- --commit` arrives
 * with it in front. Every real argument stays strictly checked.
 */
export function parseFirstSyncArgs(argv: string[]): FirstSyncArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let commit = false;
  for (const arg of args) {
    if (arg === "--commit") { commit = true; continue; }
    throw new Error(`unrecognised argument ${JSON.stringify(arg)}; `
      + "the only flag this script takes is --commit");
  }
  return { commit };
}

/**
 * How many `Email/query` pages one enumeration may walk.
 *
 * FINDING 8's trap, one module over: `??` does not fire on "", and an env var is
 * empty far more often than it is absent — a bare `MAIL_FIRST_SYNC_PAGES=` line
 * in .env.prod, a compose file interpolating something unset. An empty value is
 * a mistake, not a claim that the sync may walk zero pages.
 *
 * Anything else that is not a plain positive integer is REFUSED rather than
 * coerced. `Number("2e3")` and `Number("1.5")` both produce a number, and a
 * fractional or exponential page bound silently truncates the enumeration —
 * which is precisely the partial first sync MailFirstSyncOverflowError exists
 * to prevent, arriving through the knob meant to fix it. The message names the
 * variable and not the value: it is read straight out of the process
 * environment, and this script is run in the same shell that holds the
 * credentials.
 */
export function parseFirstSyncPages(raw: string | undefined): number {
  const v = raw?.trim();
  if (!v) return DEFAULT_FIRST_SYNC_PAGES;
  if (!/^[0-9]+$/.test(v) || Number(v) < 1) {
    throw new Error("MAIL_FIRST_SYNC_PAGES must be a positive whole number of pages");
  }
  return Number(v);
}

// --- the walk -----------------------------------------------------------------

/** One fresh message, as the table prints it. */
export interface FreshMessageRow {
  id: string;
  sentAt: Date;
  from: string;
  subject: string;
  /** Attachments the port would promote to documents — i.e. after
   *  isInlineBodyImage has dropped the cid images an HTML body embeds.
   *
   *  FILES ON THE MESSAGE, NOT LEDGER EVENTS. A row showing "3 att" may cost
   *  zero events if the vault already holds all three, which is why the totals
   *  above the table are the part that is authorised and this column is only
   *  there to let a human recognise the mail. */
  attachments: number;
}

export interface FirstSyncPreviewReport {
  counts: FirstSyncPreview;
  // NO `hasMore` HERE, deliberately. A first sync is `changedSince(null)`, and
  // the port answers that by THROWING MailFirstSyncOverflowError rather than by
  // handing back a partial enumeration with a flag on it — see the note on the
  // error itself: a truncated delta is recoverable, a truncated first sync
  // strands every message it never reached behind a cursor that claims to
  // account for them. So a "the enumeration was truncated" field could only
  // ever read false, and a report that carried one would invite exactly the
  // dead branch that used to print the advice for a case it could not see. The
  // entry point catches the error and prints that advice instead.
  addrs: string[];
  rejected: RejectedAddress[];
  /** At most SAMPLE_ROWS of the fresh messages, oldest first as enumerated. */
  sample: FreshMessageRow[];
  /** Candidates whose blobs could not be read. Listed, because each one is a
   *  message the commit will attempt and whose attachments are unknown. */
  failures: { id: string; message: string }[];
}

/**
 * Exactly what pollMail does, minus every write.
 *
 * It deliberately re-walks pollMail's steps here rather than calling into it
 * with the writes stubbed out. A "dry-run" flag threaded through pollMail would
 * put a branch that must never be wrong on the production ingest path, where
 * the cost of getting it wrong is an unremovable ledger event; a separate
 * read-only walk can only ever fail by reporting the wrong number.
 *
 * The consequence, stated so it is not discovered later: the two are held in
 * step by hand. If pollMail's relevance policy or its dedup keys change, this
 * function changes with them or the preview stops describing the commit.
 */
export async function previewFirstSync(deps: {
  db: Db; mail: MailPort; sampleRows?: number;
}): Promise<FirstSyncPreviewReport> {
  const sampleRows = deps.sampleRows ?? SAMPLE_ROWS;

  // A first sync is `changedSince(null)`: there is no "changes since nothing",
  // so this is a different question rather than the delta with an argument
  // missing. It THROWS MailFirstSyncOverflowError if the raised page bound is
  // still not enough — never a partial list with a flag on it — which is the
  // loud failure we want in a preview, and the reason this report carries no
  // "truncated" field. The entry point catches it and prints the cure.
  const changed = await deps.mail.changedSince(null);
  const scanned = changed.ids.length;

  const { addrs, rejected } = await relevanceFilter(deps.db);
  // The port batches these itself, and no blob is downloaded: an irrelevant
  // message must not have its attachments pulled through the wire before being
  // discarded, which over an 11.49 GB archive is the whole cost of the run.
  const heads = await deps.mail.headers(changed.ids);
  const wanted = heads.filter((h) => isRelevantMessage(addrs, h)).map((h) => h.id);

  let knownById = 0;
  let knownByContent = 0;
  const attachmentShas: string[][] = [];
  const sample: FreshMessageRow[] = [];
  const failures: { id: string; message: string }[] = [];

  for (const id of wanted) {
    try {
      const [seen] = await deps.db.select({ id: schema.rawEmails.id })
        .from(schema.rawEmails).where(eq(schema.rawEmails.gmailMessageId, id));
      if (seen) { knownById++; continue; }

      const msg = await deps.mail.getMessage(id);
      // The second idempotence key, and the one that matters here: the ~50
      // emails already ingested from Gmail come back over JMAP under fresh
      // Stalwart ids, miss the lookup above, and would each earn a second
      // raw_emails row. Reported separately from knownById precisely so the
      // rate of that is known rather than assumed.
      const sha = sha256Hex(msg.raw);
      const [sameBytes] = await deps.db.select({ id: schema.rawEmails.id })
        .from(schema.rawEmails).where(eq(schema.rawEmails.rawRfc822Sha256, sha));
      if (sameBytes) { knownByContent++; continue; }

      // Hashed HERE, in the walk, and with the same helper the ingest path
      // uses: `storeFile` hashes the identical buffer with `sha256Hex`, and
      // `ingestDocument` dedups on exactly that string. Costs no extra wire
      // traffic — getMessage has already downloaded these bytes — and a second
      // hash function anywhere in this chain would silently predict events for
      // documents the vault holds.
      attachmentShas.push(msg.attachments.map((a) => sha256Hex(a.data)));
      if (sample.length < sampleRows) {
        sample.push({ id, sentAt: msg.sentAt, from: msg.from, subject: msg.subject,
          attachments: msg.attachments.length });
      }
    } catch (err) {
      // Isolated per message for the same reason pollMail isolates: one
      // unreadable blob must not cost the whole preview. It is counted apart
      // from `fresh` because its attachments are unknown, which makes the
      // prediction a LOWER BOUND — said in the printed report, not just here.
      failures.push({ id, message: String(err) });
    }
  }

  return {
    counts: summarisePreview({
      scanned, headersReturned: heads.length, relevant: wanted.length,
      knownById, knownByContent, unreadable: failures.length, attachmentShas,
      vaultShas: await shasAlreadyInVault(deps.db, attachmentShas.flat()),
    }),
    addrs, rejected, sample, failures,
  };
}

/**
 * Which of these attachment shas the vault already holds.
 *
 * ONE BATCHED LOOKUP AFTER THE WALK, not a query per attachment: `documents` is
 * only read here, nothing writes to it while a preview runs, and a per-message
 * lookup would add a round trip per file to a script that already pulls every
 * blob over the wire.
 *
 * It reads `documents.sha256` RAW and does not resolve the effective status,
 * which is the opposite of the rule `documents.list` and `pendingDocMeta`
 * follow — and deliberately. Those surfaces ask "should Martin see this?"; this
 * one asks "will `ingestDocument` insert a row?", and `ingestDocument` matches
 * on the sha alone. A DISCARDED document still short-circuits it and still
 * appends no event, so excluding discarded rows here would predict events the
 * commit cannot append.
 */
async function shasAlreadyInVault(db: Db, shas: string[]): Promise<Set<string>> {
  const distinct = [...new Set(shas)];
  const found = new Set<string>();
  for (let i = 0; i < distinct.length; i += VAULT_LOOKUP_CHUNK) {
    const rows = await db.select({ sha256: schema.documents.sha256 })
      .from(schema.documents)
      .where(inArray(schema.documents.sha256, distinct.slice(i, i + VAULT_LOOKUP_CHUNK)));
    for (const r of rows) found.add(r.sha256);
  }
  return found;
}

// --- printing ------------------------------------------------------------------

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** UTC and to the day. The table exists to let a human recognise messages, not
 *  to date evidence — `documents.received_at` is where that argument lives. */
const day = (d: Date) => (Number.isNaN(d.getTime()) ? "????-??-??" : d.toISOString().slice(0, 10));

function printPreview(report: FirstSyncPreviewReport): void {
  const c = report.counts;
  const row = (label: string, n: number, note = "") =>
    console.log(`  ${label.padEnd(29)}${String(n).padStart(7)}${note ? `   ${note}` : ""}`);

  console.log("\nrelevance filter");
  if (report.addrs.length === 0) {
    // An empty list matches NOTHING, deliberately — isRelevantMessage's own
    // note. Said out loud here, because "0 relevant of 146 270" otherwise reads
    // as "the archive holds nothing for this case" when it means "the gate is
    // shut", and the two want opposite responses.
    console.log("  watching NO addresses at all — every message will be judged irrelevant");
  } else {
    console.log(`  watching ${report.addrs.length} address(es): ${report.addrs.join(", ")}`);
  }
  for (const r of report.rejected) {
    console.log(`  rejected ${JSON.stringify(r.value)} — ${r.reason}`);
  }

  console.log("\nwhat the mailbox holds");
  row("enumerated", c.scanned);
  row("vanished", c.vanished, "(ids the store no longer holds)");
  row("irrelevant", c.irrelevant);
  row("relevant", c.relevant);
  row("already ingested by id", c.knownById);
  row("already ingested by content", c.knownByContent, "(the Gmail-era overlap)");
  if (c.unreadable > 0) row("unreadable", c.unreadable);
  row("NEW", c.fresh);

  if (report.sample.length > 0) {
    console.log(`\nthe new messages (${report.sample.length} of ${c.fresh})`);
    for (const m of report.sample) {
      console.log(`  ${day(m.sentAt)}  ${truncate(m.from, 34).padEnd(34)}  `
        + `${truncate(m.subject, 58).padEnd(58)}  ${m.attachments} att`);
    }
  }

  for (const f of report.failures) {
    console.log(`  UNREADABLE ${f.id} — ${f.message}`);
  }

  // The three lines under the total are what makes it reconcile. Printing
  // "142 attachments" beside "31 events" and nothing else reads as though 111
  // files were dropped, which is the opposite of what happened: they are
  // already in the vault, and this is where the disclosure says so.
  console.log("\nthe attachments on those new messages");
  row("attachments", c.attachments);
  row("already in the vault", c.attachmentsAlreadyInVault, "(same bytes — append nothing)");
  row("repeated within this run", c.attachmentsRepeatedInRun, "(same bytes twice — one event)");
  row("NEW FILES", c.predictedLedgerEvents);

  console.log(`\nNEW LEDGER EVENTS: ${c.predictedLedgerEvents}`);
  console.log("  This is the ONLY irreversible consequence of --commit: one");
  console.log("  `document.ingested` event per attachment whose bytes the vault does");
  console.log("  NOT already hold, on tables with no DELETE grant. ingestDocument");
  console.log("  returns the existing row on a sha256 match and appends nothing, so");
  console.log(`  the other ${c.attachments - c.predictedLedgerEvents} attachment(s) above cost zero events.`);
  if (c.unreadable > 0) {
    // The only thing that keeps the figure from being exact, and it is stated
    // where the figure is, not in a footnote further down.
    console.log(`  IT IS A LOWER BOUND: ${c.unreadable} message(s) could not be read, and`);
    console.log("  their attachments are not in this figure.");
  } else {
    console.log(`  The ledger chain head will move by exactly ${c.predictedLedgerEvents} event(s).`);
  }
  console.log("\nNOTHING WAS WRITTEN: no cursor, no worker_runs row, no ingest.");
}

// --- entry point ---------------------------------------------------------------

/**
 * The enqueue this script deliberately cannot do — and why that is safe.
 *
 * The script runs outside the worker process and holds no pg-boss connection.
 * The alternative to throwing is a no-op that RESOLVES, and that is the one
 * genuinely unsafe choice available: enqueueAndMark sets `suggest_queued_at`
 * once the enqueue resolves, so a silent no-op would mark every message of the
 * first sync as queued when nothing was sent, and repairSuggestOutbox — which
 * finds work by exactly that marker — would never look at them again. The whole
 * first sync would sit in raw_emails, out of the review queue, permanently.
 *
 * Throwing leaves the marker NULL, which is the state the outbox repair exists
 * to drive: the scheduled poll runs repairSuggestOutbox FIRST, before discovery
 * and independently of it, in batches of SUGGEST_REPAIR_BATCH per tick. So the
 * review queue fills on its own within minutes of the worker's next ticks, and
 * this script never needs pg-boss.
 *
 * THE COST, stated because the printed output has to warn about it: pollMail
 * isolates each message inside one try that spans the ingest AND the enqueue,
 * so every one of these throws is recorded as a per-message failure — and a
 * failure HOLDS the cursor. The first --commit therefore ingests everything and
 * writes no cursor. Run it a second time: every message is then known by id and
 * skipped before any enqueue, nothing fails, and the cursor is written. A
 * repair failure never holds the cursor, so the noisy repair on that second run
 * cannot stop it.
 */
async function throwingEnqueueSuggest(): Promise<never> {
  throw new Error("mail-first-sync holds no pg-boss connection; suggest_queued_at is "
    + "left NULL on purpose for repairSuggestOutbox to drive");
}

/**
 * The two fields that make this caller the authorised one, in a shape a test
 * can hold.
 *
 * It exists ONLY so there is a regression guard on them. Both used to be
 * written inline inside the `import.meta.url` block, which no test can reach —
 * so `maxDelta: Infinity` was correct and completely unprotected, and deleting
 * it would have broken the one path whose whole purpose is to cross the
 * ceiling, with the resulting error advising the operator to run the command
 * that had just refused. A guard on the value that authorises an irreversible
 * append should not live somewhere unreachable.
 *
 * `allowFirstSync` is spelled out rather than left to its permissive default
 * for the same reason: this script's right to enumerate the whole mailbox is
 * the point of it, and a default is a poor place to keep a claim that load
 * bearing.
 */
export const FIRST_SYNC_BYPASS = {
  maxDelta: Number.POSITIVE_INFINITY,
  allowFirstSync: true,
} as const;

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { commit } = parseFirstSyncArgs(process.argv.slice(2));
  const firstSyncPages = parseFirstSyncPages(process.env.MAIL_FIRST_SYNC_PAGES);

  // The first line, before anything is opened, so a mode nobody intended is
  // visible in the terminal and in the scrollback rather than inferred from
  // what happened afterwards.
  console.log(commit
    ? `mail-first-sync: *** COMMIT *** — this WILL ingest and WILL append ledger events `
      + `(firstSyncPages=${firstSyncPages})`
    : `mail-first-sync: PREVIEW — read-only, nothing will be written `
      + `(firstSyncPages=${firstSyncPages}; pass --commit to ingest)`);

  const { db, pool } = createDb(url);
  try {
    // openMailPort is the ONE place a live port is built from the environment,
    // so this script authenticates exactly as the scheduled poll does. Only
    // `firstSyncPages` is overridden: pageSize and changesPages stay at
    // DEFAULT_LIMITS, because nothing about a hand-run sync justifies asking
    // the server for bigger pages than the poll asks for every minute.
    const mail = await openMailPort(process.env, { limits: { firstSyncPages } });

    if (!commit) {
      printPreview(await previewFirstSync({ db, mail }));
    } else {
      const result = await pollMail({
        db, mail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
        // THE ONE CALLER THAT MAY HAVE A HUGE BATCH, and the only one that has
        // earned it. MAIL_MAX_DELTA is a tripwire on the SCHEDULED poll — an
        // ordinary delta is single digits, so anything past 500 is a bulk
        // import nobody previewed — and this command IS the preview: the
        // operator has already read `NEW LEDGER EVENTS: n` above and typed
        // --commit against it. Leaving the default here would make the ceiling
        // fire on the one path whose whole purpose is to cross it, and the
        // error's own advice ("run mail-first-sync") would point at the command
        // that just refused.
        ...FIRST_SYNC_BYPASS,
        enqueueSuggest: throwingEnqueueSuggest,
      });
      // pollMail writes its own worker_runs row carrying the cursor, so the run
      // is read back rather than reconstructed — the detail it recorded is the
      // authoritative account of what happened, including the cursor.
      const [run] = await db.select({ status: schema.workerRuns.status,
        detail: schema.workerRuns.detail })
        .from(schema.workerRuns).where(eq(schema.workerRuns.worker, MAIL_WORKER))
        .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
      console.log(`\nmail-first-sync: ingested ${result.ingested}`);
      console.log(`worker_runs(mail) status=${run?.status ?? "?"}`);
      console.log(JSON.stringify(run?.detail ?? null, null, 2));
      const held = (run?.detail as { cursorHeld?: unknown } | null)?.cursorHeld === true;
      if (held) {
        console.log("\nTHE CURSOR WAS HELD — expected on the first commit, see the note on");
        console.log("throwingEnqueueSuggest. RUN THIS COMMAND AGAIN WITH --commit: every");
        console.log("message is now known by id, nothing will fail, and the cursor will be");
        console.log("written for the scheduled poll to continue from.");
      }
    }
  } catch (err) {
    // No worker_runs row is written here on purpose. In preview the whole
    // contract is that the script writes nothing, and in commit mode pollMail
    // has already recorded its own error run — a second row from this layer
    // would be the same failure told twice, in the one table the health tile
    // reads.
    console.error(`mail-first-sync: failed — ${String(err)}`);
    // THE ONE FAILURE THIS SCRIPT EXISTS TO SURVIVE, so it gets the cure and
    // not just the message. The page bound is the whole reason the first sync
    // is hand-run — the port refuses a partial enumeration rather than writing
    // a cursor that strands the remainder — and the operator who hits this is
    // one environment variable away from a clean run. Printed from the error's
    // own fields rather than reworded, because `enumerated` is measured and a
    // guess at the mailbox size here would send him to the wrong number.
    if (err instanceof MailFirstSyncOverflowError) {
      console.error(`\nTHE ENUMERATION DID NOT FINISH: ${err.enumerated} message(s) in `
        + `${err.pages} page(s) and the mailbox still had more.`);
      console.error("Nothing was written, and nothing is stranded — the port refuses a cursor");
      console.error("over a partial enumeration precisely so this stays recoverable.");
      console.error(`Raise MAIL_FIRST_SYNC_PAGES (currently ${firstSyncPages}) above`);
      console.error("ceil(mailbox size / page size) and run again.");
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
