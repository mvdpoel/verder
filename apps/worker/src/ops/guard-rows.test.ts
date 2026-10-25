import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { eq, desc } from "drizzle-orm";
import { DB_BACKUP_WORKER_NAME, WATCHDOG_WORKER_NAME } from "@verder/api/src/worker-names";
import { declFor } from "@verder/api/src/worker-health";
import { parseOutcome } from "./db-backup-run";
import { buildReport, runWatchdogReport } from "./watchdog-run";

describe("db-backup-run", () => {
  it("records ok without detail and error with a Dutch message from a closed code", () => {
    expect(parseOutcome(["ok"])).toEqual({ status: "ok", detail: undefined });
    expect(parseOutcome(["error", "target-unmounted"])).toEqual({
      status: "error",
      detail: { reason: "target-unmounted", message: "Back-upmap op de NAS niet gekoppeld" } });
    expect(parseOutcome(["error", "dump-incomplete"]).detail?.message).toBe("Database-dump onvolledig");
  });

  it("refuses anything outside the vocabulary", () => {
    expect(() => parseOutcome([])).toThrow(/usage/);
    expect(() => parseOutcome(["OK"])).toThrow(/expected ok or error/);
    expect(() => parseOutcome(["error"])).toThrow(/unknown reason/);
    expect(() => parseOutcome(["error", "toString"])).toThrow(/unknown reason/);
    expect(() => parseOutcome(["error", "pw=hunter2"])).toThrow(/unknown reason/);
  });
});

describe("watchdog-run", () => {
  it("nothing healed: ok row listing what was checked, no push", () => {
    expect(buildReport(["--checked", "postgres,web", "--restarted", "", "--problems", ""])).toEqual({
      status: "ok", detail: { checked: ["postgres", "web"] }, push: undefined });
  });

  it("healed: error row with Dutch reason and a push naming what was restarted", () => {
    expect(buildReport(["--checked", "web", "--restarted", "postgres,worker", "--problems", ""])).toEqual({
      status: "error",
      detail: { restarted: ["postgres", "worker"], reason: "Hersteld: postgres, worker." },
      push: { title: "verder hersteld", body: "Automatisch hersteld: postgres, worker." } });
  });

  it("an unfixable problem is an error row but never a push", () => {
    expect(buildReport(["--checked", "", "--restarted", "", "--problems", "scan-mount-missing"])).toEqual({
      status: "error",
      detail: { restarted: [], reason: "NAS-scanmap niet gekoppeld op de host." },
      push: undefined });
  });

  it("refuses names and flags it does not know", () => {
    expect(() => buildReport(["--restarted", "rm -rf"])).toThrow(/unknown restarted item/);
    expect(() => buildReport(["--note", "x"])).toThrow(/unknown flag/);
  });

  it("writes the row, then pushes; a failing push keeps the row", async () => {
    const { db, pool } = createDb(
      process.env.WORKER_DATABASE_URL ?? "postgres://verder_worker:verder_worker@localhost:5432/verder");
    const pushed: unknown[] = [];
    await runWatchdogReport(db,
      buildReport(["--restarted", "web"]), async (_d, p) => { pushed.push(p); });
    const [row] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, WATCHDOG_WORKER_NAME))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
    expect(row.status).toBe("error");
    expect(row.detail).toEqual({ restarted: ["web"], reason: "Hersteld: web." });
    expect(pushed).toEqual([{ title: "verder hersteld", body: "Automatisch hersteld: web." }]);
    await runWatchdogReport(db, buildReport(["--restarted", "web"]), async () => { throw new Error("vapid"); });
    await pool.end();
  });
});

describe("taxonomy", () => {
  it("declares the two new rows", () => {
    expect(DB_BACKUP_WORKER_NAME).toBe("db-backup");
    expect(declFor("db-backup")).toEqual({ kind: "nightly" });
    expect(WATCHDOG_WORKER_NAME).toBe("watchdog");
    expect(declFor("watchdog")).toEqual({ kind: "watcher", everyMs: 5 * 60_000 });
  });
});
