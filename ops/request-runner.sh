#!/usr/bin/env bash
# Host runner for Vraag Grip (docs/superpowers/specs/2026-11-04-vraag-grip-design.md).
# Host crontab:
#   * * * * * /home/<user>/apps/grip/ops/request-runner.sh >> /home/<user>/.local/state/grip-requests/cron.log 2>&1
#
# ONE REQUEST PER RUN. `requests-pending --claim` resets a request left
# `working` for more than 15 minutes, moves the oldest queued one to `working`
# and stores its prompt; this script pipes that prompt into `claude -p`, whose
# ONLY tools are the read-only `grip` MCP server, started INSIDE the worker
# container for this one request:
#
#   docker compose exec -T worker pnpm --silent --filter worker grip-tools --request <id>
#
# and hands the answer to `requests-store`, which refuses any source,
# recipient, attachment or reply target the tools never showed.
#
# THE TOKEN NEVER ENTERS A CONTAINER, NEVER ENTERS ARGV, and is never echoed or
# logged: it is read from the file into the environment of the ONE `claude`
# process. The MCP server that claude starts is launched through
# `env -u CLAUDE_CODE_OAUTH_TOKEN`, so not even the host-side `docker` client
# inherits it, and `docker compose exec` passes no environment into the
# container unless asked. There is no `set -x` in this file, and there must
# never be one: it would print the token into the cron log.
#
# `claude` runs with `--tools ""` (no built-in tool: no shell, no file access,
# no web) and `--strict-mcp-config --mcp-config <file>` (no MCP server but the
# one written below), with `--allowedTools "mcp__grip__*"`. The CLI has NO
# --max-turns: the run is bounded by `timeout -k 5 600` here and by the
# per-request call caps inside grip-tools (60 calls, 10 Gmail searches, 20
# Gmail reads). A run killed by the timeout is recorded `failed`
# ("Duurde te lang" on the phone).
#
# EVERY `docker compose exec` of this script is wrapped in `timeout -k 5 60`
# (the heartbeat included): a hung exec would otherwise hold the flock and
# silence the runner for good. The MCP server's own exec lives for the length
# of the research and is bounded at 620 s, just past claude's 600.
#
# STATE LIVES OUTSIDE THE REPO (~/.local/state/grip-requests): ~/apps/grip is
# rsynced with --delete, and a log written in there is erased on the next
# deploy. The generated MCP config holds no secret and is removed after use.
#
# Nothing here sends anything: a proposal in an answer waits for Martin's
# approval on the phone, behind Face ID, like every other proposal.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)

STATE_DIR=${REQUEST_STATE_DIR:-$HOME/.local/state/grip-requests}
LOG="$STATE_DIR/runner.log"
TOKEN_FILE=${CLAUDE_TOKEN_FILE:-$HOME/.config/claude-agent/oauth-token}
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# The ONE place this script reaches the worker. Bounded, always.
worker() {
  timeout -k 5 60 docker compose --env-file .env.prod -f docker-compose.prod.yml \
    exec -T worker pnpm --silent --filter worker "$@"
}

# The ONE place `claude` runs. The token reaches it through its environment
# only, read from the file at the moment of the call; stdin is the prompt.
research() {
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" timeout -k 5 600 claude -p --tools "" --strict-mcp-config --mcp-config "$1" --allowedTools "mcp__grip__*" --no-session-persistence
}

# One request at a time. A tick that finds the lock held by a request still
# being researched (up to 600 s) records a `busy` heartbeat, so a long request
# never reads as a dead cron on the Systeem panel.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  if ! flock -n 9; then
    worker requests-store --heartbeat --busy </dev/null >/dev/null 2>&1 || true
    exit 0
  fi
fi

# A missing token fails every request, so claim nothing and write nothing: the
# `request-runner` watcher goes stale, which is the honest signal, and the
# queued requests wait rather than fail.
if [ ! -s "$TOKEN_FILE" ]; then
  log "no claude token at the configured path; nothing claimed"
  echo "request-runner.sh: claude token missing" >&2
  exit 1
fi

# The MCP config embeds the repo path as a JSON string.
case "$REPO" in
  *'"'*|*'\'*) log "refusing a repo path that needs JSON escaping"; echo "request-runner.sh: bad repo path" >&2; exit 1;;
esac

if ! id=$(worker requests-pending --claim </dev/null); then
  log "requests-pending --claim failed; nothing researched"
  echo "request-runner.sh: could not claim a request" >&2
  exit 1
fi

if [ -z "$id" ]; then
  worker requests-store --heartbeat </dev/null \
    || { log "could not record the heartbeat"; echo "request-runner.sh: heartbeat failed" >&2; }
  exit 0
fi

if ! [[ "$id" =~ $UUID_RE ]]; then
  log "refusing a malformed id from requests-pending"
  exit 1
fi

model="claude-cli $(timeout -k 5 30 claude --version 2>/dev/null | head -1 | tr -cd '\40-\176' | cut -c1-100)"

if ! prompt=$(worker requests-pending --prompt "$id" </dev/null); then
  log "$id no prompt (no longer working, or exec failed)"
  worker requests-store --id "$id" --model "$model" --failed no-prompt </dev/null >> "$LOG" 2>&1 \
    || log "$id could not record the failure"
  exit 1
fi

cfg="$STATE_DIR/mcp-$id.json"
printf '{"mcpServers":{"grip":{"type":"stdio","command":"timeout","args":["-k","5","620","env","-u","CLAUDE_CODE_OAUTH_TOKEN","docker","compose","--env-file","%s/.env.prod","-f","%s/docker-compose.prod.yml","exec","-T","worker","pnpm","--silent","--filter","worker","grip-tools","--request","%s"]}}}\n' \
  "$REPO" "$REPO" "$id" > "$cfg"

started=$(date +%s)
answer=$(printf '%s' "$prompt" | research "$cfg")
rc=$?
took=$(( $(date +%s) - started ))
rm -f "$cfg"

if [ "$rc" -ne 0 ] || [ -z "$answer" ]; then
  reason="claude-exit-$rc"
  [ "$rc" -eq 0 ] && reason="empty-answer"
  log "$id claude failed ($reason) after ${took}s"
  worker requests-store --id "$id" --model "$model" --failed "$reason" </dev/null >> "$LOG" 2>&1 \
    || log "$id could not record the failure"
  exit 0
fi

if printf '%s' "$answer" | worker requests-store --id "$id" --model "$model" >> "$LOG" 2>&1; then
  log "$id stored after ${took}s"
else
  log "$id requests-store refused or failed after ${took}s"
fi
exit 0
