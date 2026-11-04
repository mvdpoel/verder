import { beforeAll, describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";

describe("search.health", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `ih${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("exposes the index counters to a signed-in user", async () => {
    const h = await caller().search.health();
    expect(h.chunks).toBeGreaterThanOrEqual(0);
    expect(h.outboxDepth).toBeGreaterThanOrEqual(0);
    expect(h.embedFailures).toBeGreaterThanOrEqual(0);
    expect(typeof h.degraded).toBe("boolean");
  });

  // Project law: the index is derived, never evidence. Reading its health must
  // not touch the chain.
  it("appends no ledger events", async () => {
    const [before] = await db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    await caller().search.health();
    const [after] = await db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    expect(after?.seq ?? 0).toBe(before?.seq ?? 0);
  });
});
