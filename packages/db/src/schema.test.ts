import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("schema", () => {
  it("inserts and reads a party", async () => {
    const { db, pool } = createDb(url);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "VerderGroep" }).returning();
    expect(p.id).toBeTruthy();
    const found = await db.select().from(schema.parties);
    expect(found.some((r) => r.id === p.id)).toBe(true);
    await pool.end();
  });
});
