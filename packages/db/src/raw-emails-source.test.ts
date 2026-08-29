import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

const URL = "postgres://verder:verder@localhost:5432/verder";

describe("raw_emails.source", () => {
  it("defaults existing rows to gmail so no historical id is rewritten", async () => {
    const { db, pool } = createDb(URL);
    const r = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'raw_emails' AND column_name = 'source'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].is_nullable).toBe("NO");
    expect(String(r.rows[0].column_default)).toContain("gmail");
    await pool.end();
  });

  // Both halves of the title, asserted. The previous version of this test was
  // one bare `.rejects.toThrow()` and nothing else: it would have passed just as
  // happily if the column did not exist, if the INSERT had a typo, or if the
  // CHECK were `source IN ('gmail')` — which would reject every JMAP-ingested
  // mail and break the whole new ingest path while the suite stayed green.
  it("accepts jmap and rejects anything else", async () => {
    const { db, pool } = createDb(URL);
    const tag = `src-check-${crypto.randomUUID()}`;
    const insert = (source: string) => sql`
      INSERT INTO raw_emails (gmail_message_id, gmail_thread_id, from_addr, to_addr,
        subject, sent_at, raw_rfc822_sha256, body_text, source)
      VALUES (${`${tag}-${source}`}, 't', 'a@b.nl', 'c@d.nl', 's', now(), 'h', '', ${source})`;

    // Accepts jmap: this is the value task 5 writes for every message the JMAP
    // port ingests, so it has to be provably storable, not merely intended.
    await db.execute(insert("jmap"));
    const stored = await db.execute(sql`
      SELECT source FROM raw_emails WHERE gmail_message_id = ${`${tag}-jmap`}`);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].source).toBe("jmap");

    // Rejects anything else — and from THIS constraint. Matching the name is
    // what distinguishes a working CHECK from a missing column, a NOT NULL
    // violation, or a malformed statement.
    await expect(db.execute(insert("imap")))
      .rejects.toThrow(/raw_emails_source_check/);

    // The dev database is shared and never truncated, so the fixture goes away
    // again. Deleting runs as the `verder` admin role, which owns the table;
    // no grant anywhere changes, and raw_emails stays append-only for the app
    // and worker roles that actually ingest.
    await db.execute(sql`
      DELETE FROM search_outbox WHERE entity_type = 'email' AND entity_id IN (
        SELECT id FROM raw_emails WHERE gmail_message_id LIKE ${`${tag}%`})`);
    const gone = await db.execute(sql`
      DELETE FROM raw_emails WHERE gmail_message_id LIKE ${`${tag}%`}`);
    expect(gone.rowCount).toBe(1);
    await pool.end();
  });
});
