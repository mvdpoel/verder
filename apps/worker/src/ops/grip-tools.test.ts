import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseToolsArgs } from "./grip-tools";
import { parseRequestStoreArgs } from "./requests-store";

const ID = "00000000-0000-4000-8000-0000000000d1";

describe("grip-tools over stdio", () => {
  it("speaks one JSON-RPC message per line, and stdout carries nothing else", async () => {
    const cwd = fileURLToPath(new URL("../..", import.meta.url));
    // A request id that does not exist: every tool call is refused, nothing is
    // written, and the protocol is still exercised end to end.
    const child = spawn("npx", ["tsx", "src/ops/grip-tools.ts", "--request", ID], {
      cwd, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GMAIL_"))),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    const got = (n: number) => new Promise<void>((resolve) => {
      const check = () => { if (lines.length >= n) resolve(); };
      rl.on("line", (l) => { lines.push(l); check(); });
      check();
    });
    const send = (m: object) => child.stdin!.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "case_map", arguments: {} } });
    child.stdin!.write("this is not json\n");
    await got(4);
    child.stdin!.end();
    await new Promise((r) => child.once("exit", r));
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3, null]);
    expect(msgs[0].result.serverInfo.name).toBe("grip-tools");
    expect(msgs[1].result.tools).toHaveLength(14);
    expect(msgs[2].result).toMatchObject({ isError: true });
    expect(msgs[2].result.content[0].text).toMatch(/niet meer uitgezocht/);
    expect(msgs[3].error.code).toBe(-32700);
  }, 60_000);

  it("refuses anything but --request <uuid>", () => {
    expect(parseToolsArgs(["--request", ID.toUpperCase()])).toEqual({ requestId: ID });
    for (const a of [[], ["--request"], ["--request", "x"], ["--request", ID, "--extra"]]) {
      expect(() => parseToolsArgs(a)).toThrow(/usage/);
    }
  });
});

describe("requests-store arguments", () => {
  it("store, failed and heartbeat modes", () => {
    expect(parseRequestStoreArgs(["--id", ID, "--model", "claude-cli 2.1"])).toEqual({ mode: "store", id: ID, model: "claude-cli 2.1" });
    expect(parseRequestStoreArgs(["--id", ID, "--model", "m", "--failed", "claude-exit-124"]))
      .toEqual({ mode: "failed", id: ID, model: "m", reason: "claude-exit-124" });
    expect(parseRequestStoreArgs(["--heartbeat"])).toEqual({ mode: "heartbeat", busy: false });
    expect(parseRequestStoreArgs(["--heartbeat", "--busy"])).toEqual({ mode: "heartbeat", busy: true });
  });
  it.each([
    [["--id", "x", "--model", "m"], "--id must be a uuid"],
    [["--id", ID, "--model", "é"], "--model must be 1-120 printable ASCII characters"],
    [["--id", ID, "--model", "m", "--failed", "Bad Reason"], "--failed must be a short [a-z0-9-] reason"],
    [["--party", ID], 'unknown flag "--party"'],
    [["--heartbeat", "--now"], "--heartbeat takes only --busy"],
  ])("refuses %j", (args, message) => {
    expect(() => parseRequestStoreArgs(args)).toThrow(message);
  });
});
