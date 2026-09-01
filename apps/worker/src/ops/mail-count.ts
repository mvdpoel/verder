// The sidecar manifest for a mail snapshot: what the store held AT THE MOMENT
// ops/mail-backup.sh took it.
//
//   pnpm --filter worker mail-count <archive basename>
//
// It prints ONE line of JSON on stdout and nothing else:
//
//   {"archive":"native-2026-09-01.tar.zst","takenAt":"…","count":146270,
//    "mailboxes":{"Inbox":137503,…}}
//
// WHY IT EXISTS AS A WORKER SCRIPT rather than as a node heredoc in the backup
// script, which is what it was. The manifest is the baseline the monthly restore
// drill judges a restored store against, so the two have to ask the same
// question — and the heredoc was a second, hand-rolled JMAP client that built
// its own Basic header, fetched its own session, walked its own methodResponses
// and read JMAP_BASE_URL / JMAP_USER / JMAP_APP_PASSWORD directly. That breaks
// the law mail/from-env.ts states in as many words ("NOTHING else in `mail/`
// reads an env var for the connection … this is the seam where configuration
// becomes a dependency, and it is the only one"), and the failure it warns about
// is not loud: the spelling that was TESTED keeps working and the other one gets
// a 401 that reads like a wrong app password.
//
// It had also already drifted, before either half had ever run: it kept the LAST
// of two mailboxes sharing a name where the drill SUMS them, and it dropped a
// mailbox whose `totalEmails` was missing where the drill refuses one. Either
// difference makes a byte-perfect restore fail rule 3 every month — the
// permanent red that ends with somebody no longer reading the drill. Now both
// halves call mail/jmap-counts.ts and there is nothing left to drift.
//
// THE COUNT IS A CONVENIENCE, NEVER A GATE. The backup runs this inside an `if`
// and carries on without a manifest when it fails: a night with an archive and
// no manifest costs the drill a fallback to the live count; a night with no
// archive costs everything.
import { basic, openSession } from "../mail/jmap-client";
import { mailEnvFrom } from "../mail/from-env";
import { countMessages, mailboxTotals } from "../mail/jmap-counts";

/**
 * A fetch that cannot hang.
 *
 * There is NO request timeout anywhere else on the JMAP path — jmap-client.ts
 * passes no AbortSignal and undici's 300 s defaults are all that sit under it,
 * and they reset per chunk, so a trickling server holds forever. This script
 * runs IN FRONT OF THE TAR in the nightly backup, so a hang here is a night with
 * no snapshot at all. The backup script bounds the `docker compose exec` as
 * well, because that can hang for reasons this signal cannot reach; two hangs,
 * two bounds.
 */
export function timedFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    base(url, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The manifest line, as one string.
 *
 * KEY ORDER IS LOAD-BEARING. ops/mail-backup.sh gates this line against an
 * ANCHORED regex — `^\{"archive":"native-[^"]+","takenAt":"[^"]+","count":[1-9][0-9]*,"mailboxes":\{`
 * — whose whole job is to refuse anything that is not a manifest, including
 * error text that reached stdout instead of stderr. `JSON.stringify` emits an
 * object literal's keys in insertion order, so these four stay in this order.
 *
 * A COUNT BELOW 1 IS REFUSED HERE rather than written and rejected downstream.
 * No manifest is honest — the drill falls back to the live count and says so —
 * while a manifest saying 0 is a lie the drill would act on, failing a perfectly
 * good restore for holding 146 270 messages where "the snapshot" held none.
 */
export function manifestLine(
  archive: string, takenAt: string, count: number, mailboxes: Record<string, number>,
): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`refusing to write a manifest claiming ${String(count)} message(s)`);
  }
  return JSON.stringify({ archive, takenAt, count, mailboxes });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // The archive this manifest belongs to. It ties the baseline to ONE file, so a
  // manifest can never be read as the baseline for the archive beside it — which
  // is exactly what a drill pointed at the second-newest archive would otherwise
  // do.
  const archive = (process.argv[2] ?? "").trim();
  try {
    if (!archive) throw new Error("usage: mail-count <archive basename>");
    // The same factory the scheduled poll authenticates through: empty-is-missing,
    // one trailing slash, the app password untrimmed. Nothing here handles the
    // credential itself — it arrives in the worker's own environment through
    // `env_file: .env.prod`, so the backup script never touches it and it never
    // reaches a command line or the host process table.
    const env = mailEnvFrom(process.env);
    const fetchFn = timedFetch(REQUEST_TIMEOUT_MS);
    const auth = basic(env.user, env.appPassword);
    const session = await openSession(env.baseUrl, auth, fetchFn);
    const count = await countMessages(session, auth, fetchFn);
    const mailboxes = await mailboxTotals(session, auth, fetchFn);
    // stdout carries the manifest and NOTHING else, because the caller captures
    // it. Every diagnosis goes to stderr, where the cron log keeps it.
    process.stdout.write(`${manifestLine(archive, new Date().toISOString(), count, mailboxes)}\n`);
  } catch (err) {
    // No environment dump, no Authorization header, no credential: this message
    // reaches a cron log that is kept, and an app password does not expire.
    console.error(`mail-count: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
