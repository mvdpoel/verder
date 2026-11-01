import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { DOC_SOURCES } from "./doc-sources";

const URL = "postgres://verder:verder@localhost:5432/verder";

/**
 * Migration M-B (0041): a recording Martin chose to keep with a voice
 * quick-log ("bewaar opname") is stored with its own source, and the unique
 * index that makes `suggestions.createVoice` idempotent under two concurrent
 * retries exists.
 */
describe("doc_source phone-voice (0041)", () => {
  it("enum has phone-voice", async () => {
    const { db, pool } = createDb(URL);
    try {
      const r = await db.execute(sql`SELECT unnest(enum_range(NULL::doc_source))::text AS v`);
      expect(r.rows.map((row) => String(row.v))).toContain("phone-voice");
      expect(DOC_SOURCES).toContain("phone-voice");
    } finally {
      await pool.end();
    }
  });

  it("has the partial unique index on a voice suggestion's clientId", async () => {
    const { db, pool } = createDb(URL);
    try {
      const r = await db.execute(sql`SELECT indexdef FROM pg_indexes
        WHERE tablename = 'suggestions' AND indexname = 'suggestions_voice_client_uq'`);
      expect(r.rows).toHaveLength(1);
      const def = String(r.rows[0].indexdef);
      expect(def).toMatch(/UNIQUE INDEX/);
      expect(def).toMatch(/proposed ->> 'clientId'/);
      expect(def).toMatch(/voice-v1/);
    } finally {
      await pool.end();
    }
  });
});
