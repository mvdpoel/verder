import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { recordRun } from "../heartbeat";

/**
 * The JMAP state string from the latest run of `worker`, or null for a first
 * sync. No new table for one string — worker_runs already carries per-run
 * detail, the same place gmail's retryAfter lives.
 */
export async function readCursor(db: Db, worker: string): Promise<string | null> {
  const [last] = await db.select({ detail: schema.workerRuns.detail })
    .from(schema.workerRuns).where(eq(schema.workerRuns.worker, worker))
    .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
  const raw = (last?.detail as { cursor?: unknown } | null)?.cursor;
  // A BLANK STATE IS NOT A STATE. RFC 8620 §5.2 types Email/changes'
  // `sinceState` as a required String with no "since nothing" form, so an
  // empty or whitespace-only cursor read back from a run row would be sent as
  // `sinceState: ""` — the same invalid request as the null one, wearing a
  // different spelling. jmap-port guards its own two writes with usableState();
  // this is the third door into the same room, and the only one on the read
  // side. The value itself is opaque and is returned VERBATIM, never trimmed:
  // a JMAP state string is the server's to define.
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/**
 * Record a run CARRYING THE CURSOR FORWARD. Every run must pass the cursor it
 * ended on, including a no-op run: readCursor takes the latest row, so a run
 * that drops it resets the sync to full and re-ingests the whole mailbox.
 *
 * `cursor` may be null — a first sync that failed has none to carry — and the
 * key is then OMITTED rather than written as null: readCursor returns null for
 * both, but a `"cursor": null` in the detail of a run reads to a human as "the
 * server gave us nothing", which is a different and untrue story.
 *
 * `status` is a REQUIRED-in-spirit argument with an ok default, because
 * dashboard.ts selects DISTINCT ON (worker) worker, status — the health tile
 * reads the status COLUMN and nothing else. Hardcoding "ok" here showed a poll
 * that ingested 0 of 40 in exactly the same green as one that ingested all 40,
 * which is the one signal that mail was lost, hidden on the surface built to
 * show it. pollGmail has recorded `failures.length ? "error" : "ok"` all along.
 */
export async function writeCursor(
  db: Db, worker: string, cursor: string | null, detail: object,
  status: "ok" | "error" = "ok",
): Promise<void> {
  await recordRun(db, worker, status,
    { ...detail, ...(cursor === null ? {} : { cursor }) });
}
