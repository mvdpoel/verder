// What the host drafter should draft next (spec §6.5):
//
//   pnpm --silent --filter worker proposals-pending              # JSON lines {id, prompt}
//   pnpm --silent --filter worker proposals-pending --ids        # one id per line
//   pnpm --silent --filter worker proposals-pending --prompt <id> # that row's prompt, raw
//
// `drafting` rows, oldest first, at most DRAFT_BATCH per run. The prompt is
// built HERE, in the worker, from the context stored on the row; the host only
// pipes it into `claude -p`. `--ids`/`--prompt` exist so ops/proposal-drafter.sh
// needs no JSON parser on the host (nothing guarantees `jq` there), and the
// prompt reaches `claude` byte for byte without a shell ever splitting it.
//
// A row created before the drafter landed has a NULL prompt; it is built from
// the stored context and WRITTEN BACK, so `proposals.prompt` always records the
// exact prompt the drafter saw (golden rule).
import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import type { ProposalKind } from "@verder/api/src/proposal-state";
import type { ProposalContext } from "../proposals/context";
import { buildProposalPrompt } from "../proposals/draft-prompt";

export const DRAFT_BATCH = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof schema.proposals.$inferSelect;

async function ensurePrompt(db: Db, row: Row): Promise<string> {
  if (row.prompt !== null) return row.prompt;
  const prompt = buildProposalPrompt(row.context as ProposalContext, row.kind as ProposalKind);
  await db.update(schema.proposals).set({ prompt, updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, row.id), isNull(schema.proposals.prompt),
      eq(schema.proposals.status, "drafting")));
  return prompt;
}

export async function pendingDrafts(db: Db, limit = DRAFT_BATCH): Promise<{ id: string; prompt: string }[]> {
  const rows = await db.select().from(schema.proposals)
    .where(eq(schema.proposals.status, "drafting"))
    .orderBy(asc(schema.proposals.createdAt), asc(schema.proposals.id))
    .limit(limit);
  const out: { id: string; prompt: string }[] = [];
  for (const row of rows) out.push({ id: row.id, prompt: await ensurePrompt(db, row) });
  return out;
}

/** The prompt of one row that is still `drafting`, else null. */
export async function promptForDraft(db: Db, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, id));
  if (!row || row.status !== "drafting") return null;
  return ensurePrompt(db, row);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const args = process.argv.slice(2);
  const { db, pool } = createDb(url);
  try {
    if (args[0] === "--prompt") {
      const prompt = await promptForDraft(db, args[1] ?? "");
      if (prompt === null) {
        console.error("proposals-pending: no drafting proposal with that id");
        process.exitCode = 3;
      } else process.stdout.write(prompt);
    } else if (args[0] === "--ids") {
      for (const { id } of await pendingDrafts(db)) process.stdout.write(`${id}\n`);
    } else if (args.length === 0) {
      for (const d of await pendingDrafts(db)) process.stdout.write(`${JSON.stringify(d)}\n`);
    } else {
      console.error("proposals-pending: usage: [--ids | --prompt <id>]");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`proposals-pending: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
