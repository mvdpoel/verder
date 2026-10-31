import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index";

// Read on the ADMIN connection: has_table_privilege answers for any role, so one
// connection states the whole grant law for both application roles at once.
//
// The law (migration 0037):
// - push_devices is a delivery address, not evidence: both roles may DELETE it,
//   because a lost phone must be removable outright.
// - notifications and notification_attempts are the delivery record. The worker
//   writes them, the app reads them, and NOBODY edits or deletes them — that is
//   what keeps "sent but never arrived" diagnosable.
// - the worker may read a session's id and expiry, never its token.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

const ROLES = ["verder_app", "verder_worker"] as const;

describe("push and notification grants", () => {
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

  async function canColumn(role: string, table: string, column: string, privilege: string): Promise<boolean> {
    const r = await db.execute(
      sql`SELECT has_column_privilege(${role}, ${table}, ${column}, ${privilege}) AS ok`);
    return r.rows[0].ok === true;
  }

  it("app and worker may delete push_devices", async () => {
    for (const role of ROLES) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await can(role, "push_devices", p), `${role} ${p}`).toBe(true);
      }
    }
  });

  it("app may not insert notifications", async () => {
    for (const t of ["notifications", "notification_attempts"]) {
      expect(await can("verder_app", t, "SELECT"), `app SELECT ${t}`).toBe(true);
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        expect(await can("verder_app", t, p), `app ${p} ${t}`).toBe(false);
      }
    }
  });

  it("worker may not update or delete notifications or notification_attempts", async () => {
    for (const t of ["notifications", "notification_attempts"]) {
      expect(await can("verder_worker", t, "SELECT"), `worker SELECT ${t}`).toBe(true);
      expect(await can("verder_worker", t, "INSERT"), `worker INSERT ${t}`).toBe(true);
      expect(await can("verder_worker", t, "UPDATE"), `worker UPDATE ${t}`).toBe(false);
      expect(await can("verder_worker", t, "DELETE"), `worker DELETE ${t}`).toBe(false);
    }
  });

  // 0006's law: a dead web-push subscription is revoked by UPDATE, never
  // deleted. 0037 must not widen it by accident while granting on its neighbour.
  it("push_subscriptions grants are unchanged", async () => {
    for (const role of ROLES) {
      for (const p of ["SELECT", "INSERT", "UPDATE"]) {
        expect(await can(role, "push_subscriptions", p), `${role} ${p}`).toBe(true);
      }
      expect(await can(role, "push_subscriptions", "DELETE"), `${role} DELETE`).toBe(false);
    }
  });

  // COLUMN-level on purpose: notify() needs to know a device's session was
  // revoked or expired (a lost phone), and it never needs a bearer token.
  it("worker may read session id and expires_at but not token", async () => {
    expect(await canColumn("verder_worker", "session", "id", "SELECT")).toBe(true);
    expect(await canColumn("verder_worker", "session", "expires_at", "SELECT")).toBe(true);
    expect(await canColumn("verder_worker", "session", "token", "SELECT")).toBe(false);
    expect(await can("verder_worker", "session", "SELECT")).toBe(false);
  });
});
