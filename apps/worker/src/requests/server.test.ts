import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema, type Db } from "@grip/db";
import type { EmbedPort } from "@grip/api/src/search/embed";
import { REQUEST_RUNNER_WORKER_NAME } from "@grip/api/src/worker-names";
import { rateLimitedUntil } from "../gmail";
import type { GmailReadPort } from "./gmail-read";
import { RESULT_MAX_CHARS, fitResult, plainBody, refsOf } from "./output";
import { runReadOnly } from "./read-only";
import { CAPS, ToolServer } from "./server";
import { TOOLS, type ToolDef } from "./tools";

// Runs as grip_worker, the role grip-tools meets in production. Every test is
// ONE transaction that is ROLLED BACK, so the shared dev database keeps no
// fixture. The tools' read-only transactions nest as savepoints inside it
// (runReadOnly rolls them back, which is what keeps READ ONLY from leaking).
const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();
const nullEmbed: EmbedPort = { embed: async (t) => t.map(() => null) };
/** A clock far past anything the dev database holds, so no committed Gmail
 *  deadline from another suite can leak into these calls. */
const FAR = () => new Date(Date.parse("2032-03-01T09:00:00Z") + Math.floor(Math.random() * 1e6) * 60_000);

async function working(db: Db): Promise<string> {
  const [r] = await db.insert(schema.requests).values({ clientId: uid(), text: "Testvraag", status: "working",
    claimedAt: new Date() }).returning();
  return r.id;
}

function server(db: Db, requestId: string, o: { gmail?: GmailReadPort | null; tools?: ToolDef[]; now?: () => Date } = {}) {
  return new ToolServer({ db, requestId, embed: nullEmbed, gmail: async () => o.gmail ?? null,
    vaultDir: "/nonexistent", now: o.now ?? FAR, tools: o.tools });
}

const logOf = async (db: Db, id: string) =>
  (await db.select({ log: schema.requests.toolLog }).from(schema.requests).where(eq(schema.requests.id, id)))[0].log;

describe("runReadOnly", () => {
  it("returns the result and refuses any write, even nested in a transaction", async () => {
    await isolated(async (db) => {
      expect(await runReadOnly(db, async (tx) => (await tx.execute(sql`SELECT 41 + 1 AS n`)).rows[0].n)).toBe(42);
      await expect(runReadOnly(db, (tx) => tx.execute(sql`INSERT INTO worker_runs (worker, status) VALUES ('ro-test', 'ok')`)))
        .rejects.toThrow(/read-only transaction/);
      // The outer transaction is writable again: READ ONLY did not leak.
      await db.execute(sql`INSERT INTO worker_runs (worker, status) VALUES ('ro-test', 'ok')`);
    });
  });
});

describe("ToolServer", () => {
  it("a tool that tries to write fails, and nothing is written", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const writer: ToolDef = { name: "evil", description: "writes", args: z.object({}).strict(),
        async run(env) {
          await env.db.execute(sql`INSERT INTO worker_runs (worker, status) VALUES ('grip-tools-evil', 'ok')`);
          return { data: {} };
        } };
      const out = await server(db, id, { tools: [writer] }).call("evil", {});
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/read-only transaction/);
      const rows = await db.execute(sql`SELECT count(*)::int AS n FROM worker_runs WHERE worker = 'grip-tools-evil'`);
      expect(rows.rows[0].n).toBe(0);
      const [entry] = await logOf(db, id);
      expect(entry).toMatchObject({ tool: "evil", ids: [] });
      expect(entry.error).toMatch(/^tool-failed: .*read-only/);
    });
  });

  it("every real tool runs read-only: tools/list serves all 14 with a schema", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const res = await server(db, id).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = (res!.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      expect(tools).toHaveLength(14);
      for (const t of tools) expect(t.inputSchema.type).toBe("object");
    });
  });

  it("speaks JSON-RPC: initialize echoes the version, notifications get no reply, unknown methods -32601", async () => {
    await isolated(async (db) => {
      const s = server(db, await working(db));
      const init = await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      expect(init!.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "grip-tools" }, capabilities: { tools: {} } });
      expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
      expect(await s.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
      expect(await s.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    });
  });

  it("logs each call with the ids it showed and a hash of the result", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const [p] = await db.insert(schema.parties).values({ kind: "organization",
        name: `Kade Testfixture ${uid()}`, email: `incasso-${uid().slice(0, 8)}@kade.example` }).returning();
      const out = await server(db, id).handle({ jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "get_party", arguments: { id: p.id } } });
      const r = out!.result as { content: { text: string }[]; isError: boolean };
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content[0].text).party).toMatchObject({ type: "party", id: p.id, name: p.name });
      const [entry] = await logOf(db, id);
      expect(entry.tool).toBe("get_party");
      expect(entry.args).toEqual({ id: p.id });
      expect(entry.resultSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.ids).toEqual(expect.arrayContaining([
        { type: "party", id: p.id, label: p.name }, { type: "address", id: p.email!.toLowerCase() }]));
    });
  });

  it("caps: 10 gmail_search, 20 gmail_read, and the total — counted from the log", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      let searches = 0; let reads = 0;
      const gmail: GmailReadPort = {
        search: async () => { searches++; return []; },
        read: async (gid) => { reads++; return { gmailId: gid, threadId: "t", messageId: null, references: [],
          from: "a@b.example", to: "", cc: "", subject: "s", date: "2026-11-01T00:00:00.000Z", body: "x", attachments: [] }; },
      };
      const s = server(db, id, { gmail });
      for (let i = 0; i < CAPS.gmail_search + 2; i++) await s.call("gmail_search", { query: "x" });
      expect(searches).toBe(CAPS.gmail_search);
      for (let i = 0; i < CAPS.gmail_read + 2; i++) await s.call("gmail_read", { id: `m${i}` });
      expect(reads).toBe(CAPS.gmail_read);
      const capped = await s.call("gmail_read", { id: "again" });
      expect(capped).toMatchObject({ isError: true });
      expect(capped.text).toMatch(/Limiet bereikt: 20 keer gmail_read/);
      // A fresh server for the same request gets no second allowance.
      expect((await server(db, id, { gmail }).call("gmail_search", { query: "y" })).isError).toBe(true);
      expect(searches).toBe(CAPS.gmail_search);
      while ((await logOf(db, id)).length < CAPS.total) await s.call("case_map", {});
      const over = await s.call("case_map", {});
      expect(over.text).toMatch(/Limiet bereikt: 60 tool-aanroepen/);
    });
  });

  it("results are at most 8 000 characters and only the ids shown are logged", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const big: ToolDef = { name: "big", description: "many", args: z.object({}).strict(),
        async run() {
          return { data: { items: Array.from({ length: 400 }, (_, i) => ({ type: "document", id: `doc-${i}`, title: `Document ${i} ${"x".repeat(40)}` })) } };
        } };
      const out = await server(db, id, { tools: [big] }).call("big", {});
      expect(out.text.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
      const shown = JSON.parse(out.text) as { items: { id: string }[]; truncated: boolean };
      expect(shown.truncated).toBe(true);
      const [entry] = await logOf(db, id);
      expect(entry.ids.map((r) => r.id)).toEqual(shown.items.map((i) => i.id));
      expect(entry.ids.some((r) => r.id === "doc-399")).toBe(false);
    });
  });

  it("bad arguments are refused and logged; a request no longer working gets nothing", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const s = server(db, id);
      const bad = await s.call("get_document", { id: "not-a-uuid" });
      expect(bad.isError).toBe(true);
      expect((await logOf(db, id))[0]).toMatchObject({ tool: "get_document", error: "bad-args" });
      await db.update(schema.requests).set({ status: "cancelled" }).where(eq(schema.requests.id, id));
      const after = await s.call("case_map", {});
      expect(after).toMatchObject({ isError: true });
      expect(after.text).toMatch(/niet meer uitgezocht/);
      expect(await logOf(db, id)).toHaveLength(1);
    });
  });

  it("Gmail: a lockout answers without calling Google; a 429 records the account-wide deadline", async () => {
    await isolated(async (db) => {
      const id = await working(db);
      const now = FAR();
      let calls = 0;
      const retry = new Date(now.getTime() + 15 * 60_000).toISOString();
      const gmail: GmailReadPort = {
        search: async () => { calls++; throw new Error(`User-rate limit exceeded.  Retry after ${retry}`); },
        read: async () => { throw new Error("unused"); },
      };
      const s = server(db, id, { gmail, now: () => now });
      const first = await s.call("gmail_search", { query: "from:x" });
      expect(first.isError).toBe(true);
      expect(first.text).toMatch(/Gmail weigert tijdelijk/);
      const [run] = await db.select().from(schema.workerRuns).where(eq(schema.workerRuns.worker, REQUEST_RUNNER_WORKER_NAME))
        .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
      expect(run.detail).toMatchObject({ requestId: id, retryAfter: retry });
      expect((await rateLimitedUntil(db, now))?.toISOString()).toBe(retry);
      // The next call sees the deadline and never reaches Google.
      const second = await s.call("gmail_search", { query: "from:x" });
      expect(second.isError).toBe(false);
      expect(JSON.parse(second.text).unavailable).toMatch(/tijdelijk niet beschikbaar/);
      expect(calls).toBe(1);
    });
  });
});

describe("output helpers", () => {
  it("fitResult halves a long string when there is no list to shorten", () => {
    const out = fitResult({ text: "y".repeat(20_000) }, 8000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(8000);
  });

  it("refsOf reads typed objects and address lists only", () => {
    expect(refsOf({ a: { type: "mail", id: "m1", subject: "Hoi" }, b: { type: "weird", id: "x" },
      c: [{ addresses: ["Ilse@Noordkust.example"] }] })).toEqual([
      { type: "mail", id: "m1", label: "Hoi" }, { type: "address", id: "ilse@noordkust.example" }]);
  });

  it("plainBody strips HTML and decodes entities, and leaves plain text alone", () => {
    expect(plainBody("<html><body><p>Beste Martin,</p><p>Zie&nbsp;bijlage &amp; groet</p><style>x{}</style></body></html>"))
      .toBe("Beste Martin,\n Zie bijlage & groet");
    expect(plainBody("Gewoon tekst <3")).toBe("Gewoon tekst <3");
  });
});
