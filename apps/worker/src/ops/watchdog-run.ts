// The `worker_runs` row for ops/watchdog.sh, plus the push when it healed
// something:
//
//   pnpm --filter worker watchdog-run --checked a,b --restarted a --problems code
//
// Every list item comes from a closed vocabulary and is validated here, so the
// row (and the push body) can only ever contain names this file knows.
import { createDb, type Db } from "@verder/db";
import { WATCHDOG_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { sendPush } from "../push";

const SERVICES = ["postgres", "web", "worker", "stalwart"] as const;
const MOUNTS = ["nas-workspace", "nas-download"] as const;
const PROBLEMS = {
  "scan-mount-missing": "NAS-scanmap niet gekoppeld op de host",
  "backup-mount-missing": "NAS-back-upmap niet gekoppeld op de host",
} as const;

export interface WatchdogReport {
  status: "ok" | "error";
  detail: { checked: string[] } | { restarted: string[]; reason: string };
  push: { title: string; body: string } | undefined;
}

function list(arg: string | undefined, allowed: readonly string[], flag: string): string[] {
  const items = (arg ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const it of items) {
    if (!allowed.includes(it)) throw new Error(`refusing unknown ${flag} item "${it.slice(0, 40)}"`);
  }
  return [...new Set(items)];
}

export function buildReport(args: string[]): WatchdogReport {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) flags.set(args[i], args[i + 1] ?? "");
  for (const k of flags.keys()) {
    if (!["--checked", "--restarted", "--problems"].includes(k)) {
      throw new Error(`unknown flag "${k.slice(0, 40)}"`);
    }
  }
  const checked = list(flags.get("--checked"), [...SERVICES, ...MOUNTS], "checked");
  const restarted = list(flags.get("--restarted"), [...SERVICES, ...MOUNTS], "restarted");
  const problems = list(flags.get("--problems"), Object.keys(PROBLEMS), "problems");

  if (restarted.length === 0 && problems.length === 0) {
    return { status: "ok", detail: { checked }, push: undefined };
  }
  const parts: string[] = [];
  if (restarted.length) parts.push(`Hersteld: ${restarted.join(", ")}`);
  for (const p of problems) parts.push(PROBLEMS[p as keyof typeof PROBLEMS]);
  return {
    status: "error",
    detail: { restarted, reason: `${parts.join(". ")}.` },
    push: restarted.length
      ? { title: "verder hersteld", body: `Automatisch hersteld: ${restarted.join(", ")}.` }
      : undefined,
  };
}

export async function runWatchdogReport(
  db: Db, report: WatchdogReport, push: typeof sendPush = sendPush,
): Promise<void> {
  await recordRun(db, WATCHDOG_WORKER_NAME, report.status, report.detail);
  if (!report.push) return;
  // The row is the durable record; a push failure must not undo it.
  try { await push(db, report.push); }
  catch (err) { console.error(`watchdog-run: push failed: ${String(err)}`); }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    await runWatchdogReport(db, buildReport(process.argv.slice(2)));
  } catch (err) {
    console.error(`watchdog-run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
