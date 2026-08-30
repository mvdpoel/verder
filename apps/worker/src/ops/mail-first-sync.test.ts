import { describe, expect, it } from "vitest";
import { MAIL_MAX_DELTA } from "../mail/poll";
import { parseFirstSyncArgs, parseFirstSyncPages, summarisePreview, FIRST_SYNC_BYPASS } from "./mail-first-sync";

/** n distinct attachment shas, spelled so a test reads as "n new files". */
const shas = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("summarisePreview", () => {
  it("derives every count the operator authorises against", () => {
    const p = summarisePreview({
      scanned: 146_270, headersReturned: 146_000, relevant: 900,
      knownById: 40, knownByContent: 12, unreadable: 0,
      // 848 fresh messages, three of which carry attachments.
      attachmentShas: [...Array(845).fill([]), ["a0"], ["b0", "b1"], ["c0", "c1", "c2"]],
      vaultShas: new Set<string>(),
    });
    expect(p).toEqual({
      scanned: 146_270, vanished: 270, irrelevant: 145_100, relevant: 900,
      knownById: 40, knownByContent: 12, unreadable: 0, fresh: 848,
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
      knownById: 10, knownByContent: 40, unreadable: 0,
      attachmentShas: [], vaultShas: new Set<string>(),
    });
    expect(p.fresh).toBe(0);
    expect(p.predictedLedgerEvents).toBe(0);
  });

  // A `document.ingested` event is appended PER ATTACHMENT, not per message, so
  // the prediction counts attachments and never messages. Getting this the
  // other way round understates a mail carrying the 16-file moratorium package
  // as one irreversible event instead of sixteen.
  it("predicts one ledger event per attachment, not per message", () => {
    const p = summarisePreview({
      scanned: 2, headersReturned: 2, relevant: 2,
      knownById: 0, knownByContent: 0, unreadable: 0,
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
      knownById: 0, knownByContent: 0, unreadable: 0,
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
      knownById: 0, knownByContent: 0, unreadable: 0,
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
      knownById: 0, knownByContent: 0, unreadable: 0,
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
      knownById: 0, knownByContent: 0, unreadable: 1,
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
      knownById: 0, knownByContent: 0, unreadable: 0,
      attachmentShas: [["a"], ["b"]], vaultShas: new Set<string>(),
    })).toThrow(/fresh/);
  });

  it("refuses counts that cannot have come from one walk", () => {
    // More headers than ids were asked for: the walk lost track of itself.
    expect(() => summarisePreview({
      scanned: 5, headersReturned: 6, relevant: 6,
      knownById: 0, knownByContent: 0, unreadable: 0,
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
