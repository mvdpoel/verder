#!/usr/bin/env bash
# The mail agent, folded into verder (Plan 2 Task 20, spec §6.5). Host crontab,
# at the OLD agent's cadence so Gmail sees no new load:
#   7,22,37,52 * * * * /home/<user>/apps/verder/ops/mail-agent.sh >> /mnt/data/verder/mail-agent/cron.log 2>&1
#
# It replaces /mnt/data/verder/mail-agent/run.sh (gwatch.mts + .md drafts).
# ONE PRODUCER AT A TIME: comment out the old run.sh line when this one goes in.
#
# The watchlist senders (Statiegeld Nederland, Bungas, Tikkie, Hanneke) stay OUT
# of the dossier: their mail is not ingested, only turned into a proposal Martin
# approves on the phone. Every reply verder sends still becomes an outbound log
# entry (decided by Martin 2026-10-31).
#
#   1. the watchlist (and seen.txt, each line prefixed `seen:`) goes to the
#      worker on STDIN — the worker has no mount for this directory, and stdin
#      needs no compose change;
#   2. `mail-agent-watch` prints one JSON line per new thread, READ-ONLY;
#   3. each line goes to `proposals-store --external`, which makes a `drafting`
#      proposal and prints `seen <id>` for every Gmail id it covers;
#   4. those ids are appended to seen.txt, and one line to handled.log.
#
# FAILS CLOSED: a missing or empty watchlist is checked HERE, before any exec,
# and the worker is still called with EMPTY stdin so it records the
# `mail-agent` error row — an empty `from:()` query would be the whole mailbox,
# and silence would read as a healthy agent with nothing to do.
#
# EVERY `docker compose exec` IS WRAPPED IN `timeout -k 5 60`: a hung exec would
# otherwise hold the flock and silence the agent for good.
#
# STATE LIVES OUTSIDE THE REPO (/mnt/data/verder/mail-agent): ~/apps/verder is
# rsynced with --delete, and anything written in there is erased on the next
# deploy. Nothing here sends anything, and nothing here reads a token.
set -uo pipefail
cd "$(dirname "$0")/.."

STATE_DIR=${MAIL_AGENT_DIR:-/mnt/data/verder/mail-agent}
WATCHLIST=${MAIL_AGENT_WATCHLIST:-$STATE_DIR/watchlist.txt}
SEEN="$STATE_DIR/seen.txt"
HANDLED="$STATE_DIR/handled.log"
LOG="$STATE_DIR/agent.log"
# The newest seen ids are the only ones a 3-day window can return again.
SEEN_TAIL=5000

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# The ONE place this script reaches the worker. Bounded, always.
worker() {
  timeout -k 5 60 docker compose --env-file .env.prod -f docker-compose.prod.yml \
    exec -T worker pnpm --silent --filter worker "$@"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || exit 0
fi

if [ ! -s "$WATCHLIST" ]; then
  log "no watchlist at the configured path; nothing watched"
  echo "mail-agent.sh: watchlist missing or empty" >&2
  # Empty stdin: the worker records `mail-agent` error {reason: empty-watchlist}
  # and makes no Gmail call.
  worker mail-agent-watch < /dev/null >> "$LOG" 2>&1 \
    || log "recorded the empty-watchlist error (or could not reach the worker)"
  exit 1
fi

watch_input() {
  cat "$WATCHLIST"
  printf '\n'
  if [ -f "$SEEN" ]; then tail -n "$SEEN_TAIL" "$SEEN" | sed 's/^/seen:/'; fi
}

# A non-zero exit still prints every line it could (one bad message does not
# hide the rest), so the output is used either way.
lines=$(watch_input | worker mail-agent-watch 2>>"$LOG")
rc=$?
[ "$rc" -ne 0 ] && log "mail-agent-watch exited $rc"

[ -z "$lines" ] && exit 0

while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    "{"*) ;;
    *) log "refusing a line that is not a JSON object"; continue ;;
  esac
  out=$(printf '%s\n' "$line" | worker proposals-store --external 2>>"$LOG")
  src=$?
  ids=$(printf '%s\n' "$out" | grep -E '^seen [0-9A-Za-z_-]{1,64}$' | cut -d' ' -f2)
  [ -n "$ids" ] && printf '%s\n' "$ids" >> "$SEEN"
  status=$(printf '%s\n' "$out" | grep '^proposals-store: ' | head -n 1)
  [ "$src" -ne 0 ] && status="${status:-proposals-store exited $src}"
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$ids" | tr '\n' ',')" "${status:-no answer}" >> "$HANDLED"
done <<< "$lines"

exit 0
