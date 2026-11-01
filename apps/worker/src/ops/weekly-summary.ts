// The Sunday summary by hand:
//
//   pnpm --filter worker weekly-summary --dry   # compose and print; sends nothing, records nothing
//   pnpm --filter worker weekly-summary         # the real thing: records the row and pushes
//
// The scheduled job is `weekly.summary` in src/index.ts; this is the same
// runWeeklySummary, so `--dry` prints exactly the body Sunday would send.
//
// The week is the newest one whose Sunday 18:00 Amsterdam has passed: run on
// Monday after a failed Sunday, it recovers THAT week (and takes its dedupKey),
// never the new one. Run before Sunday 18:00 it re-targets last week, whose
// push already went out, so the push is a refused duplicate — but a non-dry run
// still records a newest `ok` row with that week's counts. `waiting` and
// `topWaiting` are a snapshot taken when it runs, not on Sunday.
import { createDb } from "@verder/db";
import { closeNotify, notifier } from "../notify/notify";
import { runWeeklySummary } from "../weekly-summary";

const args = process.argv.slice(2).filter((a) => a !== "--");
const unknown = args.filter((a) => a !== "--dry");
if (unknown.length > 0) {
  console.error(`weekly-summary: unknown argument "${unknown[0].slice(0, 40)}" (only --dry)`);
  process.exit(2);
}
const dry = args.includes("--dry");

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
const { db, pool } = createDb(url);
try {
  const out = await runWeeklySummary({ db, notify: notifier(db) }, { dry });
  console.log(JSON.stringify({ dry, ...out }, null, 2));
} finally {
  await closeNotify();
  await pool.end();
}
