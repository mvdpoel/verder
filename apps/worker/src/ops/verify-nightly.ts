// Nightly full-chain verification. Runs inside the worker container from
// ops/nightly.sh. Uses the exact same implementation as the verify.run tRPC
// router (packages/api/src/verification.ts) so the nightly result and the
// Verify page can never disagree. Writes the outcome to worker_runs and exits
// non-zero on a broken chain so the cron log surfaces it.
import { createDb } from "@verder/db";
import { runFullVerification } from "@verder/api/src/verification";
import { recordRun } from "../heartbeat";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
const vaultDir = process.env.VAULT_DIR ?? "./vault-files";

const { db, pool } = createDb(url);
try {
  const result = await runFullVerification(db, vaultDir);
  await recordRun(db, "nightly-verify", result.ok ? "ok" : "error", result);
  if (result.ok) {
    console.log(`nightly-verify: OK — ${result.count} events, ${result.checkedFiles} files checked, head=${result.headHash}`);
  } else {
    console.error(`nightly-verify: BROKEN at seq ${result.brokenAtSeq} (${result.reason})`);
    process.exitCode = 1;
  }
} catch (err) {
  await recordRun(db, "nightly-verify", "error", { message: String(err) }).catch(() => {});
  console.error(`nightly-verify: crashed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
