import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index";
import { ENTRY_SOURCES } from "./entry-sources";

// Read on the ADMIN connection: has_table_privilege answers for any role.
//
// The law (migration 0038):
// - proposals are NOT evidence (spec §6.5). The golden-rule record (model
//   output, verdict, diff) lives on the row, and the evidence of a send is the
//   ledgered outbound log entry. Both roles therefore hold full CRUD.
// - log_entries stays evidence: SELECT, INSERT only, for both roles. 0038
//   widens the enum the entries table reads, and must not widen its grants.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

const ROLES = ["verder_app", "verder_worker"] as const;

describe("proposals grants and the entry_source enum", () => {
  let db: Db; let close: () => Promise<void>;

  beforeAll(() => {
    const c = createDb(ADMIN_URL);
    db = c.db;
    close = () => c.pool.end();
  });
  afterAll(() => close());

  async function can(role: string, table: string, privilege: string): Promise<boolean> {
    const r = await db.execute(
      sql`SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS ok`);
    return r.rows[0].ok === true;
  }

  it("app and worker hold delete on proposals", async () => {
    for (const role of ROLES) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await can(role, "proposals", p), `${role} ${p}`).toBe(true);
      }
    }
  });

  // The TypeScript list is what the pgEnum, every zod schema and the label map
  // are built from; if it and the database disagree, a value either cannot be
  // stored or cannot be shown. Order too: drizzle-kit diffs on it.
  it("entry_source includes proposal", async () => {
    const r = await db.execute(sql`SELECT unnest(enum_range(NULL::entry_source))::text AS v`);
    const values = r.rows.map((row) => String(row.v));
    expect(values).toContain("proposal");
    expect(values).toEqual([...ENTRY_SOURCES]);
  });

  it("log_entries grants unchanged", async () => {
    for (const role of ROLES) {
      for (const p of ["SELECT", "INSERT"]) {
        expect(await can(role, "log_entries", p), `${role} ${p}`).toBe(true);
      }
      for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) {
        expect(await can(role, "log_entries", p), `${role} ${p}`).toBe(false);
      }
    }
  });

  // One proposal per raw-email trigger, keyed on the trigger ALONE: a row born
  // `reply` may become `question` (Task 14), and a (trigger, kind) key would
  // then let an at-least-once retry insert a second `reply` beside it.
  // Follow-ups are exempt — a thread can be chased more than once.
  it("one proposal per raw-email trigger, follow-ups exempt", async () => {
    const r = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'proposals' AND indexname = 'proposals_trigger_uq'`);
    const def = String(r.rows[0]?.indexdef ?? "");
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/\(trigger_raw_email_id\)/);
    expect(def).toMatch(/follow-up/);
  });

  it("refuses a proposal with no trigger at all", async () => {
    await expect(db.execute(sql`
      INSERT INTO proposals (kind, status, priority, context)
      VALUES ('reply', 'drafting', 'other', '{}'::jsonb)`)).rejects.toThrow(/check/i);
  });
});
