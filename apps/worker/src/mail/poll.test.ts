import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { createDb, schema } from "@verder/db";
import { ingestRawEmail } from "../gmail";
import { MAIL_MAX_DELTA, MAIL_WORKER, makeRepairBackoff, pollMail } from "./poll";
import { readCursor, writeCursor } from "./cursor";
import {
  MailCursorRejectedError, MailDeltaTooLargeError, MailFirstSyncRefusedError,
  type MailMessage, type MailPort,
} from "./port";
import { settleDocumentTexts } from "../test-support/document-texts";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const vault = () => mkdtempSync(join(tmpdir(), "jmap-vault-"));

/**
 * EVERY test gets its own worker name. worker_runs is shared, append-only and
 * never truncated, and readCursor takes the LATEST row for a name — so a test
 * that writes a fabricated cursor under the PRODUCTION name "mail" hands the
 * first real dev poll a literal test string, which the server answers with
 * cannotCalculateChanges. Ingestion then looks like a broken JMAP server rather
 * than like test residue. (34 such rows had to be deleted by hand.)
 */
const uniqueWorker = (tag: string) =>
  `mail-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function msg(id: string, over: Partial<MailMessage> = {}): MailMessage {
  return { id, threadId: "t1", from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
    subject: "Stukken aanleveren", sentAt: new Date(), bodyText: "Beste Martin",
    raw: Buffer.from(`raw-${id}`),
    // Per-fixture, exactly like the raw bytes: the Message-ID is an identity,
    // so two fixture messages sharing one would be two mails claiming to be the
    // same mail — the very thing the dedup reads it for.
    messageId: `${id}@fixture.invalid`,
    // Per-message bytes, exactly as gmail.test.ts's fixture does it. Sharing
    // one buffer across every fixture message made ingestDocument dedup them on
    // sha256, so the second message's "attachment" was really the first
    // message's document under the first message's source_ref — which is not
    // what two different mails carrying an attachment look like, and it made
    // the document unreachable from the id that supposedly delivered it.
    attachments: [{ filename: "a.pdf", mime: "application/pdf", data: Buffer.from(`pdf-${id}`) }],
    ...over };
}

/**
 * A port over a fixed set of messages. `headers` answers from the SAME fixtures
 * `getMessage` would return, which is what the real JMAP port does with a
 * properties-limited Email/get — and `gets` records which messages were
 * actually downloaded, because "was this blob fetched at all" is the thing
 * under test in the relevance case.
 */
function portOf(msgs: MailMessage[], cursor = "s2") {
  const gets: string[] = [];
  const port: MailPort = {
    changedSince: async () => ({ ids: msgs.map((m) => m.id), cursor }),
    headers: async (ids) => msgs.filter((m) => ids.includes(m.id))
      .map((m) => ({ id: m.id, from: m.from, to: m.to, messageId: m.messageId })),
    getMessage: async (id) => {
      gets.push(id);
      const m = msgs.find((x) => x.id === id);
      if (!m) throw new Error(`no fixture for ${id}`);
      return m;
    },
  };
  return { port, gets };
}

type TestDb = ReturnType<typeof createDb>["db"];

/**
 * A database whose Nth `select` explodes, and every other call is the real one.
 *
 * Finding G is about a failure BEFORE the run is recorded, so the failure has
 * to come from the same connection the run row is then written on — a second
 * fake `db` would prove nothing about the ordering inside pollMail.
 */
function dbFailingSelect(db: TestDb, nth: number, message: string): TestDb {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          if (++calls === nth) throw new Error(message);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TestDb;
}

/**
 * Mark every JMAP email still owing a suggest job as enqueued.
 *
 * The repair driver is GLOBAL — it asks the table, not the poll — so a test
 * that reasons about which rows fit in a batch has to start from a table with
 * no strangers in it. Residue from an earlier run of this very file is exactly
 * what would take the slot. Deliberately an UPDATE of the marker a successful
 * enqueue writes rather than a DELETE: raw_emails is append-only evidence and
 * no test gets a DELETE grant, the same discipline settleDocumentTexts follows.
 */
async function settleOwedJmapEmails(db: TestDb) {
  await db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
    .where(and(isNull(schema.rawEmails.suggestQueuedAt),
      eq(schema.rawEmails.source, "jmap")));
}

async function lastRun(db: ReturnType<typeof createDb>["db"], worker: string) {
  const [row] = await db.select().from(schema.workerRuns)
    .where(eq(schema.workerRuns.worker, worker))
    .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
  return row as { status: string; detail: Record<string, unknown> | null };
}

describe("pollMail", () => {
  it("ingests, stores the raw bytes in the vault and enqueues the suggestion", async () => {
    const { db, pool } = createDb(URL);
    const id = `j-${Date.now()}`;
    const worker = uniqueWorker("ingest");
    const enqueued: string[] = [];
    const { port } = portOf([msg(id)]);
    const r = await pollMail({ db, mail: port, vaultDir: vault(), worker,
      enqueueSuggest: async (x) => { enqueued.push(x); } });
    expect(r.ingested).toBe(1);
    const [row] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, id));
    expect(row.source).toBe("jmap");
    expect(enqueued).toContain(row.id);
    // Shared-dev-DB hygiene: msg() attaches a.pdf, so every run of this file
    // leaves documents behind on a database nothing truncates. pendingDocMeta
    // is ORDER BY created_at ASC LIMIT 50, so untreated fixture attachments
    // squat at the front of the sweep's page and eventually fail
    // docmeta-sweep.test.ts on a document it has just created. Settle what this
    // test ingested — the append-only way, writing the "none" row a failed
    // extraction would have written rather than deleting evidence.
    expect(await settleDocumentTexts(db, id)).toBe(1);
    await pool.end();
  });

  it("is idempotent on a re-run of the same id", async () => {
    const { db, pool } = createDb(URL);
    const id = `j-idem-${Date.now()}`;
    const { port } = portOf([msg(id)]);
    const deps = { db, mail: port, vaultDir: vault(), worker: uniqueWorker("idem"),
      enqueueSuggest: async () => {} };
    expect((await pollMail(deps)).ingested).toBe(1);
    expect((await pollMail(deps)).ingested).toBe(0);
    await settleDocumentTexts(db, id);
    await pool.end();
  });

  it("advances the cursor so the next poll asks only for changes", async () => {
    const { db, pool } = createDb(URL);
    const seen: (string | null)[] = [];
    const worker = uniqueWorker("advance");
    const p: MailPort = {
      changedSince: async (c) => { seen.push(c); return { ids: [], cursor: "s-next" }; },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await pollMail({ db, mail: p, vaultDir: vault(), enqueueSuggest: async () => {}, worker });
    await pollMail({ db, mail: p, vaultDir: vault(), enqueueSuggest: async () => {}, worker });
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("s-next");
    await pool.end();
  });

  // FINDING 14 + 15. Gmail's `newer_than:7d` window re-listed a failed id on the
  // next tick, which is what made per-message isolation safe. JMAP hands an id
  // over ONCE: advance the cursor past a message whose blob download 500'd and
  // that email is gone from the dossier forever, traced only by a detail field.
  // So a failure HOLDS the cursor — and the run says `error`, because
  // dashboard.ts reads the status COLUMN and nothing else.
  it("isolates a failing message, HOLDS the cursor and records the run as error", async () => {
    const { db, pool } = createDb(URL);
    const bad = `j-bad-${Date.now()}`, good = `j-good-${Date.now()}`;
    const worker = uniqueWorker("isolate");
    await writeCursor(db, worker, "s-held", { seeded: true });
    const { port } = portOf([msg(bad), msg(good)]);
    const failing: MailPort = { ...port,
      getMessage: async (id) => {
        if (id === bad) throw new Error("boom");
        return port.getMessage(id);
      } };
    const r = await pollMail({ db, mail: failing, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    expect(await readCursor(db, worker)).toBe("s-held");
    await settleDocumentTexts(db, good);
    await pool.end();
  });

  // FINDING 14, the first-sync half: there is no earlier cursor to hold, so the
  // run must record NO cursor at all — writing the new one would strand the
  // failed message exactly as advancing does.
  it("records no cursor when a first sync had a failure", async () => {
    const { db, pool } = createDb(URL);
    const bad = `j-first-bad-${Date.now()}`;
    const worker = uniqueWorker("firstfail");
    const { port } = portOf([msg(bad)]);
    const failing: MailPort = { ...port, getMessage: async () => { throw new Error("boom"); } };
    await pollMail({ db, mail: failing, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} });
    expect(await readCursor(db, worker)).toBeNull();
    await pool.end();
  });

  // FINDING 13, the blocker. pollGmail gates ingest twice — server-side in
  // buildQueries and again in-process — and pollMail had no gate at all. After
  // the Takeout import the first poll would walk years of commercial mail,
  // writing a raw_emails row, a vault file and a `document.ingested` LEDGER
  // EVENT per attachment. There is no DELETE grant: it is not undoable.
  //
  // The efficiency half matters as much: an irrelevant message must never have
  // its blobs downloaded, so the filter runs on batched headers and getMessage
  // is never reached.
  it("never ingests — or even downloads — a message from nobody in the case", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wanted = `j-rel-${stamp}`;
    const junk = `j-junk-${stamp}`;
    const { port, gets } = portOf([
      msg(wanted),
      msg(junk, { from: `deals@shop-${stamp}.example`, to: `promo@shop-${stamp}.example` }),
    ]);
    const r = await pollMail({ db, mail: port, vaultDir: vault(),
      worker: uniqueWorker("relevance"), enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    expect(gets).toEqual([wanted]);
    const junkRows = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, junk));
    expect(junkRows).toHaveLength(0);
    await settleDocumentTexts(db, wanted);
    await pool.end();
  });

  // FINDING 16. A Stalwart Email id is a different NAMESPACE from a Gmail
  // message id, so after the import every already-ingested email comes back
  // with a fresh id, misses the id lookup and gets a SECOND raw_emails row plus
  // a SECOND suggest.entry — a duplicate review-queue item for every historical
  // mail. Content is the second key. THE LAW: on a content match you SKIP, and
  // you NEVER rewrite the existing row's gmail_message_id — it is also
  // documents.source_ref and the case map's third level derives from it.
  //
  // FINDING I, on how this test is BUILT. The pre-existing row used to be
  // hand-written with `sha256Hex(bytes)`, which asserts that poll.ts's
  // `sha256Hex(msg.raw)` and the hash ingestRawEmail actually stores agree BY
  // CONSTRUCTION rather than by observation. They agree today — storage.ts runs
  // the same helper over the same buffer — but if storeFile ever normalised or
  // re-encoded before hashing, dedup would silently stop firing on real rows
  // and this test would stay green over it. So the historic email is INGESTED
  // through the real path, exactly as the ~50 Gmail-era emails were, and the
  // hash it is looked up by is READ BACK from that row instead of spelled here.
  it("skips a message whose bytes are already in the vault, without touching its id", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = vault();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const historicId = `m-gmail-${stamp}`;
    const jmapId = `j-again-${stamp}`;
    const bytes = Buffer.from(`raw-shared-${stamp}`);
    // skipSuggest, because a Gmail-era email's suggestion was owed and settled
    // long ago — the same marker ingestRawEmail writes for a receipt lookup.
    await ingestRawEmail({ db, vaultDir }, {
      id: historicId, threadId: "t-hist", from: "case@verdergroep.nl",
      to: "martin@vanderpoel.pro", subject: "Beschikking", sentAt: new Date(),
      bodyText: "", raw: bytes, attachments: [],
      // DELIBERATELY not the Message-ID the JMAP fixture below carries. What is
      // under test here is the sha256 path, and two fixtures sharing an
      // identity would let a dedup on that identity keep this test green while
      // the hash path had stopped working.
      messageId: `${historicId}@fixture.invalid`,
    }, { skipSuggest: true });
    const [historic] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, historicId));
    const enqueued: string[] = [];
    const worker = uniqueWorker("dedup");
    const { port } = portOf([msg(jmapId, { raw: bytes, attachments: [] })]);
    const r = await pollMail({ db, mail: port, vaultDir,
      worker, enqueueSuggest: async (x) => { enqueued.push(x); } });
    expect(r.ingested).toBe(0);
    const bySha = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.rawRfc822Sha256, historic.rawRfc822Sha256));
    expect(bySha).toHaveLength(1);
    expect(bySha[0].gmailMessageId).toBe(historicId);   // never rewritten
    expect(bySha[0].source).toBe("gmail");
    expect(enqueued).not.toContain(bySha[0].id);

    // FINDING 11, and the reason every assertion above it is not enough. They
    // are ALL satisfied by a poller that never dedups at all: verder_worker's
    // UPDATE on raw_emails is COLUMN-SCOPED to suggest_queued_at, so a poller
    // that "corrected" the historic row's gmail_message_id is refused by
    // Postgres, falls into the per-message catch, and leaves the row untouched
    // FOR THE WRONG REASON — a run recording status=error, duplicates=0 and
    // cursorHeld=true, with the message neither ingested nor deduped and the
    // cursor pinned. Measured: mutating poll.ts to rewrite the id left this
    // test green. The LAW is enforced by the grant, which is where it belongs;
    // what the test has to be able to see is that the poller RECOGNISED the
    // duplicate rather than crashed into the same outcome.
    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    expect(run.detail?.duplicates).toBe(1);
    expect(run.detail?.failures).toEqual([]);
    // A held cursor is the tell that the message failed rather than deduped: a
    // recognised duplicate is finished business and the delta may move past it.
    expect(run.detail?.cursorHeld).toBeUndefined();
    await pool.end();
  });

  // THE KEY THE OTHER TWO CANNOT REACH. A Stalwart Email id is a different
  // namespace from a Gmail message id, so the id lookup misses every email the
  // dossier already holds — and Takeout's mbox bytes are not the bytes Gmail's
  // API returned for the same message, so the sha256 key misses them too.
  // Measured on the archive: 130 relevant messages matching 0 of 107 existing
  // rows, i.e. ~114 permanent duplicate rows in an append-only table and ~114
  // redundant LLM jobs on a VRAM-starved GPU. The RFC 5322 Message-ID is
  // assigned by the ORIGINATING server and survives both export formats, which
  // is what makes it the identity that spans them.
  //
  // IT MUST FIRE BEFORE getMessage, and that is half the point: recognising the
  // duplicate only after its blobs have crossed the wire drags the whole
  // Gmail-era overlap through an 11.49 GB archive to throw it away again.
  it("skips a message the dossier holds under another id and other bytes", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = vault();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const historicId = `m-gmail-mid-${stamp}`;
    const jmapId = `j-mid-${stamp}`;
    // Normalised, i.e. exactly what normaliseMessageId hands back: the ingest
    // stores what the skip decision is made on, so a fixture wearing angle
    // brackets would be testing a value nothing ever compares.
    const shared = `case.${stamp}@verdergroep.nl`;
    // Ingested through the REAL path, exactly as the 107 Gmail-era rows were —
    // hand-writing the row would assert that ingestRawEmail records the
    // Message-ID by construction rather than by observation, and it recording
    // nothing is precisely the failure that leaves this dedup blind.
    await ingestRawEmail({ db, vaultDir }, {
      id: historicId, threadId: "t-hist", from: "case@verdergroep.nl",
      to: "martin@vanderpoel.pro", subject: "Beschikking", sentAt: new Date(),
      bodyText: "", raw: Buffer.from(`gmail-bytes-${stamp}`), attachments: [],
      messageId: shared,
    }, { skipSuggest: true });
    const [historic] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, historicId));
    expect(historic.messageId).toBe(shared);

    const enqueued: string[] = [];
    const worker = uniqueWorker("mid-dedup");
    // DIFFERENT BYTES ON PURPOSE. If the fixture reused the historic raw the
    // content hash would skip this message and the test would stay green with
    // the Message-ID path deleted — which is the whole case that actually
    // happens here, an mbox export of a message the API had already handed over.
    const { port, gets } = portOf([msg(jmapId, {
      raw: Buffer.from(`takeout-bytes-${stamp}`), attachments: [], messageId: shared })]);
    const r = await pollMail({ db, mail: port, vaultDir, worker,
      enqueueSuggest: async (x) => { enqueued.push(x); } });
    expect(r.ingested).toBe(0);
    // NOT EVEN DOWNLOADED — the assertion the ingest count cannot make.
    expect(gets).toEqual([]);

    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    expect(run.detail?.knownByMessageId).toBe(1);
    // Counted apart from the content-hash key, because the two answer different
    // questions and one number for both would hide either going blind.
    expect(run.detail?.duplicates).toBe(0);
    expect(run.detail?.failures).toEqual([]);
    // A held cursor is the tell that the message FAILED rather than deduped.
    expect(run.detail?.cursorHeld).toBeUndefined();

    // THE LAW, the same one the content-hash branch obeys: the existing row's
    // gmail_message_id is NEVER rewritten. It is also documents.source_ref, and
    // the case map's third level — the mail and its files hanging off a stop —
    // is derived from the equality of the two, so "correcting" it to the JMAP
    // id would silently unlink every attachment of that mail.
    const [after] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, historic.id));
    expect(after.gmailMessageId).toBe(historicId);
    expect(after.source).toBe("gmail");
    expect(enqueued).not.toContain(historic.id);
    await pool.end();
  });


  // THE SAME KEY, TURNED ON THE RUN ITSELF, and the case the batched lookup
  // above cannot see. `heldMessageIds` is a SNAPSHOT taken once before the
  // loop: it answers "what did raw_emails hold when this poll started", and a
  // second candidate carrying a Message-ID the FIRST candidate has just
  // ingested is not in it. The content hash behind it queries the database live
  // per message and so catches a same-bytes repeat inside one run — which makes
  // an un-updated snapshot strictly WEAKER than the key it fronts, rather than
  // a cheaper version of it.
  //
  // THE MAILBOX ACTUALLY LOOKS LIKE THIS. One mail delivered to two addresses
  // arrives as two Stalwart Emails with one Message-ID and different bytes
  // (different Received headers) — the exact reason schema.ts leaves the sha
  // index non-unique and the reason `findDuplicates` in backfill-message-ids
  // exists to report pairs. Without the mutation both are ingested: two
  // permanent rows in a table with no DELETE grant, two suggest.entry jobs on a
  // VRAM-starved GPU, and BOTH counters reporting 0, so there is no trace of it
  // anywhere.
  it("skips a second candidate carrying a Message-ID this same poll just ingested", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = vault();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const firstId = `j-run-a-${stamp}`;
    const secondId = `j-run-b-${stamp}`;
    // Normalised, as normaliseMessageId hands it back — the value the skip is
    // decided on, so a fixture in angle brackets would test nothing.
    const shared = `two.addresses.${stamp}@verdergroep.nl`;

    const worker = uniqueWorker("mid-in-run");
    // DIFFERENT BYTES ON PURPOSE, and this is the whole test: one mail
    // delivered twice differs in its Received headers, so the content hash
    // cannot see the pair and only the Message-ID can.
    const { port, gets } = portOf([
      msg(firstId, { raw: Buffer.from(`delivered-to-one-${stamp}`), attachments: [],
        messageId: shared }),
      msg(secondId, { raw: Buffer.from(`delivered-to-two-${stamp}`), attachments: [],
        messageId: shared }),
    ]);
    const enqueued: string[] = [];
    const r = await pollMail({ db, mail: port, vaultDir, worker,
      enqueueSuggest: async (x) => { enqueued.push(x); } });

    expect(r.ingested).toBe(1);
    // NOT EVEN DOWNLOADED — the assertion the ingest count cannot make, and the
    // one that fails against a snapshot that is never updated.
    expect(gets).toEqual([firstId]);
    // One row, not two, and it is the first candidate's: the second is skipped,
    // never merged into the first, exactly as the two dedup keys behind it
    // skip rather than rewrite.
    const rows = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.messageId, shared));
    expect(rows).toHaveLength(1);
    expect(rows[0].gmailMessageId).toBe(firstId);
    expect(enqueued).toHaveLength(1);

    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    // COUNTED APART FROM knownByMessageId, the same way the preview keeps
    // attachmentsRepeatedInRun apart from attachmentsAlreadyInVault. That
    // figure is the measured Gmail-era overlap with the DOSSIER (130 relevant
    // against 0 of 107 rows); a within-run repeat is a fact about the MAILBOX
    // and folding it in would inflate the one number this slice was measured
    // against with something that is not overlap at all.
    expect(run.detail?.messagesRepeatedInRun).toBe(1);
    expect(run.detail?.knownByMessageId).toBe(0);
    expect(run.detail?.duplicates).toBe(0);
    expect(run.detail?.failures).toEqual([]);
    // A recognised duplicate is finished business: the delta may move past it.
    expect(run.detail?.cursorHeld).toBeUndefined();
    await pool.end();
  });

  // A message carrying no Message-ID at all is unusual and perfectly legal, and
  // it must fall through to the content hash rather than be skipped — otherwise
  // the new key trades one blind spot for a worse one, silently dropping mail
  // the dossier does not hold.
  //
  // THE TRAP IT GUARDS. A lookup built as a Set of the values found in
  // raw_emails answers `has(null)` with true the moment ANY existing row has no
  // Message-ID recorded — which is every row until the backfill has run — so a
  // null candidate would be "recognised" by an unknown and never ingested. SQL
  // gets this right on its own (`NULL = NULL` is unknown); the Set does not, so
  // the existing row here also carries none.
  it("ingests a candidate with no Message-ID instead of matching it on nothing", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = vault();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const otherId = `m-nomid-${stamp}`;
    const newId = `j-nomid-${stamp}`;
    await ingestRawEmail({ db, vaultDir }, {
      id: otherId, threadId: "t-nomid", from: "case@verdergroep.nl",
      to: "martin@vanderpoel.pro", subject: "Zonder Message-ID", sentAt: new Date(),
      bodyText: "", raw: Buffer.from(`no-mid-existing-${stamp}`), attachments: [],
      messageId: null,
    }, { skipSuggest: true });

    const worker = uniqueWorker("mid-null");
    const { port, gets } = portOf([msg(newId, {
      raw: Buffer.from(`no-mid-new-${stamp}`), attachments: [], messageId: null })]);
    const r = await pollMail({ db, mail: port, vaultDir, worker,
      enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    // It reached the content-hash path, which is the only place a message with
    // no Message-ID can be judged at all.
    expect(gets).toEqual([newId]);
    const run = await lastRun(db, worker);
    expect(run.detail?.knownByMessageId).toBe(0);
    // THE TELL THAT THE KEY IS ALIVE AT ALL. jmap-port.ts asks for
    // `header:Message-ID:asText` and reads it back by exact string key, and
    // every test in this repo uses a fake that echoes that key verbatim —
    // docs/deploy.md says in terms that none of it has been measured against a
    // running Stalwart. A server that omits the property, or answers under
    // different casing, returns null for EVERY message and the whole dedup
    // becomes a silent no-op reporting `knownByMessageId: 0` — indistinguishable
    // from a genuinely disjoint mailbox. This counter is what separates them: on
    // ordinary mail "130 of 130 carry no Message-ID" is visibly impossible,
    // whereas a zero overlap is not.
    expect(run.detail?.noMessageId).toBe(1);
    await pool.end();
  });

  // FINDING 17. The outbox repair was written for the crash between the ingest
  // committing and the enqueue returning. Under Gmail the 7-day window
  // re-listed the id and healed it; under JMAP the id was in `created`, the
  // cursor moved past it, and Email/changes never returns it again — so the
  // branch that heals it sits on a path that cannot be reached, and the email
  // stays out of the review queue forever. It needs its own driver.
  it("repairs an email whose suggest enqueue never landed, without re-discovering it", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [orphan] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `j-orphan-${stamp}`, gmailThreadId: "t-orphan",
      fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Stukken", sentAt: new Date(), rawRfc822Sha256: sha256Hex(`orphan-${stamp}`),
      bodyText: "", source: "jmap",
    }).returning();
    const enqueued: string[] = [];
    const empty: MailPort = {
      changedSince: async () => ({ ids: [], cursor: "s-empty" }),
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await pollMail({ db, mail: empty, vaultDir: vault(), worker: uniqueWorker("repair"),
      enqueueSuggest: async (x) => { enqueued.push(x); } });
    expect(enqueued).toContain(orphan.id);
    const [after] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, orphan.id));
    expect(after.suggestQueuedAt).not.toBeNull();
    await pool.end();
  });

  // The repair needs the database and pg-boss, not the mail server — so it must
  // not sit behind discovery. An unreachable Stalwart already stops new mail;
  // it must not also keep an email that is ALREADY in raw_emails out of the
  // review queue for as long as the outage lasts.
  it("repairs the outbox even when discovery fails", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [orphan] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `j-orphan-down-${stamp}`, gmailThreadId: "t-orphan",
      fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Stukken", sentAt: new Date(),
      rawRfc822Sha256: sha256Hex(`orphan-down-${stamp}`), bodyText: "", source: "jmap",
    }).returning();
    const enqueued: string[] = [];
    const down: MailPort = {
      changedSince: async () => { throw new Error("ECONNREFUSED"); },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db, mail: down, vaultDir: vault(),
      worker: uniqueWorker("repair-down"),
      enqueueSuggest: async (x) => { enqueued.push(x); } })).rejects.toThrow("ECONNREFUSED");
    expect(enqueued).toContain(orphan.id);
    await pool.end();
  });

  // A message destroyed between Email/changes and the header fetch is not an
  // irrelevant message, and a run row that calls it one hides a store that is
  // dropping mail behind a number that reads as normal housekeeping.
  it("counts a vanished message apart from an irrelevant one", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = uniqueWorker("counts");
    const junk = `j-junk-${stamp}`;
    const p: MailPort = {
      changedSince: async () => ({ ids: [junk, `j-gone-${stamp}`], cursor: "s2" }),
      headers: async () => [{ id: junk, from: `deals@shop-${stamp}.example`, to: "",
        messageId: `${junk}@shop.example` }],
      getMessage: async (id) => msg(id),
    };
    await pollMail({ db, mail: p, vaultDir: vault(), worker, enqueueSuggest: async () => {} });
    const run = await lastRun(db, worker);
    expect(run.detail?.scanned).toBe(2);
    expect(run.detail?.irrelevant).toBe(1);
    expect(run.detail?.vanished).toBe(1);
    await pool.end();
  });

  // FINDING 18. A cursor the SERVER rejects is not a transport failure, and
  // conflating them wedges ingestion permanently: readCursor keeps handing back
  // the same dead state, every poll dies on it, and nothing ever ingests again
  // — the same silent-permanent-stall that the Gmail rate-limit wedge was.
  it("falls back to a full resync when the server rejects the cursor", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("rejected");
    await writeCursor(db, worker, "dead-state", { seeded: true });
    const asked: (string | null)[] = [];
    const p: MailPort = {
      changedSince: async (c) => {
        asked.push(c);
        if (c !== null) throw new MailCursorRejectedError(c);
        return { ids: [], cursor: "s-fresh" };
      },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await pollMail({ db, mail: p, vaultDir: vault(), worker, enqueueSuggest: async () => {} });
    expect(asked).toEqual(["dead-state", null]);
    expect(await readCursor(db, worker)).toBe("s-fresh");
    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    expect(run.detail?.resynced).toBe(true);
    await pool.end();
  });

  // Once a resync has happened the old cursor is the one the SERVER refused, so
  // a later failure in the same poll must not write it back: storing a
  // known-dead state means every following poll dies on it and resyncs again,
  // which is the wedge finding 18 exists to remove wearing a different hat.
  it("never writes back a cursor the server already rejected", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("rejected-then-down");
    await writeCursor(db, worker, "dead-state", { seeded: true });
    const p: MailPort = {
      changedSince: async (c) => {
        if (c !== null) throw new MailCursorRejectedError(c);
        return { ids: ["e1"], cursor: "s-fresh" };
      },
      headers: async () => { throw new Error("ETIMEDOUT"); },
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} })).rejects.toThrow("ETIMEDOUT");
    expect(await readCursor(db, worker)).toBeNull();
    await pool.end();
  });

  // The other half of finding 18, and the one that would be a worse bug than
  // the one being fixed: a socket blip must NOT drop a healthy cursor and
  // re-walk the whole mailbox.
  it("keeps the cursor and does not resync on a transport failure", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("transport");
    await writeCursor(db, worker, "s-healthy", { seeded: true });
    const asked: (string | null)[] = [];
    const p: MailPort = {
      changedSince: async (c) => { asked.push(c); throw new Error("ECONNRESET"); },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} })).rejects.toThrow("ECONNRESET");
    expect(asked).toEqual(["s-healthy"]);
    expect(await readCursor(db, worker)).toBe("s-healthy");
    expect((await lastRun(db, worker)).status).toBe("error");
    await pool.end();
  });

  // FINDING G. Every other failure path writes a worker_runs row: discovery
  // failure writes an error run, the normal path writes on success. The outbox
  // repair ran BETWEEN readCursor and the try, so a repair that threw
  // propagated out of pollMail with NOTHING recorded anywhere — and
  // docs/deploy.md tells the operator that worker_runs is the only place mail
  // failure is visible. A path that deliberately writes nothing there is the
  // wrong shape: the health tile stays green while nothing ingests.
  it("records an error run when the outbox repair itself throws", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("repair-throws");
    // readCursor's SELECT is the first of the poll; the repair's is the second.
    const failing = dbFailingSelect(db, 2, "repair select exploded");
    const empty: MailPort = {
      changedSince: async () => ({ ids: [], cursor: "s-empty" }),
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db: failing, mail: empty, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} })).rejects.toThrow("repair select exploded");
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    expect(String(run.detail?.message)).toContain("repair select exploded");
    await pool.end();
  });

  // FINDING H. The repair query is `suggest_queued_at IS NULL AND source='jmap'
  // ORDER BY fetched_at ASC LIMIT N`, and a failed row is deliberately left
  // NULL so the next poll retries it. With no per-row backoff a row that can
  // NEVER be enqueued sits at the head of that ORDER BY forever; once N of them
  // accumulate, a newly ingested email whose enqueue crashed never reaches the
  // review queue — the exact loss the repair exists to prevent, wearing the
  // batch bound as a hat. pendingDocMeta converges because storeDocumentText
  // writes a row for EVERY attempt including the failures; this driver has no
  // such marker, so the backoff is the marker.
  it("backs a permanently failing row off so it cannot starve a newer one", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = uniqueWorker("repair-backoff");
    await settleOwedJmapEmails(db);
    const owed = async (tag: string, fetchedAt: Date) => {
      const [row] = await db.insert(schema.rawEmails).values({
        gmailMessageId: `j-${tag}-${stamp}`, gmailThreadId: `t-${tag}`,
        fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
        subject: "Stukken", sentAt: new Date(),
        rawRfc822Sha256: sha256Hex(`${tag}-${stamp}`), bodyText: "",
        source: "jmap", fetchedAt,
      }).returning();
      return row;
    };
    // The poison row is the OLDER one, which is what puts it at the head of the
    // batch every single poll.
    const poison = await owed("poison", new Date(Date.now() - 3_600_000));
    const fresh = await owed("fresh", new Date());
    const attempted: string[] = [];
    const enqueued: string[] = [];
    const empty: MailPort = {
      changedSince: async () => ({ ids: [], cursor: "s-empty" }),
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    // Batch of one, which is the whole point: with the poison row taking the
    // only slot on every poll, the fresh email never gets one.
    const deps = { db, mail: empty, vaultDir: vault(), worker, repairBatch: 1,
      enqueueSuggest: async (id: string) => {
        attempted.push(id);
        if (id === poison.id) throw new Error("pg-boss refused this row");
        enqueued.push(id);
      } };
    await pollMail(deps);
    expect(attempted).toEqual([poison.id]);
    await pollMail(deps);
    // The poison row is NOT retried this minute, and the batch it was eating
    // goes to the email that is actually waiting for the review queue.
    expect(attempted).toEqual([poison.id, fresh.id]);
    expect(enqueued).toEqual([fresh.id]);
    const run = await lastRun(db, worker);
    expect(run.detail?.repairDeferred).toBe(1);
    // Leave the shared dev database as we found it: the poison row would
    // otherwise be permanent residue at the head of the real repair's page.
    await db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
      .where(eq(schema.rawEmails.id, poison.id));
    await pool.end();
  });

  // FINDING F, the visible half. An entry the address filter had to throw away
  // — a party row with a space in the email column, or the mailbox owner's own
  // address that docs/deploy.md's backfill command widens RELEVANT_SENDERS with
  // — is a filter quietly not doing what its operator thinks it does. Under
  // JMAP it is the ONLY gate, so it belongs in the one place mail health is
  // visible rather than in nobody's head.
  it("records the filter entries it refused", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("filter-report");
    const before = process.env.RELEVANT_SENDERS;
    const beforeOwn = process.env.MAIL_OWN_ADDRESSES;
    process.env.RELEVANT_SENDERS = " , @verdergroep.nl, martin@vanderpoel.pro";
    process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
    try {
      const empty: MailPort = {
        changedSince: async () => ({ ids: [], cursor: "s-empty" }),
        headers: async () => [],
        getMessage: async (id) => msg(id),
      };
      await pollMail({ db, mail: empty, vaultDir: vault(), worker,
        enqueueSuggest: async () => {} });
      const run = await lastRun(db, worker);
      const rejected = run.detail?.rejectedAddresses as { value: string; reason: string }[];
      expect(rejected).toContainEqual({ value: " ", reason: "malformed" });
      expect(rejected).toContainEqual({
        value: "martin@vanderpoel.pro", reason: "own-mailbox" });
    } finally {
      if (before === undefined) delete process.env.RELEVANT_SENDERS;
      else process.env.RELEVANT_SENDERS = before;
      if (beforeOwn === undefined) delete process.env.MAIL_OWN_ADDRESSES;
      else process.env.MAIL_OWN_ADDRESSES = beforeOwn;
      await pool.end();
    }
  });

  // THE UNATTENDED CALLER MAY NOT START A FIRST SYNC, and until now nothing
  // said so. The scheduled poll was protected only by DEFAULT_LIMITS — 100
  // pages x 500 = 50 000 against a store holding 146 270 — so the protection
  // was an ARITHMETIC ACCIDENT of how much mail happens to be in Stalwart
  // today. Point the same poll at a store under 50 000 (a partial Vandelay
  // import, a restored subset, a rebuilt mailbox) and the first cron tick after
  // `up -d worker` walks the entire archive unattended, appending one
  // `document.ingested` LEDGER EVENT per attachment on tables with no DELETE
  // grant — bypassing the preview-and-authorise ceremony ops/mail-first-sync.ts
  // exists to impose. The flag is the policy said out loud, and it holds
  // whatever size the mailbox is.
  it("refuses a first sync outright when the caller may not enumerate the mailbox", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("no-first-sync");
    const asked: (string | null)[] = [];
    const p: MailPort = {
      changedSince: async (c) => { asked.push(c); return { ids: [], cursor: "s-fresh" }; },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker, allowFirstSync: false,
      enqueueSuggest: async () => {} })).rejects.toThrow(MailFirstSyncRefusedError);
    // The enumeration is never even ASKED FOR. Asserting on the ingest count
    // would pass against a poll that walked the whole mailbox and found nothing
    // relevant, which is the expensive half of what is being refused.
    expect(asked).toEqual([]);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    // The recovery is named in the row, because worker_runs is the only place
    // mail failure is visible and "refused" without a cure is just a wedge.
    expect(String(run.detail?.message)).toContain("mail-first-sync");
    // No cursor invented on the way out: there was none to carry.
    expect(await readCursor(db, worker)).toBeNull();
    await pool.end();
  });

  // The same policy on the other door into a full enumeration. FINDING 18's
  // resync is the RIGHT recovery for a rejected cursor — for a human running
  // mail-first-sync. For the cron it is the identical irreversible walk with
  // nobody watching, so the refusal replaces it and the run goes red every
  // minute until someone runs the script by hand.
  it("refuses to resync a rejected cursor when the caller may not enumerate", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("no-resync");
    await writeCursor(db, worker, "dead-state", { seeded: true });
    const asked: (string | null)[] = [];
    const p: MailPort = {
      changedSince: async (c) => {
        asked.push(c);
        if (c !== null) throw new MailCursorRejectedError(c);
        return { ids: [], cursor: "s-fresh" };
      },
      headers: async () => [],
      getMessage: async (id) => msg(id),
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker, allowFirstSync: false,
      enqueueSuggest: async () => {} })).rejects.toThrow(MailFirstSyncRefusedError);
    expect(asked).toEqual(["dead-state"]);          // never a changedSince(null)
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    // The dead cursor is KEPT rather than dropped. It is the state the server
    // named as unresolvable, and holding it means every following tick fails
    // the same loud way; dropping it would leave readCursor answering null,
    // which is a first sync refused for a DIFFERENT reason and loses the one
    // piece of evidence about what the server actually refused.
    expect(await readCursor(db, worker)).toBe("dead-state");
    await pool.end();
  });

  // THE DELTA DOOR, and the one allowFirstSync does not watch. The first-sync
  // flag closes two doors — a null cursor and a cursor the server rejected —
  // and a bulk import into Stalwart is neither of them. The first sync writes
  // cursor C; a re-import, a restored subset, a second Vandelay pass, or phase
  // 2 starting to deliver real mail all arrive as messages CREATED after C,
  // which is a perfectly legitimate delta: nothing for the first-sync guard to
  // catch. jmap-port then drains up to changesPages x maxChanges = 20 x 500 =
  // 10 000 ids in ONE poll and hands every one of them to the ingest loop, once
  // a minute, unattended, appending a `document.ingested` LEDGER EVENT per
  // attachment of everything the relevance filter wants — on tables with no
  // DELETE grant. That is precisely the harm MailFirstSyncRefusedError exists
  // to prevent, arriving through the door nobody closed. `hasMore` in the run
  // detail makes it visible AFTER the fact, and visibility after an
  // irreversible append is not authorisation.
  it("refuses a delta above the ceiling before downloading anything", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("big-delta");
    await writeCursor(db, worker, "s-before", { seeded: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = [`j-big-a-${stamp}`, `j-big-b-${stamp}`, `j-big-c-${stamp}`];
    const asked: string[][] = [];
    const gets: string[] = [];
    const p: MailPort = {
      changedSince: async () => ({ ids, cursor: "s-after" }),
      headers: async (x) => { asked.push(x); return []; },
      getMessage: async (id) => { gets.push(id); return msg(id); },
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker, maxDelta: 2,
      enqueueSuggest: async () => {} })).rejects.toThrow(MailDeltaTooLargeError);
    // NOTHING CROSSED THE WIRE. The refusal sits ahead of the relevance filter,
    // so not even the batched headers are asked for — asserting on the ingest
    // count alone would pass against a poll that downloaded all 10 000 blobs
    // and happened to find nothing relevant.
    expect(asked).toEqual([]);
    expect(gets).toEqual([]);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    // The recovery is named in the row, for the same reason the first-sync
    // refusal names it: worker_runs is the only place mail failure is visible,
    // and a red row that names no cure is a wedge rather than a signal.
    expect(String(run.detail?.message)).toContain("mail-first-sync");
    // THE CURSOR IS HELD, and that is the whole recovery. Nothing is lost: the
    // same delta is re-listed next tick, the poll goes red once a minute
    // naming the previewed script, and a human decides. A cursor advanced past
    // a delta this poll refused to look at would strand every message in it.
    expect(await readCursor(db, worker)).toBe("s-before");
    await pool.end();
  });

  // THE HOLE THE COUNT ALONE LEAVES. `scanned` is what one poll drained, not
  // what is waiting: RFC 8620 §5.2 lets a server return small Email/changes
  // pages and set hasMoreChanges, so a bulk import can walk in UNDER the
  // tripwire, a bounded batch a minute — which is the slow irreversible bulk
  // append the ceiling exists to refuse, arriving beneath it instead of over
  // it. A delta of one with more queued behind it must refuse just as firmly
  // as a delta of ten thousand.
  it("refuses a truncated delta even when the count is under the ceiling", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("truncated-delta");
    await writeCursor(db, worker, "s-before", { seeded: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const asked: string[][] = [];
    const gets: string[] = [];
    const p: MailPort = {
      // ONE id — far under the ceiling of 500 — but the server says it has
      // more. Without the hasMore half of the guard this poll ingests happily.
      changedSince: async () => ({ ids: [`j-trunc-${stamp}`], cursor: "s-after", hasMore: true }),
      headers: async (x) => { asked.push(x); return []; },
      getMessage: async (id) => { gets.push(id); return msg(id); },
    };
    await expect(pollMail({ db, mail: p, vaultDir: vault(), worker,
      enqueueSuggest: async () => {} })).rejects.toThrow(MailDeltaTooLargeError);
    expect(asked).toEqual([]);
    expect(gets).toEqual([]);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("error");
    // The message must say WHICH trigger fired: "a delta of 1" alone reads as
    // absurd next to a ceiling of 500, and an operator would raise the knob.
    expect(String(run.detail?.message)).toContain("MORE queued");
    expect(await readCursor(db, worker)).toBe("s-before");
    await pool.end();
  });

  // The hand-run path must still drain a truncated delta: draining a large
  // batch is exactly its job, and refusing it on hasMore would break the one
  // caller that has already read the preview.
  it("lets the hand-run ops path through a truncated delta", async () => {
    const { db, pool } = createDb(URL);
    const worker = uniqueWorker("trunc-infinite");
    await writeCursor(db, worker, "s-before", { seeded: true });
    const id = `j-trunc-ok-${Date.now()}`;
    const p: MailPort = {
      changedSince: async () => ({ ids: [id], cursor: "s-after", hasMore: true }),
      headers: async () => [{ id, from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
        messageId: `${id}@verdergroep.nl` }],
      getMessage: async (x) => msg(x),
    };
    const r = await pollMail({ db, mail: p, vaultDir: vault(), worker,
      maxDelta: Infinity, enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    await pool.end();
  });

  // The off-by-one, which is not a nicety here: a `>=` would refuse a delta of
  // exactly the ceiling on every tick forever, and the recovery for a refusal
  // is a hand-run script — so getting this edge wrong stops ingestion until
  // someone reads the code.
  it("polls a delta of exactly the ceiling normally", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wanted = `j-edge-${stamp}`;
    const junk = `j-edge-junk-${stamp}`;
    const worker = uniqueWorker("edge-delta");
    const { port, gets } = portOf([
      msg(wanted),
      msg(junk, { from: `deals@shop-${stamp}.example`, to: `promo@shop-${stamp}.example` }),
    ]);
    const r = await pollMail({ db, mail: port, vaultDir: vault(), worker, maxDelta: 2,
      enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(1);
    expect(gets).toEqual([wanted]);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    expect(run.detail?.scanned).toBe(2);
    // The cursor MOVES, which is the difference between a poll that ran and a
    // poll that refused: a held cursor is what a refusal looks like.
    expect(await readCursor(db, worker)).toBe("s2");
    await settleDocumentTexts(db, wanted);
    await pool.end();
  });

  // THE OPS PATH IS UNAFFECTED, and it has to be: ops/mail-first-sync.ts is the
  // hand-run, previewed command whose entire purpose is to ingest a batch far
  // past this ceiling, after a human has read how many ledger events it implies.
  // It passes Infinity, and a tripwire that also fired there would make the only
  // authorised way of doing a bulk ingest impossible.
  it("lets the hand-run ops path through a delta far past the ceiling", async () => {
    const { db, pool } = createDb(URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = uniqueWorker("ops-delta");
    // Irrelevant on purpose: this test is about the gate, and ingesting five
    // hundred fixtures to prove a comparison would leave that much residue in
    // an append-only table on the shared dev database.
    const flood = Array.from({ length: MAIL_MAX_DELTA + 1 }, (_, i) =>
      msg(`j-ops-${stamp}-${i}`,
        { from: `deals@shop-${stamp}.example`, to: `promo@shop-${stamp}.example` }));
    const { port, gets } = portOf(flood);
    const r = await pollMail({ db, mail: port, vaultDir: vault(), worker,
      maxDelta: Infinity, enqueueSuggest: async () => {} });
    expect(r.ingested).toBe(0);
    expect(gets).toEqual([]);
    const run = await lastRun(db, worker);
    expect(run.status).toBe("ok");
    expect(run.detail?.scanned).toBe(MAIL_MAX_DELTA + 1);
    expect(await readCursor(db, worker)).toBe("s2");
    await pool.end();
  });
});

/**
 * The name the cursor lives under, pinned.
 *
 * It was a non-exported `const WORKER = "mail"` here while index.ts spelled the
 * same string by hand, and the two drifting apart is silent and total: rows land
 * under one name, readCursor reads the other and answers null, and the refusal
 * above then fires on every tick forever. One exported constant is the fix; this
 * test is what makes changing its VALUE a deliberate act, since the string is
 * also what docs/deploy.md and the dashboard's health tile look for.
 */
describe("MAIL_WORKER", () => {
  it("is the worker_runs name the cursor is stored under", () => {
    expect(MAIL_WORKER).toBe("mail");
  });
});

/** The cool-down itself, on an explicit clock — the same way makeEnqueueGuard's
 *  TTL is testable without waiting for one. */
describe("makeRepairBackoff", () => {
  it("holds a failed row, escalates, and caps the wait", () => {
    const b = makeRepairBackoff(1_000, 4_000);
    b.fail("a", 0);
    expect(b.ready("a", 999)).toBe(false);
    expect(b.waiting(999)).toBe(1);
    expect(b.ready("a", 1_000)).toBe(true);
    b.fail("a", 1_000);                 // second attempt: 2 s
    expect(b.ready("a", 2_999)).toBe(false);
    b.fail("a", 3_000);                 // third: 4 s
    b.fail("a", 7_000);                 // fourth would be 8 s — capped at 4 s
    expect(b.ready("a", 11_000)).toBe(true);
  });

  it("forgets a row the moment it succeeds, so a blip costs nothing later", () => {
    const b = makeRepairBackoff(1_000, 4_000);
    b.fail("a", 0);
    b.ok("a");
    expect(b.ready("a", 0)).toBe(true);
    expect(b.waiting(0)).toBe(0);
  });

  it("never counts an expired wait against the batch", () => {
    const b = makeRepairBackoff(1_000, 4_000);
    b.fail("a", 0);
    expect(b.waiting(5_000)).toBe(0);
  });
});
