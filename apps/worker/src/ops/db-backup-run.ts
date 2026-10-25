// The `worker_runs` row for the nightly Postgres dump + vault mirror, written
// from ops/nightly.sh through `docker compose exec worker`:
//
//   pnpm --filter worker db-backup-run ok
//   pnpm --filter worker db-backup-run error <reason code>
//
// Same shape as mail-backup-run.ts. The worker name is a constant, so a typo in
// the shell cannot mint a tile that no code path will ever clear. The reason is
// a closed code mapped to Dutch text here, so nothing free-form from a shell can
// reach `worker_runs.detail` (which the nightly pg_dump copies off-box).
import { createDb } from "@verder/db";
import { DB_BACKUP_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";

export const DB_BACKUP_REASONS = {
  "target-unmounted": "Back-upmap op de NAS niet gekoppeld",
  "dump-incomplete": "Database-dump onvolledig",
  "vault-mirror-failed": "Kluis-kopie naar de NAS mislukt",
} as const;

export type DbBackupReason = keyof typeof DB_BACKUP_REASONS;

export interface DbBackupOutcome {
  status: "ok" | "error";
  detail: { reason: DbBackupReason; message: string } | undefined;
}

export function parseOutcome(args: string[]): DbBackupOutcome {
  const status = (args[0] ?? "").trim();
  if (status === "") throw new Error("usage: db-backup-run <ok|error> [reason]");
  if (status === "ok") return { status, detail: undefined };
  if (status !== "error") {
    throw new Error(`refusing to record status "${status.slice(0, 40)}" — expected ok or error`);
  }
  const reason = (args[1] ?? "").trim();
  if (!Object.hasOwn(DB_BACKUP_REASONS, reason)) {
    throw new Error(`refusing unknown reason "${reason.slice(0, 40)}"`);
  }
  const code = reason as DbBackupReason;
  return { status, detail: { reason: code, message: DB_BACKUP_REASONS[code] } };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    const outcome = parseOutcome(process.argv.slice(2));
    await recordRun(db, DB_BACKUP_WORKER_NAME, outcome.status, outcome.detail);
  } catch (err) {
    // Exit code answers "did you record it?", not "did the backup pass?".
    console.error(`db-backup-run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
