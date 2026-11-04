// THE WHOLE VRAAG GRIP LOOP, WITHOUT CLAUDE, AGAINST THE DEV DATABASE:
//
//   pnpm --filter worker requests-dry-run [--with-proposal] [--forged] [--in-process] [--text "…"]
//
// queue → claim (stuck reset, prompt built and stored) → the REAL grip-tools
// server over stdio (spawned exactly as the host runner's MCP config starts it,
// minus docker) → a FAKE model answer built only from what the tools showed →
// requests-store's validation → answered (or failed) → the push (printed, never
// sent) → loadWaiting counts the answer → the phone's GET /requests/<id> view.
//
//   --with-proposal  the fake answer carries a compose proposal to an address a
//                    tool showed, attaching a document a tool showed; it lands
//                    `pending` with trigger_request_id, on the existing approval path
//   --forged         the fake answer cites an id no tool showed: must be REFUSED
//   --in-process     talk to the ToolServer in this process instead of spawning it
//
// It REFUSES any database that is not on localhost: it writes a request (and
// maybe a pending proposal) and must never touch production. Nothing is sent,
// nothing is ledgered; a dry-run proposal can be rejected on /queue like any other.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@grip/db";
import { loadWaiting } from "@grip/api/src/waiting";
import { appRouter } from "@grip/api/src/root";
import { createContext } from "@grip/api/src/trpc";
import type { EmbedPort } from "@grip/api/src/search/embed";
import { claimNext, promptFor } from "../requests/claim";
import { REQUEST_PROMPT_VERSION } from "../requests/prompt";
import { ToolServer } from "../requests/server";
import { storeAnswer, type StoreResult } from "../requests/store";
import type { NotifyFn, NotifyInput } from "../notify/notify";

export interface DryRunOptions {
  db: Db;
  withProposal?: boolean;
  forged?: boolean;
  /** Spawn the real stdio server (default) or call the ToolServer in-process. */
  spawnTools?: boolean;
  text?: string;
  embed?: EmbedPort;
  workerUrl?: string;
  log?: (line: string) => void;
}

export interface DryRunResult {
  requestId: string;
  toolCalls: string[];
  store: StoreResult;
  pushes: NotifyInput[];
  waitingHasRequest: boolean;
  proposal: { id: string; status: string; kind: string; triggerRequestId: string | null } | null;
}

/** The dev guard: a dry run writes rows, so only ever on localhost. */
export function assertDevUrl(url: string): void {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* fall through */ }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`requests-dry-run refuses a non-local database (${host || "unparseable url"})`);
  }
}

const withoutGmail = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GMAIL_")));

type Rpc = (method: string, params?: unknown) => Promise<{ result?: Record<string, unknown>; error?: unknown }>;

function spawnedRpc(requestId: string, workerUrl: string): { rpc: Rpc; close: () => Promise<void> } {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn("npx", ["tsx", "src/ops/grip-tools.ts", "--request", requestId], {
    // No Gmail credentials reach the child: a dry run never calls Google, so
    // gmail_search answers "not configured" and the loop still completes.
    cwd, env: { ...withoutGmail(process.env), WORKER_DATABASE_URL: workerUrl }, stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: unknown }) => void>();
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const msg = JSON.parse(line) as { id: number; result?: Record<string, unknown>; error?: unknown };
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  const rpc: Rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return {
    rpc,
    close: () => new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin!.end();
    }),
  };
}

function inProcessRpc(server: ToolServer): Rpc {
  let next = 1;
  return async (method, params) =>
    (await server.handle({ jsonrpc: "2.0", id: next++, method, params })) as { result?: Record<string, unknown> };
}

const nullEmbed: EmbedPort = { embed: async (texts) => texts.map(() => null) };

export async function dryRun(o: DryRunOptions): Promise<DryRunResult> {
  const log = o.log ?? (() => {});
  const db = o.db;
  const [request] = await db.insert(schema.requests).values({
    clientId: crypto.randomUUID(),
    text: o.text ?? "Dry run: welke documenten en partijen heeft Grip, en moet ik iemand mailen?",
  }).returning();
  log(`queued ${request.id}`);

  const claimed = await claimNext(db, new Date(), { onlyId: request.id });
  if (claimed.id !== request.id) throw new Error("dry run: could not claim its own request");
  const prompt = await promptFor(db, request.id);
  log(`claimed; prompt ${prompt?.length ?? 0} chars, version ${REQUEST_PROMPT_VERSION}`);

  const spawned = o.spawnTools !== false && o.workerUrl ? spawnedRpc(request.id, o.workerUrl) : null;
  const rpc = spawned?.rpc ?? inProcessRpc(new ToolServer({
    db, requestId: request.id, embed: o.embed ?? nullEmbed, gmail: async () => null, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
  }));
  const toolCalls: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    toolCalls.push(name);
    const r = await rpc("tools/call", { name, arguments: args });
    const content = (r.result?.content as { text: string }[] | undefined)?.[0]?.text ?? "{}";
    log(`  ${name} → ${content.length} chars${r.result?.isError ? " (error)" : ""}`);
    try { return JSON.parse(content) as Record<string, unknown>; } catch { return { error: content }; }
  };

  let documentsShown: { id: string; title: string }[] = [];
  let addressShown: string | null = null;
  let partyShown: { id: string; name: string } | null = null;
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dry-run", version: "1" } });
    log(`initialize → ${(init.result?.serverInfo as { name?: string })?.name}`);
    const tools = await rpc("tools/list");
    log(`tools/list → ${(tools.result?.tools as unknown[]).length} tools`);
    await call("search", { query: "loonstrook" });
    const docs = await call("list_documents", { limit: 3 });
    documentsShown = ((docs.items ?? []) as { id: string; title: string }[]);
    if (documentsShown[0]) await call("get_document", { id: documentsShown[0].id });
    const parties = await call("list_parties", { limit: 30 });
    const withEmail = ((parties.items ?? []) as { id: string; name: string; addresses: string[] }[])
      .find((p) => p.addresses?.length);
    partyShown = withEmail ?? ((parties.items ?? []) as { id: string; name: string }[])[0] ?? null;
    addressShown = withEmail?.addresses[0] ?? null;
    await call("case_map", {});
    await call("gmail_search", { query: "newer_than:7d" });
  } finally {
    await spawned?.close();
  }

  // THE FAKE MODEL ANSWER: built only from what the tools showed — or, with
  // --forged, citing an id no tool showed, which the store must refuse.
  const sources: Record<string, string>[] = [];
  if (documentsShown[0]) sources.push({ type: "document", id: documentsShown[0].id, why: "Het nieuwste document in het dossier." });
  if (partyShown) sources.push({ type: "party", id: partyShown.id, why: "Een partij uit het dossier." });
  if (o.forged) sources.push({ type: "document", id: crypto.randomUUID(), why: "Een document dat geen tool liet zien." });
  const proposal = o.withProposal && addressShown ? {
    kind: "compose", to: [addressShown], cc: [], subject: "Dry run: vraag over mijn dossier",
    body: "Geachte heer, mevrouw,\n\nDit is een proefconcept van Grip.\n\nMet vriendelijke groet,\nMartin van der Poel",
    attachments: documentsShown[0] ? [documentsShown[0].id] : [], inReplyTo: null,
  } : null;
  if (o.withProposal && !addressShown) log("no party with an address was shown; the answer carries no proposal");
  const answer = JSON.stringify({
    answer: `Dit is een proefantwoord. Grip zag ${documentsShown.length} document(en)${partyShown ? ` en de partij ${partyShown.name}` : ""}.`,
    sources, martinSteps: ["Niets: dit was een proefrun."], proposal,
  });

  const pushes: NotifyInput[] = [];
  const notify: NotifyFn = async (n) => {
    pushes.push(n);
    log(`push (not sent): ${n.title} — ${n.body} [${n.link}]`);
    return { notificationId: null, duplicate: false, delivered: 0, failed: 0, skipped: 1 };
  };
  const store = await storeAnswer({ db, notify, vaultDir: process.env.VAULT_DIR ?? "./vault-files" },
    { id: request.id, model: "dry-run (no model)", answer });
  log(`requests-store → ${store.outcome}${store.reason ? ` (${store.reason})` : ""}`);

  const waitingHasRequest = (await loadWaiting(db)).some((i) => i.kind === "request" && i.id === request.id);
  const [p] = store.proposalId ? await db.select().from(schema.proposals).where(eq(schema.proposals.id, store.proposalId)) : [];
  return {
    requestId: request.id, toolCalls, store, pushes, waitingHasRequest,
    proposal: p ? { id: p.id, status: p.status, kind: p.kind, triggerRequestId: p.triggerRequestId } : null,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const url = process.env.WORKER_DATABASE_URL ?? "postgres://grip_worker:grip_worker@localhost:5432/grip";
  const appUrl = process.env.DATABASE_URL ?? "postgres://grip_app:grip_app@localhost:5432/grip";
  try { assertDevUrl(url); assertDevUrl(appUrl); }
  catch (err) { console.error((err as Error).message); process.exit(2); }
  const textAt = args.indexOf("--text");
  const { db, pool } = createDb(url);
  const app = createDb(appUrl);
  try {
    const r = await dryRun({
      db, workerUrl: url, withProposal: args.includes("--with-proposal"), forged: args.includes("--forged"),
      spawnTools: !args.includes("--in-process"), text: textAt >= 0 ? args[textAt + 1] : undefined,
      log: (l) => console.log(l),
    });
    console.log(`waiting on Martin: ${r.waitingHasRequest ? "yes" : "no"}`);
    if (r.proposal) console.log(`proposal ${r.proposal.id}: ${r.proposal.kind} ${r.proposal.status}, trigger_request_id ${r.proposal.triggerRequestId}`);
    // The phone's view, through the real router as grip_app.
    const [u] = await app.db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (u) {
      const view = await appRouter.createCaller(createContext({ db: app.db, userId: u.id })).requests.get({ id: r.requestId });
      console.log(`GET /requests/${r.requestId}: ${view.status}, ${view.sources.length} sources, proposal ${view.proposal ? view.proposal.status : "none"}`);
    }
    const expectOk = !args.includes("--forged");
    if ((r.store.outcome === "answered") !== expectOk) process.exitCode = 1;
  } catch (err) {
    console.error(`requests-dry-run: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await app.pool.end();
  }
}
