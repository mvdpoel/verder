import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import type { EmbedPort } from "@grip/api/src/search/embed";
import { REQUEST_RUNNER_WORKER_NAME } from "@grip/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { rateLimitDeadline } from "../proposals/send";
import type { GmailReadPort } from "./gmail-read";
import { jsonSchemaOf } from "./json-schema";
import { fitResult, refsOf, sha256 } from "./output";
import { runReadOnly } from "./read-only";
import { GmailRateLimited, TOOLS, toolByName, type ToolDef, type ToolResult } from "./tools";

/**
 * `grip-tools` — THE READ-ONLY TOOL SERVER (Vraag Grip spec, "The tools").
 *
 * A Model Context Protocol server over stdio, hand-rolled JSON-RPC 2.0 with one
 * message per line (the MCP stdio transport), started INSIDE the worker
 * container by the host runner for ONE request:
 *
 *   docker compose exec -T worker pnpm --silent --filter worker grip-tools --request <id>
 *
 * WHAT IT GUARANTEES, and where:
 *   - every tool reads inside `SET TRANSACTION READ ONLY` (`runReadOnly`) — the
 *     server wraps the call, a tool cannot opt out;
 *   - per-request caps: CAPS.total calls, 10 `gmail_search`, 20 `gmail_read`;
 *     the counts are read from the request's own tool log, so a restarted
 *     server cannot grant a second allowance;
 *   - every result is at most 8 000 characters (`fitResult`), and the ids it
 *     SHOWED are written to the tool log with a hash of the result, per call —
 *     which is what `requests-store` checks every citation against;
 *   - a request no longer `working` (cancelled, reset, answered) gets no more
 *     tool results: the log write is conditional on the status.
 *
 * The ONLY writes it makes are that log append and, on a Gmail 429, one
 * `request-runner` run row carrying the deadline (the account-wide memory
 * `rateLimitedUntil` reads). Both are outside the read-only transaction and
 * neither touches an evidence table.
 */

export const CAPS = { total: 60, gmail_search: 10, gmail_read: 20 } as const;
export const SERVER_NAME = "grip-tools";
const ARGS_LOG_CHARS = 1000;

export interface ServerDeps {
  /** The worker's pool. Reads go through runReadOnly; only the log is written. */
  db: Db;
  requestId: string;
  embed: EmbedPort;
  gmail: () => Promise<GmailReadPort | null>;
  vaultDir: string;
  now?: () => Date;
  /** Tests only: a different tool set. Production always serves TOOLS. */
  tools?: readonly ToolDef[];
}

export interface CallOutcome { text: string; isError: boolean }

type Json = Record<string, unknown>;
type ToolLogEntry = typeof schema.requests.$inferSelect["toolLog"][number];

const argsForLog = (args: unknown): unknown => {
  const s = JSON.stringify(args ?? {});
  return s.length <= ARGS_LOG_CHARS ? args ?? {} : { truncated: s.slice(0, ARGS_LOG_CHARS) };
};

export function toolList(tools: readonly ToolDef[] = TOOLS) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.args) }));
}

export class ToolServer {
  private readonly now: () => Date;
  constructor(private readonly deps: ServerDeps) { this.now = deps.now ?? (() => new Date()); }

  /** One JSON-RPC message in; the response, or null for a notification. */
  async handle(msg: unknown): Promise<Json | null> {
    const m = (msg ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = m.id !== undefined && m.id !== null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: hasId ? m.id : null, error: { code, message } });
    if (typeof m.method !== "string") return fail(-32600, "invalid request");
    if (!hasId) return null; // notifications/initialized, notifications/cancelled, …
    switch (m.method) {
      case "initialize": {
        const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return reply({
          protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: "1.0.0" },
          instructions: "Read-only tools over Martin's dossier for one Grip request. Nothing here can write, file or send.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: toolList(this.deps.tools) });
      case "tools/call": {
        const p = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof p.name !== "string") return fail(-32602, "tools/call needs a tool name");
        const out = await this.call(p.name, p.arguments ?? {});
        return reply({ content: [{ type: "text", text: out.text }], isError: out.isError });
      }
      default: return fail(-32601, `method not found: ${m.method.slice(0, 60)}`);
    }
  }

  /** The request's status and how many calls of each tool it has made. */
  private async budget(): Promise<{ status: string | null; counts: Map<string, number>; total: number }> {
    const [r] = await this.deps.db.select({ status: schema.requests.status, log: schema.requests.toolLog })
      .from(schema.requests).where(eq(schema.requests.id, this.deps.requestId));
    const counts = new Map<string, number>();
    for (const c of r?.log ?? []) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
    return { status: r?.status ?? null, counts, total: r?.log.length ?? 0 };
  }

  /** Append one entry, only while the request is still `working`. */
  private async log(entry: ToolLogEntry): Promise<boolean> {
    const rows = await this.deps.db.execute(sql`UPDATE requests
      SET tool_log = tool_log || ${JSON.stringify([entry])}::jsonb, updated_at = now()
      WHERE id = ${this.deps.requestId} AND status = 'working' RETURNING id`);
    return rows.rows.length > 0;
  }

  async call(name: string, rawArgs: unknown): Promise<CallOutcome> {
    const started = Date.now();
    const at = this.now().toISOString();
    const errorOut = async (error: string, text: string, args: unknown = rawArgs): Promise<CallOutcome> => {
      await this.log({ tool: name.slice(0, 40), args: argsForLog(args), resultSha256: sha256(text), ids: [],
        ms: Date.now() - started, at, error });
      return { text, isError: true };
    };

    const b = await this.budget();
    if (b.status !== "working") {
      return { text: "Deze vraag wordt niet meer uitgezocht (geannuleerd of afgerond). Stop en antwoord niet.", isError: true };
    }
    const tool: ToolDef | undefined = this.deps.tools
      ? this.deps.tools.find((t) => t.name === name) : toolByName(name);
    if (!tool) return errorOut("unknown-tool", `Onbekende tool ${name.slice(0, 40)}.`);
    if (b.total >= CAPS.total) return errorOut("cap-total", `Limiet bereikt: ${CAPS.total} tool-aanroepen per vraag. Antwoord nu met wat je hebt.`);
    const cap = (CAPS as Record<string, number>)[tool.name];
    if (cap !== undefined && (b.counts.get(tool.name) ?? 0) >= cap) {
      return errorOut(`cap-${tool.name}`, `Limiet bereikt: ${cap} keer ${tool.name} per vraag.`);
    }
    const parsed = tool.args.safeParse(rawArgs);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ").slice(0, 300);
      return errorOut("bad-args", `Ongeldige argumenten: ${why}`);
    }

    let result: ToolResult;
    try {
      result = await runReadOnly(this.deps.db, (tx) => tool.run({
        db: tx, embed: this.deps.embed, gmail: this.deps.gmail, vaultDir: this.deps.vaultDir, now: this.now,
      }, parsed.data));
    } catch (err) {
      if (err instanceof GmailRateLimited) {
        const deadline = rateLimitDeadline(err.original, this.now()) ?? new Date(this.now().getTime() + 15 * 60_000);
        await recordRun(this.deps.db, REQUEST_RUNNER_WORKER_NAME, "error", {
          requestId: this.deps.requestId, during: tool.name, retryAfter: deadline.toISOString(),
          message: String(err.original).slice(0, 300),
        });
        return errorOut("gmail-rate-limited",
          `Gmail weigert tijdelijk (limiet tot ${deadline.toISOString()}). Antwoord zonder Gmail en zeg dat.`, parsed.data);
      }
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return errorOut(`tool-failed: ${message}`, `De tool ${tool.name} faalde: ${message}`, parsed.data);
    }

    const data = fitResult(result.data);
    const text = JSON.stringify(data);
    const logged = await this.log({
      tool: tool.name, args: argsForLog(parsed.data), resultSha256: sha256(text), ids: refsOf(data),
      ms: Date.now() - started, at, ...(result.mail ? { mail: result.mail } : {}),
    });
    if (!logged) return { text: "Deze vraag wordt niet meer uitgezocht. Stop en antwoord niet.", isError: true };
    return { text, isError: false };
  }
}

/** The JSON-RPC parse error for a line that is not JSON. */
export const parseError = () => ({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
