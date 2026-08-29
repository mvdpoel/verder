import { and, asc, eq, isNull } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestRawEmail } from "../gmail";
import { readCursor, writeCursor } from "./cursor";
import {
  isRelevantMessage, relevanceFilter, type RejectedAddress,
} from "./relevance";
import {
  MailCursorRejectedError, type MailChanges, type MailPort, type SkippedPart,
} from "./port";

const WORKER = "mail";

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
  let irrelevant = 0;
  let vanished = 0;
  let resynced = false;
  const failures: { id: string; message: string }[] = [];
  // Parts the port refused to promote. Recorded per message so a wrong skip is
  // visible the same day: a skipped part never becomes a document and re-polling
  // will not fetch it again.
  const skippedParts: (SkippedPart & { messageId: string })[] = [];

  const worker = deps.worker ?? WORKER;
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
      resynced = true;
      changed = await deps.mail.changedSince(null);
    }
    scanned = changed.ids.length;

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
    const wanted: string[] = [];
    for (const h of heads) {
      if (isRelevantMessage(addrs, h)) wanted.push(h.id);
    }
    irrelevant = heads.length - wanted.length;
    // An id the store no longer holds is NOT an irrelevant message, and one
    // number for both would hide a store dropping mail behind a figure that
    // reads as ordinary housekeeping.
    vanished = scanned - heads.length;

    for (const id of wanted) {
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
    ingested, scanned, irrelevant, vanished, duplicates,
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
