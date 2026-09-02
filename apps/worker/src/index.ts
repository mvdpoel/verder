import { readFile } from "node:fs/promises";
import PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";
import { pollGmail } from "./gmail";
import { realGmailPort } from "./gmail-auth";
import { readCursor, writeCursor } from "./mail/cursor";
import { openMailPort } from "./mail/from-env";
import { MAIL_WORKER, pollMail } from "./mail/poll";
import { makeSingleFlight } from "./mail/single-flight";
import { realLlmPort, suggestDocMeta, suggestEntry } from "./ollama";
import { realRetrieveRefs } from "./retrieval-refs";
import { scanNasFolder } from "./nas";
import { makeEnqueueGuard, pendingDocMeta } from "./docmeta-sweep";
import { storeDocumentText } from "./document-text";
import { autoNameSafely } from "./auto-name";
import { mineRegistry } from "./registry-mine";
import { suggestTask } from "./task-mine";
import { resolveAggregator } from "./receipts";
import { sendPush } from "./push";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { drainOnce } from "./search-drain";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
export const { db } = createDb(url);
const boss = new PgBoss(url);

boss.on("error", (err) => { void recordRun(db, "pg-boss", "error", { message: String(err) }); });

await boss.start();
await boss.createQueue("heartbeat");
await boss.schedule("heartbeat", "*/5 * * * *");
await boss.work("heartbeat", async () => { await recordRun(db, "heartbeat", "ok"); });
// Tasks 16–19 append their queues, schedules and workers below this line.

await boss.createQueue("gmail.poll");
await boss.createQueue("suggest.entry");
// RESUMED 2026-09-02, at `*/15` and NOT the `*/3` it stopped at.
//
// STOPPED 2026-08-29, and the history is the reason for the cadence. The account
// sat in an account-level rate limit that EVERY attempt re-armed for another
// fifteen minutes, so a 3-minute cron could never let it expire — measured at
// 378 rate-limited skips in 24 hours, last successful poll 00:07.
//
// WHY IT IS BACK. Phase 1 moved ingestion to JMAP, which was true and did not
// help: Stalwart holds the imported ARCHIVE and receives no new mail, because
// the MX still points at Gmail. Measured 2026-09-02 — the newest message in the
// dossier was 2026-08-28, five days stale, during an active bewindvoering with
// live Verder correspondence. "Ingestion is back" was a statement about a path,
// not about mail arriving. So this is a deliberate BRIDGE until phase 3 moves
// the MX, not a reversal of the JMAP decision: both pollers run, and they cannot
// duplicate each other because the Gmail path dedups on `gmail_message_id` and
// the JMAP path on RFC 5322 `Message-ID`, which is what migrations 0030/0031
// exist for.
//
// THE TWO THINGS THAT MADE IT SAFE, both measured before this line was
// uncommented:
//  1. THE BURN IS FIXED. The lockout was self-inflicted: pollGmail called
//     getMessage on EVERY id BEFORE testing relevance, so a few hundred
//     commercial mails were re-fetched in full, twice each, every three minutes,
//     at a hit rate near zero. `buildQueries` now filters server-side, so a tick
//     costs one `messages.list` plus gets for genuinely new case mail only.
//  2. THE LOCKOUT HAD LIFTED. Nothing touched the API for 3 d 19 h after the
//     last skip (retryAfter 2026-08-29T11:54Z), and a read-only probe then got
//     `users.getProfile` AND `users.messages.list` answered — the 5-unit call
//     that was refused throughout the lockout. A single hand-run poll ingested
//     9 messages with no 429.
//
// `*/15` rather than `*/3` because the old cadence is precisely what made the
// limit inescapable: `rateLimitedUntil` skipped the window correctly and then
// the first tick past the deadline polled at full speed and bought another
// fifteen minutes. With the burn fixed that loop should not exist at all, but
// the poll is now the cheap half of a bridge and case mail does not need
// three-minute latency — 15 minutes leaves a wide margin against the one failure
// mode this poller has ever had.
//
// NOTE removing this call does NOT delete an existing row in `pgboss.schedule`
// (that was done separately when it stopped), and adding it back is what
// recreates the row. `boss.send("gmail.poll")` still runs one poll by hand.
await boss.schedule("gmail.poll", "*/15 * * * *");
await boss.work("gmail.poll", async () => {
  const gmail = await realGmailPort();
  await pollGmail({ db, gmail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); } });
});

// The JMAP poll that replaces the one above. Every minute, where Gmail's `*/3`
// was already too fast for it: `Email/changes` answers "what changed since this
// state" and returns a DELTA, so a tick over a quiet mailbox costs one request
// that names nothing, where Gmail's window re-listed and re-fetched the same
// mail forever. Stalwart is Martin's own server on the same host — no third
// party, no per-account quota, no rate limit that a tick can re-arm for another
// fifteen minutes — so the cost of polling more often is a loopback round trip,
// and the benefit is that a beschikking is in the dossier a minute after it
// lands rather than three.
//
// THE HONEST LIMIT while phase 1 stands: no new mail reaches Stalwart yet — the
// MX still points at Gmail and gmail.poll is unscheduled — so these ticks find
// an empty delta and what they actually do is run repairSuggestOutbox, which
// keeps the review queue fed for emails that committed while pg-boss was
// unreachable. That is worth a minute's cron on its own, and the schedule is
// written now precisely so phase 2 (the MX cutover) is a DNS change and not a
// worker change: the day mail starts arriving, this is already polling for it.
const mailPoll = makeSingleFlight();
await boss.createQueue("mail.poll");
await boss.schedule("mail.poll", "* * * * *");
await boss.work("mail.poll", async () => {
  // One poll at a time. A poll can outlast its minute — a slow Stalwart, a
  // large delta, a request held open until its timeout — and two polls that
  // start on the SAME cursor both ask what changed since it and both write a
  // state back, so one of them either loses its delta or ingests it twice. A
  // skipped tick costs one minute; an overlapped one corrupts the cursor — and
  // a lost delta is mail that silently never reaches the dossier, because
  // Email/changes hands an id over ONCE and will not offer it again.
  await mailPoll.run(async () => {
    // The port is built PER TICK, not once at startup. openMailPort fetches a
    // JMAP session with the app password on every call, so a rotated credential
    // or a restarted Stalwart heals on the next tick instead of needing a
    // worker restart to notice — and a session cached at startup would be a
    // 401 an hour after a rotation with no obvious cause. The cost is one extra
    // HTTP round trip a minute to a server on the same host, which is nothing.
    //
    // AND THE PRICE OF BUILDING IT HERE is that this one call sits inside the
    // single flight but outside every piece of recording pollMail does. A
    // MailEnvError from a missing or mistyped JMAP_* variable, a Stalwart that
    // refuses the session fetch, a 401 after an app-password rotation — each
    // throws straight out of the job handler and writes NO "mail" row at all,
    // while dashboard.ts selects DISTINCT ON (worker) and keeps rendering the
    // last `ok` forever with ingestion dead. poll.ts states the invariant in its
    // own comments — every failure path writes a worker_runs row, because
    // worker_runs is the only place mail failure is visible — and this is the
    // single call site that could break it. It is not hypothetical:
    // JMAP_APP_PASSWORD is not in .env.prod yet, so the first tick after deploy
    // takes exactly this path.
    //
    // THE READ-THEN-WRITE HERE IS NOT MADE SAFE BY THE SINGLE FLIGHT, which is
    // what this comment used to claim. makeSingleFlight is a PER-PROCESS latch
    // and says so in its own docstring, and ops/mail-first-sync.ts is documented
    // to run as a SECOND process against the same database (`docker compose
    // exec worker pnpm --filter worker mail-first-sync`). The latch does not
    // span them, so "no other poll can be committing a row between the read and
    // the write" was simply false.
    //
    // What IS true, stated without overclaiming in the other direction: the only
    // other writer of `mail` rows is that hand-run script, so the whole of the
    // rule is that the two must not run at the same time — and the reason is
    // sharper than a cursor lost between this read and this write. A SCHEDULED
    // REFUSAL ROW CARRIES NO CURSOR AT ALL: pollMail's outer catch writes back
    // the cursor it read, and on the no-cursor refusal that is null. So a tick
    // that started before the script finished, refused, and commits its row
    // just after the script writes the cursor it spent an hour earning leaves
    // readCursor answering null again — and the next tick refuses a first sync
    // it is never allowed to perform, permanently, with the ingest it just paid
    // for invisible.
    //
    // Hence the runbook ordering, which is where this is actually enforced: the
    // first sync runs BEFORE the schedule is live — a one-shot `docker compose
    // run --rm` against the newly built image, before `up -d worker` — so there
    // is no scheduled tick to race. docs/deploy.md §8.11 carries that ordering.
    //
    // Only openMailPort is wrapped — pollMail records its own error row and
    // re-throws, and a second catch around it would write a duplicate run for
    // one failure.
    let mail;
    try {
      mail = await openMailPort(process.env);
    } catch (err) {
      await writeCursor(db, MAIL_WORKER, await readCursor(db, MAIL_WORKER),
        { message: String(err) }, "error");
      throw err;
    }
    // THE GUARD AGAINST AN UNATTENDED FULL SYNC IS THIS FLAG — the FIRST-SYNC
    // one, and only that one; the delta door below is a different mechanism and
    // this flag never sees it. It used to be arithmetic. The argument written
    // here before was that the port's
    // DEFAULT_LIMITS cap a first sync at 100 × 500 = 50 000 while Stalwart holds
    // 146 270, so a resync would overflow and fail loudly and cheaply. True
    // today, and true only BY COINCIDENCE OF MAILBOX SIZE — nothing asserts it.
    // Point this poll at a store under 50 000 (a partial Vandelay import, a
    // restored subset, a rebuilt mailbox) and the first cron tick after
    // `up -d worker` completes a full first sync unattended, appending one
    // `document.ingested` ledger event per attachment of every relevant message
    // on tables with no DELETE grant, straight past the preview-and-authorise
    // ceremony ops/mail-first-sync.ts exists to impose.
    //
    // allowFirstSync: false says the policy instead of deriving it: this caller
    // polls deltas and nothing else, at any mailbox size. The limits are KEPT as
    // a second backstop, but they are no longer what is doing the protecting.
    //
    // AND A DELTA IS NOT AUTOMATICALLY SMALL, which the flag alone cannot say.
    // Once the first sync has written a cursor, anything imported into Stalwart
    // afterwards — a re-import, a restored subset, a second Vandelay pass,
    // phase 2 starting to deliver real mail — comes back as an ordinary delta
    // with a valid cursor, and the port hands over up to 10 000 ids in one poll.
    // That is closed by MAIL_MAX_DELTA inside pollMail (a tripwire, not a rate:
    // see MailDeltaTooLargeError), and this caller takes its default. Both
    // refusals HOLD the cursor and both name the same recovery in the run row:
    // `pnpm --filter worker mail-first-sync`, which raises the limits
    // deliberately and behind a preview, because ingestion is irreversible.
    return pollMail({ db, mail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
      allowFirstSync: false,
      enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); } });
  });
  // NOTHING IS WRITTEN ON A SKIP, deliberately, and both reasons matter.
  //
  // The first is a race. The mail cursor lives in the LATEST worker_runs row for
  // "mail", so any row written here has to carry it forward — and reading it to
  // carry it forward is a read-then-write against a poll that is running RIGHT
  // NOW on another tick: it can commit its own row between the read and the
  // write, leaving the skip row newest with the OLDER cursor. The severe case is
  // the resync — the in-flight poll replaced a REJECTED cursor with a fresh one,
  // the skip re-installs the rejected one, and every following tick dies on it.
  // Any correct version of "carry the cursor forward" from here would have to be
  // atomic with its read; the cheapest correct version is to write nothing, and
  // let the in-flight poll's own row — which it always writes, and later — be
  // the newest.
  //
  // The second is that a green skip row is actively MISLEADING. A poll hung on a
  // JMAP request with no timeout would emit a healthy-looking `ok` row every
  // minute for as long as it hangs, which is the most convincing possible
  // picture of a mail path that is working. Writing nothing makes the newest
  // "mail" run go STALE instead, and staleness is the honest signal for "a poll
  // is stuck" — it is what an operator should be looking at. docs/deploy.md
  // documents exactly that: if the newest `mail` run is more than a few minutes
  // old, a poll is hung and the single flight is skipping ticks.
});

const llm = realLlmPort();

// Naming has its OWN endpoint and model. The M3 runs qwen3.8, which the
// homelab's ollama 0.18.3 cannot load, and the homelab GPU is already
// oversubscribed — but the default falls back to the worker's own OLLAMA_URL
// so a machine that is asleep degrades to "not renamed", never to a failure.
const NAME_OLLAMA = process.env.NORMALIZE_OLLAMA_URL ?? process.env.OLLAMA_URL
  ?? "http://localhost:11434";
const NAME_MODEL = process.env.NORMALIZE_MODEL ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
// One journal per worker boot; `normalize-names --undo` takes it by path.
const NAME_JOURNAL = `/journal/auto-name-${new Date().toISOString().slice(0, 10)}.jsonl`;

async function nameJson(prompt: string): Promise<unknown> {
  const res = await fetch(`${NAME_OLLAMA}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NAME_MODEL, messages: [{ role: "user", content: prompt }],
      format: "json", stream: false, think: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message: { content: string } };
  return JSON.parse(data.message.content) as unknown;
}
const retrieveRefs = realRetrieveRefs(db);

await boss.work("suggest.entry", async ([job]) => {
  const { rawEmailId } = job.data as { rawEmailId: string };
  await suggestEntry({ db, llm, sendPush, retrieveRefs }, rawEmailId);
  // Action-item mining rides along, error-isolated: suggestTask swallows its
  // own failures, and this guard makes sure a task-mine crash can never fail
  // (and re-run) the entry suggestion above.
  try { await suggestTask({ db, llm }, rawEmailId); }
  catch (err) { await recordRun(db, "task-mine", "error", { rawEmailId, message: String(err) }); }
});

await boss.createQueue("suggest.docmeta");
await boss.work("suggest.docmeta", async ([job]) => {
  const { documentId } = job.data as { documentId: string };
  const [doc] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  // Extract once, store it, and hand the same text to the docmeta prompt: the
  // text the model saw is the text the search index holds.
  const stored = await storeDocumentText({ db }, doc, buf);
  // Name it before suggesting metadata, so /queue shows the suggestion against
  // the name the document will actually have. Never throws: see autoNameSafely.
  await autoNameSafely({ db, nameLlm: nameJson, scanDir: process.env.NAS_SCAN_DIR ?? "/scans",
    journalPath: NAME_JOURNAL, log: (l) => console.log(l) }, documentId, stored.text);
  await suggestDocMeta({ db, llm, extractText: async () => stored.text, sendPush },
    documentId, buf);
});

await boss.createQueue("nas.scan");
await boss.schedule("nas.scan", "*/2 * * * *");
await boss.work("nas.scan", async () => {
  await scanNasFolder({ db, scanDir: process.env.NAS_SCAN_DIR ?? "/mnt/nas/scans",
    vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueDocMeta: async (documentId) => { await boss.send("suggest.docmeta", { documentId }); } });
});

// Extraction-coverage sweep: gmail.poll and documents.registerUpload cannot
// enqueue docmeta themselves (the web app holds no pg-boss connection), so the
// backlog is swept instead. Bounded per tick: each document costs an OCR pass
// and a 120 s LLM call, and the GPU is shared with the evals.
const DOCMETA_SWEEP_BATCH = 5;
// A document stays "pending" until its docmeta job writes document_texts, so
// without the guard every tick re-enqueues the batch that is still being worked
// on. See makeEnqueueGuard: enqueue rate is not drain rate.
const admitDocMeta = makeEnqueueGuard();
await boss.createQueue("docmeta.sweep");
await boss.schedule("docmeta.sweep", "* * * * *");
await boss.work("docmeta.sweep", async () => {
  const pending = await pendingDocMeta(db, DOCMETA_SWEEP_BATCH);
  const ids = admitDocMeta(pending, Date.now());
  for (const documentId of ids) await boss.send("suggest.docmeta", { documentId });
  // Both numbers, so a log that reads `pending: 5, enqueued: 0` is legible as
  // "the batch is still being worked" rather than as a stalled sweep.
  await recordRun(db, "docmeta-sweep", "ok", { pending: pending.length, enqueued: ids.length });
});

// Registry mining sweep: no direct enqueue from web — the cron sweeps all
// un-mined transactions (idempotent via suggestion-key dedup, matches the
// watcher architecture). receipts.resolve is consumed by Task 8; the queue
// exists already so aggregator candidates enqueue safely.
await boss.createQueue("registry.mine");
await boss.createQueue("receipts.resolve");
await boss.schedule("registry.mine", "*/2 * * * *");
await boss.work("registry.mine", async () => {
  await mineRegistry({ db, llm,
    enqueueResolve: async (suggestionId) => { await boss.send("receipts.resolve", { suggestionId }); } });
});

// Aggregator resolution: APPLE.COM/BILL and PayPal statement lines resolve
// into real subscriptions via targeted Gmail receipt searches.
await boss.work("receipts.resolve", async ([job]) => {
  const gmail = await realGmailPort();
  await resolveAggregator({ db, gmail, llm,
    vaultDir: process.env.VAULT_DIR ?? "./vault-files" },
    (job.data as { suggestionId: string }).suggestionId);
});

// Search index freshness: the fourteen triggers fill search_outbox and this is
// its only consumer. Every minute is pg-boss's finest cron granularity and the
// spec's 60 s target.
const embed = realEmbedPort();
await boss.createQueue("search.drain");
await boss.schedule("search.drain", "* * * * *");
await boss.work("search.drain", async () => {
  await drainOnce({ db, embed });
});

console.log("worker up");
