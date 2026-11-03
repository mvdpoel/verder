import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index";
import { PARTY_BRIEF_VERDICTS } from "./schema";

// Read on the ADMIN connection: has_table_privilege answers for any role.
//
// The law (migration 0043): `party_briefs` holds the CURRENT brief and is
// overwritten by every redraft, so the golden rule — every model output, a
// refused one included, with the context and prompt it answered — lives in
// `party_brief_drafts`, one row per attempt. That history is APPEND-ONLY: the
// worker (the only writer) holds SELECT and INSERT, never UPDATE or DELETE;
// the web app holds nothing. Still NOT evidence: no ledger event.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

describe("party_brief_drafts (0043)", () => {
  let db: Db; let close: () => Promise<void>;
  beforeAll(() => { const c = createDb(ADMIN_URL); db = c.db; close = () => c.pool.end(); });
  afterAll(() => close());

  async function can(role: string, privilege: string): Promise<boolean> {
    const r = await db.execute(
      sql`SELECT has_table_privilege(${role}, 'party_brief_drafts', ${privilege}) AS ok`);
    return r.rows[0].ok === true;
  }

  it("the worker appends and reads, and can never rewrite or remove an attempt", async () => {
    for (const p of ["SELECT", "INSERT"]) expect(await can("verder_worker", p), p).toBe(true);
    for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) expect(await can("verder_worker", p), p).toBe(false);
  });

  it("the app holds nothing on it", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(await can("verder_app", p), p).toBe(false);
    }
  });

  it("verdict enum matches the TypeScript list", async () => {
    const r = await db.execute(sql`SELECT unnest(enum_range(NULL::party_brief_verdict))::text AS v`);
    expect(r.rows.map((row) => String(row.v))).toEqual([...PARTY_BRIEF_VERDICTS]);
    expect([...PARTY_BRIEF_VERDICTS]).toEqual(["ready", "refused", "failed", "late"]);
  });
});
