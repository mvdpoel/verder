// What the host drafter should brief next (talking points, Added 2026-11-03):
//
//   pnpm --silent --filter worker briefs-pending --ids               # one party id per line
//   pnpm --silent --filter worker briefs-pending --prompt <partyId>  # that brief's prompt, raw
//
// Called ONLY by ops/proposal-drafter.sh on the host, after the proposals. The
// prompt is built HERE, in the worker, from the dossier; `--prompt` stores the
// context and the exact prompt on the party_briefs row and moves it to
// `drafting` before printing, so what the model saw is what is recorded.
// Exit 3 when the brief is no longer draftable or there is nothing to say.
//
// NOT EVIDENCE: no ledger event, here or anywhere.
import { createDb } from "@grip/db";
import { pendingBriefs, promptForBrief } from "../briefs/store";

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  const args = process.argv.slice(2);
  const { db, pool } = createDb(url);
  try {
    if (args.length === 2 && args[0] === "--prompt") {
      const prompt = await promptForBrief(db, args[1]);
      if (prompt === null) {
        console.error("briefs-pending: no draftable brief for that party");
        process.exitCode = 3;
      } else process.stdout.write(prompt);
    } else if (args.length === 1 && args[0] === "--ids") {
      for (const id of await pendingBriefs(db)) process.stdout.write(`${id}\n`);
    } else {
      console.error("briefs-pending: usage: --ids | --prompt <partyId>");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`briefs-pending: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
