// The researcher's answer, back into the dossier (Vraag Grip):
//
//   … | pnpm --silent --filter worker requests-store --id <uuid> --model <text>
//   pnpm --silent --filter worker requests-store --id <uuid> --model <text> --failed <reason>
//   pnpm --silent --filter worker requests-store --heartbeat [--busy]
//
// Called ONLY by ops/request-runner.sh on the host. The answer arrives on stdin
// and is untrusted: requests/store.ts checks every source, recipient,
// attachment and reply target against the request's tool log, and refuses the
// whole answer on any miss. Every call writes exactly one `request-runner` row.
import { createDb } from "@grip/db";
import { closeNotify, notifier } from "../notify/notify";
import { MAX_ANSWER_CHARS, recordRunnerHeartbeat, storeAnswer, storeRunnerFailure } from "../requests/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_TEXT = /^[\x20-\x7e]{1,120}$/;
const FAILURE_REASON = /^[a-z0-9-]{1,40}$/;

export type RequestStoreArgs =
  | { mode: "heartbeat"; busy: boolean }
  | { mode: "store"; id: string; model: string }
  | { mode: "failed"; id: string; model: string; reason: string };

export function parseRequestStoreArgs(args: string[]): RequestStoreArgs {
  if (args[0] === "--heartbeat") {
    if (args.length === 1) return { mode: "heartbeat", busy: false };
    if (args.length === 2 && args[1] === "--busy") return { mode: "heartbeat", busy: true };
    throw new Error("--heartbeat takes only --busy");
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!["--id", "--model", "--failed"].includes(k)) throw new Error(`unknown flag "${k.slice(0, 40)}"`);
    if (args[i + 1] === undefined) throw new Error(`${k} needs a value`);
    flags.set(k, args[i + 1]);
  }
  const id = flags.get("--id") ?? "";
  if (!UUID.test(id)) throw new Error("--id must be a uuid");
  const model = flags.get("--model") ?? "";
  if (!MODEL_TEXT.test(model)) throw new Error("--model must be 1-120 printable ASCII characters");
  const failed = flags.get("--failed");
  if (failed !== undefined) {
    if (!FAILURE_REASON.test(failed)) throw new Error("--failed must be a short [a-z0-9-] reason");
    return { mode: "failed", id, model, reason: failed };
  }
  return { mode: "store", id, model };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    const b = c as Buffer;
    size += b.length;
    if (size <= MAX_ANSWER_CHARS * 4 + 4) chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  let args: RequestStoreArgs;
  try { args = parseRequestStoreArgs(process.argv.slice(2)); }
  catch (err) { console.error(`requests-store: ${(err as Error).message}`); process.exit(2); }
  const { db, pool } = createDb(url);
  try {
    if (args.mode === "heartbeat") await recordRunnerHeartbeat(db, args.busy);
    else if (args.mode === "failed") {
      const r = await storeRunnerFailure(db, args, new Date(), notifier(db));
      console.log(`requests-store: ${args.id} ${r.outcome}`);
    } else {
      const r = await storeAnswer({ db, notify: notifier(db), vaultDir: process.env.VAULT_DIR ?? "./vault-files" },
        { id: args.id, model: args.model, answer: await readStdin() });
      // The outcome and the validator's reason only: never the answer itself.
      console.log(`requests-store: ${args.id} ${r.outcome}${r.reason ? ` (${r.reason.slice(0, 200)})` : ""}${r.proposalId ? ` proposal ${r.proposalId}` : ""}`);
      if (r.outcome === "failed" || r.outcome === "not-found") process.exitCode = 1;
    }
  } catch (err) {
    console.error(`requests-store: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeNotify();
    await pool.end();
  }
}
