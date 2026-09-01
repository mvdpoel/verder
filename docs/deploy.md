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
from the containers. The drizzle journal currently contains thirty
migrations — `0000` (schema) through `0029` — and covers everything
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
  the `pgvector/pgvector:pg17-trixie` image; a stock `postgres:17` fails here
  and every later migration cascades. THE `-trixie` SUFFIX IS NOT OPTIONAL: it
  is the only pgvector tag built against prod's glibc 2.41, and the bare
  `:pg17` tag downgrades the collation provider underneath the ledger
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
- `0022_transactions_account_iban` — nullable `transactions.account_iban`, the
  account a statement row belongs to, so `/money` can keep the beheerrekening
  and the leefgeldrekening apart. Additive with no default and no backfill;
  old code ignores the column. **Apply it before deploying a web/worker build
  that serves `/money`** — without it every `money.series` query fails on an
  unknown column

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
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build postgres web worker
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

`web` listens on `127.0.0.1:3000` only; the tunnel is the sole way in.

**The services are named on purpose.** A bare `up -d` would also start
`stalwart`, and the mail service has a first-start ritual of its own: three host
directories that must exist and be owned by uid 2000, and a setup wizard that
decides where the mail store lives. Starting it before §8 is not dangerous —
with no `config.json` it comes up in bootstrap mode on an in-memory store and
writes nothing (§8.4) — and if the host directories are not there yet it simply
refuses to start, because all three of its bind mounts carry
`create_host_path: false`: `invalid mount config for type "bind": bind source
path does not exist`. That message is this document telling you to go to §8.3.
Bring mail up through §8, not through this step.

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

Point the existing cloudflared tunnel hostname at `http://localhost:3000`.

Cloudflare Access is deliberately **not** used any more. The app authenticates
its own users: a passkey (Touch ID / Face ID) with a password fallback, and a
"trust this device for 30 days" choice that decides the session length. Access
added a second email-code ceremony on top of a login screen that already
existed, and delivered those codes to the same mailbox the worker polls for
case correspondence.

Two things replace what Access was quietly providing:

- **A Cloudflare rate-limiting rule** on the hostname, matching
  `starts_with(http.request.uri.path, "/api/auth/")`, at 10 requests per
  minute per IP. The password endpoint is now reachable from the open
  internet and must not be grindable.
- **`advanced.ipAddress.ipAddressHeaders`** in `packages/auth`, set to
  `["cf-connecting-ip", "x-forwarded-for"]`. Everything arrives through the
  tunnel, so better-auth's default of `x-forwarded-for` alone would let a
  client prepend a value and hand itself a fresh rate-limit bucket per
  request. Cloudflare sets and overwrites `cf-connecting-ip`.

Two environment variables in `.env.prod` drive the passkey:

| Variable | Value |
| --- | --- |
| `PASSKEY_RP_ID` | `<your-tunnel-hostname>` (no scheme, no path) |
| `PASSKEY_RP_NAME` | `Verder` |

A passkey is cryptographically bound to its `rpID`, so one registered against
`localhost` in development will never work in production. Register the
production passkey against the production hostname, and confirm it signs you
in **before** removing the Access application — otherwise the only remaining
door is the password, under a policy that has just changed.

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

### 7.0 Syncing the tree — the canonical rsync

Every runbook below says "sync the checkout" and this is what that means. There
is no GitHub key on the homelab, so the tree is pushed from the Mac with rsync.

**The exclude list is the entire safety mechanism.** `--delete` is required —
without it a file deleted in the repo lives on in `~/apps/verder` and the Docker
`next build` fails on a stale file importing something that no longer exists.
But rsync does **not** read `.gitignore`: a path being git-ignored protects it
from nothing here. Use this command, and only ever add to the list:

```bash
# ALWAYS dry-run first and read every `deleting` line.
# Plain --dry-run without -v/--info=del prints NOTHING, which reads as
# "no deletions" and is not the same thing.
rsync -avn --delete --info=del \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  --exclude '.env' --exclude '.env.local' --exclude '*.traineddata' \
  --exclude '.superpowers' --exclude '.gstack' --exclude '.claude' \
  --exclude 'next-env.d.ts' --exclude '*.tsbuildinfo' \
  ./ homelab:~/apps/verder/

# Then the real run: same flags, drop the -n.
rsync -av --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
  --exclude '.env' --exclude '.env.local' --exclude '*.traineddata' \
  --exclude '.superpowers' --exclude '.gstack' --exclude '.claude' \
  --exclude 'next-env.d.ts' --exclude '*.tsbuildinfo' \
  ./ homelab:~/apps/verder/
```

Why each of the three dangerous ones is there, measured 2026-08-27 — a dry run
carrying only `.git`, `node_modules` and `nightly.log` printed:

```
deleting secrets/role-passwords
deleting secrets/gmail-token.json
deleting secrets/gmail-oauth.json
deleting .env.prod
```

That is the Gmail integration and every database role password, destroyed by one
command. `vault-files/` is the dev vault and must never be shipped over the
production one. `nightly.log` is written into `~/apps/verder/` itself and exists
on the homelab only, so `--delete` without it erases the whole history of
nightly backup and verify runs — on 2026-08-22 the dry run printed exactly one
line, `deleting nightly.log`, which is the only warning there is.

**The last eight excludes were added 2026-08-30, and the list was UNSAFE without
them.** It only ever looked safe because every deploy so far ran from Martin's
working tree, where those gitignored files happen to exist locally — so
`--delete` found a matching copy on both sides and printed nothing. Sync from
any tree that does not have them (a fresh clone, a `git worktree`, CI, a second
machine) and the dry run asks to delete, measured — 44 `deleting` lines from a
clean worktree of HEAD, of which these four matter:

```
deleting apps/worker/nld.traineddata     11 MB of Tesseract data; ocr-image
deleting apps/worker/eng.traineddata     and ocr-pdf stop working
deleting .env                            VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
deleting apps/web/.env.local             DATABASE_URL, AUTH_SECRET, APP_URL,
                                         VAULT_DIR, VAPID keys
```

None of those three files is in git anywhere, so the deletion is unrecoverable —
and losing the VAPID keys takes out web-push, which is the alerting path
precisely BECAUSE it does not depend on mail.

**Prefer deploying from a clean worktree of HEAD**, not from the working tree:

```bash
git worktree add --detach /tmp/deploy-tree HEAD    # then rsync from there
```

It ships exactly what is committed, which is the only way to be sure a second
session's uncommitted work is not riding along — on 2026-08-30 a parallel
session was mid-edit in `apps/web/` during this deploy, and a working-tree rsync
would have built its half-finished design system into the production web image.
That habit is only safe with the excludes above, which is why they are not
optional.

Afterwards, confirm the secrets survived:

```bash
ssh homelab 'ls ~/apps/verder/secrets/ && ls -l ~/apps/verder/.env.prod'
```

**Note this is NOT the Syncthing folder.** Syncthing keeps `~/Workspace` in step
bidirectionally across MacbookPro, aios and homelab (excluding `.git` and
`node_modules` via `~/Workspace/.stignore`), so `homelab:~/Workspace/mp/verder`
is usually current on its own. Production deliberately does not run from there:
`.env.prod`, `secrets/` and the vault live under `~/apps/verder`, and a
bidirectionally-synced production directory would replicate those secrets to
three machines and let a half-saved edit on any of them reach a build.

### 7.1 Order of operations

Order matters: migrate first, then rebuild, then backfill.

```bash
# 1. Sync the checkout (see 7.0), then migrate from the HOST as the admin role
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

After deploying the case map (sub-project 6), the migration does more than add
tables — it also drops the two retired search triggers and deletes the chunks
and outbox rows for the entity kinds the map replaced. Order matters more here
than usual, because the blast radius is not only `/timeline`: the dashboard and
every logbook entry page call `tracks.map()` themselves, so an image deployed
ahead of the migration takes down the landing page too.

```bash
# 1. migration FIRST, from the homelab HOST
ssh homelab 'cd ~/apps/verder && set -a && source ./.env.prod && set +a && \
  DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate'   # bare, without DATABASE_URL, dies on 28P01
# 2. then rsync the tree and rebuild web + worker
# 3. index the two new entity kinds (track, stop)
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker reindex'
# 4. verify — this sub-project appends NO ledger events, so the event count
#    must not move at all. If it does, something wrote evidence that should not.
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```

`reindex --prune` does **not** remove the retired `milestone` and
`timeline_event` chunks — it walks `SEARCH_ENTITY_TYPES` and a retired kind is
no longer in it, so it never visits them. Migration 0023's `DELETE` is the only
thing that clears them; do not rely on prune for it.

Between step 1 and step 2 there is a short window where the seeded `track` and
`stop` outbox rows are queued and the *old* worker image does not know those
entity kinds. It records `search.drain` as `error` until the new image lands and
then heals itself. Expect it; it is bounded, unlike the failure the migration
removes.

If a dev database ever loses its map (the test suite truncates evidence tables
and the cascade reaches `stops`), restore it with
`pnpm --filter @verder/db seed-map` — idempotent, and safe to run against a
database that already has one.

### Migration 0026 — the vertical case map

0026 turns the map vertical (newest at the top, one band per month) and makes it
history-only. It is the ONE migration in this project that DELETES rows from
`stops` and `tracks`: the *Einde bewindvoering* goal, the duplicated anchors and
every `expected` stop go, the Aanvraag and Opstart stops move onto the spine,
and every child track's `branches_at_stop_id` / `merges_at_stop_id` is nulled
(branch geometry is date-driven from here on; the pointer is semantic only and
the spoor editor is where Martin records one when he knows it). It runs as the
`verder` admin role — the app and worker grants are untouched and still carry no
DELETE.

Same ordering trap as 0020–0023, and the same reason: `/timeline`, the dashboard
and every logbook entry page read `tracks.map()`, and the new web image reads
columns and rows the old schema does not have.

```bash
# 1. migration FIRST, from the homelab HOST
ssh homelab 'cd ~/apps/verder && set -a && source ./.env.prod && set +a && \
  DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate'   # bare, without DATABASE_URL, dies on 28P01
# 2. then rsync the tree (with the full --exclude list) and rebuild web + worker
# 3. verify — 0026 appends NO ledger events, so the event count and the chain
#    HEAD must both be unchanged. A moved head means something wrote evidence.
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```

After it lands, check:

- `/timeline` draws the spine top-to-bottom with a month band per month, and no
  spoor is left dangling — the map derives a departure from a spoor's own oldest
  halte, so a NULL pointer is normal and not a problem to fix.
- The dashboard's **Waar de zaak staat** block shows the running haltes plus the
  newest three dated ones, and one line per open spoor under them.
- `/verify` is green and the chain head is the one recorded before the deploy.

`pnpm --filter worker case-history` remains safe to re-run afterwards: it no
longer touches a branch or merge point that no seed entry names, so a pointer
recorded by hand in the spoor editor survives every run.

It is scoped to the population it was measured against: `created_at` before
2026-08-21, and only documents still sitting in the inbox. `image.png` is also
the filename Gmail, Apple Mail and Outlook give a pasted-from-clipboard
screenshot sent as a genuine attachment — which the port filter correctly keeps
— so without those bounds a later re-run (after a restore, say) would discard
real evidence, including documents already filed by hand.

### Reconstructing the case history from the mailbox

`pnpm --filter worker case-history` writes the case as it actually ran onto the
map and the task list: the parties, the main line's stations, seven side tracks
and thirty tasks including the finished ones. It changes no schema, so there is
nothing to migrate — but the worker **image** has to be rebuilt, because the
script is baked in.

It is idempotent by title, and it **converges**: the seed describes the map it
wants and the script moves what exists into that shape. `stops` and `tracks`
have INSERT and UPDATE and no DELETE, so that is always a rename and a move,
never a delete-and-recreate — which is exactly why a restructure is safe here
at all, and why the renames in `STOP_RENAMES`/`TRACK_RENAMES` run *first*: every
other guard keys on the title, so a late rename would leave the old row and
insert a second one beside it that nothing can remove.

Structure belongs to the seed; content belongs to Martin. On a stop that already
exists the script writes only its track, its position and any still-null
evidence link. It never touches `state`, `kind`, `note` or `happened_at` — those
are the fields the editor lets him change, and a backfill that reverted his
edits on every run would be worse than no backfill. The same rule gives the
`SPINE_DATES` block its guard: a date is filled in only where the column is
still null.

Two invariants worth knowing before editing the seed, both asserted by
`case-history.test.ts`: **stop titles are unique across the whole map** (the
lookup is map-wide, so two tracks claiming one title would drag the row back and
forth on every run), and **every `open` stop is work waiting on Martin** (the
map's headline is the furthest-right open stop, and an open stop that waits on
somebody else silently steals it). The result's `strandedOnSpine` is the guard
that the main line stayed bare — four stops, nothing else.

```bash
# 1. rsync + rebuild the worker image (no migration; nothing schema-side moved)
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml up -d --build worker'
# 2. the reconstruction — creates the parties the backfill then needs
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker case-history'
# 3. the mail, INCLUDING Martin's own sent mail — see the trap below
# 4. run case-history again to link the newly ingested attachments
```

Its ledger footprint is stated in the file header and must be checked against
the event count afterwards: one `party.created` per genuinely new party, one
`task.status` per task that is not plain open, and **nothing at all** for
tracks, stops or the tasks themselves (`tasks.create` appends no event; a plain
open task carries no status row). Measured on the first production run:
47 → 73 events, which is 4 + 22, and `nightly-verify` green on 73.

**THE TRAP, and it is the reason the vault looked thin.** `pollGmail` decides
relevance on `msg.from` against `RELEVANT_SENDERS` plus every `parties.email` —
so Martin's own sent mail matched nothing and was never ingested, and with it
every attachment he ever *sent*. That is the whole moratorium package of
sixteen files, the passport copy, the payslips, the policies, the BKR summary.
Fifty inbound emails were stored and not one outbound one. Widen the filter for
the run only, and scope the query so it cannot pull in unrelated business mail:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T \
  -e RELEVANT_SENDERS="@verdergroep.nl,@verderbewindmidden.nl,martin@vanderpoel.pro" \
  -e BACKFILL_QUERY="after:2026/04/01 (to:verdergroep.nl OR to:verderbewindmidden.nl \
OR from:verdergroep.nl OR from:verderbewindmidden.nl OR to:info@hafkamp.nl \
OR from:stamdeurwaarders.nl OR from:collections.trustandlaw.nl)" \
  worker pnpm --filter worker backfill
```

Run `case-history` **before** this, not after: it creates Hafkamp, Stam and
Trust and Law as parties, which widens the relevance filter permanently and is
the real fix rather than a one-off env override. Their mail was invisible to
this app until then — which is exactly how a Stam sommation that refers to an
existing *vonnis* sat in Gmail for five weeks reaching no surface of the system.

**A `429 User-rate limit exceeded` here does not heal on its own — you have to
stop the worker.** The limit is account-wide, and every attempt against it
resets the retry deadline to a fresh fifteen minutes. `gmail.poll` is scheduled
`*/3 * * * *`, so the cron alone re-arms the lockout five times per window and
the account never recovers; `worker_runs` fills with a stair of `error` rows
whose retry instants keep marching forward in step with the cron. Measured on
2026-08-22: 20:42 → 20:57, 20:45 → 21:00, 20:48 → 21:03, 20:51 → 21:06, with
three attempts per cron tick. Normal mail ingestion is down for the duration,
not just the backfill.

The way out is a genuinely quiet window:

```bash
# 1. stop ALL Gmail traffic — the cron is the thing keeping the lockout alive
docker compose --env-file .env.prod -f docker-compose.prod.yml stop worker
# 2. wait past the LAST retry instant in worker_runs, plus a margin
# 3. run the backfill in a one-off container, with the service still down
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm -T \
  -e RELEVANT_SENDERS=... -e BACKFILL_QUERY=... worker pnpm --filter worker backfill
# 4. bring the worker back
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker
```

Nothing partial is left behind when it does trip: the limit hits
`listMessageIds` before any ingest, and the backfill is idempotent on
`gmail_message_id` regardless.

Worth knowing, and currently unfixed: `pollGmail` has no backoff. It records the
failure and the cron simply tries again three minutes later, which is what turns
one 429 into a permanent one. Honouring the `Retry-After` instant the error
already carries — skipping the poll until it passes — would make this
self-healing.

Each newly ingested email enqueues a `suggest.entry` job, so a backfill of this
size puts a few dozen LLM jobs on the GPU and fills the review queue. That is
the designed path, not a side effect: the suggestions are how the mail becomes
log entries, and Martin approves them one by one.

Note also that `pollGmail` short-circuits on a message id it has already seen,
so re-running the backfill will **not** collect attachments from the fifty
emails ingested earlier. Those were already fully processed; the gap was only
ever the outbound half.

Money in/out needs no backfill: `account_iban` is populated by the importer
from the next statement onward, and any row imported before it simply shows up
under "unknown account". Re-import a statement to fill it in — the import is
idempotent on (statementSha256, rowIndex), so drop those rows first if you
want them re-read.

## 8. Stalwart: eigen mail over JMAP (phase 1)

Phase 1 of the mail rearchitecture runs a mailbox on the homelab and gives the
worker a JMAP client for it. **It changes nothing about how mail arrives**, and
**it does not switch mail ingestion on** — see §8.8 before you plan an evening
around it. No MX record is touched and no DNS is changed; the mailbox is filled
once from a Google Takeout export and read by the worker from then on. Gmail
polling stays unscheduled — see the rate-limit runbook in §7 for why it cannot
simply be restarted.

One file describes the service: the `stalwart` block in
`docker-compose.prod.yml`. **This repo ships no Stalwart configuration file, and
nothing in `ops/stalwart/` is mounted into the container.** That directory
contains exactly two things — `config.json.example`, a disaster-recovery copy of
the one file Stalwart keeps on disk and writes itself, and a `README.md` saying
what it is for. There is no `config.toml` here and there never was one: the
directory arrives with this changeset (`git log -- ops/stalwart` is empty), so
nothing stale is waiting on the homelab for the rsync to clean up. §8.1 is about
the shape of the product, not about a file this repo lost.

**It does ship two migrations**, which are not optional and must run before the
images are rebuilt — §8.4.

### 8.0 Provenance: what is read, what is measured

This project keeps read-from-source and measured-against-a-running-thing apart,
and a mail server is not where to start blurring them. A passage in the previous
draft of this section was headed "one measured trap" and had in fact only been
read. So:

**THE ARCHIVE IMPORT, MEASURED 2026-08-30.** Google Takeout → Vandelay →
Stalwart, 146,270 messages. Two things dominate and neither is in any guide:

1. **Stalwart rate-limits its own migration, twice, and the defaults make it
   impossible.** Vandelay is a well-behaved client: it honours the 429s and
   sleeps, so nothing fails — it just never finishes. Both limits must be raised
   BEFORE starting, and both are per-account, not per-connection:

   | Limit | Where | Default | For a migration | Cost if left |
   | --- | --- | --- | --- | --- |
   | `maxUploadCount` | Network → Services → JMAP | 1000 files | 10,000,000 | ~95 h |
   | `uploadQuota` | Network → Services → JMAP | 50,000,000 B | 107,374,182,400 | ~150 h |
   | Authenticated rate limit | Network → Services → HTTP → **Security** | 1000/min | 1,000,000/min | ~5 h |
   | `maxConcurrentRequests` / `maxConcurrentUploads` | JMAP | 4 / 4 | 64 / 64 | throughput |

   The blob quota and the request rate limit live on DIFFERENT pages, and the
   first only reveals the second: clearing the upload quota simply exposes the
   HTTP limit underneath. Measured after raising all four: **zero 429s**, 146,270
   messages in 18 minutes, ~8,000 messages/minute.

   Leave `uploadTtl` alone. Its own help text says a LONGER duration keeps
   uploads alive until referenced, so with the quota raised there is nothing to
   gain and shortening it is the risky direction.

   THESE ARE LEFT WIDE DELIBERATELY, not overlooked. One human, loopback-bound,
   no SMTP listener. The practical exposure is that an authenticated client could
   park 100 GB in temp upload storage on `/mnt/data`; the ANONYMOUS rate limit
   (100/min) is untouched and is the one that guards an unauthenticated endpoint.

2. **`vandelay import takeout --dry-run` reports FILE counts, not message
   counts.** The count comes from the real import, which writes only to a local
   SQLite archive and never contacts the mail server — so it is safe to run for
   the number alone.

Measured end state, and the acceptance test that matters is the THIRD line, not
the second — "exited 0" is not evidence that anything arrived:

```
archive (vandelay inspect)   146,270 emails · 20 mailboxes
export summary               created=143,547  skipped=2,723  failed=0
Email/query calculateTotal   146,270          <- the actual server-side count
```

The 2,723 skips are duplicates from two earlier throttled attempts, correctly
recognised; the export is idempotent and safe to re-run. Store on disk is 7.3 GB
for 11.5 GB of blobs — RocksDB lz4, which is the payoff for leaving Attachment &
File Storage on "Use data store" at the wizard's Storage screen.

Ledger unchanged throughout: 129 events, head `e30067a9…`. Importing 146,270
messages into Stalwart appends nothing to verder's chain, which is the point.

**THE SETUP WIZARD, MEASURED END TO END 2026-08-30.** It was run twice; the
first run had to be thrown away. Everything here is observed, not read:

1. **"Automatically Obtain TLS Certificate" on step 1 must be OFF, and it is ON
   by default.** Leaving it on creates an ACME provider that immediately orders
   a Let's Encrypt certificate for FIVE hostnames it derives from the domain —
   `autoconfig`, `autodiscover`, `mail`, `mta-sts`, `ua-auto-config` — over
   `tls-alpn-01`, which requires Let's Encrypt to reach port 443 on a public IP.
   Behind a tunnel none of that resolves and none of it is reachable, so every
   order fails with `Cannot negotiate ALPN protocol "acme-tls/1"` and it retries
   about every 35 seconds: 6 orders in twelve minutes before it was stopped.
   Let's Encrypt allows 5 failed validations per hostname per hour, so this
   burns the budget phase 3 will actually need.
2. **THE ACME PROVIDER CANNOT BE DELETED THROUGH THE WEBUI, so the only cure is
   not to create it.** Both routes were tried on v0.16.19: the edit form's red
   Delete with its "cannot be undone" confirm, and the list's Actions → Delete
   with its "Confirm Action" dialog. Both return to a list that still shows the
   provider after a hard reload, and NOTHING is written to the server log —
   no error, no rejection, while the same session authenticates fine and the
   identical bulk control deletes listeners without trouble. Recovering from a
   provider you did not want means wiping the store and re-running the wizard,
   which is only cheap before the archive import.
3. **The wizard enables SEVEN listeners no matter what you choose** — it never
   asks. `smtp:25`, `submissions:465`, `imaps:993`, `pop3s:995`, `sieve:4190`,
   `https:443` and `http:8080`. Phase 1 wants only the last. Delete the other
   six (Network → Listeners, select, Actions → Delete) and restart; verified
   afterwards from `/proc/net/tcp` inside the container, not from the UI.
   Only 8080 is published to the host, so the others were never externally
   reachable — but an SMTP listener that exists without being meant to is
   exactly what makes phase 2's "is inbound 25 reachable?" test lie.
4. **Finishing setup invalidates your session, and the failure looks like a
   broken htaccess.** You authenticate against the ephemeral BOOTSTRAP store;
   setup replaces it with the real one; your token then decodes against nothing
   and the server logs `Failed to decode token` while the browser falls back to
   a Basic-auth prompt. It is not a bad password. Clear `localStorage` and
   `sessionStorage` for the origin and sign in again. This happens on every
   run — it is inherent to the bootstrap handover, not a fault.
5. **`sudo rm -rf <dir>/*` SILENTLY DOES NOTHING on `etc/`.** That directory is
   mode 0750 owned by uid 2000, so the `*` glob is expanded by the unprivileged
   shell BEFORE sudo runs, matches nothing, and rm removes nothing while exiting
   0. Measured: `data/` and `blobs/` (0755) were wiped and `etc/config.json`
   survived, leaving a stale config over an empty database. Use
   `sudo sh -c 'rm -rf …'` so the glob expands as root, and verify with
   `sudo find <dir> -mindepth 1 | wc -l` rather than trusting the exit code.
6. **Log Destination offers `Console`, and its defaults are the right ones** —
   ANSI colours off, multiline off, where the `Log file` default has ANSI on.
   Choose Console: `/var/log/stalwart/` is not a bind mount, so file logs live
   in the container's writable layer and vanish on the next image bump.
7. **Min blob size renders with a locale comma (`16,44`)** and a typed value can
   land off by one — `16` was entered and `blobSize: 15360` was stored. It is
   inert when Attachment & File Storage is left on "Use data store", because the
   threshold then chooses between two names for the same RocksDB.

**MEASURED ON THE HOMELAB, first start 2026-08-30 08:34 CEST.** Until this
deploy nothing in this section had ever met a running Stalwart. These four have:

- **The container reports healthy in bootstrap mode.** `docker compose ps` shows
  `stalwart  Up (healthy)` within 12 s of a cold start, and on the host
  `/healthz/live` → 200, `/admin` → 302, `/.well-known/jmap` → 307. §8.8 listed
  "up and healthy" as an *assumption* because the server behaves differently in
  recovery mode; it holds.
- **`create_host_path: false` is honoured by the homelab's Compose 2.40.3**, not
  merely by Docker Desktop's v5.0.0 where it was first tested. Differential test
  on the homelab: the guarded service refused with `invalid mount config for
  type "bind": bind source path does not exist` and created nothing, while an
  unguarded service on an identical missing path started and silently created
  the directory. Note that `docker compose config` on 2.40.3 renders the mount
  as a bare `bind: {}` and does NOT echo the key back — the guard is there, the
  render just does not show it, so do not read its absence as missing.
- **Bootstrap mode prints a one-time admin password to the container log** and
  writes NOTHING to `/etc/stalwart` until the wizard finishes — that directory
  was still empty after a successful start. Recover the password with
  `docker compose … logs stalwart`; it survives until the container is recreated.
- **The nested blob mount leaves a root-owned stub.** `STALWART_BLOB_DIR` targets
  `/var/lib/stalwart/blobs`, which is *inside* `STALWART_DATA_DIR`'s target, so
  Docker creates the mountpoint inside the outer bind and it lands `root:root`
  (`/mnt/data/verder/stalwart/data/blobs`). It is inert — real writes go to the
  outer `blobs` bind, which is `2000:2000` — but if the wizard's Storage screen
  is ever pointed at a Filesystem blob store, check ownership first.

**MEASURED (locally, before the deploy):**

- `docker compose -f docker-compose.prod.yml --env-file <file> config` renders
  the whole file with **all four `STALWART_*` variables absent**: the three
  paths take the production defaults below and `STALWART_RECOVERY_ADMIN` renders
  as `null`, i.e. is simply not passed. `docker compose … ps` against the same
  file exits 0. This is what protects `ops/nightly.sh` (§8.4).
- `stalwartlabs/stalwart:v0.16.19` exists on Docker Hub, pushed 2026-08-24,
  linux/amd64 + linux/arm64, manifest list
  `sha256:0bb2e1fa01ce8dfc8d8dc1006ed11bd7359be6144fd0f8a950b0c7bf5e9a9b6c`
  (`https://hub.docker.com/v2/repositories/stalwartlabs/stalwart/tags/v0.16.19`).
  The old image name `stalwartlabs/mail-server` has no tag newer than 2023.
- `ops/stalwart/config.json.example` parses as JSON.
- **`create_host_path: false` does what §8.4 claims.** Two one-container compose
  files differing only in that flag, Docker 29.1.3 / Compose v5.0.0-desktop.1:
  with it, `up` fails with `invalid mount config for type "bind": bind source
  path does not exist: <path>` and nothing appears on the host; without it, the
  host directory is created silently. Re-rendering `docker-compose.prod.yml`
  after adding the flag changes only the three `bind:` blocks — `config` still
  renders and `ps` still exits 0 with every `STALWART_*` variable absent.
- **The two migrations are load-bearing for `web`/`worker`** (§8.4): rendering
  drizzle's `select().from(rawEmails)` from `packages/db/src/schema.ts` in this
  tree emits a column list ending in `"source"`, which does not exist in the
  database until `0028_raw_emails_source.sql` runs. That one is about this
  repository, not about Stalwart, and it is measured.

**READ FROM SOURCE**, at `github.com/stalwartlabs/stalwart` ref `v0.16.19`
(commit `a0cf06f868e4d658d0a1943abb086e6b73ae5c73`, 2026-08-24) — every claim
below about how *Stalwart* behaves, with the file and line it came from. Where
the website and the tag disagree, the tag wins and the disagreement is called
out.

**MEASURED AGAINST A RUNNING SERVER: nothing.** No Stalwart has ever started in
this project. §8.9 is the list to confirm on the first start; correct this
section the same day if any of it turns out differently.

### 8.1 Version, and why the config file is gone

`stalwartlabs/stalwart:v0.16.19`, pinned. Never `:latest` on the service that
holds the archive: Stalwart is pre-1.0, its on-disk format is still moving, and
the 11.49 GB import happens once and must land in the version we keep.

The plan named `v0.11.5` (never released) and an earlier draft of this section
`v0.11.8` under the old image name `stalwartlabs/mail-server`, which upstream
abandoned. **Do not go back**: 0.12 rewrote the configuration model and 0.16
finished the job.

What changed, and it is the whole of §8:

| | 0.11 | **0.16.19** |
| --- | --- | --- |
| Config file | `config.toml`, the entire configuration | `config.json`, **only** the data-store connection |
| Format | TOML | JSON (`serde_json::from_str::<DataStore>`, `crates/store/src/registry/local.rs:71-80`) |
| Everything else | in that file | in a **registry inside the data store**, edited via `/admin` or the JMAP management API |
| Entrypoint | shell script running `--init` when the config was absent | the bare binary: `ENTRYPOINT ["/usr/local/bin/stalwart"]`, `CMD ["--config", "/etc/stalwart/config.json"]` (`Dockerfile:45-46`) — **there is no entrypoint script and no `--init`** |
| Paths | `/opt/stalwart-mail/{etc,data,blobs}` | `/etc/stalwart` and `/var/lib/stalwart` (`Dockerfile:32-40`) |
| Runs as | root | uid/gid **2000** (`Dockerfile:32-38`) |

`grep -rni toml` over `crates/**` at that tag returns nothing and no workspace
`Cargo.toml` depends on a `toml` crate. **A TOML file mounted into this image is
inert.** That is why the TOML-shaped configuration the mail plan drafted against
0.11 was dropped rather than ported — and to be exact about the history, dropped
before it was ever committed: no `ops/stalwart/config.toml` exists in this
repository's history, so there is no leftover of it anywhere.

The 0.11 trap this section used to warn about — "the entrypoint runs `--init`
only when the config file is absent, so mounting ours skips the generated admin
password and leaves no way in" — **does not exist in 0.16, and its replacement
runs the other way round.** With no `config.json`, Stalwart starts in
**bootstrap mode**: an in-memory ephemeral store, one HTTP listener on port
8080, and a one-time random `admin` password printed to the log
(`crates/store/src/build/registry.rs:38-67`). Finishing the setup wizard is what
*writes* `config.json`. So the danger is no longer "no way in" but "the file you
must not lose" — see `STALWART_ETC_DIR` in §8.3.

### 8.2 What the compose service does, and the one variable that matters

The whole service is in `docker-compose.prod.yml` with the citations inline.
Three things are worth repeating here.

**`STALWART_PUBLIC_URL=http://stalwart:8080` decides whether JMAP works at
all.** The session object's `apiUrl` / `downloadUrl` / `uploadUrl` are built
from a *configured* base URL and never from the request:
`crates/common/src/config/network.rs:437-442` sets `url_https` to
`registry.public_url()` — this variable, verbatim,
`crates/store/src/registry/local.rs:56-65` — and otherwise to
`https://{hostname}` with no port, where the hostname falls back to the
container's own (`crates/common/src/config/network.rs:199-204`).
`crates/jmap-proto/src/request/capability.rs:379-388` then formats every URL off
it. Unset, a worker that authenticates perfectly reads back
`apiUrl = "https://<random container id>/jmap/"` and posts its first real method
call into nothing. This is the 0.11 hostname trap, still here, wearing an env
var instead of a config key.

**Phase 1 does not claim there is no SMTP listener — it claims none is
published.** The first time 0.16 leaves bootstrap mode it inserts smtp/25,
submissions/465, imaps/993, pop3s/995, sieve/4190, https/443 and http/8080 into
the registry as safe defaults (`crates/common/src/manager/defaults.rs:462-491`).
They exist inside the container. Compose publishes **only**
`127.0.0.1:8080:8080`, so nothing outside the host can reach any of them, and no
MX record points here. Deleting the unwanted listeners in `/admin` is tidier;
not publishing them is what makes it safe.

**JMAP on plain HTTP over that 8080 listener is fine.** The default `http`
listener is created with `tls_implicit: false`
(`crates/common/src/manager/defaults.rs:473`), and
`crates/common/src/network/listen.rs:46` accepts such a connection in the clear.
`/.well-known/jmap` answers **307 → `/jmap/session`**
(`crates/http/src/request.rs:272-277`), which `fetch` follows by default and
which is same-origin, so the `Authorization` header survives.

### 8.3 Host directories — `chown 2000:2000`, not `$USER`

The store goes on `/mnt/data` — local NVMe, ~342 GB free (measured on the
homelab) — for all three directories. Nothing goes on the NAS mount: an
NFS-backed mail database is how a mail store corrupts, and keeping the whole
store local means that line is never approached rather than merely respected.

```bash
ssh homelab 'sudo mkdir -p /mnt/data/verder/stalwart/{etc,data,blobs} && \
  sudo chown -R 2000:2000 /mnt/data/verder/stalwart && \
  sudo chmod 750 /mnt/data/verder/stalwart/etc'
```

Run it before anything starts `stalwart`. If those directories are missing the
container refuses to start rather than creating them — all three bind mounts
carry `create_host_path: false` — so a missing `bind source path does not exist`
is this step, not a broken image.

**`2000:2000`, not `$USER`.** The image creates a `stalwart` user with uid and
gid 2000 and runs as it (`Dockerfile:32-38`). Docker will happily create a
missing bind-mount source as `root`, and the container then cannot write a byte
— which on a first start looks like a crash loop with a permissions line buried
in it.

| Variable | Production value |
| --- | --- |
| `STALWART_ETC_DIR` | `/mnt/data/verder/stalwart/etc` → `/etc/stalwart`. **New in 0.16 and load-bearing.** Stalwart writes `config.json` here itself when the wizard finishes (`crates/store/src/registry/local.rs:91-105`). Lose it and the server starts in bootstrap mode offering to build a second store beside the good one. It is a writable *directory*, never a read-only file mount |
| `STALWART_DATA_DIR` | `/mnt/data/verder/stalwart/data` → `/var/lib/stalwart`. The RocksDB holding the registry (all configuration) and all mail metadata |
| `STALWART_BLOB_DIR` | `/mnt/data/verder/stalwart/blobs` → `/var/lib/stalwart/blobs`. Used **only** if you point the wizard's Storage screen at a Filesystem blob store on exactly that path; leave it on "Use data store" and blobs go into the RocksDB above, which is still on `/mnt/data` and still correct. Kept separately settable because phase 2 may want the split |
| `STALWART_RECOVERY_ADMIN` | `admin:<plaintext password>`, e.g. `admin:$(openssl rand -hex 24)`. Honoured on **every** start and not only during setup (`crates/common/src/auth/authentication.rs:85-89`), compared as plaintext when it carries no hash prefix (`crates/directory/src/core/secret.rs:240-243`), and an empty secret can never authenticate. **Leaving it unset is safe** (§8.4) |
| `JMAP_BASE_URL` | `http://stalwart:8080` — the worker reaches it over the compose network |
| `JMAP_USER` / `JMAP_APP_PASSWORD` | the mailbox address and its app password, minted in §8.6. These two legitimately arrive late: they cannot exist before the account does |

`STALWART_PUBLIC_URL`, `STALWART_HOSTNAME` and `STALWART_HEALTHCHECK_URL` are
literals in the compose file, not `.env.prod` entries. Phase 2 replaces the
first two with the real FQDN.

### 8.4 Ordering: rsync, **migrate**, rebuild — and why the nightly cron is safe

**This changeset ships two migrations, and the images must not be rebuilt before
they run.** Same trap as 0020 through 0027, and it is not confined to mail:

| Migration | What it does |
| --- | --- |
| `packages/db/drizzle/0028_raw_emails_source.sql` | adds `raw_emails.source`, `NOT NULL DEFAULT 'gmail'`, plus the `raw_emails_source_check` constraint. Additive: every historical row is labelled and no `gmail_message_id` is rewritten |
| `packages/db/drizzle/0029_raw_emails_sha256_idx.sql` | non-unique btree index on `raw_emails.raw_rfc822_sha256`, which the JMAP poller's content dedup needs before the first post-import sync |

`packages/db/src/schema.ts` now carries `source` in the `rawEmails` model, and a
bare drizzle `select()` enumerates every column in the model. **Measured this
session** by rendering the query:

```
select "id", "gmail_message_id", "gmail_thread_id", "from_addr", "to_addr",
       "subject", "sent_at", "raw_rfc822_sha256", "body_text", "fetched_at",
       "suggest_queued_at", "source" from "raw_emails"
```

So `web` and `worker` images built from this tree against a database that has
not seen 0028 fail with `column raw_emails.source does not exist` on every one
of these, none of which is mail code:

- `/queue` (`packages/api/src/routers/suggestions.ts`)
- `search.drain` on `raw_email` chunks (`packages/api/src/search/index-entity.ts`)
- `suggest.entry` (`apps/worker/src/ollama.ts`)
- task mining (`apps/worker/src/task-mine.ts`)
- the receipts poller (`apps/worker/src/receipts.ts`)

**rsync first, then migrate from the HOST, then rebuild.** The rsync is first
because the two `.sql` files do not exist on the homelab until you send them,
and it is safe to be first because rsync only writes files — the running
containers keep the old images, so the migration still lands ahead of any new
code. Do not reorder these three.

```bash
# 1. Host directories (§8.3) and the .env.prod block (§8.3 for what each
#    variable means, §8.6 for the copy-pasteable block). Order against the
#    rsync does not matter — see below.

# 2. rsync the tree with the canonical command from §7.0 (--delete, full
#    exclude list). This is what puts the new docker-compose.prod.yml AND
#    packages/db/drizzle/0028_*.sql / 0029_*.sql on the homelab.

# 3. Migrations, from the homelab HOST, as the admin role — exactly the
#    spelling in §7.1. The bare `pnpm --filter @verder/db migrate` falls back
#    to the dev default and dies on 28P01 auth_failed, so DATABASE_URL is not
#    optional and $POSTGRES_PASSWORD has to come out of .env.prod:
ssh homelab                       # steps 3-5 all run inside this session
cd ~/apps/verder
set -a; source ./.env.prod; set +a
DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" \
  pnpm --filter @verder/db migrate     # applies 0028 then 0029, each once

# 4. Only now the app containers:
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker

# 5. And only now mail. `stalwart` touches no database, so this step is
#    independent of 3 and 4 — it is last so that one pass through this section
#    leaves the app correct before anything new is started:
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d stalwart
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f stalwart
```

Afterwards `/verify` should be green and the ledger event count unchanged:
**nothing in this changeset appends a `ledger_events` row.**

**On writing `.env.prod` before or after the rsync: it does not matter, and an
earlier draft of this section claimed otherwise.** The canonical rsync excludes
`.env.prod` outright (§7.0), so it can never disturb the file; and the window in
which the homelab holds a compose file naming variables its `.env.prod` lacks is
harmless, which is the measurement below. `JMAP_USER` and `JMAP_APP_PASSWORD`
legitimately arrive later still — they cannot exist before the account does
(§8.6).

That window used to be fatal. `ops/nightly.sh` shares this compose file and runs
`docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres
pg_dump …` as its first line under `set -euo pipefail`.

Compose interpolates the **whole file, every service**, on every command, before
it looks at which service you named — so a `${VAR:?}` marker in the `stalwart`
service would abort commands with nothing to do with mail: `gzip` still creates a
zero-byte `db-<date>.sql.gz` that looks like a backup, and `set -e` then skips
the vault mirror, `nightly-verify` and `model-check`. Every night, until someone
notices.

**Measured, this session, with all four `STALWART_*` variables absent:** the file
renders completely; the three paths take the defaults in the table above and
`STALWART_RECOVERY_ADMIN` renders as `null`, i.e. is not passed to the container.
`docker compose … ps` against it exits 0 — re-measured after the
`create_host_path: false` change, which alters only the three rendered mounts and
nothing about interpolation. The rule that keeps it that way: **nothing in the
`stalwart` service may use `${VAR:?}`** — defaults for the paths, bare
pass-through for the secret.

The cron is safe for a second reason as well: it only ever runs `exec` against
`postgres` and `worker`, never `up`, so it neither starts `stalwart` nor notices
that it is down (§8.10).

**Do not reach for a bare `up -d` anywhere in this section.** It would start
`stalwart` ahead of the mkdir/chown, and the three bind mounts now carry
`create_host_path: false` precisely so that fails loudly — `bind source path does
not exist: /mnt/data/verder/stalwart/etc` — instead of leaving three root-owned
directories that uid 2000 cannot write. Measured locally, both with and without
the flag; the reasoning is on the mounts in `docker-compose.prod.yml`. The flag
says nothing about ownership: a path that exists but is root-owned still passes,
so §8.3's `chown 2000:2000` is still yours to run.

**Starting `stalwart` without `STALWART_RECOVERY_ADMIN` set is safe**, which is
new in 0.16. It is why a stray start is untidy rather than damaging (§2.4) and
why the restore procedure can bring it up deliberately without hunting for a
password first. With no `config.json` yet the server enters bootstrap
mode on an **ephemeral, in-memory** store and prints a one-time random admin
password to the log (`crates/store/src/build/registry.rs:43-67`). Nothing is
written and nothing is corrupted; you only have to read the log instead of
knowing the password in advance. Setting the variable means you never have to.

### 8.5 First start: the setup wizard

On a fresh install `/etc/stalwart` is empty, so Stalwart comes up in bootstrap
mode: one HTTP listener on 8080 and the WebUI on it at `/admin`.

**You need an SSH tunnel to reach it, and this is the only interactive step in
phase 1 — if you skip the tunnel, phase 1 stops here.** Compose publishes
`127.0.0.1:8080:8080`, loopback on the homelab, exactly like `web` on 3000:
there is no URL that reaches `/admin` from the MacBook, and no tunnel hostname
points at it. `http://<homelab>:8080/admin` is connection-refused by design.
Open the forward from the Mac and leave the session running for as long as you
are in the WebUI:

```bash
ssh -L 8080:127.0.0.1:8080 homelab
```

Then browse **`http://127.0.0.1:8080/admin`** on the Mac. (`homelab` is the
alias in `~/.ssh/config`; the `127.0.0.1` in the middle is resolved on the
homelab, so it is that host's loopback and not your own. If something on the Mac
already holds 8080, use `-L 8081:127.0.0.1:8080` and browse `:8081` — the port
on your side is free choice, the one on the far side is not.)

Log in as `admin` with the password from `STALWART_RECOVERY_ADMIN`, or the
one-time one from the log.

*Unverified, with a ready fallback:* the WebUI is being reached on an origin
(`127.0.0.1:8080`) that is not `STALWART_PUBLIC_URL` (`http://stalwart:8080`).
If the browser ends up posting at `http://stalwart:8080/…` and failing, do not
change `STALWART_PUBLIC_URL` — that variable is what makes JMAP work at all
(§8.2). Add `127.0.0.1 stalwart` to the **Mac's** `/etc/hosts` and browse
`http://stalwart:8080/admin` instead: the same forward answers, and now the
origin matches.

The wizard has five screens (server identity, storage, account directory,
logging, DNS) and a confirmation. What matters for us:

- **Server identity** — hostname `stalwart` for phase 1 (it is what
  `STALWART_HOSTNAME` and `STALWART_PUBLIC_URL` already say). No TLS certificate
  and no DKIM: phase 1 publishes no port that would use them.
- **Storage** — data store **RocksDB at `/var/lib/stalwart/data`**. That is the
  value `ops/stalwart/config.json.example` records, and it is the one thing the
  wizard writes to disk. For blobs either leave "Use data store" (simplest;
  blobs land in the RocksDB, still on `/mnt/data`) or choose **Filesystem at
  `/var/lib/stalwart/blobs`**, which is the mount `STALWART_BLOB_DIR` provides.
  Decide before importing 11.49 GB, not after.
- **Account directory** — **internal**. In 0.16 that is simply the absence of an
  external one: the `Directory` object covers only LDAP, SQL and OIDC
  (`crates/registry/src/schema/structs.rs:927-932`), and
  `crates/directory/src/core/config.rs:42-56` leaves the default directory
  `None` unless `Authentication.directoryId` names one. **No directory or
  principal block is required for the server to start** — that question, from
  the 0.11 era, no longer has a subject.
- **Logging** — console. Unlike 0.11 no tracer block is needed to get output;
  the bootstrap and startup banners are unconditional
  (`crates/common/src/manager/boot.rs:168-190`).

Finishing writes `/etc/stalwart/config.json`, creates the permanent
administrator, and restarts into normal mode.

**The wizard is not baked into the image.** `/admin` is downloaded on first
start from
`https://github.com/stalwartlabs/webui/releases/latest/download/webui.zip`
(`crates/common/src/manager/defaults.rs:58-76`), and `stalwart-cli` is **not**
in the image any more — upstream moved it to its own repository and does not
ship it in Docker (github.com/stalwartlabs/stalwart/discussions/3013). So if the
container has no outbound internet, there is no wizard and no CLI, and the way
through is to write `/etc/stalwart/config.json` by hand from
`ops/stalwart/config.json.example`, restart, and do the rest via `/admin` once
the bundle can be fetched, or via `stalwart-cli` installed on the host. This is
the most likely single cause of an unusable first `up -d`; §8.9 checks it first.

### 8.6 Create the account and mint the app password

Through the same SSH forward as §8.5 (`ssh -L 8080:127.0.0.1:8080 homelab`, then
`http://127.0.0.1:8080/…` on the Mac) — both screens below sit on that same
loopback-only listener.

In `/admin`, as the administrator: create the domain `vanderpoel.pro`, then an
account for `martin@vanderpoel.pro`.

Then mint the credential the worker uses. **App passwords are issued by the
account holder, not by an administrator** — upstream is explicit that admins can
view and revoke them but not create them
(`https://stalw.art/docs/auth/authentication/app-password/`). So sign in to the
self-service portal at `http://127.0.0.1:8080/account` **as that account**,
through the same forward, and create one under Credentials › App Passwords. The value looks like `app_…`
(`crates/common/src/auth/credential.rs:86-91`).

- Leave `expiresAt` empty. That is the whole reason this is an app password and
  not an OAuth token: `expiresAt` is optional
  (`crates/registry/src/schema/structs.rs:4626-4641`), and a credential with no
  expiry cannot die silently on a Tuesday.
- `allowedIps` is available on the same object and is a cheap extra fence if you
  want one.
- Note the account default is at most 5 app passwords
  (`max_app_passwords: Some(5)`, `structs_impl.rs:3435`).

**Why an app password and not a bearer token, confirmed against this tag.** An
OAuth access token expires after `access_token_expiry`, whose default is
3 600 000 ms — one hour (`structs_impl.rs:30626`). An `API_…` API key is a
management credential and upstream states it "cannot be used to log in over
IMAP, POP3, JMAP mail, SMTP submission, or any CalDAV, CardDAV, or WebDAV
service" (`https://stalw.art/docs/auth/authentication/api-key/`). App passwords
are what upstream names for exactly this job.

**HTTP Basic is accepted on the JMAP routes.** `/jmap` POST and `/jmap/session`
both call `authenticate_headers` (`crates/http/src/request.rs:87-90, 212-220`),
which decodes a `Basic` header into `Credentials::Basic`
(`crates/http/src/auth/authenticate.rs:54-61`); the authenticator then parses an
`app_…` secret as an app password and validates it against the account
(`crates/common/src/auth/authentication.rs:143-167`). There is no
`allow_api_access`-style gate any more — that symbol does not exist at this tag.
This is read from source; §8.9 item 4 is the two-minute confirmation, and if it
comes back 401 the credential decision has to be re-made rather than quietly
swapped for OAuth.

Add to `~/apps/verder/.env.prod` (mode 600, never committed):

```
# written in §8.3, before the rsync
STALWART_RECOVERY_ADMIN=admin:<the administrator password>
STALWART_ETC_DIR=/mnt/data/verder/stalwart/etc
STALWART_DATA_DIR=/mnt/data/verder/stalwart/data
STALWART_BLOB_DIR=/mnt/data/verder/stalwart/blobs
JMAP_BASE_URL=http://stalwart:8080
# added here, after the account exists
JMAP_USER=martin@vanderpoel.pro
JMAP_APP_PASSWORD=app_…
```

`JMAP_*` reach the worker through its `env_file`, so restart it to pick them up
— but read §8.8 first about what that does and does not start:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker
```

### 8.7 Verify the endpoint answers

```bash
ssh homelab 'curl -sSL -u "martin@vanderpoel.pro:app_…" \
  http://127.0.0.1:8080/.well-known/jmap | head -c 400'
```

`-L` matters: `/.well-known/jmap` is a 307 to `/jmap/session`
(`crates/http/src/request.rs:272-277`). Same-origin, so curl keeps the
credentials.

Expect JSON with `apiUrl`, `downloadUrl` and a `primaryAccounts` entry for
`urn:ietf:params:jmap:mail` — RFC 8620 §2 requires those keys. **Read the actual
`apiUrl` out of that response.** It must be `http://stalwart:8080/jmap/`. If it
says `https://` anything, `STALWART_PUBLIC_URL` did not take effect and the
worker will fail on its first method call while its session fetch looks perfect
(§8.2).

Nothing on the host resolves `stalwart`, so a JMAP client run **on the homelab**
rather than inside the compose network needs one line in `/etc/hosts`:

```
127.0.0.1 stalwart
```

Setting `STALWART_PUBLIC_URL` to `localhost` instead is not the fix: it would
break the worker, which cannot reach the host's loopback from its own container.

An unauthenticated liveness check, useful when you only want to know the process
is up (`crates/http/src/request.rs:526-535`):

```bash
ssh homelab 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/healthz/live'
```

### 8.8 What §8.6 leaves you with, and what actually starts ingestion

**SUPERSEDED 2026-08-30 by task 8.** This section used to say that phase 1 ends
with the mailbox empty and `pollMail` with no call site, and that setting
`JMAP_USER` / `JMAP_APP_PASSWORD` and restarting the worker starts nothing. Both
halves have since stopped being true and the section is kept, corrected, rather
than deleted: someone who read the old wording is the person most likely to be
surprised by a worker that now ingests.

What is true now:

- **The mailbox is not empty.** Task 7 ran on 2026-08-30: 146,270 messages,
  counted server-side with `Email/query` `calculateTotal` and not from the
  importer's exit code (§8.0). 3,348 of them are Sent Items — the outbound half
  the dossier has never had.
- **`pollMail` has a call site.** `apps/worker/src/index.ts` registers the
  `mail.poll` queue, schedules it `* * * * *`, and runs it behind a per-process
  single-flight latch. So the three JMAP variables are now load-bearing: with
  them set the worker polls, and **without them it writes a red `mail` row every
  minute** rather than nothing at all. That red row is the wiring working — see
  §8.11 — but it will look like a new failure to anyone who does not expect it.
- **Starting the worker still does not ingest the archive.** The scheduled poll
  runs with `allowFirstSync: false` and may only ever ask for deltas. With no
  cursor it refuses, loudly, once a minute. The archive is ingested by the
  hand-run, previewed `mail-first-sync`, and §8.11 carries the order in which
  the two must happen — the first sync BEFORE `up -d worker`, which is not
  interchangeable.
- **Mail delivery is still untouched.** No MX record, no DNS. New mail continues
  to arrive at Gmail and does not reach Stalwart at all; `gmail.poll` remains
  unscheduled. Phase 1 restores ingestion of what the dossier already has, not
  of what arrives tomorrow. Bridging that gap is a phase 2 decision, and the
  plan says so in as many words.

So after §8.7, before the first sync, the honest expectation is:

- `docker compose ps` shows `stalwart` **up (healthy)** — measured on the first
  cold start, 12 s (§8.0), where this section previously called it unverified.
- `/.well-known/jmap` answers with a session object, and its `apiUrl` reads
  `http://stalwart:8080/jmap/`. Any `https://` there means
  `STALWART_PUBLIC_URL` did not take (§8.2) and the worker will fail on its
  first method call while its session fetch looks perfect.
- `worker_runs` has `mail` rows once the new worker is up, and before the first
  sync they are RED, saying a first sync was refused. That is correct, not a
  fault.
- Nothing new appears in the vault, on `/queue`, or in `documents` until
  `mail-first-sync --commit` runs and you have read the ledger-event count it
  prints first.

### 8.9 Confirm on the first start — the read-vs-measured list

Every item is cheap, and every one of them is currently an assumption.

1. **The WebUI is reachable — through the SSH forward.** With
   `ssh -L 8080:127.0.0.1:8080 homelab` open, `http://127.0.0.1:8080/admin`
   renders on the Mac. Read the failure correctly, because two very different
   faults look similar:
   - **connection refused / nothing listening** → *not* the bundle. Either the
     forward is not open, or `stalwart` is not running, or the port is not
     published. `http://<homelab>:8080/admin` without the forward is always
     refused; that is the design (§8.5), not a fault.
   - **it connects but 404s, hangs or serves an empty page** → *now* suspect the
     bundle download (§8.5): `/admin` is fetched from GitHub at first start and
     `stalwart-cli` is not in the image, so with no outbound internet there is
     neither wizard nor CLI.

   The discriminator is one line on the homelab itself, which needs no forward:

   ```bash
   ssh homelab 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/admin'
   ```

   A code means the server is up and the question is the bundle; a curl error
   means the server or the port is the problem.
2. **The container logs at all**, and the bootstrap banner appears
   (`docker compose logs stalwart`). If it is silent, everything below is being
   judged blind.
3. **`STALWART_RECOVERY_ADMIN` logs in** — and still logs in *after* the wizard
   has finished and the server restarted into normal mode. Source says it is
   honoured on every start; if it is not, the administrator account created by
   the wizard is the only way in and its password had better be recorded.
4. **HTTP Basic + `app_…` is accepted on JMAP** (§8.7). A 401 here invalidates
   the credential decision — say so loudly rather than reaching for OAuth: the
   whole point of choosing an app password was that OAuth's 1 h access token
   turns into a silent ingestion death.
5. **`apiUrl` is `http://stalwart:8080/jmap/`** and not an `https://` URL built
   from the container id (§8.2).
6. **The blob mount is the one being written.** If you chose the Filesystem blob
   store, write a message and confirm bytes land in
   `/mnt/data/verder/stalwart/blobs` on the host; `docker compose exec stalwart
   df -h /var/lib/stalwart /var/lib/stalwart/blobs` should show two distinct
   mounts. The nested bind mount is expected to work — Docker orders mounts by
   destination depth — but expected is not observed.
7. **`config.json` exists on the host** at
   `/mnt/data/verder/stalwart/etc/config.json` after the wizard, and matches
   `ops/stalwart/config.json.example`. If it differs, update the example — it is
   the disaster-recovery copy.
8. **The unwanted listeners.** `/admin` › Network › Listeners shows smtp/25 and
   friends. Confirm none of them is published (`docker compose port stalwart 25`
   should fail), and delete the ones you do not want.
9. **Does the container ever report `healthy`, and when?** Record it in
   bootstrap mode (before the wizard) *and* after the wizard has restarted the
   server into normal mode — those are two different states and only the second
   has any source-level reason to answer:

   ```bash
   ssh homelab 'docker inspect --format "{{.State.Health.Status}}" $(docker compose \
     --env-file ~/apps/verder/.env.prod -f ~/apps/verder/docker-compose.prod.yml \
     ps -q stalwart)'
   ssh homelab 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/healthz/live'
   ```

   If `/healthz/live` answers 200 by hand while compose says `unhealthy`, the
   healthcheck URL is wrong, not the server — and §8.8's expectation is the
   thing to correct.

### 8.10 What is not covered yet

`ops/nightly.sh` backs up postgres and the vault. Measured by reading it: its
steps are `pg_dump`, an additive `rsync` of `$VAULT_HOST_DIR`, and
`nightly-verify` / `model-check` inside the worker container. **None of them
touches the Stalwart store**, so `/mnt/data/verder/stalwart` is unbacked — the
Takeout `.mbox` is the only second copy of the archive until that changes. Keep
the export. A future backup step must cover `etc/` as well as the store:
`config.json` is small and losing it is worse than it looks (§8.3).

Nor does the cron know the mail service exists: it never runs `up`, only `exec`
against `postgres` and `worker`, so a stopped or broken `stalwart` can never turn
a nightly run red. That cuts both ways.

### 8.11 Reading mail health: the newest `mail` run, and its AGE

`worker_runs` is the only place mail failure is visible, and for the JMAP poll
there are two things to read, not one.

**The status** of the newest `mail` row is the ordinary signal — the dashboard's
health tile selects `DISTINCT ON (worker) worker, status`, so an `error` there is
a failed poll and the `detail` says which kind. One detail is worth knowing in
advance: a row saying **a first sync was refused** is the scheduled poll doing
its job. It runs with `allowFirstSync: false` and may only ever ask for deltas,
because a first sync over the imported archive is irreversible (one
`document.ingested` ledger event per attachment, on tables with no DELETE grant)
and hours long. It refuses in two cases — no cursor at all, or a cursor Stalwart
has rejected — and it will go red once a minute until a human acts. The recovery
is the hand-run, previewed `pnpm --filter worker mail-first-sync`, never a
restart.

A **second** refusal reads differently and has the same cure: `a delta of N
message(s) exceeds the 500 this caller may accept in one poll`. The first-sync
flag cannot see that case — once a cursor exists, anything bulk-imported into
Stalwart afterwards comes back as an ordinary delta with a valid cursor, and the
port will hand over up to 10 000 ids in a single poll. `MAIL_MAX_DELTA` refuses
it instead of draining it, because draining is the same irreversible ingest with
a longer tail. **The cursor is HELD on both refusals**: nothing is lost, nothing
is ingested, and the same delta is offered again next tick.

**Run the first sync BEFORE the schedule is live.** The order matters and it is
not interchangeable:

```bash
# with the NEW image built and the worker NOT yet up
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  run --rm -T worker pnpm --filter worker mail-first-sync            # preview
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  run --rm -T worker pnpm --filter worker mail-first-sync -- --commit
# twice — see the note on throwingEnqueueSuggest — then:
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker
```

The script and the scheduled poll are two processes writing the same `mail`
rows, and `makeSingleFlight` is per-process, so it does not hold across them.
The failure that ordering avoids is specific: **a scheduled refusal row carries
no cursor** (the no-cursor refusal writes back the null it read), so a tick that
refuses and commits just *after* the script writes the cursor it spent an hour
earning leaves `readCursor` answering null again — and every following tick then
refuses a first sync it is never allowed to perform, with the ingest already
paid for and invisible. Starting the worker only once the cursor exists removes
the race rather than managing it.

**The AGE** of that row is the second signal, and nothing else reports it. The
poll is single-flight: while one poll is still running, every following tick is
skipped and **writes nothing at all** — deliberately, because a row written on
the skip path would either race the running poll for the cursor or, worse, paint
a hung poll green once a minute for as long as it hangs. So:

> If the newest `mail` run is more than a few minutes old, a poll is hung and
> the single flight is skipping ticks.

That staleness is the intended tell. The poll is scheduled `* * * * *`, so on a
healthy worker the newest `mail` row is under a minute old whether or not any
mail arrived.

```sql
select worker, status, ran_at, now() - ran_at as age, detail
  from worker_runs where worker = 'mail'
  order by ran_at desc limit 5;
```

### 8.12 The monthly restore drill — install its crontab line

`ops/mail-backup.sh` proves an archive is well formed. **Only a restore proves a
backup restores**, so `ops/mail-restore-drill.sh` performs one every month
against a scratch Stalwart on the production compose project and throws it away.

**Nothing in the repo installs this. It is a manual step and it is easy to
forget, and forgetting it is invisible:** the dashboard's Systeem panel is built
from `SELECT DISTINCT ON (worker) … FROM worker_runs`, so a worker that has never
run has no row, no tile and no colour. A drill that was never scheduled looks
exactly like a system with no restore drill concept at all — which is the state
this whole task exists to leave behind.

The crontab is `CRON_TZ=UTC`, and this line runs on the 1st at 05:30 UTC — after
the 03:30 nightly, so the archive it drills is the one written a couple of hours
earlier:

```
30 5 1 * * /path/to/verder/ops/mail-restore-drill.sh >> /var/log/verder-drill.log 2>&1
```

That schedule is spelled in three places and they must move together: here, in
`ops/mail-restore-drill.sh`'s header, and in `packages/api/src/worker-health.ts`,
whose 35-day staleness bound (31 days of the longest month plus four days of
slack) is reasoned *from* it.

**Verify it, the same evening — do not wait a month for the first run.** The
drill takes ~10–20 minutes and holds ~20 GB of `/mnt/data` while it runs:

```bash
ssh homelab
cd ~/apps/verder
./ops/mail-restore-drill.sh          # prints PASS, or FAIL and the reasons
crontab -l | grep mail-restore-drill # the line is actually installed
```

Then confirm the row it wrote, which is what the dashboard reads:

```sql
select worker, status, ran_at, now() - ran_at as age, detail
  from worker_runs where worker = 'mail-drill'
  order by ran_at desc limit 3;
```

Reading the outcome:

- **A green tile means a passing drill within the last 35 days.** Nothing else
  turns it green — the row is written by the drill and by nothing else.
- **A failed drill stays red for the whole month**, on purpose: it is declared
  `monthly` with an error window as long as its silence bound, because "the
  backup could not be restored" stays true until a human fixes it and the next
  run is a month away. `/verify` does not cover it, so the tile and the push are
  the only surfaces there are.
- **The drill fails on a skipped tier 2 as well as on a bad restore.** A weekly
  Vandelay archive that is missing, unreadable, or age-encrypted (this cron has
  no key and must not acquire one) fails the drill with that reason quoted. The
  spec forbids a generation where only the native snapshot is proven.
- **A month with no row at all is the loud case.** Everything the shell half can
  detect before the assertions run — no archive on the NAS, an archive that will
  not extract, an extracted tree with no `etc/config.json`, a scratch server that
  never became healthy — records its own `mail-drill` error row and pushes,
  precisely so a missing row means the cron line itself is gone.


## Restore procedure

Both the dump and the restore must run on a **pgvector-capable image**
(`pgvector/pgvector:pg17-trixie`, the exact tag prod runs — see §2.1): the dump
contains `CREATE EXTENSION IF NOT EXISTS vector`, and a stock `postgres:17`
fails on that line and cascades. Restoring onto the bare `:pg17` tag instead
would succeed and then sit under the ledger with a different collation
provider, which is worse than failing.

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
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres web worker
   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker \
     pnpm --filter worker nightly-verify
   ```
   Confirm the run is green (exit 0) and the Verify page agrees before
   trusting the restored system.

   **`stalwart` is deliberately not in that list, and this is the step where it
   matters most.** Nothing in this backup contains the mail store (§8.10): the
   dump is postgres, the mirror is the vault. If the disk that held
   `/mnt/data/verder/stalwart` is the disk that failed, starting `stalwart` here
   would find an empty `/etc/stalwart`, come up in bootstrap mode and offer to
   build a brand-new mailbox — which is not what you want to discover at 02:00.

   So bring it back deliberately, after the three above are green:

   ```bash
   # Does the store still exist, and is it still owned by uid 2000?
   ssh homelab 'ls -la /mnt/data/verder/stalwart/ /mnt/data/verder/stalwart/etc/'
   ```

   - **`etc/config.json` and `data/` are both there** → start it and check
     §8.7: `up -d stalwart`.
   - **`data/` survived but `etc/config.json` is gone** → copy
     `ops/stalwart/config.json.example` to
     `/mnt/data/verder/stalwart/etc/config.json`, `chown 2000:2000` it, then
     start. Do **not** run the wizard: it would build a second store beside the
     good one.
   - **The store is gone** → this is a rebuild, not a restore. Re-run §8 from
     §8.3 and re-import the Takeout archive (Task 7 of the mail plan). If the
     directories themselves went with the disk, `up -d stalwart` will refuse to
     start (`create_host_path: false`) until §8.3's mkdir/chown has been run —
     which is the intended answer, not an extra obstacle: a mail service that
     silently invented an empty store here is exactly what you do not want at
     02:00.
