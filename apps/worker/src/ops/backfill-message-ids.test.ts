import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { storeFile } from "@verder/api/src/storage";
import { backfillMessageIds, classifyBackfillRow } from "./backfill-message-ids";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

/**
 * Every fixture below is made unique per run, and the Message-IDs especially.
 * `raw_emails` is append-only — no test has a DELETE grant on it and the dev
 * database is never truncated — so a fixed Message-ID would show up as a
 * genuine duplicate group in the NEXT run's report, which is the one number
 * this file has to be able to assert about precisely.
 */
const stamp = () => `${Date.now()}-${crypto.randomUUID()}`;

/** An RFC822 original as the vault stores it, carrying `id` or nothing. */
const eml = (id: string | null, marker: string) => Buffer.from([
  "From: Team Opstart <opstart@verdergroep.nl>",
  "To: Martin van der Poel <martin@vanderpoel.pro>",
  "Subject: Aanleveren stukken",
  ...(id === null ? [] : [`Message-ID: <${id}>`]),
  `X-Verder-Test: ${marker}`,
  "",
  "Beste meneer Van der Poel,",
  "",
].join("\r\n"), "utf8");

describe("classifyBackfillRow", () => {
  // The whole point of extracting this: three outcomes that a caller must count
  // separately, decided without a database and without a filesystem.
  it("reads the Message-ID out of a stored original", () => {
    expect(classifyBackfillRow(eml("abc123@mail.verdergroep.nl", "a")))
      .toEqual({ kind: "filled", messageId: "abc123@mail.verdergroep.nl" });
  });

  it("says no-header for a message that carries none", () => {
    // Unusual but perfectly legal, and NOT an error: the row stays NULL and the
    // dedup falls back to the content hash for it.
    expect(classifyBackfillRow(eml(null, "b"))).toEqual({ kind: "no-header" });
  });

  it("says missing when the vault has no file for the row", () => {
    // null is the caller's word for "the vault does not hold these bytes",
    // which is a different fact from "the message has no Message-ID" and must
    // never be folded into it: one is a gap in the vault worth investigating,
    // the other is an ordinary message.
    expect(classifyBackfillRow(null)).toEqual({ kind: "missing" });
  });
});

describe("backfillMessageIds", () => {
  const { db, pool } = createDb(URL);
  afterAll(async () => { await pool.end(); });

  /**
   * A raw_emails row whose RFC822 original really lives in `vaultDir`, as after
   * a Gmail poll.
   *
   * `suggestQueuedAt` is set and `source` stays 'gmail' deliberately: a fixture
   * with a NULL marker is a permanent orphan at the front of
   * repairSuggestOutbox's `ORDER BY fetched_at ASC LIMIT n` on a dev database
   * nobody truncates, which is how a suite goes red for reasons that have
   * nothing to do with it. Same debt, and the same reasoning, as
   * settleDocumentTexts for ingested documents.
   */
  const seed = async (db: Db, vaultDir: string, opts: {
    raw?: Buffer; sha256?: string; messageId?: string;
  }) => {
    const sha = opts.sha256
      ?? (await storeFile(vaultDir, opts.raw as Buffer)).sha256;
    const [row] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `test-backfill-${stamp()}`, gmailThreadId: "t-backfill",
      fromAddr: "opstart@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Aanleveren stukken", sentAt: new Date(),
      rawRfc822Sha256: sha, bodyText: "", source: "gmail",
      suggestQueuedAt: new Date(),
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
    }).returning();
    return row;
  };

  it("fills what it can, counts the rest apart, and converges on a second run", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-message-id-"));
    const run = stamp();
    const wanted = `filled.${run}@mail.verdergroep.nl`;
    const already = `already.${run}@mail.verdergroep.nl`;

    const fillable = await seed(db, vaultDir, { raw: eml(wanted, run) });
    // Already carries an id, and its stored original says something DIFFERENT —
    // so if the backfill touched it at all, the value would change and the test
    // would see it. A row that is already answered must not be re-read.
    const answered = await seed(db, vaultDir, {
      raw: eml(`other.${run}@mail.verdergroep.nl`, run), messageId: already });
    // Bytes that were never stored: a valid sha256 with no file behind it.
    const gone = await seed(db, vaultDir, { sha256: sha256Hex(`never-stored-${run}`) });
    const headerless = await seed(db, vaultDir, { raw: eml(null, run) });

    const first = await backfillMessageIds({ db, vaultDir });

    // The dev database is shared and holds raw_emails rows from every other
    // suite, all of them NULL and none of them backed by THIS throwaway vault —
    // so the run totals mean nothing here beyond "it considered at least ours",
    // and every assertion that matters is scoped to the four rows just seeded.
    expect(first.considered).toBeGreaterThanOrEqual(4);
    // Exact, and safe to be exact: `vaultDir` is a fresh temp directory, so the
    // only rows in the whole table whose bytes it holds are the ones above.
    expect(first.filled).toBe(1);
    expect(first.noHeader).toBeGreaterThanOrEqual(1);
    expect(first.vaultFileMissing).toBeGreaterThanOrEqual(1);

    const idOf = async (id: string) => (await db.select()
      .from(schema.rawEmails).where(eq(schema.rawEmails.id, id)))[0].messageId;
    expect(await idOf(fillable.id)).toBe(wanted);
    expect(await idOf(answered.id)).toBe(already);
    expect(await idOf(gone.id)).toBeNull();
    // A message with no Message-ID header stays NULL forever, which is the
    // truthful answer: NULL means unknown, and the dedup reading it as "no
    // match" is exactly right about such a row.
    expect(await idOf(headerless.id)).toBeNull();

    // Idempotent: the select is `message_id IS NULL`, so the row that was
    // filled is not considered again and nothing is rewritten. The headerless
    // and vault-less rows ARE re-considered every run — deliberately, since a
    // vault file restored later must still get picked up — but they cost one
    // failed read each and change nothing.
    const second = await backfillMessageIds({ db, vaultDir });
    expect(second.filled).toBe(0);
    expect(await idOf(fillable.id)).toBe(wanted);
    // Nothing this test seeded is a duplicate of anything: each Message-ID is
    // unique to this run.
    expect(first.duplicates.map((d) => d.messageId)).not.toContain(wanted);
  });

  it("reports a Message-ID that now sits on more than one row", async () => {
    // THE CASE THIS REPORT EXISTS FOR. The Takeout mbox copy and the Gmail API
    // copy of one message are NOT byte-identical, so they hash differently and
    // both could already be in the dossier under two rows — invisible until
    // their shared Message-ID is recorded. It is diagnostic, not an error: the
    // operator wants to know before trusting the dedup, and failing the run
    // over it would leave the remaining rows unfilled for a fact that is
    // already true in the table.
    const vaultDir = await mkdtemp(join(tmpdir(), "verder-message-id-dup-"));
    const run = stamp();
    const shared = `shared.${run}@mail.verdergroep.nl`;
    const takeout = await seed(db, vaultDir, { raw: eml(shared, `mbox-${run}`) });
    const api = await seed(db, vaultDir, { raw: eml(shared, `api-${run}`) });
    // Different bytes on purpose — otherwise the vault stores one file and this
    // proves nothing about two rows.
    expect(takeout.rawRfc822Sha256).not.toBe(api.rawRfc822Sha256);

    const res = await backfillMessageIds({ db, vaultDir });
    expect(res.filled).toBe(2);
    const group = res.duplicates.find((d) => d.messageId === shared);
    expect(group).toBeDefined();
    expect([...group!.rawEmailIds].sort()).toEqual([takeout.id, api.id].sort());
  });
});
