// What the host runner researches next (Vraag Grip):
//
//   pnpm --silent --filter worker requests-pending --claim         # one id, or nothing
//   pnpm --silent --filter worker requests-pending --prompt <id>   # that request's prompt, raw
//
// `--claim` first resets any request left `working` for more than 15 minutes
// (a dead runner) to `failed`, then moves the OLDEST queued request to
// `working`, building and storing its prompt in the same transaction, and
// prints its id. `--prompt` prints the stored prompt of a working request, so
// the prompt reaches `claude` byte for byte without a shell splitting it and
// ops/request-runner.sh needs no JSON parser.
import { createDb } from "@grip/db";
import { claimNext, promptFor } from "../requests/claim";

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  const args = process.argv.slice(2);
  const { db, pool } = createDb(url);
  try {
    if (args.length === 1 && args[0] === "--claim") {
      const r = await claimNext(db);
      for (const id of r.reset) console.error(`requests-pending: reset stuck request ${id}`);
      if (r.id) process.stdout.write(`${r.id}\n`);
    } else if (args.length === 2 && args[0] === "--prompt") {
      const prompt = await promptFor(db, args[1]);
      if (prompt === null) { console.error("requests-pending: no working request with that id"); process.exitCode = 3; }
      else process.stdout.write(prompt);
    } else {
      console.error("requests-pending: usage: --claim | --prompt <id>");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`requests-pending: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
