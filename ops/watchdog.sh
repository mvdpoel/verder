#!/usr/bin/env bash
# Host watchdog: puts back what a reboot, a maintenance stop or an NFS outage
# left down. Host crontab (CRON_TZ=UTC is irrelevant, it runs every 5 minutes):
#   */5 * * * * /home/<user>/apps/verder/ops/watchdog.sh >> /home/<user>/.local/state/verder-watchdog/cron.log 2>&1
#
# It deliberately has no `set -e`: one failing check must not stop the others.
#
# STATE LIVES OUTSIDE THE REPO. ~/apps/verder is rsynced with --delete, and any
# file the host writes in there that is not in the exclude list is erased on the
# next deploy. The strike counters would silently reset; the log would vanish.
set -uo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source ./.env.prod
set +a

COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)
STATE_DIR=${WATCHDOG_STATE_DIR:-$HOME/.local/state/verder-watchdog}
LOG="$STATE_DIR/watchdog.log"
SERVICES="postgres web worker stalwart"
SCAN_DIR=${NAS_SCAN_HOST_DIR:-/mnt/nas-workspace}
BACKUP_MOUNT=${WATCHDOG_BACKUP_MOUNT:-/mnt/nas-download}
MARKER=.verder-nas

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# One run at a time: a hung docker call must not stack up behind itself.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || exit 0
fi

# mail-backup.sh stops stalwart on purpose; the others hold the stack busy.
# Skipping writes no row, which is why `watchdog` tolerates three missed ticks.
if pgrep -f 'ops/(nightly|mail-backup|mail-restore-drill)\.sh' >/dev/null; then
  exit 0
fi

# ok | unhealthy (running, healthcheck failing) | down (anything else).
service_state() {
  local id st
  id=$(timeout -k 5 30 "${COMPOSE[@]}" ps -q "$1" 2>/dev/null) || id=""
  [ -n "$id" ] || { echo down; return; }
  st=$(timeout -k 5 30 docker inspect -f \
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$id" 2>/dev/null) || { echo down; return; }
  case "$st" in
    "running none"|"running healthy"|"running starting") echo ok ;;
    "running unhealthy") echo unhealthy ;;
    *) echo down ;;
  esac
}

# A bad check only acts on the SECOND consecutive run (10 minutes): a deploy or
# a slow restart is not an outage.
strikes() { cat "$STATE_DIR/bad.$1" 2>/dev/null || echo 0; }

checked=""
restarted=""
problems=""
worker_acted=0

for svc in $SERVICES; do
  checked="$checked$svc,"
  state=$(service_state "$svc")
  if [ "$state" = ok ]; then
    rm -f "$STATE_DIR/bad.$svc"
    continue
  fi
  n=$(( $(strikes "$svc") + 1 ))
  echo "$n" > "$STATE_DIR/bad.$svc"
  if [ "$n" -lt 2 ]; then
    log "$svc $state (strike $n, waiting)"
    continue
  fi
  # `up -d` is a no-op on a container that is running but unhealthy.
  if [ "$state" = unhealthy ]; then act=(restart "$svc"); else act=(up -d "$svc"); fi
  if timeout -k 5 180 "${COMPOSE[@]}" "${act[@]}" >/dev/null 2>&1; then
    log "$svc $state -> ${act[*]} ok"
    restarted="$restarted$svc,"
    rm -f "$STATE_DIR/bad.$svc"
    [ "$svc" = worker ] && worker_acted=1
  else
    log "$svc $state -> ${act[*]} FAILED (will retry next run)"
  fi
done

is_mountpoint() { timeout -k 5 10 mountpoint -q "$1"; }
has_marker() { timeout -k 5 10 test -f "$SCAN_DIR/$MARKER"; }

# Best effort: fstab owns the mount options, sudoers must allow `mount` without
# a password. Bounded because a dead NFS server hangs mount.
try_mount() { timeout -k 5 60 sudo -n mount "$1" >/dev/null 2>&1; }

checked="${checked}nas-workspace,nas-download,"

if ! has_marker; then
  if ! is_mountpoint "$SCAN_DIR" && try_mount "$SCAN_DIR" && has_marker; then
    log "mounted $SCAN_DIR"
    restarted="${restarted}nas-workspace,"
  else
    log "$SCAN_DIR has no $MARKER (not mounted, or marker missing)"
    problems="${problems}scan-mount-missing,"
  fi
fi

# A bind mount is resolved to the host directory when the container STARTS. If
# the NAS mounted afterwards the container keeps the empty directory underneath,
# so waiting never heals it. Recreate rather than `restart`: it is the same
# bind-resolution as a fresh start plus any changed env, and it is what
# `docker compose` documents for config changes. --no-deps leaves postgres alone.
if has_marker && [ "$worker_acted" -eq 0 ] && [ "$(strikes worker)" -eq 0 ]; then
  if ! timeout -k 5 30 "${COMPOSE[@]}" exec -T worker test -f "/scans/$MARKER" >/dev/null 2>&1; then
    if timeout -k 5 180 "${COMPOSE[@]}" up -d --force-recreate --no-deps worker >/dev/null 2>&1; then
      log "worker lacks /scans/$MARKER while host has it -> recreated worker"
      restarted="${restarted}worker,"
    else
      log "worker recreate FAILED (will retry next run)"
    fi
  fi
fi

if ! is_mountpoint "$BACKUP_MOUNT"; then
  if try_mount "$BACKUP_MOUNT" && is_mountpoint "$BACKUP_MOUNT"; then
    log "mounted $BACKUP_MOUNT"
    restarted="${restarted}nas-download,"
  else
    log "$BACKUP_MOUNT is not a mountpoint"
    problems="${problems}backup-mount-missing,"
  fi
fi

# A heal while postgres was down cannot be recorded until postgres is back, so
# it is carried to the next run that can write the row (and send the push).
pending="$STATE_DIR/pending-restarted"
all_restarted="$(cat "$pending" 2>/dev/null)$restarted"
if timeout -k 5 60 "${COMPOSE[@]}" exec -T worker \
     pnpm --silent --filter worker watchdog-run \
     --checked "${checked%,}" --restarted "${all_restarted%,}" --problems "${problems%,}" >/dev/null; then
  rm -f "$pending"
else
  echo "watchdog.sh: could not record the watchdog row (is postgres up?)" >&2
  log "could not record row"
  [ -n "$all_restarted" ] && printf '%s' "$all_restarted" > "$pending"
fi
exit 0
