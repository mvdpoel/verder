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
  ./ homelab:~/apps/verder/

# Then the real run: same flags, drop the -n.
rsync -av --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' \
  --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod' \
  --exclude 'secrets' --exclude 'vault-files' \
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
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
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
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
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
