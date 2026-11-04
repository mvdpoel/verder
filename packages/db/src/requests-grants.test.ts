import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index";
import { REQUEST_STATUSES } from "./schema";

// Read on the ADMIN connection: has_table_privilege answers for any role.
//
// The law (migration 0044, Vraag Grip): a request is NOT evidence. It appends
// no ledger event, and the golden rule (prompt, model, tool log, model output,
// answer) is kept on the row. The web app creates, cancels and marks opened;
// the worker claims, logs tool calls and stores the answer. NO role holds
// DELETE: a request is the record of what Martin asked and what Grip answered.
// The proposal a request creates names it in `proposals.trigger_request_id`,
// and `compose` (a new mail, not a reply) joins the proposal kinds.
const ADMIN_URL = "postgres://grip:grip@localhost:5432/grip";

describe("requests (0044)", () => {
  let db: Db; let close: () => Promise<void>;
  beforeAll(() => { const c = createDb(ADMIN_URL); db = c.db; close = () => c.pool.end(); });
  afterAll(() => close());

  async function can(role: string, table: string, privilege: string): Promise<boolean> {
    const r = await db.execute(
      sql`SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS ok`);
    return r.rows[0].ok === true;
  }

  it("app and worker read, insert and update, and never delete", async () => {
    for (const role of ["grip_app", "grip_worker"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE"]) expect(await can(role, "requests", p), `${role} ${p}`).toBe(true);
      for (const p of ["DELETE", "TRUNCATE"]) expect(await can(role, "requests", p), `${role} ${p}`).toBe(false);
    }
  });

  it("the evidence tables' grants are unchanged by it", async () => {
    for (const role of ["grip_app", "grip_worker"]) {
      for (const t of ["log_entries", "ledger_events", "documents"]) {
        for (const p of ["UPDATE", "DELETE"]) expect(await can(role, t, p), `${role} ${t} ${p}`).toBe(false);
      }
    }
  });

  it("status check matches the TypeScript list", async () => {
    const r = await db.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'requests'::regclass AND conname = 'requests_status_check'`);
    const def = String(r.rows[0]?.def ?? "");
    for (const s of REQUEST_STATUSES) expect(def).toContain(`'${s}'`);
    expect([...REQUEST_STATUSES]).toEqual(["queued", "working", "answered", "failed", "cancelled"]);
  });

  // Inside a transaction that is rolled back; SAVEPOINTs let a refused INSERT
  // fail without aborting the rest.
  it("constraints: idempotent client id, answered needs an answer, compose needs only its request", async () => {
    const ROLLBACK = new Error("rollback");
    await expect(db.transaction(async (tx) => {
      const refused = async (q: ReturnType<typeof sql>) => {
        await tx.execute(sql`SAVEPOINT s`);
        try { await tx.execute(q); return false; }
        catch { await tx.execute(sql`ROLLBACK TO SAVEPOINT s`); return true; }
      };
      const client = crypto.randomUUID();
      const [r] = (await tx.execute(sql`INSERT INTO requests (client_id, text)
        VALUES (${client}, 'Zeg het abonnement op') RETURNING id, status`)).rows as { id: string; status: string }[];
      expect(r.status).toBe("queued");
      expect(await refused(sql`INSERT INTO requests (client_id, text) VALUES (${client}, 'nog eens')`)).toBe(true);
      expect(await refused(sql`INSERT INTO requests (client_id, text) VALUES (${crypto.randomUUID()}, '')`)).toBe(true);
      expect(await refused(sql`UPDATE requests SET status = 'answered' WHERE id = ${r.id}`)).toBe(true);
      expect(await refused(sql`UPDATE requests SET status = 'working' WHERE id = ${r.id}`)).toBe(true);
      expect(await refused(sql`UPDATE requests SET status = 'nonsense' WHERE id = ${r.id}`)).toBe(true);
      expect(await refused(sql`UPDATE requests SET parent_request_id = id WHERE id = ${r.id}`)).toBe(true);

      // A compose proposal whose only trigger is the request.
      const [p] = (await tx.execute(sql`INSERT INTO proposals (kind, status, priority, context, trigger_request_id)
        VALUES ('compose', 'pending', 'other', '{}'::jsonb, ${r.id}) RETURNING id`)).rows as { id: string }[];
      expect(p.id).toBeTruthy();
      // One proposal per request.
      expect(await refused(sql`INSERT INTO proposals (kind, status, priority, context, trigger_request_id)
        VALUES ('compose', 'pending', 'other', '{}'::jsonb, ${r.id})`)).toBe(true);
      expect(await refused(sql`INSERT INTO proposals (kind, status, priority, context)
        VALUES ('compose', 'pending', 'other', '{}'::jsonb)`)).toBe(true);
      expect(await refused(sql`INSERT INTO proposals (kind, status, priority, context, trigger_request_id)
        VALUES ('nonsense', 'pending', 'other', '{}'::jsonb, ${r.id})`)).toBe(true);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });

  it("0045: title, headline, steps_done and dismissed_at are additive, with the app's UPDATE unchanged", async () => {
    const cols = (await db.execute(sql`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'requests' AND column_name IN ('title', 'headline', 'steps_done', 'dismissed_at')
      ORDER BY column_name`)).rows as { column_name: string; is_nullable: string; column_default: string | null }[];
    expect(cols.map((c) => [c.column_name, c.is_nullable])).toEqual([
      ["dismissed_at", "YES"], ["headline", "YES"], ["steps_done", "NO"], ["title", "YES"]]);
    expect(cols.find((c) => c.column_name === "steps_done")?.column_default).toMatch(/'\{\}'::jsonb/);
    for (const p of ["DELETE", "TRUNCATE"]) expect(await can("grip_app", "requests", p)).toBe(false);
  });
});
