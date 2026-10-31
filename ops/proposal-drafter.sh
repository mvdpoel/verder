#!/usr/bin/env bash
# Host drafter for proposals (spec §6.5). Host crontab:
#   */5 * * * * /home/<user>/apps/verder/ops/proposal-drafter.sh >> /home/<user>/.local/state/verder-drafter/cron.log 2>&1
#
# The worker builds every prompt and validates every answer; this script only
# carries text between them and `claude -p`, which runs HERE, on the host, with
# Martin's long-lived token. THE TOKEN NEVER ENTERS A CONTAINER, NEVER ENTERS
# ARGV (it is passed in the environment of the one `claude` process), and is
# never echoed or logged. There is no `set -x` in this file, and there must
# never be one: it would print the token into the cron log.
#
# `claude` runs with `--tools ""`: the prompt carries third-party mail, so the
# model gets no tool it could be talked into using. Whatever it answers is
# refused by `proposals-store` unless every recipient, attachment, cited id and
# option target is in the context the worker assembled.
#
# EVERY `docker compose exec` IS WRAPPED IN `timeout -k 5 60`, the heartbeat
# included: a hung exec would otherwise hold the flock and silence the drafter
# for good. `claude` itself gets 300 s.
#
# STATE LIVES OUTSIDE THE REPO (~/.local/state/verder-drafter): ~/apps/verder
# is rsynced with --delete, and a log written in there is erased on the next
# deploy.
#
# Nothing here sends anything: a drafted proposal waits for Martin's approval
# on the phone, behind Face ID.
set -uo pipefail
cd "$(dirname "$0")/.."

STATE_DIR=${DRAFTER_STATE_DIR:-$HOME/.local/state/verder-drafter}
LOG="$STATE_DIR/drafter.log"
TOKEN_FILE=${CLAUDE_TOKEN_FILE:-$HOME/.config/claude-agent/oauth-token}
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# The ONE place this script reaches the worker. Bounded, always.
worker() {
  timeout -k 5 60 docker compose --env-file .env.prod -f docker-compose.prod.yml \
    exec -T worker pnpm --silent --filter worker "$@"
}

# One run at a time: five 300 s drafts can outlast the 5-minute cadence.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || exit 0
fi

# A missing token fails every draft, so draft nothing and write nothing: the
# `proposal-draft` watcher goes stale, which is the honest signal.
if [ ! -s "$TOKEN_FILE" ]; then
  log "no claude token at the configured path; nothing drafted"
  echo "proposal-drafter.sh: claude token missing" >&2
  exit 1
fi

if ! ids=$(worker proposals-pending --ids); then
  log "proposals-pending failed; nothing drafted"
  echo "proposal-drafter.sh: could not list pending proposals" >&2
  exit 1
fi

if [ -z "$ids" ]; then
  worker proposals-store --heartbeat \
    || { log "could not record the heartbeat"; echo "proposal-drafter.sh: heartbeat failed" >&2; }
  exit 0
fi

model="claude-cli $(timeout -k 5 30 claude --version 2>/dev/null | head -1 | tr -cd '\40-\176' | cut -c1-100)"

# The ids come in on fd 3, NOT stdin: `docker compose exec -T` inside the loop
# inherits stdin and would swallow the rest of the list, drafting only the first.
while IFS= read -r id <&3; do
  if ! [[ "$id" =~ $UUID_RE ]]; then
    log "refusing a malformed id from proposals-pending"
    continue
  fi
  if ! prompt=$(worker proposals-pending --prompt "$id" </dev/null); then
    # Superseded since the listing, or the exec failed: leave it for next run.
    log "$id no prompt (no longer drafting, or exec failed)"
    continue
  fi
  started=$(date +%s)
  answer=$(printf '%s' "$prompt" \
    | CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" timeout -k 5 300 claude -p --tools "" --no-session-persistence)
  rc=$?
  took=$(( $(date +%s) - started ))
  if [ "$rc" -ne 0 ] || [ -z "$answer" ]; then
    reason="claude-exit-$rc"
    [ "$rc" -eq 0 ] && reason="empty-answer"
    log "$id claude failed ($reason) after ${took}s"
    worker proposals-store --id "$id" --model "$model" --failed "$reason" >> "$LOG" 2>&1 \
      || log "$id could not record the failure"
    continue
  fi
  if printf '%s' "$answer" | worker proposals-store --id "$id" --model "$model" >> "$LOG" 2>&1; then
    log "$id stored after ${took}s"
  else
    log "$id proposals-store failed after ${took}s"
  fi
done 3<<< "$ids"

exit 0
