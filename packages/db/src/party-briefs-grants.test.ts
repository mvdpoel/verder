import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index";
import { PARTY_BRIEF_STATUSES } from "./schema";

// Read on the ADMIN connection: has_table_privilege answers for any role.
//
// The law (migration 0042): a party brief — the ONE AI line on the phone's
// call screen — is NOT evidence. It appends no ledger event, and the golden
// rule (prompt, model output, model, prompt version) is kept on the row. The
// web app only READS it; the worker marks a party pending on ingest and the
// host drafter's store step writes the answer, so the worker holds SELECT,
// INSERT, UPDATE — and no role holds DELETE, because a brief is overwritten by
// the next draft, never removed, and its model output is the only record of
// what the model said.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

describe("party_briefs (0042)", () => {
  let db: Db; let close: () => Promise<void>;
  beforeAll(() => { const c = createDb(ADMIN_URL); db = c.db; close = () => c.pool.end(); });
  afterAll(() => close());

  async function can(role: string, privilege: string): Promise<boolean> {
    const r = await db.execute(
      sql`SELECT has_table_privilege(${role}, 'party_briefs', ${privilege}) AS ok`);
    return r.rows[0].ok === true;
  }

  it("app reads only", async () => {
    expect(await can("verder_app", "SELECT")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(await can("verder_app", p), p).toBe(false);
    }
  });

  it("worker reads, inserts and updates, and never deletes", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE"]) expect(await can("verder_worker", p), p).toBe(true);
    for (const p of ["DELETE", "TRUNCATE"]) expect(await can("verder_worker", p), p).toBe(false);
  });

  // The TypeScript list is what the pgEnum is built from; order too.
  it("status enum matches the TypeScript list", async () => {
    const r = await db.execute(sql`SELECT unnest(enum_range(NULL::party_brief_status))::text AS v`);
    expect(r.rows.map((row) => String(row.v))).toEqual([...PARTY_BRIEF_STATUSES]);
    expect([...PARTY_BRIEF_STATUSES]).toEqual(["pending", "drafting", "ready", "failed"]);
  });

  // Inside a transaction that is rolled back: a `parties` row is evidence
  // (party.created), and the shared dev database must not keep one with no
  // event. SAVEPOINTs let a refused INSERT fail without aborting the rest.
  it("a ready brief must carry its summary and its time; one row per party", async () => {
    const ROLLBACK = new Error("rollback");
    await expect(db.transaction(async (tx) => {
      const [p] = (await tx.execute(sql`INSERT INTO parties (kind, name)
        VALUES ('organization', ${`Brief Testfixture ${crypto.randomUUID()}`}) RETURNING id`)).rows as { id: string }[];
      const refused = async (q: ReturnType<typeof sql>) => {
        await tx.execute(sql`SAVEPOINT s`);
        try { await tx.execute(q); return false; }
        catch { await tx.execute(sql`ROLLBACK TO SAVEPOINT s`); return true; }
      };
      expect(await refused(sql`INSERT INTO party_briefs (party_id, status) VALUES (${p.id}, 'ready')`)).toBe(true);
      expect(await refused(sql`INSERT INTO party_briefs (party_id, status) VALUES (${p.id}, 'nonsense')`)).toBe(true);
      await tx.execute(sql`INSERT INTO party_briefs (party_id) VALUES (${p.id})`);
      expect(await refused(sql`INSERT INTO party_briefs (party_id) VALUES (${p.id})`)).toBe(true);
      const r = await tx.execute(sql`SELECT status, source_refs FROM party_briefs WHERE party_id = ${p.id}`);
      expect(r.rows[0]).toEqual({ status: "pending", source_refs: [] });
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
