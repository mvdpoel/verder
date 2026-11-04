// The brief drafter's answer, back into the dossier (talking points, Added 2026-11-03):
//
//   … | pnpm --silent --filter worker briefs-store --party <uuid> --model <text>
//   pnpm --silent --filter worker briefs-store --party <uuid> --model <text> --failed <reason>
//
// Called ONLY by ops/proposal-drafter.sh. The answer on stdin is untrusted:
// `validateBrief` refuses it unless every cited id is in the context stored on
// the row (the proposals-store discipline). Either way the raw answer is kept.
// Prints the outcome and the validator's reason only — never the answer.
//
// NOT EVIDENCE: no ledger event, here or anywhere.
import { createDb } from "@grip/db";
import { MAX_BRIEF_ANSWER_CHARS, storeBrief, storeBriefFailure } from "../briefs/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_TEXT = /^[\x20-\x7e]{1,120}$/;
const FAILURE_REASON = /^[a-z0-9-]{1,40}$/;

export type BriefStoreArgs =
  | { mode: "store"; partyId: string; model: string }
  | { mode: "failed"; partyId: string; model: string; reason: string };

export function parseBriefStoreArgs(args: string[]): BriefStoreArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!["--party", "--model", "--failed"].includes(k)) throw new Error(`unknown flag "${k.slice(0, 40)}"`);
    if (args[i + 1] === undefined) throw new Error(`${k} needs a value`);
    flags.set(k, args[i + 1]);
  }
  const partyId = flags.get("--party") ?? "";
  if (!UUID.test(partyId)) throw new Error("--party must be a uuid");
  const model = flags.get("--model") ?? "";
  if (!MODEL_TEXT.test(model)) throw new Error("--model must be 1-120 printable ASCII characters");
  const failed = flags.get("--failed");
  if (failed !== undefined) {
    if (!FAILURE_REASON.test(failed)) throw new Error("--failed must be a short [a-z0-9-] reason");
    return { mode: "failed", partyId, model, reason: failed };
  }
  return { mode: "store", partyId, model };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    const b = c as Buffer;
    size += b.length;
    // Keep reading past the cap (the writer is never blocked) but stop storing.
    if (size <= MAX_BRIEF_ANSWER_CHARS * 4 + 4) chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  let args: BriefStoreArgs;
  try { args = parseBriefStoreArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(`briefs-store: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { db, pool } = createDb(url);
  try {
    const r = args.mode === "failed"
      ? await storeBriefFailure(db, args)
      : await storeBrief(db, { partyId: args.partyId, model: args.model, answer: await readStdin() });
    console.log(`briefs-store: ${args.partyId} ${r.outcome}${r.reason ? ` (${r.reason.slice(0, 200)})` : ""}`);
    if (r.outcome === "not-found") process.exitCode = 1;
  } catch (err) {
    console.error(`briefs-store: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
