import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestRawEmail } from "../gmail";
import { readCursor, writeCursor } from "./cursor";
import {
  isRelevantMessage, relevanceFilter, type RejectedAddress,
} from "./relevance";
import {
  MailCursorRejectedError, MailDeltaTooLargeError, MailFirstSyncRefusedError,
  type MailChanges, type MailHeaders, type MailPort, type SkippedPart,
} from "./port";

/**
 * The worker_runs name the mail cursor lives under.
 *
 * EXPORTED, and that is the whole point: index.ts used to spell this string by
 * hand next to a `const WORKER = "mail"` nobody could see from there. Rename one
 * side and the failure is silent and total — the runs land under one name,
 * readCursor asks the other, gets null, and (with allowFirstSync false) every
 * tick from then on refuses a first sync that will never resolve itself. It is
 * also the string docs/deploy.md and the dashboard health tile look for.
 */
export const MAIL_WORKER = "mail";

/**
 * Ids one delta may carry before this caller refuses to ingest it.
 *
 * WHERE THE NUMBER COMES FROM, and it is a tripwire rather than a throughput
 * knob. An ordinary delta on this mailbox is single digits — a minute of mail,
 * and usually nothing at all — while the port's own ceiling is changesPages x
 * maxChanges = 20 x 500 = 10 000 ids in ONE poll. 500 sits far above every
 * normal day and far below anything that could only be a bulk import, so it can
 * fire on the event it names and on nothing else. It is not a rate: see
 * MailDeltaTooLargeError for why draining a bulk import slowly is the same
 * irreversible append with a longer tail, and why the cure is the previewed
 * hand-run script rather than a bigger number here.
 */
export const MAIL_MAX_DELTA = 500;

/**
 * Message-IDs per `raw_emails.message_id` lookup.
 *
 * The lookup is ONE batched query for the whole candidate set and not one per
 * message, which is the lesson 0029 records about the content hash: a query per
 * downloaded message over a table growing by one row per message is O(N^2) on
 * precisely the run this dedup exists for, the first sync after the 11.49 GB
 * Takeout import. Batching it makes the whole poll one round trip instead of
 * one per candidate, and the ceiling is not a delta of 500 — mail-first-sync
 * passes Infinity and hands this 146 270 ids.
 *
 * Chunked for the reason VAULT_LOOKUP_CHUNK is: every id is a bound parameter
 * and Postgres refuses a statement with more than 65 535 of them, so the one
 * run this is built for is exactly the one that would die on a driver error.
 * The extra round trips are against a database on the same box and cannot fail.
 */
export const MESSAGE_ID_LOOKUP_CHUNK = 500;

/** Rows the outbox repair may retry in ONE poll. It is an ENQUEUE bound, not a
 *  drain bound — the same lesson DOCMETA_SWEEP_BATCH records — and the repair
 *  runs every minute, so a genuine backlog clears in minutes while a broken
 *  pg-boss cannot be hammered with thousands of sends per tick. */
export const SUGGEST_REPAIR_BATCH = 50;

/** First wait after a failed enqueue, doubling per attempt. One minute is one
 *  poll: a transient pg-boss hiccup costs a single skipped tick. */
export const REPAIR_BACKOFF_MIN_MS = 60_000;
/** Ceiling on that doubling. Fifteen minutes is chosen against the failure that
 *  is actually common — the finding's own point that enqueue failures are
 *  usually pg-boss-WIDE rather than row-specific. A wide outage defers every
 *  row it touched, so the cap is the longest the review queue can lag behind a
 *  recovered pg-boss. An hour's cap would have been cheaper per poll and would
 *  have made an outage's tail an hour long. */
export const REPAIR_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * A per-process memory of which rows just failed to enqueue, and until when.
 *
 * FINDING H. The repair walks `suggest_queued_at IS NULL ORDER BY fetched_at
 * ASC LIMIT N` and deliberately leaves a failed row NULL so the next poll
 * retries it. pendingDocMeta gets away with the same shape only because
 * storeDocumentText writes a row for EVERY attempt including the failures, so a
 * document that can never be read leaves the queue on its own. This driver has
 * no such marker: a row that can never be enqueued stays at the head of that
 * ORDER BY forever, and once N of them accumulate a newly ingested email whose
 * enqueue crashed never reaches the review queue at all — the exact loss the
 * repair exists to prevent, wearing the batch bound as a hat. Low probability,
 * silent, and permanent, which is the shape this project fixes.
 *
 * In-process and not a table, and `now` is a parameter — both the same choices
 * makeEnqueueGuard records: a restart costs at most one repeated round, and a
 * cool-down that needs no clock is a cool-down that can be tested. Entries are
 * deleted the moment a row succeeds, so the map is bounded by the rows that are
 * genuinely failing rather than by the mailbox.
 */
export function makeRepairBackoff(
  minMs: number = REPAIR_BACKOFF_MIN_MS, maxMs: number = REPAIR_BACKOFF_MAX_MS,
) {
  const held = new Map<string, { until: number; attempts: number }>();
  return {
    ready(id: string, now: number): boolean {
      const h = held.get(id);
      return h === undefined || h.until <= now;
    },
    fail(id: string, now: number): void {
      const attempts = (held.get(id)?.attempts ?? 0) + 1;
      held.set(id, { until: now + Math.min(minMs * 2 ** (attempts - 1), maxMs), attempts });
    },
    ok(id: string): void { held.delete(id); },
    /** Rows still inside their wait. The query's LIMIT is widened by exactly
     *  this, so a deferred row occupies no part of the batch — a bound that
     *  deferred rows could eat is the starvation again under another name. */
    waiting(now: number): number {
      let n = 0;
      for (const h of held.values()) if (h.until > now) n++;
      return n;
    },
  };
}

export type RepairBackoff = ReturnType<typeof makeRepairBackoff>;

/** The one the poller uses. Process-wide because the poller is: pollMail is
 *  called on a schedule by a single long-lived worker. */
const repairBackoff = makeRepairBackoff();

export interface RepairResult {
  enqueued: number;
  /** Rows skipped this poll because a recent attempt failed. Reported so a row
   *  nobody can enqueue is a number an operator can see, not a silence. */
  deferred: number;
  failures: { id: string; message: string }[];
}

interface Deps {
  db: Db; mail: MailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
  /** The worker_runs name the cursor is stored under. Production never passes
   *  it; a test does, because worker_runs is shared and append-only and two
   *  tests under one name read each other's cursor. */
  worker?: string;
  /** Rows the outbox repair may ATTEMPT in one poll. Production never passes
   *  it; a test does, because head-of-line starvation is only observable when
   *  the batch is smaller than the number of rows owed, and seeding fifty
   *  emails into a shared append-only table to prove it would be worse. */
  repairBatch?: number;
  /**
   * Ids this caller may accept in ONE delta before refusing to ingest it.
   *
   * Defaults to MAIL_MAX_DELTA, which is the whole of the protection on the
   * DELTA door — allowFirstSync watches the two first-sync doors and cannot see
   * this one, because a bulk import after the first sync arrives as an entirely
   * ordinary delta with a valid cursor. ops/mail-first-sync.ts passes Infinity:
   * the hand-run, previewed path is exactly the context in which a huge batch IS
   * authorised, and it is the only caller that has shown a human the ledger
   * events it implies first.
   *
   * A test passes a small value, for the same reason repairBatch exists —
   * seeding ten thousand fixtures into a shared append-only table to cross the
   * real ceiling would be worse than parameterising it.
   */
  maxDelta?: number;
  /**
   * Whether this caller may enumerate the WHOLE mailbox.
   *
   * Defaults to TRUE so that ops/mail-first-sync.ts — the hand-run, previewed,
   * explicitly authorised path — and every existing test keep working unchanged.
   * The SCHEDULED poll passes false, and that flag is what stands between a cron
   * tick and an irreversible walk of the archive THROUGH THE FIRST-SYNC DOORS —
   * a null cursor and a cursor the server rejected. It is not the only guard on
   * the ingest path and must not be read as one: a bulk import arriving AFTER a
   * healthy first sync is an ordinary delta this flag never sees, and `maxDelta`
   * above is what refuses that. See MailFirstSyncRefusedError for why the
   * previous guard (the port's DEFAULT_LIMITS overflowing at 50 000 against a
   * store holding 146 270) was true by coincidence of mailbox size rather than
   * by policy.
   *
   * Deliberately opt-OUT rather than opt-in: a new caller that forgets the flag
   * gets the behaviour that is merely expensive, not the one that silently
   * refuses to ingest. The one caller that must not have it is a single line in
   * index.ts, right next to the schedule that makes it dangerous.
   */
  allowFirstSync?: boolean;
}

/**
 * One poll over the mail port: ask what changed since the cursor, ingest what
 * the case is interested in, and record the run carrying the cursor forward.
 *
 * The shape mirrors pollGmail on purpose — the same evidence-first transaction,
 * the same per-message isolation, the same relevance policy — with discovery
 * swapped from a time window to a JMAP state string. That one swap invalidates
 * three things Gmail got for free, and all three are handled here rather than
 * inherited: the window used to re-list a FAILED id (so the cursor must not
 * advance past one), it used to re-list an id whose enqueue never landed (so
 * the outbox repair needs its own driver), and a Gmail message id is not a
 * Stalwart Email id (so content is a second idempotence key).
 */
export async function pollMail(deps: Deps): Promise<{ ingested: number }> {
  let ingested = 0;
  let duplicates = 0;
  // Counted apart from `duplicates` on purpose: the two keys answer different
  // questions and the rate of each is the only evidence that it still works.
  // One number for both would let the Message-ID lookup go blind — the case
  // that actually happens on this mailbox — behind a content-hash figure that
  // reads as healthy.
  let knownByMessageId = 0;
  // Counted apart from knownByMessageId, which is the measured overlap with the
  // DOSSIER (130 relevant messages against 0 of 107 existing rows). A repeat
  // inside one run is a fact about the MAILBOX — one mail delivered to two
  // addresses — and folding it into that figure would inflate the one number
  // this slice was measured against with something that is not overlap at all.
  // It is the message-level twin of the preview's attachmentsRepeatedInRun.
  let messagesRepeatedInRun = 0;
  // MISSING TELL C. jmap-port.ts asks for `header:Message-ID:asText` and reads
  // it back by EXACT string key, and docs/deploy.md says in terms that none of
  // this has been measured against a running Stalwart — every test drives a
  // fake that echoes the key verbatim. A server that omits the property, or
  // answers under different casing, returns null for EVERY candidate and the
  // whole Message-ID dedup becomes a silent no-op that reports
  // `knownByMessageId: 0` — indistinguishable from a genuinely disjoint
  // mailbox, which is exactly the report measured before this key existed. This
  // counter separates the two: on ordinary mail "130 of 130 relevant messages
  // carry no Message-ID" is impossible on its face, and a zero overlap is not.
  let noMessageId = 0;
  let irrelevant = 0;
  let vanished = 0;
  let resynced = false;
  const failures: { id: string; message: string }[] = [];
  // Parts the port refused to promote. Recorded per message so a wrong skip is
  // visible the same day: a skipped part never becomes a document and re-polling
  // will not fetch it again.
  const skippedParts: (SkippedPart & { messageId: string })[] = [];

  const worker = deps.worker ?? MAIL_WORKER;
  const cursor = await readCursor(deps.db, worker);
  let changed: MailChanges;
  let scanned = 0;

  // FINDING G: declared out here, and only ASSIGNED inside the try, so the
  // error path can report what the repair managed before it died. Every failure
  // path in this function writes a worker_runs row, because docs/deploy.md
  // tells the operator that worker_runs is the only place mail failure is
  // visible — a path that throws before recording anything leaves the health
  // tile green while nothing ingests.
  let repaired: RepairResult = { enqueued: 0, deferred: 0, failures: [] };
  let rejectedAddresses: RejectedAddress[] = [];

  try {
    // FINDING 17: the repair the ingest loop can no longer perform. It runs
    // FIRST and outside the cursor accounting entirely — it needs the database
    // and pg-boss, not the mail server, and a row that failed to enqueue three
    // polls ago has nothing to do with what changed since the last state.
    // Behind discovery it would stop for the whole of an outage, which is
    // precisely when an email already sitting in raw_emails must still reach
    // the review queue. Inside the try but before it: first in ORDER, covered
    // by the same reporting.
    repaired = await repairSuggestOutbox(deps);

    // THE FIRST OF THE THREE DOORS INTO A BULK INGEST, and the one an
    // unattended caller must be refused at. `changedSince(null)` is not "the
    // same question with a missing argument" (see MailPort): it enumerates
    // EVERYTHING, and everything relevant it finds is ingested irreversibly.
    //
    // The refusal sits AFTER repairSuggestOutbox on purpose. The repair needs
    // the database and pg-boss and nothing else, so an email already in
    // raw_emails must still reach the review queue in a minute of a refused
    // poll — the same reason the repair sits ahead of discovery at all. And the
    // throw is left to the catch below rather than recording its own row: that
    // handler already writes the error run carrying no cursor (there is none)
    // plus what the repair managed, which is exactly the row this needs.
    if (deps.allowFirstSync === false && cursor === null) {
      throw new MailFirstSyncRefusedError("no-cursor");
    }

    // FINDING 18: a cursor the SERVER rejected and a socket failure are
    // different conditions with opposite cures, and the port makes them
    // distinguishable so this layer can own the policy. Rejected → drop the
    // cursor and resync from scratch; anything else → keep the cursor and let
    // the next poll ask the same question, because resyncing on a transport
    // blip re-walks the whole mailbox.
    try {
      changed = await deps.mail.changedSince(cursor);
    } catch (err) {
      if (!(err instanceof MailCursorRejectedError)) throw err;
      // The second door, and the comment above finding 18 already said the
      // recovery policy belongs to THIS layer. Here it is, made explicit for
      // the caller that cannot be trusted with it: a resync is the right cure
      // for a rejected cursor when a human runs it and has read the preview,
      // and the identical hours-long irreversible ingest when a cron does.
      //
      // The rejected cursor is NOT dropped on the way out — the catch below
      // writes back `cursor` because `resynced` stayed false — and that is
      // wanted. It is the state the server named as unresolvable, so every
      // following tick fails the same loud way with the same detail, once a
      // minute, until someone runs the script. Writing null instead would turn
      // the next tick's refusal into the "no-cursor" one and throw away the
      // only record of what the server actually refused.
      if (deps.allowFirstSync === false) {
        throw new MailFirstSyncRefusedError("cursor-rejected", { cause: err });
      }
      resynced = true;
      changed = await deps.mail.changedSince(null);
    }
    scanned = changed.ids.length;

    // THE THIRD DOOR, and the only one of the three that is not about a first
    // sync at all. The two above are shut by allowFirstSync and neither of them
    // is what a bulk import looks like: the first sync writes cursor C, and a
    // re-import, a restored subset, a second Vandelay pass or phase 2 starting
    // to deliver real mail all arrive as messages `created` after C — a
    // perfectly legitimate delta, valid cursor, no cannotCalculateChanges. The
    // port drains up to 10 000 of them in one poll and this loop would ingest
    // every relevant one, unattended, once a minute, appending a
    // `document.ingested` ledger event per attachment on tables with no DELETE
    // grant. `hasMore` in the run detail below reports that AFTER the fact, and
    // visibility after an irreversible append is not authorisation.
    //
    // IT THROWS HERE, before the relevance filter and before any getMessage, so
    // not one blob is pulled through the wire for a delta this poll has decided
    // it may not have. And it throws into the outer catch on purpose: that
    // handler writes the error row with `resynced ? null : cursor`, i.e. it
    // HOLDS the cursor. The same delta is re-listed next tick, nothing is lost,
    // and the poll goes red once a minute naming the previewed script until a
    // human acts — which is the recoverable failure, where an advanced cursor
    // would silently strand every message in the batch it skipped.
    //
    // `hasMore` IS PART OF THE DECISION, and leaving it out was the hole this
    // guard was written to close, wearing the guard as a hat. `scanned` is what
    // ONE poll happened to drain, not what is waiting: RFC 8620 §5.2 lets the
    // server return fewer ids per Email/changes page than asked for and set
    // hasMoreChanges, so a store handing back 200 a page with thousands queued
    // trips no ceiling and drains unattended at a bounded rate — precisely the
    // slow irreversible bulk append MailDeltaTooLargeError exists to refuse,
    // arriving under the tripwire instead of over it. With changesPages ×
    // maxChanges = 10 000 requested, `hasMore` cannot mean an ordinary day; it
    // means a bulk event, and a bulk event is a human's decision.
    //
    // Both halves are gated on a FINITE ceiling so the hand-run path is
    // untouched: mail-first-sync passes Infinity precisely because draining a
    // large batch is its job, and refusing it on hasMore would break the one
    // caller that has read the preview.
    const maxDelta = deps.maxDelta ?? MAIL_MAX_DELTA;
    if (Number.isFinite(maxDelta) && (scanned > maxDelta || changed.hasMore === true)) {
      throw new MailDeltaTooLargeError(scanned, maxDelta, changed.hasMore === true);
    }

    // FINDING 13, THE BLOCKER. Email/changes hands over every id in the
    // mailbox, and after the Takeout import that is years of commercial mail.
    // Each one ingested writes a raw_emails row, vault bytes, and a
    // `document.ingested` LEDGER EVENT per attachment — on tables with no
    // DELETE grant, so the chain head and the vault would be permanently
    // polluted, plus one suggest.entry LLM job each on a VRAM-starved GPU.
    //
    // The filter runs on BATCHED HEADERS, never on getMessage: an irrelevant
    // message must not have its blobs downloaded at all. A header the store no
    // longer holds is simply absent, and absent means skipped — never ingested
    // on a guess.
    //
    // FINDING F: `rejected` is the half of this that must not stay in the
    // filter's head. `parties.email` is free text and RELEVANT_SENDERS is typed
    // into a deploy command, and under JMAP this filter is the only gate there
    // is — there is no `newer_than:7d` behind it. An entry thrown away is
    // either a party whose mail is now invisible or an attempt to widen the
    // filter to the whole mailbox, and both belong in worker_runs, which
    // docs/deploy.md names as the one place mail health can be read.
    const { addrs, rejected } = await relevanceFilter(deps.db);
    rejectedAddresses = rejected;
    const heads = await deps.mail.headers(changed.ids);
    const wanted = heads.filter((h) => isRelevantMessage(addrs, h));
    irrelevant = heads.length - wanted.length;
    // An id the store no longer holds is NOT an irrelevant message, and one
    // number for both would hide a store dropping mail behind a figure that
    // reads as ordinary housekeeping.
    vanished = scanned - heads.length;

    // THE THIRD IDEMPOTENCE KEY, and the only one that recognises this mailbox.
    // Asked for the WHOLE candidate set in one batched query, ahead of the loop
    // — see MESSAGE_ID_LOOKUP_CHUNK for why a lookup per message is the shape
    // 0029 already had to fix once. It is then KEPT UP TO DATE by the loop
    // rather than left as a snapshot: see the note at the add itself for why a
    // snapshot is weaker than the live content-hash query it fronts.
    const heldMessageIds = await messageIdsAlreadyHeld(deps.db, wanted);
    noMessageId = wanted.filter((h) => h.messageId === null).length;
    // What THIS run has put in raw_emails, tracked only to attribute the skip
    // to the right counter below. The skip itself reads `heldMessageIds` alone,
    // so there is exactly one branch that can decide ingest-or-skip and no way
    // for the two memories to disagree about a message.
    const ingestedInRun = new Set<string>();

    for (const h of wanted) {
      const id = h.id;
      // One bad message must not block the rest of the mailbox: isolate each
      // message so a persistent failure only surfaces in worker_runs while
      // every other message still ingests.
      try {
        const [seen] = await deps.db.select().from(schema.rawEmails)
          .where(eq(schema.rawEmails.gmailMessageId, id));
        // Already ingested under this id. The outbox repair for a NULL
        // suggest_queued_at deliberately does NOT live here: under cursor
        // discovery this branch is unreachable for the case it was written for
        // (the id was in `created`, the cursor moved past it, and
        // Email/changes never returns it again). repairSuggestOutbox drives it.
        if (seen) continue;

        // THE KEY THAT SPANS THE TWO INGEST NAMESPACES, applied BEFORE a single
        // blob crosses the wire. A Stalwart Email id is not a Gmail message id
        // (so the lookup above misses every mail the dossier already holds) and
        // Takeout's mbox bytes are not the bytes Gmail's API returned for the
        // same message (so the content hash below misses them too): measured at
        // 130 relevant messages matching 0 of 107 existing rows, i.e. ~114
        // permanent rows in an append-only table and ~114 redundant LLM jobs.
        // The RFC 5322 Message-ID is assigned by the ORIGINATING server and
        // survives both export formats, which is what makes it the identity
        // that spans them.
        //
        // THE DIVISION OF LABOUR WITH THE CONTENT HASH, which stays exactly as
        // it was and must: this key catches the SAME message re-exported in a
        // different format — the case that actually happens here — and the hash
        // catches a message that carries no Message-ID at all, where there is
        // nothing to compare. Removing either trades one blind spot for another.
        //
        // A NULL messageId FALLS THROUGH, never skips. It means "this message
        // has no Message-ID", which is unusual and perfectly ingestable; the
        // content hash is what judges it. Skipping on an unknown would silently
        // drop mail the dossier does not hold, which is the one failure
        // direction that cannot be repaired — no DELETE grant, no second copy.
        //
        // AND THE SAME LAW AS THE HASH BRANCH: on a match you SKIP. The
        // existing row's gmail_message_id is never rewritten, because it is
        // also documents.source_ref and the case map's third level derives from
        // it — "correcting" it to the JMAP id would silently unlink every
        // attachment of that mail.
        if (h.messageId !== null && heldMessageIds.has(h.messageId)) {
          if (ingestedInRun.has(h.messageId)) messagesRepeatedInRun++;
          else knownByMessageId++;
          continue;
        }

        const msg = await deps.mail.getMessage(id);

        // FINDING 16: a Stalwart Email id is a DIFFERENT NAMESPACE from a Gmail
        // message id, so every one of the ~50 emails already ingested from
        // Gmail comes back over JMAP with a fresh id, misses the lookup above
        // and would earn a second raw_emails row and a second review-queue
        // item. Content is the second key.
        //
        // THE LAW: on a content match you SKIP. The existing row's
        // gmail_message_id is NEVER rewritten — it is also documents.source_ref
        // and the case map's third level derives from it, so "correcting" it to
        // the JMAP id would silently unlink every attachment of that mail.
        //
        // Best-effort by nature: it catches byte-identical originals, which is
        // what an mbox import of the same message produces. Where a store
        // rewrote a header the bytes differ, the message is ingested again
        // under its own id, and `duplicates` in the run detail is what makes
        // the rate of that visible instead of assumed.
        const sha = sha256Hex(msg.raw);
        const [sameBytes] = await deps.db.select({ id: schema.rawEmails.id })
          .from(schema.rawEmails).where(eq(schema.rawEmails.rawRfc822Sha256, sha));
        if (sameBytes) { duplicates++; continue; }

        for (const p of msg.skippedParts ?? []) skippedParts.push({ ...p, messageId: id });
        const rawEmailId = await ingestRawEmail(deps, msg, { source: "jmap" });

        // BLOCKER A: THE SET IS MUTATED, and the reason is that a snapshot which
        // is never updated is not a cheaper version of the live query — it is a
        // different and weaker guarantee. MESSAGE_ID_LOOKUP_CHUNK argues for one
        // batched query plus an in-memory set precisely to avoid the O(N^2)
        // per-message lookup 0029 had to fix once already, and that argument is
        // about ROUND TRIPS, not about answering a stale question. Built once
        // and left alone, the set answers "what did raw_emails hold when this
        // poll started", while the content hash sitting right behind it queries
        // the database LIVE per message and therefore does catch a same-bytes
        // repeat inside one run: the new key would be strictly weaker than the
        // one it fronts.
        //
        // AND THE GAP IS THE CASE THIS MAILBOX ACTUALLY HAS. One mail delivered
        // to two addresses arrives as two Stalwart Emails carrying one
        // Message-ID and DIFFERENT bytes (different Received headers) — the very
        // reason schema.ts leaves the sha index non-unique and the reason
        // findDuplicates in backfill-message-ids exists to report such pairs.
        // Neither is in the pre-built set, neither matches the other's sha, so
        // both would be ingested: two permanent rows in a table with no DELETE
        // grant, two suggest.entry jobs on a VRAM-starved GPU, and BOTH counters
        // reporting 0, i.e. no trace of it anywhere.
        //
        // IT SITS BEFORE enqueueAndMark, not after, and that ordering is
        // load-bearing rather than tidy. The row is committed the moment
        // ingestRawEmail returns, and mail-first-sync's --commit run passes
        // throwingEnqueueSuggest, which throws for EVERY message by design — so
        // an add placed after the enqueue would never execute on the one run
        // this dedup was built for, and the whole first sync would duplicate
        // every twice-delivered mail in the archive.
        //
        // `h.messageId` and not `msg.messageId`: the set is the lookup's key
        // space, seeded from a query on raw_emails.message_id and probed with
        // the header value, so anything else put into it is a value the probe
        // can never match. MailMessage.messageId is required by the port
        // contract to be the SAME value headers() returned, so there is nothing
        // to choose between them here — and a port that broke that contract
        // would store one value and probe another on the next run too, which is
        // a port bug this set must not paper over.
        if (h.messageId !== null) {
          heldMessageIds.add(h.messageId);
          ingestedInRun.add(h.messageId);
        }

        await enqueueAndMark(deps, rawEmailId);
        ingested++;
      } catch (err) {
        failures.push({ id, message: String(err) });
      }
    }
  } catch (err) {
    // Discovery itself failed. The cursor is NOT advanced: the next poll must
    // ask the same question again rather than skip whatever changed meanwhile.
    // Unless a resync already happened — the old cursor is then the one the
    // server REFUSED, and writing it back guarantees the next poll dies on it.
    await writeCursor(deps.db, worker, resynced ? null : cursor, {
      message: String(err), repaired: repaired.enqueued,
      ...(repaired.failures.length ? { repairFailures: repaired.failures } : {}),
      ...(repaired.deferred ? { repairDeferred: repaired.deferred } : {}),
      ...(rejectedAddresses.length ? { rejectedAddresses } : {}),
      ...(resynced ? { resynced } : {}),
    }, "error");
    throw err;
  }

  // FINDING 14. Gmail's `newer_than:7d` window re-listed a failed id on the
  // next tick, which is the only reason its per-message isolation was safe.
  // JMAP hands an id over ONCE: advance the cursor past a message whose blob
  // download 500'd or whose vault write hit ENOSPC and that email is gone from
  // the dossier forever — for a mailed Beschikking.pdf, silent permanent loss
  // of evidence traced only by a detail field. So a failure HOLDS the cursor
  // and the next poll re-lists the same delta; everything that did ingest is
  // skipped by the id lookup, which is what makes re-asking cheap.
  //
  // Holding it is chosen over persisting failed ids because it needs no new
  // table and cannot itself lose an id — the cost is that a permanently failing
  // message pins the cursor and grows the delta, which is loud (an `error` run
  // every minute) rather than silent, and that is the right way round.
  //
  // After a RESYNC there is no earlier cursor worth keeping: the old one is the
  // one the server rejected, so a failed resync records NONE and the next poll
  // simply resyncs again.
  const held = failures.length > 0;
  const keep = held ? (resynced ? null : cursor) : changed.cursor;
  const status = failures.length || repaired.failures.length ? "error" : "ok";
  await writeCursor(deps.db, worker, keep, {
    ingested, scanned, irrelevant, vanished, knownByMessageId,
    messagesRepeatedInRun, noMessageId, duplicates,
    repaired: repaired.enqueued, failures, skippedParts,
    ...(repaired.failures.length ? { repairFailures: repaired.failures } : {}),
    ...(repaired.deferred ? { repairDeferred: repaired.deferred } : {}),
    ...(rejectedAddresses.length ? { rejectedAddresses } : {}),
    ...(resynced ? { resynced } : {}),
    ...(held ? { cursorHeld: true, pendingCursor: changed.cursor } : {}),
    ...(changed.hasMore ? { hasMore: true } : {}),
  }, status);
  return { ingested };
}

/**
 * Which of these candidates' Message-IDs `raw_emails` already holds.
 *
 * ONE BATCHED QUERY FOR THE WHOLE CANDIDATE SET, chunked — the alternative is a
 * lookup per message, which is the exact shape 0029 had to add an index for on
 * the content hash: a sequential-scan-per-message over a table growing by one
 * row per message is O(N^2) on the one run the dedup exists for. There is an
 * index now (`raw_emails_message_id_idx`), and it does not make N round trips
 * on a first sync any less wasteful.
 *
 * NULL CANDIDATES ARE DROPPED BEFORE THE QUERY, and this is the whole
 * correctness argument of the helper rather than a tidy-up. A message with no
 * Message-ID must fall through to the content check, and a Set built from what
 * comes back would answer `has(null)` with true the moment ANY row has none
 * recorded — which is every row until the backfill has run. SQL would have got
 * this right on its own (`NULL = NULL` is unknown), so the Set is where the trap
 * lives; filtering on the way in is what keeps the two agreeing.
 *
 * Returns the ids FOUND rather than a per-candidate answer, because the caller
 * asks one question per message and a Set answers it in constant time without
 * the order of the query results mattering.
 *
 * THE CALLER OWNS THE SET AND ADDS TO IT as it ingests, which is why this hands
 * back a fresh mutable Set rather than a frozen or shared one. What it returns
 * is the state of `raw_emails` at ONE instant, and the poll walks candidates
 * afterwards: without the caller's adds the key would answer a question that
 * stopped being true at the first ingest, and would miss the pair this mailbox
 * genuinely has (one mail delivered to two addresses — one Message-ID, two
 * Stalwart ids, different bytes). Batching the query is about round trips; it
 * was never an argument for answering a stale question.
 *
 * EXPORTED for ops/mail-first-sync.ts, which otherwise re-walks this poll's
 * steps by hand — deliberately, so no dry-run branch sits on the production
 * ingest path. That hand-copy is safe for a `select ... where gmail_message_id
 * = $1`; it is not safe for a null-handling rule, which is precisely the sort of
 * duplication that made `documentIdsByTitle`'s two copies disagree. The preview
 * exists to describe the commit, so both read the key through one function.
 */
export async function messageIdsAlreadyHeld(
  db: Db, candidates: MailHeaders[],
): Promise<Set<string>> {
  const distinct = [...new Set(
    candidates.map((c) => c.messageId).filter((m): m is string => m !== null))];
  const found = new Set<string>();
  for (let i = 0; i < distinct.length; i += MESSAGE_ID_LOOKUP_CHUNK) {
    const rows = await db.select({ messageId: schema.rawEmails.messageId })
      .from(schema.rawEmails)
      .where(inArray(schema.rawEmails.messageId,
        distinct.slice(i, i + MESSAGE_ID_LOOKUP_CHUNK)));
    for (const r of rows) if (r.messageId !== null) found.add(r.messageId);
  }
  return found;
}

/**
 * Emails that committed but whose suggest.entry job never got sent.
 *
 * WHY IT NEEDS ITS OWN DRIVER. enqueueAndMark enqueues and then marks, so a
 * crash in between leaves suggest_queued_at NULL. Under Gmail the 7-day window
 * re-listed the id on the next tick and the ingest loop healed it. Under JMAP
 * the id was in `created`, the cursor moved past it, and Email/changes will not
 * return it again — so the branch written to fix that state sits on a path that
 * can never be reached, and the email stays in raw_emails, out of the review
 * queue, forever. Same shape as pendingDocMeta: query the marker, not the feed.
 *
 * Scoped to `source = 'jmap'` because pollGmail still repairs its own rows in
 * its own loop, and two drivers racing for one row would send the job twice.
 *
 * The inverse state cannot happen: suggest_queued_at is only set after the
 * enqueue has resolved, so a marked row always reached the queue.
 *
 * FINDING H: a failed row is held back by makeRepairBackoff before it is
 * offered again, and the LIMIT is widened by however many rows are being held.
 * Without that, `ORDER BY fetched_at ASC LIMIT N` hands the whole batch to the
 * oldest N rows every poll — so N rows nobody can enqueue starve every email
 * behind them out of the review queue permanently, which is the loss this
 * function exists to prevent.
 */
export async function repairSuggestOutbox(
  deps: Pick<Deps, "db" | "enqueueSuggest" | "repairBatch">,
): Promise<RepairResult> {
  const batch = deps.repairBatch ?? SUGGEST_REPAIR_BATCH;
  const now = Date.now();
  const owed = await deps.db.select({ id: schema.rawEmails.id }).from(schema.rawEmails)
    .where(and(isNull(schema.rawEmails.suggestQueuedAt), eq(schema.rawEmails.source, "jmap")))
    .orderBy(asc(schema.rawEmails.fetchedAt))
    // Widened by the rows that will be skipped below, so a poisoned head cannot
    // consume the batch it is standing in front of.
    .limit(batch + repairBackoff.waiting(now));
  let enqueued = 0;
  let deferred = 0;
  const failures: { id: string; message: string }[] = [];
  for (const row of owed) {
    if (!repairBackoff.ready(row.id, now)) { deferred++; continue; }
    // The batch is an ENQUEUE bound and nothing else — the widened LIMIT above
    // must not become a widened rate.
    if (enqueued + failures.length >= batch) break;
    try {
      await enqueueAndMark(deps, row.id);
      repairBackoff.ok(row.id);
      enqueued++;
    } catch (err) {
      // Left NULL on purpose: a later poll tries again, now after a wait. A
      // repair failure never holds the cursor — it has nothing to do with
      // discovery — but it does colour the run red, because an email that
      // cannot reach the queue is exactly the loss the health tile exists to
      // show, and a row that keeps failing keeps saying so every REPAIR_BACKOFF
      // _MAX_MS rather than falling silent.
      repairBackoff.fail(row.id, Date.now());
      failures.push({ id: row.id, message: String(err) });
    }
  }
  return { enqueued, deferred, failures };
}

// Enqueue the suggest job, then mark the raw email as enqueued. If the mark
// itself fails the job is merely sent again next poll (at-least-once), which
// beats the alternative of an email that never reaches the review queue.
async function enqueueAndMark(
  deps: Pick<Deps, "db" | "enqueueSuggest">,
  rawEmailId: string,
): Promise<void> {
  await deps.enqueueSuggest(rawEmailId);
  await deps.db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
    .where(eq(schema.rawEmails.id, rawEmailId));
}
