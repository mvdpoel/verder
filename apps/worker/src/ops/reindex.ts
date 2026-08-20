// Rebuild the search index. The index is derived: this is always safe to run, it is
// idempotent (unchanged text is never re-embedded) and it is safe to interrupt — rerun
// and it continues where it stopped.
//
//   pnpm --filter worker reindex
//   pnpm --filter worker reindex -- --entity=document --since=2026-01-01
//   pnpm --filter worker reindex -- --prune
//
// In production it runs inside the worker container, like nightly-verify:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker reindex
import { createDb } from "@verder/db";
import { realEmbedPort } from "@verder/api/src/search/embed";
import { recordRun } from "../heartbeat";
import { parseReindexArgs, runReindex } from "../reindex";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";

const { db, pool } = createDb(url);
try {
  // pnpm 10 forwards the `--` separator itself to the script, so `pnpm ... reindex --
  // --entity=party` arrives as ["--", "--entity=party"]. Drop that leading separator
  // here rather than in parseReindexArgs: every *real* argument stays strictly checked.
  const argv = process.argv.slice(2);
  const args = parseReindexArgs(argv[0] === "--" ? argv.slice(1) : argv);
  console.log(`reindex: start entity=${args.entity ?? "all"} since=${args.since?.toISOString() ?? "all"} prune=${args.prune}`);
  const result = await runReindex({
    db,
    embed: realEmbedPort(),
    // Progress every 50 entities: enough to watch a GPU-bound backfill move, quiet
    // enough for a cron log.
    onProgress: ({ entityType, done }) => {
      if (done % 50 === 0) console.log(`reindex: ${entityType} — ${done} done`);
    },
  }, args);
  console.log(`reindex: done — scanned ${result.scanned}, chunks ${result.chunks}, embedded ${result.embedded}, unchanged ${result.unchanged}, pruned ${result.pruned}`);
} catch (err) {
  await recordRun(db, "reindex", "error", { message: String(err) }).catch(() => {});
  console.error(`reindex: failed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
