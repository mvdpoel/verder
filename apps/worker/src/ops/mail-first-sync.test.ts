import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@verder/db";
import { MAIL_MAX_DELTA } from "../mail/poll";
import {
  messageIdCoverage, parseFirstSyncArgs, parseFirstSyncPages, summarisePreview,
  FIRST_SYNC_BYPASS,
} from "./mail-first-sync";

const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

/** n distinct attachment shas, spelled so a test reads as "n new files". */
const shas = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("summarisePreview", () => {
  it("derives every count the operator authorises against", () => {
    const p = summarisePreview({
      scanned: 146_270, headersReturned: 146_000, relevant: 900,
      knownById: 40, knownByMessageId: 6, messagesRepeatedInRun: 2,
      knownByContent: 12, unreadable: 0, noMessageId: 3,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      // 840 fresh messages, three of which carry attachments.
      attachmentShas: [...Array(837).fill([]), ["a0"], ["b0", "b1"], ["c0", "c1", "c2"]],
      vaultShas: new Set<string>(),
    });
    expect(p).toEqual({
      scanned: 146_270, vanished: 270, irrelevant: 145_100, relevant: 900,
      knownById: 40, knownByMessageId: 6, messagesRepeatedInRun: 2,
      knownByContent: 12, unreadable: 0, noMessageId: 3, fresh: 840,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachments: 6, attachmentsAlreadyInVault: 0, attachmentsRepeatedInRun: 0,
      predictedLedgerEvents: 6,
    });
  });

  // The number that says whether the content dedup is working: every Gmail-era
  // message comes back over JMAP under a fresh Stalwart id, so it can only be
  // recognised by its bytes. A preview that reported those as fresh would be
  // asking for authorisation to duplicate the whole existing dossier.
  it("predicts nothing when the mailbox is already entirely ingested", () => {
    const p = summarisePreview({
      scanned: 50, headersReturned: 50, relevant: 50,
      knownById: 10, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 40, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [], vaultShas: new Set<string>(),
    });
    expect(p.fresh).toBe(0);
    expect(p.predictedLedgerEvents).toBe(0);
  });

  // THE KEY THE OTHER TWO CANNOT REACH, and the reason this preview was worth
  // reading before committing: measured on the archive, 130 relevant messages
  // matched 0 of the 107 rows the dossier already held — the Stalwart id is a
  // different namespace from the Gmail one and Takeout's mbox bytes are not the
  // API's bytes, so both existing keys miss every single one. A preview that
  // could not report the Message-ID overlap would present ~114 permanent
  // duplicate rows as new mail and ask for authorisation to write them.
  it("holds the messages known only by Message-ID out of fresh", () => {
    const p = summarisePreview({
      scanned: 130, headersReturned: 130, relevant: 130,
      knownById: 0, knownByMessageId: 114, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [...Array(15).fill([]), ["nieuw"]],
      vaultShas: new Set<string>(),
    });
    expect(p.knownByMessageId).toBe(114);
    expect(p.fresh).toBe(16);
    expect(p.predictedLedgerEvents).toBe(1);
  });

  // A `document.ingested` event is appended PER ATTACHMENT, not per message, so
  // the prediction counts attachments and never messages. Getting this the
  // other way round understates a mail carrying the 16-file moratorium package
  // as one irreversible event instead of sixteen.
  it("predicts one ledger event per attachment, not per message", () => {
    const p = summarisePreview({
      scanned: 2, headersReturned: 2, relevant: 2,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [shas("m", 16), []], vaultShas: new Set<string>(),
    });
    expect(p.fresh).toBe(2);
    expect(p.attachments).toBe(16);
    expect(p.predictedLedgerEvents).toBe(16);
  });

  // ingestDocument returns the existing row on a sha256 match and appends
  // NOTHING, so an attachment whose bytes the vault already holds costs zero
  // ledger events. A re-mailed Beschikking.pdf is exactly this case, and
  // counting it would report a chain head moving further than it can move.
  it("predicts no event for an attachment whose bytes the vault already holds", () => {
    const p = summarisePreview({
      scanned: 3, headersReturned: 3, relevant: 3,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [["beschikking", "logo"], ["logo"], ["nieuw"]],
      vaultShas: new Set(["beschikking", "logo"]),
    });
    expect(p.attachments).toBe(4);
    expect(p.attachmentsAlreadyInVault).toBe(3);
    expect(p.attachmentsRepeatedInRun).toBe(0);
    expect(p.predictedLedgerEvents).toBe(1);
  });

  // THE CASE A NAIVE IMPLEMENTATION GETS WRONG. The vault lookup is a snapshot
  // taken before the commit, so a sha that is new at lookup time is new only
  // ONCE: the first copy inserts the document, and every later copy inside the
  // same run meets the row that copy just wrote. One PDF mailed to two parties,
  // or the same footer image on ten mails, is one event and not ten.
  it("counts byte-identical attachments within the same run as one event", () => {
    const p = summarisePreview({
      scanned: 3, headersReturned: 3, relevant: 3,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      // The same PDF to two parties, plus one message carrying it twice itself.
      attachmentShas: [["pdf"], ["pdf", "pdf"], ["ander"]],
      vaultShas: new Set<string>(),
    });
    expect(p.attachments).toBe(4);
    expect(p.attachmentsAlreadyInVault).toBe(0);
    expect(p.attachmentsRepeatedInRun).toBe(2);
    expect(p.predictedLedgerEvents).toBe(2);
  });

  // The three disclosed numbers must ADD UP to the attachment total, or the
  // report loses the reader at "142 attachments, 31 events" — the same law the
  // /money disclosures are built on. Every attachment is in exactly one of the
  // three buckets, so a duplicate of something already in the vault is counted
  // as already-in-vault and never twice.
  it("partitions every attachment into exactly one of the three buckets", () => {
    const p = summarisePreview({
      scanned: 1, headersReturned: 1, relevant: 1,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [["oud", "oud", "nieuw", "nieuw", "nieuw"]],
      vaultShas: new Set(["oud"]),
    });
    expect(p.attachmentsAlreadyInVault).toBe(2);
    expect(p.attachmentsRepeatedInRun).toBe(2);
    expect(p.predictedLedgerEvents).toBe(1);
    expect(p.attachmentsAlreadyInVault + p.attachmentsRepeatedInRun
      + p.predictedLedgerEvents).toBe(p.attachments);
  });

  // A message whose blobs could not be read is still a message the commit will
  // try to ingest, and its attachments are unknown — so it leaves `fresh` and
  // is disclosed on its own, rather than being counted as fresh-with-zero and
  // quietly rounding the prediction down.
  it("holds an unreadable message out of fresh instead of predicting zero for it", () => {
    const p = summarisePreview({
      scanned: 3, headersReturned: 3, relevant: 3,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 1, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [shas("a", 2), shas("b", 2)], vaultShas: new Set<string>(),
    });
    expect(p.fresh).toBe(2);
    expect(p.unreadable).toBe(1);
    expect(p.predictedLedgerEvents).toBe(4);
  });

  // The summary and the table under it are read as one statement. If they can
  // disagree, the headline figure is no longer evidence of anything — and this
  // is the figure an irreversible ingest is authorised on.
  it("refuses a walk whose attachment list disagrees with the derived fresh count", () => {
    expect(() => summarisePreview({
      scanned: 10, headersReturned: 10, relevant: 10,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [["a"], ["b"]], vaultShas: new Set<string>(),
    })).toThrow(/fresh/);
  });

  // THE KEY TURNED ON THE RUN ITSELF. `messageIdsAlreadyHeld` is a snapshot
  // taken once before the walk, so it can only ever answer "what did raw_emails
  // hold when this started" — a second candidate carrying a Message-ID the
  // first candidate of the SAME run has just ingested is not in it. One mail
  // delivered to two addresses arrives exactly like that: two Stalwart Emails,
  // one Message-ID, different bytes (different Received headers), which is why
  // schema.ts leaves the sha index non-unique and why findDuplicates exists.
  //
  // KEPT APART FROM knownByMessageId, on the same law attachmentsRepeatedInRun
  // follows one level down: that figure is the measured overlap with the
  // DOSSIER (130 relevant messages against 0 of 107 rows), and a within-run
  // repeat is a fact about the MAILBOX. Folding them together would inflate the
  // one number this slice was measured against with something that is not
  // overlap at all — and it would hide the pair, which is precisely what the
  // backfill reports so the operator can look at it.
  it("holds a message repeated within this very run out of fresh", () => {
    const p = summarisePreview({
      scanned: 4, headersReturned: 4, relevant: 4,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 2,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [["a"], ["b"]], vaultShas: new Set<string>(),
    });
    expect(p.messagesRepeatedInRun).toBe(2);
    expect(p.knownByMessageId).toBe(0);
    expect(p.fresh).toBe(2);
    expect(p.predictedLedgerEvents).toBe(2);
  });

  // BLOCKER B, AND THE ONLY TELL THERE IS. The whole dedup is inert until
  // `backfill-message-ids` has run: every existing row's message_id is NULL,
  // the batched lookup comes back empty, and the preview prints `already held
  // … 0` and `NEW 130` — byte for byte the output measured BEFORE the
  // Message-ID key existed. That does not read as "you skipped a step", it
  // reads as "the overlap is genuinely zero", and --commit against it writes
  // ~114 permanent rows into a table with no DELETE grant. A nonzero NULL count
  // beside a nonzero total is the operator's only possible way to tell the two
  // apart, so the walk counts it and the report carries it.
  it("reports how many existing rows still have no Message-ID recorded", () => {
    const p = summarisePreview({
      scanned: 130, headersReturned: 130, relevant: 130,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      // The exact shape of a skipped backfill: 107 rows, none of them filled.
      rawEmailRows: 107, rowsWithoutMessageId: 107,
      attachmentShas: Array(130).fill([]), vaultShas: new Set<string>(),
    });
    expect(p.rawEmailRows).toBe(107);
    expect(p.rowsWithoutMessageId).toBe(107);
    // And the figure it makes untrustworthy is still reported — the preview's
    // job is to describe the commit, not to invent a smaller number.
    expect(p.fresh).toBe(130);
  });

  // MISSING TELL C. jmap-port.ts asks for `header:Message-ID:asText` and reads
  // it back by EXACT string key; every test in this repo uses a fake that echoes
  // that key verbatim, and docs/deploy.md says in terms that none of it has been
  // measured against a running Stalwart. A server that omits the property, or
  // answers under different casing, hands back null for every message and the
  // dedup becomes a silent no-op — producing, once again, `NEW 130`. This
  // counter is what makes that visible: on a mailbox of ordinary mail "130 of
  // 130 relevant messages carry no Message-ID" is impossible on its face,
  // whereas "knownByMessageId: 0" is not.
  it("reports how many candidates carried no Message-ID at all", () => {
    const p = summarisePreview({
      scanned: 130, headersReturned: 130, relevant: 130,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 130,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: Array(130).fill([]), vaultShas: new Set<string>(),
    });
    expect(p.noMessageId).toBe(130);
    expect(p.relevant).toBe(130);
  });

  // The same law the vanished/irrelevant/fresh guards follow: a walk that
  // cannot have happened is refused rather than summarised. More candidates
  // without a Message-ID than there were candidates, or more NULL rows than
  // rows, means the walk lost track of itself — and both of these numbers exist
  // solely so an operator can trust the ones beside them.
  it("refuses counts about Message-IDs that cannot have come from one walk", () => {
    expect(() => summarisePreview({
      scanned: 5, headersReturned: 5, relevant: 5,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 6,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [[], [], [], [], []], vaultShas: new Set<string>(),
    })).toThrow(/noMessageId/);
    expect(() => summarisePreview({
      scanned: 5, headersReturned: 5, relevant: 5,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 108,
      attachmentShas: [[], [], [], [], []], vaultShas: new Set<string>(),
    })).toThrow(/rowsWithoutMessageId/);
  });

  it("refuses counts that cannot have come from one walk", () => {
    // More headers than ids were asked for: the walk lost track of itself.
    expect(() => summarisePreview({
      scanned: 5, headersReturned: 6, relevant: 6,
      knownById: 0, knownByMessageId: 0, messagesRepeatedInRun: 0,
      knownByContent: 0, unreadable: 0, noMessageId: 0,
      rawEmailRows: 107, rowsWithoutMessageId: 0,
      attachmentShas: [[], [], [], [], [], []], vaultShas: new Set<string>(),
    })).toThrow(/vanished/);
  });
});

describe("parseFirstSyncArgs", () => {
  it("defaults to preview", () => {
    expect(parseFirstSyncArgs([])).toEqual({ commit: false });
  });

  it("commits only on the exact flag", () => {
    expect(parseFirstSyncArgs(["--commit"])).toEqual({ commit: true });
  });

  // pnpm 10 forwards its own `--` separator to the script, exactly as
  // reindex.ts records, so the real argv of `pnpm ... mail-first-sync --
  // --commit` starts with it.
  it("drops the pnpm separator and still commits", () => {
    expect(parseFirstSyncArgs(["--", "--commit"])).toEqual({ commit: true });
  });

  // THE WORST POSSIBLE FAILURE OF THIS SCRIPT is an unrecognised flag that
  // commits anyway — every ingested attachment appends a `document.ingested`
  // row to a table with no DELETE grant. A near-miss must never reach the
  // ingest, and it must not be swallowed into a silent preview either: the
  // operator who typed it believes he authorised something.
  it.each(["--commmit", "-commit", "commit", "--COMMIT", "--commit=true", "--commit-now"])(
    "refuses %s rather than committing on it", (arg) => {
      expect(() => parseFirstSyncArgs([arg])).toThrow(/--commit/);
    });

  it("refuses an unknown argument riding along beside a real --commit", () => {
    expect(() => parseFirstSyncArgs(["--commit", "--dry-run"])).toThrow(/--dry-run/);
  });
});

describe("parseFirstSyncPages", () => {
  it("defaults to 2000 pages — enough to enumerate the imported archive", () => {
    expect(parseFirstSyncPages(undefined)).toBe(2000);
  });

  it("reads a configured value", () => {
    expect(parseFirstSyncPages("400")).toBe(400);
  });

  // FINDING 8's trap, one module over: `??` does not fire on "", and a bare
  // `MAIL_FIRST_SYNC_PAGES=` line in .env.prod is far more common than an
  // absent one. An empty value is the mistake, not a claim about pages.
  it("treats an empty value as unset rather than as a number", () => {
    expect(parseFirstSyncPages("")).toBe(2000);
    expect(parseFirstSyncPages("   ")).toBe(2000);
  });

  // A compose file interpolating a variable leaves the padding behind, and a
  // page bound is not a value worth failing a hand-run migration-class script
  // over a space.
  it("tolerates padding around a real value", () => {
    expect(parseFirstSyncPages(" 400 ")).toBe(400);
  });

  it.each(["0", "-1", "1.5", "2e3", "many", "500px", "0x10"])(
    "refuses %s, because a bad page bound is a partial enumeration", (raw) => {
      expect(() => parseFirstSyncPages(raw)).toThrow(/MAIL_FIRST_SYNC_PAGES/);
    });
});

// THE REGRESSION GUARD ON THE AUTHORISED PATH. Both fields live at a call site
// inside the direct-execution block, which no test can reach, so before this
// they were correct and completely unprotected. Deleting `maxDelta` would make
// MAIL_MAX_DELTA fire on the one command whose purpose is to cross it, and the
// resulting error would advise running the command that had just refused.
describe("FIRST_SYNC_BYPASS", () => {
  it("bypasses the delta ceiling that guards the scheduled poll", () => {
    expect(FIRST_SYNC_BYPASS.maxDelta).toBe(Number.POSITIVE_INFINITY);
    // Not merely large: pollMail gates the whole ceiling on Number.isFinite, so
    // a big finite number would still refuse a truncated delta (hasMore), which
    // is precisely what a first sync over an imported archive produces.
    expect(Number.isFinite(FIRST_SYNC_BYPASS.maxDelta)).toBe(false);
    expect(FIRST_SYNC_BYPASS.maxDelta).toBeGreaterThan(MAIL_MAX_DELTA);
  });

  it("permits the whole-mailbox enumeration the scheduled poll refuses", () => {
    // pollMail tests `allowFirstSync === false`, so this must not be false.
    expect(FIRST_SYNC_BYPASS.allowFirstSync).toBe(true);
  });
});

// The one number in this report that is not derived from the walk, and the one
// the pure tests above cannot reach. It is what tells a skipped backfill apart
// from a genuinely disjoint mailbox — two conditions whose printed reports are
// otherwise identical, and only one of which is safe to --commit against. Two
// lines of SQL that run, return a plausible figure and count the wrong thing is
// exactly the failure this guards, so it is measured against the table itself
// rather than against a fixture.
describe("messageIdCoverage", () => {
  it("counts the rows the Message-ID backfill has not reached", async () => {
    const { db, pool } = createDb(WORKER_URL);
    try {
      const c = await messageIdCoverage(db);
      const [truth] = (await db.execute<{ total: number; nulls: number }>(sql`
        SELECT count(*)::int AS total,
               (count(*) FILTER (WHERE message_id IS NULL))::int AS nulls
          FROM raw_emails`)).rows;
      expect(c.rawEmailRows).toBe(truth.total);
      expect(c.rowsWithoutMessageId).toBe(truth.nulls);
      // The FILTER is the half that can silently count everything: a coverage
      // figure equal to the total on a dev database whose rows DO carry
      // Message-IDs would print the "backfill never ran" banner forever, and an
      // operator who learns to ignore that banner has lost the tell entirely.
      expect(c.rowsWithoutMessageId).toBeLessThanOrEqual(c.rawEmailRows);
      expect(c.rawEmailRows).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
