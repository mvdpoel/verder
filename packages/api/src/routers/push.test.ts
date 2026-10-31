import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("push.registerDevice", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `pd${crypto.randomUUID()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  // 64 lowercase hex characters, unique per test run.
  const token = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
  const input = (t: string, over: Partial<{ appVersion: string; sessionId: string;
    environment: "development" | "production" }> = {}) => ({
    token: t, environment: "development" as const, bundleId: "pro.vanderpoel.verder" as const,
    appVersion: "1.0 (1)", sessionId: `sess-${crypto.randomUUID()}`, ...over });
  const rows = (t: string) => db.select().from(schema.pushDevices).where(eq(schema.pushDevices.token, t));

  it("upsert keeps one row per token", async () => {
    const t = token();
    const a = await caller().push.registerDevice(input(t, { appVersion: "1.0 (1)", sessionId: "s-a" }));
    const b = await caller().push.registerDevice(input(t, {
      appVersion: "1.1 (2)", sessionId: "s-b", environment: "production" }));
    expect(b.id).toBe(a.id);
    const got = await rows(t);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ appVersion: "1.1 (2)", sessionId: "s-b", environment: "production" });
  });

  it("re-register clears revoked_at", async () => {
    const t = token();
    const { id } = await caller().push.registerDevice(input(t));
    await db.update(schema.pushDevices)
      .set({ revokedAt: new Date(), revokedReason: "Unregistered", lastSeenAt: new Date(0) })
      .where(eq(schema.pushDevices.id, id));
    await caller().push.registerDevice(input(t));
    const [row] = await rows(t);
    expect(row.revokedAt).toBeNull();
    expect(row.revokedReason).toBeNull();
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses an uppercase or short token", async () => {
    await expect(caller().push.registerDevice(input(token().toUpperCase())))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().push.registerDevice(input("ab".repeat(16))))
      .rejects.toBeInstanceOf(TRPCError);
  });

  it("refuses a registration with no session id", async () => {
    const { sessionId: _, ...noSession } = input(token());
    await expect(caller().push.registerDevice(noSession as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("writes no ledger event", async () => {
    // Keyed on this device's own id (and on the entity type), so a concurrent
    // suite appending its own events cannot make this flaky.
    const { id } = await caller().push.registerDevice(input(token()));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents)
      .where(sql`${schema.ledgerEvents.entityId} = ${id}
        OR ${schema.ledgerEvents.entityType} IN ('push_device', 'push-device')`);
    expect(n).toBe(0);
  });

  it("needs a signed-in user", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.push.registerDevice(input(token()))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
