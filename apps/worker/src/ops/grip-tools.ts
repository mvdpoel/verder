// The read-only tool server for ONE Vraag Grip request, as a stdio MCP server:
//
//   pnpm --silent --filter worker grip-tools --request <uuid>
//
// Started by `claude -p` on the host through the MCP config ops/request-runner.sh
// writes, which runs it INSIDE the worker container with `docker compose exec -T`.
// One JSON-RPC message per line on stdin, one per line on stdout. STDOUT IS THE
// PROTOCOL: every log line goes to stderr, and console.log is rerouted there so
// no imported module can corrupt the stream by printing.
//
// Everything a tool reads runs inside SET TRANSACTION READ ONLY (requests/
// read-only.ts). The server's only writes are the per-call tool log on the
// request row and, on a Gmail 429, one `request-runner` run row with the deadline.
import { createInterface } from "node:readline";
import { createDb } from "@grip/db";
import { realEmbedPort } from "@grip/api/src/search/embed";
import { realGmailReadPort, type GmailReadPort } from "../requests/gmail-read";
import { parseError, ToolServer } from "../requests/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseToolsArgs(args: string[]): { requestId: string } {
  if (args.length !== 2 || args[0] !== "--request" || !UUID.test(args[1] ?? "")) {
    throw new Error("usage: grip-tools --request <uuid>");
  }
  return { requestId: args[1].toLowerCase() };
}

/** Feeds stdin lines to the server one at a time, in order, and writes each
 *  response as one line. Resolves when stdin closes and the last reply is out. */
export async function serveStdio(server: ToolServer, input: NodeJS.ReadableStream,
  write: (line: string) => void): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { write(JSON.stringify(parseError())); continue; }
    try {
      const out = await server.handle(msg);
      if (out) write(JSON.stringify(out));
    } catch (err) {
      const id = (msg as { id?: unknown })?.id ?? null;
      console.error(`grip-tools: ${err instanceof Error ? err.message : String(err)}`);
      write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } }));
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log = (...a: unknown[]) => console.error(...a);
  let requestId: string;
  try { ({ requestId } = parseToolsArgs(process.argv.slice(2))); }
  catch (err) { console.error(`grip-tools: ${(err as Error).message}`); process.exit(2); }
  const url = process.env.WORKER_DATABASE_URL ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  const { db, pool } = createDb(url);
  let gmail: Promise<GmailReadPort | null> | null = null;
  const server = new ToolServer({
    db, requestId, embed: realEmbedPort(), vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    gmail: () => (gmail ??= realGmailReadPort().catch((err) => {
      console.error(`grip-tools: gmail unavailable: ${String(err).slice(0, 200)}`);
      return null;
    })),
  });
  try {
    await serveStdio(server, process.stdin, (line) => process.stdout.write(`${line}\n`));
  } finally {
    await pool.end();
  }
}
