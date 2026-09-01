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

# 1. Postgres dump (30-day retention). search_chunks DATA is excluded: it is
#    the largest table, fully derived, and rebuildable with `reindex` — the
#    table DDL and its GIN/HNSW indexes are still in the dump, only the rows
#    are dropped. A restore therefore yields an empty index, which is why the
#    restore procedure in docs/deploy.md ends in a reindex step.
#    --exclude-table-data is schema-qualified on purpose: a bare
#    `search_chunks` is a pattern that would match across schemas.
#    document_texts is deliberately KEPT — OCR is expensive and its rows are
#    not cheaply rebuildable.
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U verder --exclude-table-data=public.search_chunks verder \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
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

# 5. Mail store — native nightly, version-independent archive weekly.
#    LAST ON PURPOSE. This script is `set -euo pipefail`, so every step
#    suppresses the ones after it, and this is the longest step by far (a 7 GB
#    tar, and once a week a ~12 GB pull over JMAP) and the only one that stops a
#    running service. Ahead of nightly-verify — where the plan put it — a failed
#    tar would silently skip the ledger integrity check, which is the one job
#    here that must never be skipped. See ops/mail-backup.sh.
./ops/mail-backup.sh

echo "nightly.sh: done ($STAMP)"
