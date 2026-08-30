/** What a caller learns from a run it did not get to make. `run` returns the
 *  value too when it ran, so a caller that only wants to record the tick can
 *  read `.ran` alone and ignore the rest. */
export interface SingleFlightResult { ran: boolean }

/**
 * A per-process latch that lets one poll run at a time.
 *
 * WHY THIS EXISTS: mail.poll is scheduled `* * * * *`, and a poll can outlast
 * its minute — the first sync walks a 146,270-message mailbox, a delta over a
 * slow Stalwart can crawl, and a stalled server holds the request open until
 * its timeout. The cursor is the whole of the poll's memory, and two polls that
 * start on the SAME cursor both ask "what changed since X" and both write back
 * a state: whichever finishes last wins, so one poll's delta is either lost or
 * ingested twice — and a lost delta is mail that never reaches the dossier at
 * all, because Email/changes hands an id over ONCE. (It is no longer also "the
 * only thing standing between the dossier and re-walking the mailbox": the
 * scheduled poll passes allowFirstSync: false, so a cursor that ends up null
 * buys a refusal rather than a full walk.)
 * Every other guard in pollMail (the per-message isolation, the held cursor on
 * failure, the content hash) protects a message; none of them protects the
 * cursor from a second reader.
 *
 * SKIPPING, NOT QUEUEING. A queued tick would start the moment the first
 * finishes and would run against a cursor the first has only just moved —
 * at best a wasted round trip, at worst the same race one minute later. The
 * next scheduled tick is a minute away regardless, so a skip costs nothing
 * that waiting would not also cost, and it keeps the queue from growing a tail
 * of polls behind one slow first sync.
 *
 * In-process and not a table, the same choice makeEnqueueGuard and
 * makeRepairBackoff record: the poller is a single long-lived worker, so
 * process scope IS the scope of the schedule, and a restart cannot leave a
 * latch stuck closed — there is nothing to release, because the poll it was
 * holding died with the process. A lock row would have survived that restart
 * as a lie and would have needed a lease, a heartbeat and a migration to tell
 * a crashed holder from a slow one.
 */
export function makeSingleFlight() {
  let busy = false;
  return {
    /**
     * Run `fn` unless a run is already in flight.
     *
     * The flag is raised before the first await, so a second caller on the same
     * tick of the event loop sees it; it is lowered in a `finally`, because a
     * flag released only on the success path stays raised after the first throw
     * and every later tick then reports a clean skip while nothing polls at all
     * — silent, permanent, and indistinguishable from a quiet mailbox.
     *
     * `fn()` is called INSIDE the try so a function that throws before its
     * first await releases the latch too, and the error is re-thrown untouched
     * so pollMail's own handling and its worker_runs row are unchanged: this
     * guard decides whether a poll happens, never what a failed poll means.
     */
    async run<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
      if (busy) return { ran: false };
      busy = true;
      try {
        return { ran: true, value: await fn() };
      } finally {
        busy = false;
      }
    },
    /** Whether a run is in flight. Reported so a skipped tick can record WHY it
     *  skipped rather than looking like a poll that found nothing. */
    inFlight(): boolean { return busy; },
  };
}

export type SingleFlight = ReturnType<typeof makeSingleFlight>;
