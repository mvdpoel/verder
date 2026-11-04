import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";

// Shared dev postgres: assert only about the shape and the cap, never about
// rows other test files happen to have indexed.
describe("search.recent", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `sr${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("caps the list at the requested limit and gives every row a route", async () => {
    const rows = await caller().search.recent({ limit: 3 });
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(r.href).toMatch(/^\//);
  });

  it("defaults to 8 rows when called with no input", async () => {
    const rows = await caller().search.recent();
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});
