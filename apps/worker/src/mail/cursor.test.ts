import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { readCursor, writeCursor } from "./cursor";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("JMAP cursor", () => {
  it("is null before the first run, so the first poll is a full sync", async () => {
    const { db, pool } = createDb(URL);
    expect(await readCursor(db, `never-run-${Date.now()}`)).toBeNull();
    await pool.end();
  });

  it("round-trips the newest cursor and ignores older runs", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-test-${Date.now()}`;
    await writeCursor(db, w, "state-1", { ingested: 0 });
    await writeCursor(db, w, "state-2", { ingested: 3 });
    expect(await readCursor(db, w)).toBe("state-2");
    await pool.end();
  });

  // THE TRAP that bit gmail's retryAfter: readCursor takes the LATEST run, so a
  // run that forgets to carry the cursor forward silently resets the sync to
  // full and re-ingests everything.
  it("survives a run that recorded no cursor", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-gap-${Date.now()}`;
    await writeCursor(db, w, "state-1", { ingested: 1 });
    await writeCursor(db, w, "state-1", { skipped: "nothing to do" });
    expect(await readCursor(db, w)).toBe("state-1");
    await pool.end();
  });

  // FINDING 15. dashboard.ts selects DISTINCT ON (worker) worker, status — the
  // health tile reads the status COLUMN and nothing else. A poll that ingested
  // 0 of 40 must not show the same green as one that ingested all 40, or the
  // one signal that a mail was lost is invisible on the surface built to show
  // it. pollGmail has recorded `failures.length ? "error" : "ok"` all along.
  it("records the status it is given, so a failed poll is not green", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-status-${Date.now()}`;
    await writeCursor(db, w, "state-1", { failures: [{ id: "x", message: "boom" }] }, "error");
    const [run] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, w));
    expect(run.status).toBe("error");
    expect(await readCursor(db, w)).toBe("state-1");
    await pool.end();
  });

  // A first sync that failed has no earlier cursor to hold, so the run must
  // record NONE — readCursor then returns null and the next poll asks the whole
  // question again, which is the recoverable failure. Writing the new cursor
  // instead strands every message the failed pass did not ingest.
  it("omits the cursor entirely when there is none to carry forward", async () => {
    const { db, pool } = createDb(URL);
    const w = `cursor-none-${Date.now()}`;
    await writeCursor(db, w, null, { ingested: 0 }, "error");
    const [run] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, w));
    expect(run.detail).not.toHaveProperty("cursor");
    expect(await readCursor(db, w)).toBeNull();
    await pool.end();
  });

  // The third door into the sinceState blocker: jmap-port guards both of its
  // own writes with usableState(), but a blank string already sitting in a run
  // row would be read straight back out and sent as `sinceState: ""`.
  it("treats a blank recorded cursor as no cursor, not as a state", async () => {
    const { db, pool } = createDb(URL);
    for (const [name, blank] of [["empty", ""], ["spaces", "   "]] as const) {
      const w = `cursor-blank-${name}-${Date.now()}`;
      await writeCursor(db, w, blank, { ingested: 0 });
      expect(await readCursor(db, w)).toBeNull();
    }
    await pool.end();
  });
});
