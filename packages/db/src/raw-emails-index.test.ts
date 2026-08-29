import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

// Not named URL: the global URL constructor is what resolves the migration
// paths below, and a module-level `const URL` shadows it.
const DEV_URL = "postgres://verder:verder@localhost:5432/verder";

/**
 * The migrations the migrator will actually run, in order, as source text.
 *
 * WHY THIS FILE READS SQL AT ALL. Every assertion below it runs against an
 * ALREADY-MIGRATED dev database, so it reports the state of whatever database
 * it meets and not the state of the change under review. Measured: deleting the
 * CREATE INDEX from 0029 leaves this file green on the machine where that
 * deletion is made, because the index is still sitting in the dev database from
 * the run that created it. Only a fresh database — production, or a from-
 * scratch CI run — would notice, which is exactly the wrong way round: the
 * check fires nowhere near the person who can fix it.
 *
 * WHY THE SOURCE AND NOT AN ISOLATED DATABASE. run-retrieval-eval.ts does have
 * the CREATE DATABASE / migrate / DROP pattern and it would be the strongest
 * possible answer — but its localhost guard is assertSafeToTruncate in
 * @verder/api, and @verder/api depends on @verder/db, so importing it here
 * inverts the dependency; the alternative is a second copy of a guard whose
 * whole job is to never be subtly different. It would also put a full
 * twenty-nine-migration build in front of every `vitest run` in this package.
 * Reading the source catches the fault this file exists to catch — a migration
 * that does not create the index, or one that is never applied because it is
 * missing from the journal — at the cost of one file read.
 *
 * THE JOURNAL IS THE LIST, not the directory. drizzle-kit runs what
 * meta/_journal.json names, so a .sql file nobody journaled is a file that runs
 * nowhere, and a grep over the directory would call it applied.
 */
async function journaledMigrations(): Promise<{ tag: string; sql: string }[]> {
  const journal = JSON.parse(await readFile(
    new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: { tag: string }[] };
  return Promise.all(journal.entries.map(async (e) => ({
    tag: e.tag,
    sql: await readFile(new URL(`../drizzle/${e.tag}.sql`, import.meta.url), "utf8"),
  })));
}

/**
 * CREATE [UNIQUE] INDEX statements over raw_emails, from every journaled
 * migration — the whole set, because an index created twice, or created in a
 * migration nobody journaled, is as wrong as one that was never created.
 *
 * Line comments come off FIRST: these migration files carry more prose than
 * SQL, and a statement that begins with twenty lines of reasoning does not
 * start with the word CREATE.
 */
function rawEmailIndexStatements(files: { tag: string; sql: string }[]) {
  return files.flatMap((f) => f.sql
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(";")
    .map((stmt) => stmt.trim().replace(/\s+/g, " "))
    .filter((stmt) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)
      && /\braw_emails\b/.test(stmt))
    .map((stmt) => ({ tag: f.tag, stmt })));
}

describe("raw_emails.raw_rfc822_sha256 index", () => {
  // WHY THIS EXISTS. The JMAP poller dedups on message CONTENT before it
  // ingests, with one `select id from raw_emails where raw_rfc822_sha256 = $1`
  // per downloaded message. The scenario that dedup was written for is the
  // first sync after the 11.49 GB Takeout import, i.e. the one run that walks
  // every message in the archive — so an unindexed column makes that a
  // sequential scan per message over a table growing to N rows: O(N^2), on the
  // job that is already downloading every blob. Measured on the dev database
  // before the index existed: `Seq Scan on raw_emails ... Rows Removed by
  // Filter: 1334`.
  //
  // The index is deliberately NOT unique. Two different messages can carry
  // identical bytes (the same mail delivered to two addresses, a Takeout copy
  // of a message Gmail already ingested), and the poller's answer to that is to
  // skip the second — not to have Postgres reject it and abort the sync.
  it("exists, so the poller's content dedup is an index lookup and not a seq scan", async () => {
    const { db, pool } = createDb(DEV_URL);
    const r = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'raw_emails' AND indexname = 'raw_emails_sha256_idx'`);
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0].indexdef)).toContain("raw_rfc822_sha256");
    expect(String(r.rows[0].indexdef)).not.toContain("UNIQUE");
    await pool.end();
  });

  // Asserting the index EXISTS is not the same as asserting the planner uses
  // it: a mismatched expression or opclass would leave the row above green and
  // the scan sequential. This reads the plan for the poller's actual query.
  it("is what the planner picks for that exact query", async () => {
    const { db, pool } = createDb(DEV_URL);
    const plan = await db.execute(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM raw_emails WHERE raw_rfc822_sha256 = 'deadbeef'`);
    const text = plan.rows.map((row) => String(Object.values(row)[0])).join("\n");
    expect(text).toMatch(/Index Scan|Bitmap Index Scan|Index Only Scan/);
    expect(text).not.toMatch(/Seq Scan on raw_emails/);
    await pool.end();
  });
});

describe("the migration that creates it", () => {
  // FINDING 10. This is the assertion that can fail on the machine where the
  // change is written. Removing the CREATE INDEX from 0029 — or removing 0029
  // from meta/_journal.json, which is what actually decides whether it runs —
  // turns this red immediately, while both database assertions above stay green
  // against a dev database that was migrated before the deletion.
  it("is in the journaled migrations, exactly once and not unique", async () => {
    const statements = rawEmailIndexStatements(await journaledMigrations());
    const onSha = statements.filter((s) => /raw_rfc822_sha256/.test(s.stmt));
    expect(onSha).toHaveLength(1);
    expect(onSha[0].tag).toBe("0029_raw_emails_sha256_idx");
    expect(onSha[0].stmt).toMatch(/raw_emails_sha256_idx/);
    // Not unique, for the reason the migration spells out: two different
    // messages can carry identical bytes, and the poller's answer is to skip
    // the second — not to have Postgres reject it and abort the sync.
    expect(onSha[0].stmt).not.toMatch(/UNIQUE/i);
  });

  // The database assertions above read pg_indexes and EXPLAIN, which say
  // nothing about whether the dev database and the migrations still AGREE. A
  // developer who adds a migration and forgets to run it gets two green
  // database assertions describing an index some earlier run happened to
  // create, which is the same blind spot one level up.
  it("has actually been applied to the database this suite asserts against", async () => {
    const journal = JSON.parse(await readFile(
      new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: { tag: string; when: number }[] };
    const entry = journal.entries.find((e) => e.tag === "0029_raw_emails_sha256_idx");
    expect(entry).toBeDefined();
    const { db, pool } = createDb(DEV_URL);
    try {
      // The migrator's own test for "already applied": it skips a migration
      // purely on `journal.when <= max(created_at)`, which is why 0029 is a new
      // file rather than an edit to 0028 (see the comment in the migration).
      const r = await db.execute(sql`
        SELECT max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations`);
      expect(Number(r.rows[0].latest)).toBeGreaterThanOrEqual(entry!.when);
    } finally {
      await pool.end();
    }
  });
});
