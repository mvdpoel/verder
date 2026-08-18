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

mkdir -p "$BACKUP_DIR"

# 1. Postgres dump (30-day retention).
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U verder verder | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete

# 2. Vault mirror. Files are content-addressed and never mutated, so --delete
#    is deliberately NOT used: the backup only ever grows.
rsync -a "${VAULT_HOST_DIR:?}/" "$BACKUP_DIR/vault/"

# 3. Full chain verification via the worker image (writes result to worker_runs,
#    exits non-zero on a broken chain so this whole script — and the cron log —
#    goes red).
"${COMPOSE[@]}" exec -T worker pnpm --filter worker nightly-verify

# 4. Ollama model freshness check.
"${COMPOSE[@]}" exec -T worker pnpm --filter worker model-check

echo "nightly.sh: done ($STAMP)"
