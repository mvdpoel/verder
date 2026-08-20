# Deploying verder to the homelab

Production runs as three containers via `docker-compose.prod.yml` (postgres,
web, worker), plus host-level pieces: Ollama, the cloudflared tunnel, a repo
checkout for migrations/seeding, and a nightly cron job.

## Prerequisites

- Docker with the compose plugin.
- Node >= 22 and corepack on the host (the repo pins `pnpm@10.18.1` via
  `packageManager`; `corepack enable` gives you the right pnpm). Needed only
  for migrations, seeding and the one-time Gmail auth.
- Ollama running on the homelab with the model pulled:
  `ollama pull qwen3.5:9b` (or whatever `OLLAMA_MODEL` you set).
- An existing cloudflared tunnel you can point at `http://localhost:3000`.
- A Google Cloud OAuth "Desktop app" client JSON for the Gmail watcher.
- Host directories: the vault dir (e.g. `/srv/verder/vault`), the NAS scan
  mount (e.g. `/mnt/nas/scans`), and the backup target
  (e.g. `/mnt/nas/verder-backups`).

## 1. Checkout + `.env.prod`

```bash
git clone <repo-url> verder && cd verder
corepack enable
pnpm install
cp .env.example .env.prod
```

Edit `.env.prod`. Every variable the code reads, and what production values
look like:

| Variable | Production value |
| --- | --- |
| `DATABASE_URL` | `postgres://verder_app:<app-pw>@postgres:5432/verder` — the web container connects with the restricted `verder_app` role (INSERT+SELECT only on evidence tables) |
| `WORKER_DATABASE_URL` | `postgres://verder_worker:<worker-pw>@postgres:5432/verder` |
| `VAULT_DIR` | `/vault` (container mount of `VAULT_HOST_DIR`) |
| `NAS_SCAN_DIR` | `/scans` (container mount of `NAS_SCAN_HOST_DIR`) |
| `OLLAMA_URL` | `http://<homelab-lan-ip>:11434` — the container cannot reach `localhost` on the host |
| `OLLAMA_MODEL` | e.g. `qwen3.5:9b` |
| `GMAIL_CREDENTIALS_PATH` | `./secrets/gmail-oauth.json` (compose mounts `./secrets` into the worker at `/repo/secrets`) |
| `GMAIL_TOKEN_PATH` | `./secrets/gmail-token.json` |
| `RELEVANT_SENDERS` | comma-separated From-address filters, e.g. `@verdergroep.nl` |
| `AUTH_SECRET` | long random string: `openssl rand -hex 32` |
| `APP_URL` | `https://<your-tunnel-hostname>` |
| `SEED_EMAIL` / `SEED_PASSWORD` | your login; only needed while running the seed step |
| `ALLOW_SIGNUP` | leave unset — sign-up stays disabled; the seed script flips it internally |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `POSTGRES_PASSWORD` | password for the `verder` superuser inside the postgres container |
| `VAULT_HOST_DIR` | host path mounted as `/vault`, e.g. `/srv/verder/vault` |
| `NAS_SCAN_HOST_DIR` | host NAS mount, mounted read-only as `/scans` |
| `BACKUP_DIR` | nightly backup target, default `/mnt/nas/verder-backups` |

Also drop the OAuth client JSON in place:

```bash
mkdir -p secrets && cp /path/to/gmail-oauth.json secrets/gmail-oauth.json
```

All compose commands below use `--env-file .env.prod` so variable substitution
(`POSTGRES_PASSWORD`, `VAULT_HOST_DIR`, `NAS_SCAN_HOST_DIR`) and container env
come from the same file.

## 2. First run

### 2.1 Start postgres and migrate

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres
DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate
```

Migrations run from the host checkout as the admin role (`verder`), never
from the containers. The drizzle journal currently contains twenty-two
migrations — `0000` (schema) through `0021` — and covers everything
in one pass:

- `0000_noisy_the_initiative` — full schema (evidence + operational tables)
- `0001_grants` — creates `verder_app` (insert-only on evidence tables)
- `0002_auth_tables` / `0003_auth_grants` — better-auth tables (`user`,
  `account`, `session`, `verification`) + grants. There is **no separate
  better-auth migrate step**; these drizzle migrations are it.
- `0004_worker_role` — creates `verder_worker` (+ `CREATE ON DATABASE` so
  pg-boss can own its own schema)
- `0005_black_calypso` — `raw_emails.suggest_queued_at` outbox marker
  (backfills existing rows, column-level UPDATE grant for the worker)
- `0006_woozy_moonstone` — `push_subscriptions` table + grants
- `0007_sweet_masque` — financial registry schema (`financial_items`,
  `debts`, `transactions`, `registry_decisions` + enums)
- `0008_registry_grants` — registry grants: `registry_decisions` is
  evidence (INSERT+SELECT only); fact tables get UPDATE but never DELETE
- `0009_burly_jack_murdock` — `suggestion_kind` enum values
  `registry-item` and `debt`
- `0010_volatile_amazoness` — tasks + milestones schema (`tasks`,
  `task_status_changes`, `milestones`, `wsnp_stage` enum) and
  `suggestion_kind` value `task`
- `0011_task_grants` — task grants: `task_status_changes` is evidence
  (INSERT+SELECT only); `tasks`/`milestones` get UPDATE but never DELETE
- `0012_lively_scarlet_witch` — curated key events (`timeline_events` +
  `timeline_event_kind` enum)
- `0013_timeline_grants` — `timeline_events` grants (editable display aid:
  UPDATE allowed, DELETE never)
- `0014_vector_extension` — `CREATE EXTENSION IF NOT EXISTS vector`. Requires
  the `pgvector/pgvector:pg17` image; a stock `postgres:17` fails here and
  every later migration cascades
- `0015_knowledge_base` — `document_texts`, `search_chunks`, `search_outbox`,
  the GIN index on `tsv` and the HNSW cosine index on `embedding`
- `0016_search_grants` — index grants. FIRST tables in this project with
  DELETE: the index is DERIVED, not evidence — fully rebuildable by `reindex`,
  it appends no ledger events, and index health is surfaced on `/verify`.
  Neither role gets INSERT on `search_outbox`; rows arrive only through the
  SECURITY DEFINER trigger function owned by `verder`
- `0017_search_triggers` — `search_enqueue()` plus fourteen
  `AFTER INSERT OR UPDATE` triggers: nine entity tables and five
  parent-refresh tables (`document_status_changes`, `task_status_changes`,
  `registry_decisions`, `entry_participants`, `entry_documents`)
- `0018_retrieved_refs` — `suggestions.retrieved_refs` (retrieval citations;
  table-level grants already cover the new column)
- `0019_document_text_trigger` — a fifteenth search-outbox trigger, on
  `document_texts`, so text that lands after ingestion re-enqueues its document
- `0020_abn_xls_tx_source` — `tx_source` enum gains `abn-xls` (ABN AMRO's
  "Excel" statement export). Additive only: `ALTER TYPE ... ADD VALUE` rewrites
  no row, so the append-only evidence guarantee is untouched. **This migration
  must be applied before deploying a web/worker build that can detect
  spreadsheets** — without it an Excel import parses fine and then fails on
  `invalid input value for enum tx_source`
- `0021_discarded_doc_status` — `doc_status` enum gains `discarded`, so a junk
  document (an email signature logo) can be discarded by APPENDING a
  `document_status_changes` row instead of being deleted. Additive only, same
  as `0020`: `ALTER TYPE ... ADD VALUE` rewrites no row, so the append-only
  evidence guarantee is untouched. **Apply it before deploying a web/worker
  build that can discard** — without it every Discard click fails on
  `invalid input value for enum doc_status`

### 2.2 Change the role passwords from the dev defaults

`0001`/`0004` create the roles with dev passwords (`verder_app` /
`verder_worker`). Replace them, and use the new values in
`DATABASE_URL`/`WORKER_DATABASE_URL` in `.env.prod`:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U verder -d verder \
  -c "ALTER ROLE verder_app PASSWORD '<app-pw>';" \
  -c "ALTER ROLE verder_worker PASSWORD '<worker-pw>';"
```

### 2.3 Seed the single user

```bash
DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
AUTH_SECRET="<same-as-.env.prod>" APP_URL="https://<your-tunnel-hostname>" \
SEED_EMAIL="you@example.com" SEED_PASSWORD="<your-login-password>" \
  pnpm --filter @verder/auth seed
```

This creates the better-auth credential account and the app-level `users`
row, then sign-up stays disabled (`ALLOW_SIGNUP` unset).

### 2.4 Build and start the full stack

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

`web` listens on `127.0.0.1:3000` only; the tunnel is the sole way in.

## 3. Gmail one-time auth

Run on the host from the checkout (interactive: prints a Google URL, you
paste the redirect URL/code back):

```bash
GMAIL_CREDENTIALS_PATH=./secrets/gmail-oauth.json \
GMAIL_TOKEN_PATH=./secrets/gmail-token.json \
  pnpm --filter worker gmail:auth
```

The refresh token lands in `./secrets/gmail-token.json`, which compose mounts
into the worker. Restart the worker afterwards:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml restart worker
```

## 4. Tunnel

Point the existing cloudflared tunnel hostname at `http://localhost:3000`
and (recommended) put Cloudflare Access in front of the hostname as a second
factor in front of better-auth.

## 5. Nightly cron

`ops/nightly.sh` sources `.env.prod` itself, so the crontab line stays bare:

```
30 3 * * * /path/to/verder/ops/nightly.sh >> /var/log/verder-nightly.log 2>&1
```

Each night it: dumps postgres to `$BACKUP_DIR/db-YYYY-MM-DD.sql.gz` (30-day
retention), mirrors the vault to `$BACKUP_DIR/vault/` (additive rsync, no
`--delete`), runs the full chain verification inside the worker container
(same code path as the Verify page — result recorded in `worker_runs` as
`nightly-verify`, non-zero exit on a broken chain), and checks Ollama for
model updates (`worker_runs` as `model-check`).

Run it once by hand first: `./ops/nightly.sh`.

## 6. Smoke test

1. Open `https://<your-tunnel-hostname>`, log in with the seeded credentials.
2. Log one manual entry; check it appears in the logbook.
3. Email yourself from a `RELEVANT_SENDERS` address; within ~3 min it should
   show up in the queue. Approve it.
4. Drop a scan into the NAS folder; within ~2 min it appears in the vault
   inbox.
5. Run Verify in the UI → green, and `./ops/nightly.sh` → exit 0.

## 7. Upgrading an existing deployment

Order matters: migrate first, then rebuild, then backfill.

```bash
# 1. Sync the checkout, then migrate from the HOST as the admin role
DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate

# 2. Rebuild the app containers
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker
```

After deploying spreadsheet support, backfill the documents that were ingested
before it — an ABN "Excel" export ingested earlier sits at `extractor: none`,
`char_count: 0`, invisible to search, to `registry.mine` and to the "do we
already have this?" panel:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker extract-texts   # picks up anything stored as extractor "none"
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker reindex         # gets the new text into search_chunks
```

Then check `/verify`: the hash chain still verifies and index health is green.

After deploying junk-document discard, backfill the signature images that were
filed before it — they stay in the vault and in the ledger, they just stop
appearing in the vault list, the queue and search:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker discard-signature-images   # idempotent; one ledger event each
```

It prints every document it touches before touching it, and a re-run appends
nothing. Nothing is deleted: no vault file is unlinked and no `documents` row
is removed, so `/verify` must still be green afterwards — check it: the hash
chain must still verify.

## Restore procedure

Both the dump and the restore must run on a **pgvector-capable image**
(`pgvector/pgvector:pg17`): the dump contains `CREATE EXTENSION IF NOT EXISTS
vector`, and a stock `postgres:17` fails on that line and cascades.

1. Stop web + worker (leave postgres up):
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml stop web worker
   ```
2. Restore the database dump:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
     psql -U verder -c "DROP DATABASE verder;" -c "CREATE DATABASE verder;" postgres
   gunzip < "$BACKUP_DIR/db-<DATE>.sql.gz" | \
     docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
     psql -U verder verder
   ```
3. Restore the vault files:
   ```bash
   rsync -a "$BACKUP_DIR/vault/" "$VAULT_HOST_DIR/"
   ```
4. Rebuild the search index. The nightly dump excludes `search_chunks` data
   (`--exclude-table-data=public.search_chunks`), so a restored database has
   the table, its GIN/HNSW indexes and no rows — search would silently return
   nothing:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker
   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
     pnpm --filter worker reindex
   ```
   This is GPU-bound and not instant. To rebuild only part of the corpus use
   the flags `--entity=document`, `--since=2026-01-01`, `--prune`; there is no
   environment-variable form. Check `/verify` afterwards: chunk count non-zero,
   outbox depth draining, embedding failures at zero.
5. Start everything and verify:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
     pnpm --filter worker nightly-verify
   ```
   Confirm the run is green (exit 0) and the Verify page agrees before
   trusting the restored system.
