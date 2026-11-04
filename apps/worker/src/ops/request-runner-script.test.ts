import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the REAL ops/request-runner.sh in a throwaway tree with stubbed
// timeout/docker/claude/flock first on PATH, the way the drafter is exercised
// in host-scripts.test.ts. NO database and no Claude: what the script asks of
// the worker is the line it sends to the stubbed `docker compose exec`.

const OPS = new URL("../../../../ops/", import.meta.url).pathname;
const SCRIPT = readFileSync(join(OPS, "request-runner.sh"), "utf8");
const TOKEN = `sk-ant-oat01-test-${crypto.randomUUID()}`;
const ID = crypto.randomUUID();
const trees: string[] = [];
afterEach(() => { for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  timeout: `#!/bin/sh
echo "timeout $*" >> "$STUB_LOG"
while :; do case "$1" in -k) shift 2;; -*) shift;; ''|*[!0-9]*) break;; *) shift; break;; esac; done
exec "$@"
`,
  docker: `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case " $* " in
  *" requests-pending --claim "*) [ -n "$CLAIM_ID" ] && echo "$CLAIM_ID"; exit "\${CLAIM_RC:-0}";;
  *" requests-pending --prompt "*) for id; do :; done; printf 'PROMPT for %s\\nline two' "$id"; exit "\${PROMPT_RC:-0}";;
  *" requests-store --heartbeat "*) echo "heartbeat $*" >> "$STUB_STATE/store"; exit 0;;
  *" requests-store "*) echo "store $*" >> "$STUB_STATE/store"; cat >> "$STUB_STATE/store"; echo >> "$STUB_STATE/store"; exit 0;;
esac
exit 0
`,
  claude: `#!/bin/sh
echo "claude $*" >> "$STUB_LOG"
if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "token-in-env" >> "$STUB_STATE/claude"
while [ $# -gt 0 ]; do [ "$1" = "--mcp-config" ] && cp "$2" "$STUB_STATE/mcp.json"; shift; done
cat >> "$STUB_STATE/claude"
printf '%s' "$CLAUDE_ANSWER"
exit "\${CLAUDE_RC:-0}"
`,
  flock: `#!/bin/sh
[ "$FLOCK_BUSY" = 1 ] && exit 1
exit 0
`,
};

function tree() {
  const root = mkdtempSync(join(tmpdir(), "request-runner-"));
  trees.push(root);
  for (const d of ["ops", "bin", "state", "home/.config/claude-agent"]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(OPS, "request-runner.sh"), join(root, "ops/request-runner.sh"));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(root, "bin", name), body);
    chmodSync(join(root, "bin", name), 0o755);
  }
  const tokenFile = join(root, "home/.config/claude-agent/oauth-token");
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  writeFileSync(join(root, "stub.log"), "");
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const stateDir = join(root, "home/.local/state/grip-requests");
  return {
    root, tokenFile, stateDir,
    log: () => read(join(root, "stub.log")),
    store: () => read(join(root, "state/store")),
    claudeIn: () => read(join(root, "state/claude")),
    mcp: () => read(join(root, "state/mcp.json")),
    runnerLog: () => read(join(stateDir, "runner.log")),
    run(env: Record<string, string> = {}) {
      const r = spawnSync("/bin/bash", [join(root, "ops/request-runner.sh")], {
        encoding: "utf8", timeout: 30_000,
        env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"),
          STUB_LOG: join(root, "stub.log"), STUB_STATE: join(root, "state"), ...env },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

describe("ops/request-runner.sh", () => {
  it("never prints the token, and hands it to the one claude process only", () => {
    expect(SCRIPT).not.toMatch(/^\s*set\s+[^#\n]*-[a-z]*x/m);
    for (const line of SCRIPT.split("\n")) {
      if (/\b(echo|printf|log)\b/.test(line)) expect(line, line).not.toMatch(/\$\(cat|TOKEN_FILE\)/);
    }
    const uses = SCRIPT.split("\n").filter((l) => /CLAUDE_CODE_OAUTH_TOKEN="/.test(l) && !l.trim().startsWith("#"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/CLAUDE_CODE_OAUTH_TOKEN="\$\(cat "\$TOKEN_FILE"\)" timeout -k 5 600 claude -p --tools "" --strict-mcp-config --mcp-config "\$1" --allowedTools "mcp__grip__\*" --no-session-persistence/);
    // The CLI has no --max-turns: the bound is the timeout and the tool caps.
    expect(SCRIPT.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("--max-turns"))).toEqual([]);

    const t = tree();
    const r = t.run({ CLAIM_ID: ID, CLAUDE_ANSWER: '{"answer":"x"}' });
    expect(r.status).toBe(0);
    expect(t.claudeIn()).toContain("token-in-env");
    for (const out of [r.stdout, r.stderr, t.log(), t.store(), t.claudeIn(), t.runnerLog(), t.mcp()]) {
      expect(out).not.toContain(TOKEN);
    }
  });

  it("claims one request, researches it with only the grip MCP server, and stores the answer", () => {
    const t = tree();
    const r = t.run({ CLAIM_ID: ID, CLAUDE_ANSWER: '{"answer":"Gevonden."}' });
    expect(r.status).toBe(0);
    expect(t.claudeIn()).toBe(`token-in-env\nPROMPT for ${ID}\nline two`);
    expect(t.log()).toContain(`claude -p --tools  --strict-mcp-config --mcp-config ${t.stateDir}/mcp-${ID}.json --allowedTools mcp__grip__* --no-session-persistence`);
    expect(t.log()).toMatch(/timeout -k 5 600 claude -p/);
    const cfg = JSON.parse(t.mcp()) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["grip"]);
    const g = cfg.mcpServers.grip;
    expect(g.command).toBe("timeout");
    expect(g.args.join(" ")).toBe(`-k 5 620 env -u CLAUDE_CODE_OAUTH_TOKEN docker compose --env-file ${t.root}/.env.prod -f ${t.root}/docker-compose.prod.yml exec -T worker pnpm --silent --filter worker grip-tools --request ${ID}`);
    expect(t.store()).toContain(`requests-store --id ${ID} --model claude-cli 2.1.0 (Claude Code)`);
    expect(t.store()).toContain('{"answer":"Gevonden."}');
    expect(existsSync(join(t.stateDir, `mcp-${ID}.json`))).toBe(false);
    expect(t.runnerLog()).toContain(`${ID} stored after`);
  });

  it("every docker compose exec of the script itself is wrapped in timeout -k 5 60", () => {
    const t = tree();
    t.run({ CLAIM_ID: ID, CLAUDE_ANSWER: "{}" });
    const lines = t.log().trim().split("\n");
    const dockerAt = lines.flatMap((l, i) => (l.startsWith("docker ") ? [i] : []));
    expect(dockerAt.length).toBeGreaterThanOrEqual(3);
    for (const i of dockerAt) expect(lines[i - 1]).toMatch(/^timeout -k 5 60 docker compose /);
  });

  it("nothing queued: a heartbeat, no claude", () => {
    const t = tree();
    expect(t.run({ CLAIM_ID: "" }).status).toBe(0);
    expect(t.store()).toMatch(/^heartbeat .*requests-store --heartbeat\s*$/);
    expect(t.log()).not.toContain("claude -p");
  });

  it("the lock is held: a busy heartbeat and nothing claimed", () => {
    const t = tree();
    expect(t.run({ CLAIM_ID: ID, FLOCK_BUSY: "1" }).status).toBe(0);
    expect(t.store()).toContain("requests-store --heartbeat --busy");
    expect(t.log()).not.toContain("--claim");
  });

  it("claude timing out or failing marks the request failed with the exit code", () => {
    const t = tree();
    t.run({ CLAIM_ID: ID, CLAUDE_ANSWER: "", CLAUDE_RC: "124" });
    expect(t.store()).toContain(`requests-store --id ${ID} --model claude-cli 2.1.0 (Claude Code) --failed claude-exit-124`);
    const u = tree();
    u.run({ CLAIM_ID: ID, CLAUDE_ANSWER: "" });
    expect(u.store()).toContain("--failed empty-answer");
  });

  it("refuses a malformed id, and with no token claims nothing at all", () => {
    const t = tree();
    t.run({ CLAIM_ID: "--heartbeat;rm", CLAUDE_ANSWER: "{}" });
    expect(t.log()).not.toContain("--prompt");
    expect(t.store()).toBe("");
    const u = tree();
    rmSync(u.tokenFile);
    expect(u.run({ CLAIM_ID: ID }).status).toBe(1);
    expect(u.log()).toBe("");
  });

  it("keeps all state under the state dir, nothing inside the repo tree", () => {
    const t = tree();
    t.run({ CLAIM_ID: ID, CLAUDE_ANSWER: "{}" });
    expect(readdirSync(t.root).sort()).toEqual(["bin", "home", "ops", "state", "stub.log"].sort());
  });
});
