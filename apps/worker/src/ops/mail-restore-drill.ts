// The MONTHLY RESTORE DRILL — the half that runs inside the worker image and
// judges what came back.
//
//   pnpm --filter worker mail-drill
//
// It is never run by hand on its own: ops/mail-restore-drill.sh restores the
// newest tier-1 archive into a SCRATCH Stalwart (`stalwart-drill`, an overlay
// service on the production compose project), inspects the tier-2 archive with
// `vandelay inspect`, and then runs this script inside the worker container with
// MAIL_DRILL_BASE_URL pointing at the scratch server. This half never touches a
// container, a tarball or the production store; it asks two servers questions
// and compares the answers.
//
// WHY A DRILL AT ALL, and why this shape. `ops/mail-backup.sh` already refuses
// to keep an archive that does not contain `etc/config.json` — the one member
// whose absence is invisible until a restore comes up in bootstrap mode — and
// that check is worth exactly what it says: the archive contains a file. It
// cannot say the RocksDB inside it still opens under the Stalwart of the day,
// that the app password survived, that the blobs are readable, or that the store
// holds the messages it held when the tar started. Only a restore says that, so
// once a month one happens.
//
// THE MOST DANGEROUS THING IN THIS TASK, stated where an editor will meet it:
// STALWART_PUBLIC_URL decides the scratch server's session `apiUrl` VERBATIM.
// Production's is `http://stalwart:8080`, so a scratch instance that inherits it
// hands back production's URL in its session and EVERY method call this script
// makes lands on the LIVE SERVER — a drill that reads production twice, compares
// it with itself and passes forever. The compose overlay overrides it; the check
// that catches the failure anyway is `assertDistinctApiUrls` below, which
// refuses to compare two sessions that resolved to the same api url.
//
// NOTHING HERE WRITES TO THE MAIL STORE. Every JMAP method used is a read
// (Email/query, Mailbox/get, Email/get, and a blob download), against the
// scratch server for the facts and against the live server only to fetch the
// same bytes for comparison. The single write anywhere in this file is one
// `worker_runs` row, and one push — on failure only.
import { readFileSync } from "node:fs";
import { sha256Hex } from "@verder/core";
import { createDb, type Db } from "@verder/db";
import { MAIL_DRILL_WORKER_NAME } from "@verder/api/src/worker-names";
import {
  basic, call, download, openSession,
  type JmapCredential, type JmapSession,
} from "../mail/jmap-client";
import { USING, countMessages, mailboxTotals } from "../mail/jmap-counts";
import { mailEnvFrom } from "../mail/from-env";
import { recordRun } from "../heartbeat";
import { sendPush } from "../push";

/**
 * The worker name this drill records under, taken from the leaf module that
 * holds every `worker_runs.worker` string with a writer and a reader in
 * different packages. This one is written here and read by the `monthly`
 * declaration in packages/api/src/worker-health.ts — two files that cannot see
 * each other, which is precisely what that module exists for: a typo does not
 * throw, the reader simply finds no rows, and a drill that has not run in a year
 * renders as calm.
 *
 * READ THE TILE. `worker-health.ts` declares this worker `monthly` with an error
 * window as long as the silence bound, so a FAILED drill stays red on the
 * dashboard until a passing run replaces the row. That tile is the ONLY durable
 * surface a failure has — /verify renders the ledger panel and index health and
 * nothing else, and the push is a single interruption that is gone once it is
 * dismissed.
 */
export const DRILL_WORKER = MAIL_DRILL_WORKER_NAME;

// The two count probes live in mail/jmap-counts.ts, because ops/mail-backup.sh
// asks the SAME two questions when it writes the manifest this drill is judged
// against. Re-exported so this module's own surface (and its tests) still read
// as one drill. See that file for why one definition is the whole point.
export { countMessages, mailboxTotals };

/** Messages compared byte for byte when the shell names no other number. Eight
 *  spread across 146 270 costs eight small queries and eight ~50 KB downloads;
 *  the drill's slow part is the restore, not this. */
export const DEFAULT_SAMPLES = 8;

/** Mailbox and sample discrepancies quoted in one reason line. The reasons ARE
 *  the push body, and a store where all 21 mailboxes moved would otherwise send
 *  a notification nobody can read on a phone; the full lists go to
 *  `worker_runs.detail` either way. */
export const REASON_LIST_LIMIT = 5;

/** Ascending by delivery time — the same sort `firstSync` enumerates with.
 *
 *  A SORT IS NOT A FILTER (see the note on rule 1): it changes the ORDER of the
 *  answer, never which messages are in it, and Email/query's ordering is
 *  otherwise server-defined. Without it "position 91 418" is whatever the store
 *  felt like that minute, so a failing drill samples different messages on the
 *  re-run and the failure cannot be reproduced — the same reason the positions
 *  below are arithmetic and not Math.random. */
const SORT = [{ property: "receivedAt", isAscending: true }];

/** What `download` is told the blob is. Both values are cosmetic — they land in
 *  the URL template — but the drill hashes whatever bytes come back, so they
 *  must not vary between the two servers or the URLs stop being comparable. */
const BLOB_NAME = "message.eml";
const BLOB_TYPE = "message/rfc822";

// --- the facts, and the judgement --------------------------------------------

export interface DrillFacts {
  /** Basename of the tier-1 archive this drill restored, for the record. */
  archive: string;
  /** What the RESTORED server says it holds. */
  restored: { total: number; mailboxes: Record<string, number> };
  /**
   * What it SHOULD hold, and where that figure came from.
   *
   * WHY THE MANIFEST MATTERS. Comparing a restore against the LIVE count is
   * exact only while no new mail arrives between the snapshot and the drill,
   * which is true in phase 1 and stops being true the moment phase 2 moves
   * delivery onto this store. From then on the snapshot is up to 24 h behind
   * live, an equality check false-alarms every single month, and the drill
   * becomes the permanent amber the worker-health taxonomy was written to
   * remove — at which point somebody stops reading it, which is the actual
   * failure. The manifest is the snapshot's OWN count, written beside the
   * archive at the moment tar ran, so the comparison stays exact across that
   * boundary. `source` is carried and printed because a reader has to know
   * which of the two questions was answered.
   */
  expected: { total: number; mailboxes: Record<string, number>; source: "manifest" | "live" };
  /** How many positions the drill ASKED for. Recorded because `samples.length`
   *  alone cannot tell a full comparison from a partial one after the fact — a
   *  store smaller than the count legitimately yields fewer (ids are
   *  deduplicated), while a store that failed to enumerate itself yields fewer
   *  AND a sample failure per unanswered position. */
  requestedSamples: number;
  /** Messages fetched from BOTH servers and hashed. */
  samples: { id: string; bytes: number; restoredSha: string; liveSha: string }[];
  /** One human-readable line per sample that could not be compared or did not
   *  match. Each names WHICH SIDE failed: a live server that is down fails this
   *  drill, and an operator must not read that as a corrupt backup. */
  sampleFailures: string[];
  /** The shell's `vandelay inspect` result, its reason for not having one, or
   *  null when it reported nothing at all. */
  tier2: { archive: string; emails: number } | { skipped: string } | null;
  /** The three probes that make up "JMAP answers" here. See rule 1. */
  jmap: { session: boolean; query: boolean; get: boolean };
}

/**
 * How far the WEEKLY tier-2 count may sit from the NIGHTLY tier-1 baseline
 * before rule 5 calls it a fault.
 *
 * THE TWO ARTIFACTS ARE NOT TAKEN AT THE SAME MOMENT, and rule 5 compared them
 * with `!==` until this constant existed. `ops/mail-backup.sh` writes tier 1
 * every night and tier 2 once per ISO week, so they are up to SEVEN DAYS apart,
 * and `f.expected.total` is the tier-1 figure. In phase 1 that is invisible —
 * nothing writes to the store, so the two counts are identical — and the hour
 * phase 2 moves delivery onto Stalwart, a week of delivered mail makes an exact
 * comparison fail EVERY MONTH on a healthy pair. With `errorActionableMs` on the
 * monthly declaration that red does not age out either, so it would stand for
 * the whole month by design: the permanent-amber failure the worker-health
 * taxonomy was written to remove, rebuilt inside the one worker that opted out
 * of ageing.
 *
 * 5% AND NOT A COUNT OF MESSAGES, because the delivery rate after phase 2 is not
 * known and a fixed number would be a guess wearing a measurement's clothes. On
 * today's store 5% is ~7 300 messages: far more than a week of one person's mail
 * (this mailbox took years to reach 146 270), and far less than what the failure
 * this rule exists to catch — a truncated Vandelay pull — takes away. Both
 * directions are bounded: a tier 2 much LARGER than tier 1 is as odd as a
 * smaller one and equally worth a human.
 *
 * The exact figures are printed on every run, pass or fail, so drift is readable
 * long before it is a failure. IF IT EVER STARTS DRIFTING BY MORE THAN NOISE,
 * the fix is a tier-2 sidecar of its own — the same manifest treatment tier 1
 * already got — not a wider tolerance.
 */
export const TIER2_TOLERANCE_PERCENT = 5;

export function withinTier2Tolerance(emails: number, expected: number): boolean {
  // An expected total of 0 has no percentage; exact agreement is the only honest
  // reading, and `f.tier2.emails <= 0` has already been refused above.
  if (expected <= 0) return emails === expected;
  return Math.abs(emails - expected) * 100 <= expected * TIER2_TOLERANCE_PERCENT;
}

const cap = (xs: string[]): string =>
  (xs.length <= REASON_LIST_LIMIT
    ? xs.join("; ")
    : `${xs.slice(0, REASON_LIST_LIMIT).join("; ")}; +${xs.length - REASON_LIST_LIMIT} more`);

/**
 * Every rule of the drill, and nothing else.
 *
 * PURE, and exported for the same reason `summarisePreview` is: the boolean an
 * unattended monthly job decides on must be testable without a mail server, a
 * container or a 5.59 GB tarball. Everything above it is I/O that gathers
 * facts; everything below is printing and one worker_runs row.
 *
 * It returns EVERY broken rule rather than the first. The reasons are the push
 * body, and an operator reading it at 04:00 should get the whole diagnosis in
 * one go — "the total is short AND the bytes differ AND tier 2 was skipped" is
 * a different morning from any one of them.
 */
export function judgeDrill(f: DrillFacts): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // RULE 1 — "JMAP answers" is session + Email/query + Email/get.
  //
  // IT IS DELIBERATELY NOT A SEARCH, and this is the single most likely thing a
  // later reader will try to "fix". Email/query FILTERS RETURN NOTHING on this
  // store IN PRODUCTION: a subject filter for a subject known to be present
  // answers 0, and so does `header: ["Message-ID"]`, which asks only whether the
  // header EXISTS and cannot honestly be zero across 146 270 messages. That is a
  // separate, known defect — most likely a full-text index Vandelay's import
  // never populated — and it has nothing to do with the backup. A drill that
  // asserted search would therefore fail EVERY MONTH on a fault a restore cannot
  // fix, and a check that always fails is a check nobody reads. Unfiltered
  // enumeration, per-mailbox counts and blob download are what ingestion itself
  // uses (Email/changes and Email/get never filter), so this is exactly "can the
  // dossier be fed from this store again".
  const dead = (["session", "query", "get"] as const).filter((k) => !f.jmap[k]);
  if (dead.length > 0) {
    reasons.push(`the restored server did not answer JMAP: ${dead.join(", ")}`);
  }

  // RULE 2 — the headline. A restore that comes up holding less than the
  // snapshot held is the failure every other check is decoration around.
  if (f.restored.total !== f.expected.total) {
    reasons.push(`the restore holds ${f.restored.total} message(s), `
      + `expected ${f.expected.total} (${f.expected.source})`);
  }

  // RULE 3 — per-mailbox, because a bare total cannot distinguish "146 270
  // messages" from "146 270 messages in the wrong mailboxes", and Mailbox/get
  // hands the figures over in ONE round trip (measured: all 21 at once).
  //
  // MAPS AND NOT `in`, because these keys come out of JSON. `"constructor" in
  // obj` is true for every object alive, so an `in` test would call a mailbox
  // named after an Object property present and equal without ever looking.
  //
  // AN EMPTY MAP ON EITHER SIDE IS A FAILURE, and this is rule 4's floor applied
  // one rule up. Both loops below are over maps that can arrive empty from two
  // independent directions — a restored `Mailbox/get` that threw leaves `{}`,
  // and a manifest can carry `"mailboxes":{}` — and with BOTH empty they iterate
  // zero times and the rule PASSES while the report still says a per-mailbox
  // comparison happened. "We compared nothing and nothing was wrong" is how a
  // check quietly stops checking. The reason names the sizes, because "expected
  // 0, restored 21" and "expected 21, restored 0" are completely different
  // mornings.
  const expectedBoxes = new Map(Object.entries(f.expected.mailboxes));
  const restoredBoxes = new Map(Object.entries(f.restored.mailboxes));
  if (expectedBoxes.size === 0 || restoredBoxes.size === 0) {
    reasons.push(`no per-mailbox comparison was possible — ${expectedBoxes.size} mailbox(es) `
      + `in the ${f.expected.source} counts, ${restoredBoxes.size} in the restore; a drill `
      + "that compares no mailboxes proves nothing about where the messages went");
  } else {
    const boxDiffs: string[] = [];
    for (const [name, n] of expectedBoxes) {
      const got = restoredBoxes.get(name);
      if (got === undefined) boxDiffs.push(`${name}: absent from the restore, expected ${n}`);
      else if (got !== n) boxDiffs.push(`${name}: ${got}, expected ${n}`);
    }
    for (const name of restoredBoxes.keys()) {
      // A mailbox the snapshot never had is as wrong as a missing one: it is
      // what a store that came up in BOOTSTRAP MODE beside the good one looks
      // like.
      if (!expectedBoxes.has(name)) {
        boxDiffs.push(`${name}: in the restore, not in the ${f.expected.source} counts`);
      }
    }
    if (boxDiffs.length > 0) {
      reasons.push(`${boxDiffs.length} mailbox(es) disagree — ${cap(boxDiffs)}`);
    }
  }

  // RULE 4 — the bytes. A count can match perfectly while the messages behind it
  // are wrong, and that is the failure a drill exists to catch; nothing cheaper
  // than downloading and hashing can see it.
  //
  // AN EMPTY SAMPLE LIST IS A FAILURE, not a pass. "We compared nothing and
  // nothing was wrong" is how a check quietly stops checking — the same lesson
  // the tier-1 archive listing and `strandedOnSpine` already carry.
  if (f.samples.length === 0) {
    reasons.push("no message was sampled at all — a drill that compares no bytes "
      + "proves nothing about them");
  }
  if (f.sampleFailures.length > 0) {
    reasons.push(`${f.sampleFailures.length} sampled message(s) did not compare — `
      + `${cap(f.sampleFailures)}`);
  }

  // RULE 5 — tier 2. The spec (docs/superpowers/specs/
  // 2026-08-29-mail-architecture-design.md §2) requires that there is never a
  // generation where only the NATIVE form is proven: a tier-1 snapshot is a
  // RocksDB directory tree and restores only under a Stalwart that still reads
  // this on-disk layout, which is precisely the thing still moving before 1.0.
  // So "the shell had nothing to say about tier 2" and "the shell skipped it"
  // are both failures, and the skip's own reason is repeated verbatim.
  if (f.tier2 === null) {
    reasons.push("the drill script reported nothing about the tier-2 archive; it must "
      + "always report something, even if only that it skipped");
  } else if ("skipped" in f.tier2) {
    reasons.push(`the tier-2 archive was not checked: ${f.tier2.skipped} — the spec `
      + "forbids a generation where only the native snapshot is proven");
  } else if (f.tier2.emails <= 0) {
    reasons.push(`the tier-2 archive ${f.tier2.archive} inspects as ${f.tier2.emails} `
      + "message(s); an archive that holds nothing restores nothing");
  } else if (!withinTier2Tolerance(f.tier2.emails, f.expected.total)) {
    reasons.push(`the tier-2 archive ${f.tier2.archive} holds ${f.tier2.emails} `
      + `message(s), more than ${TIER2_TOLERANCE_PERCENT}% away from the `
      + `${f.expected.total} the snapshot recorded (${f.expected.source})`);
  }

  return { ok: reasons.length === 0, reasons };
}

// --- the probes ---------------------------------------------------------------

/** The scratch server's own session. A thin alias over `openSession` so every
 *  call site in this file reads as "the restored one" or "the live one", and so
 *  the test fake has one seam to drive. */
export async function openDrillSession(
  base: string, auth: JmapCredential, fetchFn: typeof fetch = fetch,
): Promise<JmapSession> {
  return openSession(base, auth, fetchFn);
}

interface QueryResponse { ids?: string[]; total?: number }

/** What one round of sampling asked for and what came back. `missed` carries the
 *  positions the server answered with NO id — see `sampleIds` for why they are
 *  reported rather than skipped. */
export interface SamplePlan { ids: string[]; missed: number[] }

/**
 * The n positions this drill samples in a store of `total` messages.
 *
 * SPLIT OUT AND PURE so the arithmetic can be read and tested without a server,
 * because it has already been wrong once in a way no green suite could see.
 *
 * FIRST AND LAST, AND EVENLY BETWEEN. The obvious spelling — floor(i × total / n)
 * for i in 0…n−1 — has a highest position of floor((n−1) × total / n), which on
 * the real store is 127 986 of 146 270: the NEWEST ~18 000 MESSAGES ARE NEVER
 * COMPARED. That is not a rounding detail, it is a hole exactly where this
 * function's own reason for existing puts the damage — a truncated tar and a
 * half-copied blob directory both lose the TAIL, and the tail was the one region
 * outside every sample. Anchoring on total−1 closes it: the last position is
 * always the last message.
 *
 * The positions are arithmetic and never random: a drill whose failure cannot be
 * reproduced on the next run is a drill that gets argued with instead of acted
 * on.
 */
export function samplePositions(total: number, n: number): number[] {
  if (!Number.isFinite(total) || total < 1 || n < 1) return [];
  // n === 1 has no interval to divide, and (n − 1) would be a division by zero.
  // One sample means the first message, not the last: with nothing to compare it
  // to, the front of the store is where a reader expects a single probe to look.
  if (n === 1) return [0];
  const last = total - 1;
  return Array.from({ length: n }, (_, i) => Math.floor((i * last) / (n - 1)));
}

/**
 * Ids at those positions.
 *
 * NOT THE FIRST PAGE. A first page samples one corner of a 146 270-message store
 * and would pass while everything after position 500 was lost.
 *
 * Ids are deduplicated, so a store smaller than the sample count yields each
 * message once rather than the same one repeatedly. That is the ONLY reason a
 * position may produce no new id and still be silent.
 *
 * A POSITION THE SERVER ANSWERS WITH NOTHING IS REPORTED, not skipped. It used
 * to be skipped, and the consequence was that a restored store whose index
 * answered one of eight positions produced ONE sample, no failures, and a pass
 * that read exactly like a full eight-of-eight comparison — including in
 * `worker_runs.detail`, where nothing recorded how many had been asked for. An
 * unanswered position is the store failing to enumerate itself, which is a
 * restore result; `collectFacts` turns each one into a named sample failure.
 */
export async function sampleIds(
  s: JmapSession, auth: JmapCredential, total: number, n: number,
  fetchFn: typeof fetch = fetch,
): Promise<SamplePlan> {
  const ids: string[] = [];
  const missed: number[] = [];
  const seen = new Set<string>();
  for (const position of samplePositions(total, n)) {
    // ONE REQUEST PER POSITION, not n method calls in one request. RFC 8620's
    // `maxCallsInRequest` bounds a batch and firstSync already has to guard
    // against a session that advertises too few; eight tiny queries at ~6 ms
    // each (measured against production) buy that problem away entirely.
    const [q] = await call<QueryResponse>(s, auth, USING, [["Email/query", {
      accountId: s.accountId, sort: SORT, position, limit: 1,
    }, `s${position}`]], fetchFn);
    const id = (q?.ids ?? [])[0];
    if (typeof id !== "string") { missed.push(position); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, missed };
}

/**
 * The sha256 of one message's raw RFC822 bytes, as the server hands them over.
 *
 * Email/get for the blobId, then the download URL template. This is the only
 * probe that proves the BLOB STORE came back: a tier-1 archive is three
 * directories, and `blobs/` is by far the largest of them — a tar that
 * truncated there restores a store whose message COUNTS are all perfect and
 * whose bodies are gone.
 */
export async function rawSha256(
  s: JmapSession, auth: JmapCredential, id: string, fetchFn: typeof fetch = fetch,
): Promise<{ sha: string; bytes: number }> {
  const [r] = await call<{ list?: { id: string; blobId?: unknown }[] }>(
    s, auth, USING, [["Email/get", {
      accountId: s.accountId, ids: [id], properties: ["id", "blobId"],
    }, "g0"]], fetchFn);
  const blobId = (r?.list ?? [])[0]?.blobId;
  if (typeof blobId !== "string" || blobId === "") {
    throw new Error(`JMAP Email/get returned no blob for message ${id}`);
  }
  const buf = await download(s, auth, blobId, BLOB_NAME, BLOB_TYPE, fetchFn);
  return { sha: sha256Hex(buf), bytes: buf.length };
}

// --- the walk -----------------------------------------------------------------

/** The snapshot's own account of itself, written beside the archive at the
 *  moment tar ran. See DrillFacts.expected for why it exists. */
export interface DrillManifest { count: number; mailboxes: Record<string, number> }

export interface CollectDeps {
  restoredBase: string;
  liveBase: string;
  auth: JmapCredential;
  archive: string;
  samples: number;
  manifest: DrillManifest | null;
  tier2: DrillFacts["tier2"];
  fetchFn?: typeof fetch;
  /** Called for every probe that threw. The failure is already reflected in the
   *  facts (a false flag, a zero count, a sample failure), but the exception's
   *  own text is the part that says WHY, and it belongs in worker_runs.detail
   *  rather than only in the terminal. */
  onProbeError?: (where: string, err: unknown) => void;
}

/**
 * Both servers are asked; nothing is judged.
 *
 * Kept apart from `main` and free of the database so the whole comparison can be
 * driven by a fake fetch — including the failure that matters most, a restore
 * whose counts agree and whose bytes do not.
 *
 * EVERY PROBE IS ISOLATED. A drill that throws on the first bad answer records
 * no run row and sends no push, which is the one outcome worse than a red one:
 * silence. So each probe that fails leaves its mark in the facts (a false JMAP
 * flag, a zero total, a named sample failure) and judgeDrill turns the lot into
 * reasons.
 */
export async function collectFacts(deps: CollectDeps): Promise<DrillFacts> {
  const fetchFn = deps.fetchFn ?? fetch;
  const note = (where: string, err: unknown) => deps.onProbeError?.(where, err);
  const jmap = { session: false, query: false, get: false };

  let restored: JmapSession | null = null;
  try {
    restored = await openDrillSession(deps.restoredBase, deps.auth, fetchFn);
    jmap.session = true;
  } catch (err) { note("restored session", err); }

  // The live session is opened even when a manifest makes its counts
  // unnecessary: the byte comparison needs it either way, and one failure
  // reported once is easier to read than the same failure eight times.
  let live: JmapSession | null = null;
  try {
    live = await openDrillSession(deps.liveBase, deps.auth, fetchFn);
  } catch (err) { note("live session", err); }

  if (restored && live) assertDistinctApiUrls(restored, live);

  let restoredTotal = 0;
  let restoredBoxes: Record<string, number> = {};
  if (restored) {
    try {
      restoredTotal = await countMessages(restored, deps.auth, fetchFn);
      jmap.query = true;
    } catch (err) { note("restored Email/query", err); }
    try {
      restoredBoxes = await mailboxTotals(restored, deps.auth, fetchFn);
    } catch (err) { note("restored Mailbox/get", err); }
  }

  let expected: DrillFacts["expected"] = deps.manifest
    ? { total: deps.manifest.count, mailboxes: deps.manifest.mailboxes, source: "manifest" }
    : { total: 0, mailboxes: {}, source: "live" };
  if (!deps.manifest && live) {
    try {
      expected = {
        total: await countMessages(live, deps.auth, fetchFn),
        mailboxes: await mailboxTotals(live, deps.auth, fetchFn),
        source: "live",
      };
    } catch (err) { note("live counts", err); }
  }

  let ids: string[] = [];
  const sampleFailures: string[] = [];
  if (restored && jmap.query) {
    try {
      const plan = await sampleIds(restored, deps.auth, restoredTotal, deps.samples, fetchFn);
      ids = plan.ids;
      // A position that answered nothing is a restore result, not a detail to
      // drop: see sampleIds. Named as a position rather than an id, because
      // there is no id — that IS the failure.
      for (const p of plan.missed) {
        sampleFailures.push(`position ${p}: the RESTORED server enumerated no message `
          + `there, so this slice of the store was never compared`);
      }
    } catch (err) { note("restored sampling", err); }
  }

  const samples: DrillFacts["samples"] = [];
  for (const id of ids) {
    let fromRestore: { sha: string; bytes: number };
    try {
      fromRestore = await rawSha256(restored!, deps.auth, id, fetchFn);
      jmap.get = true;
    } catch (err) {
      // Named side, always. The three ways a sample fails — the restore cannot
      // produce it, the live server cannot, the two disagree — mean completely
      // different things, and the middle one is not a backup fault at all.
      sampleFailures.push(`${id}: the RESTORED server could not produce it — ${String(err)}`);
      continue;
    }
    let fromLive: { sha: string; bytes: number };
    try {
      fromLive = await rawSha256(live!, deps.auth, id, fetchFn);
    } catch (err) {
      sampleFailures.push(`${id}: the LIVE server could not produce it to compare `
        + `against (this is not a fault in the backup) — ${String(err)}`);
      continue;
    }
    // Both shas known, so the pair is recorded whether or not it matched: the
    // detail row is the evidence, and "what did it compare" must be readable
    // for a failure as well as for a pass.
    samples.push({ id, bytes: fromRestore.bytes, restoredSha: fromRestore.sha,
      liveSha: fromLive.sha });
    if (fromRestore.sha !== fromLive.sha) {
      sampleFailures.push(`${id}: restored sha ${fromRestore.sha.slice(0, 12)}… != `
        + `live sha ${fromLive.sha.slice(0, 12)}… (${fromRestore.bytes} vs ${fromLive.bytes} bytes)`);
    }
  }

  return {
    archive: deps.archive,
    restored: { total: restoredTotal, mailboxes: restoredBoxes },
    expected, requestedSamples: deps.samples, samples, sampleFailures,
    tier2: deps.tier2, jmap,
  };
}

/**
 * THE GUARD AGAINST DRILLING PRODUCTION AGAINST ITSELF.
 *
 * STALWART_PUBLIC_URL decides a session's `apiUrl` VERBATIM, and production's is
 * `http://stalwart:8080`. A scratch container that inherits it — a forgotten
 * override, an env file copied wholesale, a compose merge that lost the key —
 * answers discovery with PRODUCTION's api url, and every method call after that
 * silently lands on the live server. The drill then compares production with
 * production: identical totals, identical mailboxes, identical bytes, green
 * forever, proving nothing about any archive. It is the one failure in this
 * script that looks exactly like success.
 *
 * Nothing else can catch it. The base URLs differ (the shell passes two), the
 * credentials are the same by design, and both servers answer every probe
 * correctly. Only the api url the SESSIONS resolved to gives it away.
 *
 * It THROWS out of `collectFacts` rather than becoming one more reason, which is
 * the one place that function is deliberately not isolated: there is nothing to
 * judge. The facts it would go on to gather are a comparison of production with
 * itself, and a judgement over them is a lie whichever way it comes out.
 */
export function assertDistinctApiUrls(restored: JmapSession, live: JmapSession): void {
  if (restored.apiUrl !== live.apiUrl) return;
  throw new Error("the restored server's session hands back the SAME api url as the live "
    + `server (${restored.apiUrl}) — STALWART_PUBLIC_URL was not overridden on the drill `
    + "container, so every probe would have run against production and passed for free");
}

// --- what the shell hands over -------------------------------------------------

/**
 * `MAIL_DRILL_SAMPLES`, or the default.
 *
 * The trap `parseFirstSyncPages` records, in the module that meets it next: `??`
 * does not fire on "", and an env var is empty far more often than it is absent
 * — a bare `MAIL_DRILL_SAMPLES=` line, a compose file interpolating something
 * unset, a wrapper exporting the name with no value. An empty value is a
 * mistake, not a request to compare zero messages (which rule 4 would then fail
 * on, confusingly, as "nothing was sampled").
 *
 * Anything that is not a plain positive integer is REFUSED rather than coerced:
 * `Number("8e1")` is 80 and `Number("1.5")` is 1.5, and a fractional count walks
 * `sampleIds` into positions nobody asked for.
 */
export function parseSampleCount(raw: string | undefined): number {
  const v = raw?.trim();
  if (!v) return DEFAULT_SAMPLES;
  if (!/^[0-9]+$/.test(v) || Number(v) < 1) {
    throw new Error("MAIL_DRILL_SAMPLES must be a positive whole number of messages");
  }
  return Number(v);
}

/**
 * `MAIL_DRILL_TIER2`, the shell's `vandelay inspect` result.
 *
 * Absent means null, which judgeDrill fails: the shell must always say
 * something, and "the variable was never set" is indistinguishable from "the
 * script forgot", so both are refused.
 *
 * MALFORMED BECOMES A SKIP, not a throw. A skip is a failure WITH A REASON
 * attached, so a shell that garbles its own report fails the drill and says
 * exactly that — where throwing here would kill the process before the
 * worker_runs row is written, turning a bad report into no report.
 */
export function parseTier2(raw: string | undefined): DrillFacts["tier2"] {
  const v = raw?.trim();
  if (!v) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(v); } catch {
    return { skipped: "MAIL_DRILL_TIER2 was not valid JSON" };
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as { archive?: unknown; emails?: unknown; skipped?: unknown };
    if (typeof o.skipped === "string") return { skipped: o.skipped };
    if (typeof o.archive === "string" && typeof o.emails === "number"
      && Number.isInteger(o.emails)) {
      return { archive: o.archive, emails: o.emails };
    }
  }
  return { skipped: "MAIL_DRILL_TIER2 did not carry {archive,emails} or {skipped}" };
}

/**
 * The sidecar JSON written beside the archive at snapshot time.
 *
 * THE MAILBOX TOTALS ARE REQUIRED, AND AN EMPTY OBJECT IS NOT TOTALS. A manifest
 * carrying only `count` would leave `expected.mailboxes` empty, and so would one
 * carrying `"mailboxes":{}` — which is a shape mail-backup.sh can really emit,
 * because its structural gate only checks that the key opens a brace. Either way
 * rule 3 has nothing to compare, and it now refuses to pass on that rather than
 * iterating zero times; refusing HERE is better still, because it sends `main`
 * to the live fallback, which is exact in phase 1 and fails LOUDLY rather than
 * quietly in phase 2.
 */
export function parseManifest(text: string): DrillManifest {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("manifest is not an object");
  const o = parsed as { count?: unknown; mailboxes?: unknown };
  if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 0) {
    throw new Error("manifest has no integer `count`");
  }
  if (!o.mailboxes || typeof o.mailboxes !== "object") {
    throw new Error("manifest has no `mailboxes` object; a per-mailbox comparison "
      + "against nothing would fail every mailbox of a healthy restore");
  }
  const mailboxes: Record<string, number> = {};
  for (const [name, n] of Object.entries(o.mailboxes as Record<string, unknown>)) {
    if (typeof n !== "number" || !Number.isInteger(n)) {
      throw new Error(`manifest mailbox ${JSON.stringify(name)} has no integer total`);
    }
    mailboxes[name] = n;
  }
  if (Object.keys(mailboxes).length === 0) {
    throw new Error("manifest carries no mailbox totals at all; a per-mailbox comparison "
      + "against nothing is not a comparison");
  }
  return { count: o.count, mailboxes };
}

// --- printing ------------------------------------------------------------------

function printReport(f: DrillFacts, verdict: { ok: boolean; reasons: string[] }): void {
  const row = (label: string, v: string | number) =>
    console.log(`  ${label.padEnd(26)}${String(v).padStart(12)}`);

  console.log(`\nmail-drill: ${f.archive}`);
  console.log(`\nwhat the restored store holds (expected figures from the ${f.expected.source})`);
  row("messages restored", f.restored.total);
  row("messages expected", f.expected.total);
  row("mailboxes restored", Object.keys(f.restored.mailboxes).length);
  row("mailboxes expected", Object.keys(f.expected.mailboxes).length);

  console.log("\nbytes compared against the live store");
  for (const s of f.samples) {
    const same = s.restoredSha === s.liveSha;
    console.log(`  ${same ? "ok  " : "DIFF"} ${s.id.padEnd(16)}${String(s.bytes).padStart(9)} bytes `
      + `${s.restoredSha.slice(0, 16)}`);
  }
  if (f.samples.length === 0) console.log("  (nothing was sampled)");
  for (const line of f.sampleFailures) console.log(`  FAILED ${line}`);
  // The denominator, always. `2 compared` reads like a pass on its own; `2 of 8
  // positions asked for` is the sentence that makes a partial comparison
  // visible to somebody skimming a green log.
  console.log(`  ${f.samples.length} compared, ${f.requestedSamples} position(s) asked for`);

  console.log("\nthe tier-2 archive");
  if (f.tier2 === null) console.log("  nothing was reported");
  else if ("skipped" in f.tier2) console.log(`  skipped — ${f.tier2.skipped}`);
  else console.log(`  ${f.tier2.archive} — ${f.tier2.emails} message(s)`);

  console.log(`\nJMAP on the restored server: session=${f.jmap.session} `
    + `query=${f.jmap.query} get=${f.jmap.get}`);
  // Said every run, pass or fail: the one thing this drill deliberately does NOT
  // test is search, and a reader who does not know that will file the missing
  // check as a gap rather than as the recorded defect it is.
  console.log("  (search is NOT probed: Email/query filters return nothing on this store "
    + "in production too — a known defect, and not a backup defect)");

  if (verdict.ok) {
    console.log(`\nRESTORE DRILL PASSED — ${f.archive} restores into a store holding `
      + `${f.restored.total} message(s) that JMAP can read.`);
  } else {
    console.log("\nRESTORE DRILL FAILED");
    for (const r of verdict.reasons) console.log(`  - ${r}`);
  }
}

// --- entry point ---------------------------------------------------------------

/**
 * The failure notification, best-effort.
 *
 * WHAT IT CATCHES, stated correctly because an earlier version of this comment
 * asserted a mechanism that does not exist. `sendPush`'s default transport is
 * `realTransport()`, evaluated when the call is made, and it calls
 * `webpush.setVapidDetails` with VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, which
 * throws when they are absent or malformed. That throw is NOT synchronous:
 * `sendPush` is an `async function`, so an abrupt completion while its
 * parameter defaults are evaluated rejects the returned promise (verified in
 * node — a throwing default parameter on an async function yields a rejected
 * Promise, never a sync throw). Awaiting inside try/catch catches it either way,
 * which is the point: in the crash handler below an escaping VAPID complaint
 * would replace the real diagnosis — the failure this drill exists to report,
 * buried under a misconfiguration in the thing reporting it.
 */
async function pushFailure(db: Db, body: string): Promise<void> {
  try { await sendPush(db, { title: "Mail restore drill FAILED 🚨", body }); }
  catch (err) { console.error(`mail-drill: could not push — ${String(err)}`); }
}

/**
 * `MAIL_DRILL_SHELL_FAILURE` — the shell's OWN failures, routed through the one
 * row writer.
 *
 * THE HOLE THIS CLOSES, and it was the worst thing in the whole feature. Eight
 * paths in ops/mail-restore-drill.sh exit before this script is ever started: no
 * archive on the NAS, a scratch root pointing at the live store, a tar that
 * failed, an extracted tree with no `etc/config.json`, a missing `data/` or
 * `blobs/`, a container that would not start, a container that never became
 * healthy. Two of those ARE the drill's headline result — "this archive cannot
 * restore" — and every one of them recorded NOTHING: no `worker_runs` row, no
 * push. The dashboard reads `SELECT DISTINCT ON (worker) … ORDER BY ran_at DESC`,
 * so the newest row stays last month's `ok` and the `monthly` rule keeps calling
 * it healthy for 35 days. The single most important outcome a restore drill can
 * produce would have lived only in a cron log.
 *
 * So the shell hands its verdict back rather than owning a second writer: it
 * re-invokes this script with the reason in an environment variable, and the row
 * and the push are written HERE, in the same shape a judged failure writes them.
 * One row format, one push, one place that knows the worker's name.
 */
export function shellFailureFrom(env: NodeJS.ProcessEnv): string | null {
  const v = (env.MAIL_DRILL_SHELL_FAILURE ?? "").trim();
  return v === "" ? null : v;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  const probeErrors: { where: string; message: string }[] = [];
  try {
    // BEFORE anything else, including mailEnvFrom: the shell calls this way
    // precisely when the drill never got far enough to have an environment worth
    // reading, and a MailEnvError here would replace "the archive has no
    // etc/config.json" with a complaint about JMAP_USER.
    const shellFailure = shellFailureFrom(process.env);
    if (shellFailure) {
      const archive = (process.env.MAIL_DRILL_ARCHIVE ?? "").trim() || "(archive not named)";
      console.error(`mail-drill: the drill script failed before the restore could be `
        + `judged — ${shellFailure}`);
      /*
       * EXIT 0 ON A RECORDED FAILURE, AND THIS IS NOT A TYPO. IT WAS MEASURED.
       *
       * On this path the script is not judging a restore — the shell already
       * judged it and the drill has already failed. The ONLY thing this
       * invocation does is write the row and send the push, and the only
       * consumer of its exit code is `drill_fail` in ops/mail-restore-drill.sh,
       * whose question is precisely "did you manage to record it?". The shell
       * does its own `exit 1` immediately afterwards, so the drill still fails.
       *
       * Exiting 1 here — which is what the first version did — answers a
       * question nobody asked and answers it wrongly. MEASURED on the homelab
       * 2026-09-01 by drilling a deliberately truncated snapshot: the row was
       * written correctly (`mail-drill | error | native-TRUNCATED.tar.zst could
       * not be decompressed and extracted`) and the push went out, and the cron
       * log still said "AND the mail-drill failure row could not be recorded —
       * the dashboard tile still shows the PREVIOUS run". That message is a lie
       * told on the one occasion the operator most needs the truth: it sends
       * them hunting a monitoring bug that does not exist, and teaches them to
       * distrust a tile that is correctly red. A failure path that misreports
       * itself is worse than one that is merely loud.
       *
       * So: 0 means recorded, non-zero means the recording itself failed and the
       * cron log really is the only witness. A throw from recordRun or a crash
       * still reaches the catch below, which sets exitCode 1 — which is exactly
       * the case the shell's warning is written for.
       */
      await recordRun(db, DRILL_WORKER, "error",
        { archive, shellFailure, ok: false, reasons: [shellFailure] });
      await pushFailure(db, `${archive}: ${shellFailure}`);
      await pool.end();
      // `process.exit` and not a fall-through: everything below assumes a
      // restored server to talk to, and there is not one.
      process.exit(0);
    }
    // The LIVE side comes from the ordinary worker environment, read through the
    // one factory that builds it — empty-is-missing, one trailing slash, the
    // same credential the scheduled poll authenticates with. The restored side
    // reuses that credential DELIBERATELY: the restore is a byte copy, so the
    // directory and the app password come back with it, and the fact that the
    // scratch server ACCEPTS them is itself one of the things being proven.
    const env = mailEnvFrom(process.env);
    const restoredBase = (process.env.MAIL_DRILL_BASE_URL ?? "").trim().replace(/\/$/, "");
    if (!restoredBase) {
      throw new Error("MAIL_DRILL_BASE_URL is missing or empty; it must name the RESTORED "
        + "scratch server (http://stalwart-drill:8080), never the live one");
    }
    const auth = basic(env.user, env.appPassword);

    // A manifest that is named and unreadable FALLS BACK LOUDLY rather than
    // failing. The fallback can only ever make the comparison STRICTER — live
    // moves ahead of a snapshot, never behind it — so the worst it can do is
    // fail a good restore noisily, never pass a bad one quietly. The error is
    // recorded so a manifest that silently stopped being written is visible.
    let manifest: DrillManifest | null = null;
    const manifestPath = (process.env.MAIL_DRILL_MANIFEST ?? "").trim();
    if (manifestPath) {
      try { manifest = parseManifest(readFileSync(manifestPath, "utf8")); }
      catch (err) {
        probeErrors.push({ where: "manifest", message: String(err) });
        console.error(`mail-drill: manifest ${manifestPath} is unusable (${String(err)}) — `
          + "falling back to the LIVE store's own counts");
      }
    }

    const facts = await collectFacts({
      restoredBase, liveBase: env.baseUrl, auth,
      archive: (process.env.MAIL_DRILL_ARCHIVE ?? "").trim() || "(archive not named)",
      samples: parseSampleCount(process.env.MAIL_DRILL_SAMPLES),
      manifest, tier2: parseTier2(process.env.MAIL_DRILL_TIER2),
      onProbeError: (where, err) => {
        probeErrors.push({ where, message: String(err) });
        console.error(`mail-drill: ${where} failed — ${String(err)}`);
      },
    });

    const verdict = judgeDrill(facts);
    printReport(facts, verdict);

    // ONE row, whatever happened. The drill's whole value is that a month with
    // no row is as loud as a red one.
    await recordRun(db, DRILL_WORKER, verdict.ok ? "ok" : "error", {
      ...facts, ok: verdict.ok, reasons: verdict.reasons, probeErrors,
    });

    // A GREEN MONTH IS SILENT. The push exists to interrupt someone, and a
    // notification that arrives when nothing is wrong teaches its reader to
    // dismiss the one that matters. It is written in English rather than the
    // app's Dutch on purpose: the body is `reasons`, which are the machine's own
    // engineering statements about a backup, and a Dutch title over English
    // reasons would be politeness pretending to be a translation.
    if (!verdict.ok) {
      await pushFailure(db, `${facts.archive}: ${verdict.reasons.join(" · ")}`);
    }
    process.exitCode = verdict.ok ? 0 : 1;
  } catch (err) {
    // A crash before a verdict is still a failed drill, so it gets the same row
    // and the same push — silence is the outcome this whole task exists to
    // prevent. The message carries no credential: mailEnvFrom, jmap-client and
    // this file all refuse to name one, and worker_runs.detail is rendered on
    // the dashboard and dumped off-box every night.
    console.error(`mail-drill: crashed — ${String(err)}`);
    await recordRun(db, DRILL_WORKER, "error",
      { message: String(err), probeErrors }).catch(() => {});
    await pushFailure(db, String(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
