import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@grip/db";
import { recordRun } from "./heartbeat";

const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";

describe("recordRun", () => {
  it("records worker heartbeats", async () => {
    const { db, pool } = createDb(URL);
    await recordRun(db, "test-worker", "ok", { polled: 3 });
    const [row] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "test-worker"))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
    expect(row.status).toBe("ok");
    await pool.end();
  });
});
