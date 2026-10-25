#!/usr/bin/env bash
# Nightly backup + verification + model check. Run from the homelab crontab:
#   30 3 * * * /path/to/verder/ops/nightly.sh >> /var/log/verder-nightly.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

# Cron starts with a near-empty environment; pull everything from .env.prod.
set -a
# shellcheck disable=SC1091
source ./.env.prod
set +a

COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)
STAMP=$(date +%F)
BACKUP_DIR=${BACKUP_DIR:-/mnt/nas/verder-backups}

# --- db-backup row -----------------------------------------------------------
# One `worker_runs` row per run, shaped exactly like record_backup in
# the mail backup script: the caller picks only the status and a closed reason code,
# the worker name is a constant in the worker image, the call is hard-bounded and
# can never abort this script. If postgres is down the row cannot be written;
# that goes to stderr (the cron log) and the next night records its own.
record_db_backup() {
  timeout -k 5 60 "${COMPOSE[@]}" exec -T worker \
    pnpm --silent --filter worker db-backup-run "$@" >/dev/null || {
    echo "nightly.sh: could not record the db-backup '$1' row (is postgres up?)" >&2
  }
  return 0
}

# A hard NFS mount that is gone HANGS instead of failing, hence every probe is
# under `timeout`. And a gone mount is not an error to mkdir -p: it quietly
# creates the directory on the root disk, and the "off-box" backup lands on the
# machine it is meant to survive. So the target must resolve to a mount that is
# not `/` before anything is written.
backup_target_ok() {
  local nearest="$BACKUP_DIR" mount_at
  while [ ! -e "$nearest" ] && [ "$nearest" != "/" ]; do nearest=$(dirname "$nearest"); done
  mount_at=$(timeout -k 5 20 findmnt -n -o TARGET -T "$nearest") || return 1
  [ -n "$mount_at" ] && [ "$mount_at" != "/" ] || return 1
  timeout -k 5 20 mkdir -p "$BACKUP_DIR" || return 1
  timeout -k 5 20 touch "$BACKUP_DIR/.write-probe" || return 1
  rm -f "$BACKUP_DIR/.write-probe"
}

# The 20-byte empty gzip is what a dump against a dead postgres looks like.
dump_is_complete() {
  gzip -dc "$1" | tail -n 20 | grep -q "PostgreSQL database dump complete"
}

backup_reason=""
if backup_target_ok; then
  # 1. Postgres dump (30-day retention). search_chunks DATA is excluded: it is
  #    the largest table, fully derived, and rebuildable with `reindex` — the
  #    table DDL and its GIN/HNSW indexes are still in the dump, only the rows
  #    are dropped. A restore therefore yields an empty index, which is why the
  #    restore procedure in docs/deploy.md ends in a reindex step.
  #    --exclude-table-data is schema-qualified on purpose: a bare
  #    `search_chunks` is a pattern that would match across schemas.
  #    document_texts is deliberately KEPT — OCR is expensive and its rows are
  #    not cheaply rebuildable.
  #    Staged as .partial and renamed only once complete, so a failed run never
  #    replaces a good same-day dump.
  dump="$BACKUP_DIR/db-$STAMP.sql.gz"
  if "${COMPOSE[@]}" exec -T postgres \
       pg_dump -U verder --exclude-table-data=public.search_chunks verder \
       | gzip > "$dump.partial" && dump_is_complete "$dump.partial"; then
    mv -f "$dump.partial" "$dump"
    find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete
  else
    rm -f "$dump.partial"
    backup_reason="dump-incomplete"
  fi

  # 2. Vault mirror. Files are content-addressed and never mutated, so --delete
  #    is deliberately NOT used: the backup only ever grows.
  #    Runs even after a failed dump (the vault is the irreplaceable half); the
  #    first failure is the one reported.
  if ! rsync -a "${VAULT_HOST_DIR:?}/" "$BACKUP_DIR/vault/"; then
    backup_reason=${backup_reason:-vault-mirror-failed}
  fi
else
  backup_reason="target-unmounted"
fi

if [ -z "$backup_reason" ]; then
  record_db_backup ok
else
  echo "nightly.sh: backup SKIPPED/FAILED ($backup_reason)" >&2
  record_db_backup error "$backup_reason"
fi

# 3. Full chain verification via the worker image (writes result to worker_runs,
#    exits non-zero on a broken chain so this whole script — and the cron log —
#    goes red).
"${COMPOSE[@]}" exec -T worker pnpm --filter worker nightly-verify

# 4. Ollama model freshness check.
"${COMPOSE[@]}" exec -T worker pnpm --filter worker model-check

# 5. Mail store — native nightly, version-independent archive weekly.
#    LAST ON PURPOSE. This script is `set -euo pipefail`, so every step
#    suppresses the ones after it, and this is the longest step by far (a 7 GB
#    tar, and once a week a ~12 GB pull over JMAP) and the only one that stops a
#    running service. Ahead of nightly-verify — where the plan put it — a failed
#    tar would silently skip the ledger integrity check, which is the one job
#    here that must never be skipped. See ops/mail-backup.sh.
# Needs the NAS as much as the dump does: skipped when the target is not OK.
if [ "$backup_reason" = "target-unmounted" ]; then
  echo "nightly.sh: mail backup skipped (backup target not mounted)" >&2
else
  ./ops/mail-backup.sh
fi

if [ -n "$backup_reason" ]; then
  echo "nightly.sh: FAILED ($STAMP): $backup_reason" >&2
  exit 1
fi
echo "nightly.sh: done ($STAMP)"
