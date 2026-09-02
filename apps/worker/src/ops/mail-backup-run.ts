// The `worker_runs` row for the nightly mail backup — the half that runs inside
// the worker image, so ops/mail-backup.sh never needs a database client of its
// own.
//
//   pnpm --filter worker mail-backup-run ok
//   pnpm --filter worker mail-backup-run error <failing line> <exit status>
//
// THE HOLE THIS CLOSES, read out of the source 2026-09-02. Two facts, both
// checkable by grep: ops/mail-backup.sh wrote NOTHING anywhere the app can see
// (no `worker_runs` row, no entry in the dashboard taxonomy) and it is the LAST
// step of ops/nightly.sh, so nightly-verify and model-check have already written
// their green rows by the time it runs; and ops/mail-restore-drill.sh picks the
// newest archive by mtime (`sort -rn | head -1`) without ever asking how old it
// is. The consequence is a PROJECTION and is written as one: the panel would
// stay entirely green on a night the backup died, the monthly drill would keep
// PASSING on an archive that had stopped being replaced, and the whole thing
// would stay green for fourteen days until retention's `find -mtime +14 -delete`
// removed the last archive and the drill failed with "there is NOTHING to
// restore from" — at which point there would genuinely be nothing. Exactly the
// failure shape packages/api/src/worker-health.ts already removed one level down.
//
// IT HAS NOT HAPPENED, and saying so matters more than the story: this script
// first ran from cron on 2026-09-02 and the drill has only ever been run by hand,
// so there has been no fortnight of anything to observe. In this repo "MEASURED"
// means somebody watched it; this is read-from-source plus arithmetic.
//
// NO LEDGER EVENT. `worker_runs` is not an evidence table; it records that a job
// ran, not that anything happened to the case. This whole change appends zero
// `ledger_events` rows, which is why the chain head must not move when it
// deploys.
//
// WHY IT IS NOT A GENERIC "RECORD ANY RUN ROW" TOOL, and this is the important
// design constraint rather than a stylistic one. declFor() in worker-health.ts
// defaults an unknown `worker_runs.worker` to a WATCHER at 5 min × 3 — loud
// beats quiet, so a name nobody declared goes amber. That default is right for a
// worker somebody forgot to declare and catastrophic for a TYPO: `mail-bakcup`
// would be a row that is amber within fifteen minutes, permanently, and that
// nothing can ever clear, because no code path will ever write that name again.
// So the name is a compile-time constant here and the caller can only choose the
// STATUS. There is no argument that reaches `recordRun`'s `worker` parameter.
import { createDb } from "@verder/db";
import { MAIL_BACKUP_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";

/**
 * The one name this script may ever write, taken from the leaf module that holds
 * every `worker_runs.worker` string whose writer and reader sit in different
 * packages. Written here and read by the `nightly` declaration in
 * packages/api/src/worker-health.ts — two files that cannot see each other,
 * which is precisely what that module exists for: a rename that missed one half
 * would not throw, the dashboard would simply find no rows, and a backup that
 * has not run since March would render as nothing at all.
 */
export const BACKUP_WORKER = MAIL_BACKUP_WORKER_NAME;

export interface BackupOutcome {
  status: "ok" | "error";
  /** Undefined rather than `{}` when the caller passed no numbers: recordRun
   *  stores `null`, and an empty object on the dashboard reads as detail that
   *  went missing rather than detail that was never offered. */
  detail: { failedLine?: number; exitStatus?: number } | undefined;
}

/**
 * argv -> the row to write. Pure, so the whole contract is testable without a
 * database.
 *
 * THE STATUS IS REFUSED UNLESS IT IS EXACTLY `ok` OR `error`. Anything else
 * throws and no row is written, because `workerState` treats every string that
 * is not exactly "ok" as a failure: a caller that fumbled its argument into
 * "OK", "0", "success" or the empty string would silently paint the tile amber
 * and there would be no way to tell that from a backup that actually broke. The
 * trim exists only to absorb a shell's trailing newline; the comparison itself
 * is exact and case-sensitive.
 *
 * THE DETAIL IS NUMBERS ONLY, and that is a SECRET-SAFETY GUARANTEE BY
 * CONSTRUCTION rather than by trust. `worker_runs.detail` is rendered on the
 * dashboard and dumped off-box by the nightly pg_dump, so a free-text note from
 * a shell — `$BASH_COMMAND`, an error line, anything expanded from the
 * environment — is one careless interpolation away from carrying the JMAP app
 * password into a backup on the NAS. `mail-backup.sh` handles that password (it
 * passes `-e VANDELAY_PASSWORD` name-only for exactly the same reason), so the
 * two numbers it may send are the failing line and the exit status. The script
 * is in git; a line number is enough to find the command, and nothing else can
 * get through this parser.
 *
 * A JUNK NUMBER IS DROPPED, NEVER FATAL. This is called on the failure path,
 * where the row matters far more than its detail — the same discipline
 * mail-backup.sh applies to its manifest ("the count is a convenience, never a
 * gate"). Throwing on an unparseable line number would turn a reportable backup
 * failure back into silence, which is the bug this file exists to remove.
 */
export function parseOutcome(args: string[]): BackupOutcome {
  const raw = (args[0] ?? "").trim();
  if (raw === "") throw new Error("usage: mail-backup-run <ok|error> [line] [exit status]");
  if (raw !== "ok" && raw !== "error") {
    // The refused value is quoted and capped: it reaches a cron log that is
    // kept, and argv is whatever the shell handed over.
    throw new Error(`refusing to record status "${raw.slice(0, 40)}" — expected ok or error`);
  }

  const failedLine = smallNonNegativeInt(args[1]);
  const exitStatus = smallNonNegativeInt(args[2]);
  const detail: { failedLine?: number; exitStatus?: number } = {};
  if (failedLine !== undefined) detail.failedLine = failedLine;
  if (exitStatus !== undefined) detail.exitStatus = exitStatus;

  return {
    status: raw,
    detail: Object.keys(detail).length === 0 ? undefined : detail,
  };
}

/**
 * A decimal integer in 0..999_999, or undefined.
 *
 * The regex is anchored rather than handed to Number(), which accepts "0x10",
 * "1e3", " 12 " and "Infinity" — all of them ways for something that is not a
 * line number to end up looking like one in a row an operator will read at
 * 06:00. The upper bound is a sanity cap, not a limit anyone will meet: this
 * script is a few hundred lines and an exit status is 0..255.
 */
function smallNonNegativeInt(arg: string | undefined): number | undefined {
  const v = (arg ?? "").trim();
  if (!/^\d{1,6}$/.test(v)) return undefined;
  return Number.parseInt(v, 10);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Read exactly as ops/mail-restore-drill.ts reads it, so the two ops scripts
  // that write a row from inside the worker image agree on where the connection
  // comes from.
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    const outcome = parseOutcome(process.argv.slice(2));
    await recordRun(db, BACKUP_WORKER, outcome.status, outcome.detail);
  } catch (err) {
    /*
     * THE EXIT CODE ANSWERS "DID YOU RECORD IT?", NOT "DID THE BACKUP PASS?" —
     * the same rule ops/mail-restore-drill.sh's drill_fail had to learn the hard
     * way. The backup has already succeeded or failed by the time this runs, and
     * mail-backup.sh's own exit status is what says which. The only consumer of
     * this exit code is the `|| warn` around the call, whose warning is worth
     * printing only when it is true.
     */
    console.error(`mail-backup-run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
