# verder — project notes for Claude

## Homelab access
- SSH: `ssh homelab` (key-based, user is a sudoer). This is the deployment target: fast disk/mem/CPU, AMD Radeon RX 9070 16 GB VRAM (ROCm), Ollama installed (listens on 0.0.0.0:11434), cloudflared tunnel (token-based, runs as docker container `operator-os-cloudflared`).
- Production stack DEPLOYED (2026-08-18): repo at `~/apps/verder` (synced via rsync, no GitHub key on homelab), data under `/srv/verder/{vault,backups,scans-inbox}`, stack via `docker compose --env-file .env.prod -f docker-compose.prod.yml`, nightly cron 03:30. Secrets in `~/apps/verder/.env.prod` and `~/apps/verder/secrets/role-passwords` (never commit). App on http://192.168.188.148:3000, LAN-only until Cloudflare hostname + Access are configured.
- Eval baseline (golden rule): qwen3.5:9b scored 4/6 on `pnpm --filter worker eval`, prompt entry-v1 (misses: invented action item on FYI email; ambiguous marked clear).
- Public access: https://verder.vanderpoel.pro via Cloudflare Access (allow martin@vanderpoel.pro + platform@anttail.com) → tunnel `homelab-host` → localhost:3000 (WEB_BIND=127.0.0.1, tunnel-only; LAN closed). Tunnel/DNS/Access managed via mp8s secret `cert-manager/cloudflare-api-token` (see cloudflare-admin skill learnings).
- Gmail watcher LIVE (2026-08-18): GCP project `verder-gmail` (org dytechsolutions.nl), Internal consent (no 7-day token expiry), Desktop client `verder-worker`; creds+token in `~/apps/verder/secrets/gmail-{oauth,token}.json` on homelab (600). Relevance filter: RELEVANT_SENDERS=@verdergroep.nl + any parties.email.

## Build & test
- Run builds/tests with `env -u NODE_ENV` — the shell exports `NODE_ENV=development`, which breaks `next build`.
- Dev DB: `docker compose up -d postgres` (roles: `verder` admin, `verder_app`, `verder_worker`). Dev login: martin@vanderpoel.pro / devpass.
- pnpm 10, Node 22+ (images use node:22-slim).

## Project laws
- Evidence tables are append-only (enforced by Postgres grants); every evidence mutation appends a `ledger_events` row in the same transaction. Never weaken this.
- AI output is suggestion-only; nothing enters the ledger without Martin's approval. Model suggestion + verdict + edit diff are always recorded (golden rule: self-improvement).
- Tone: supportive/encouraging toward Martin; short, professional, official register for anyone else.

## Key docs
- Vision/braindump: `docs/braindump.md`
- Spec: `docs/superpowers/specs/2026-08-18-logbook-vault-design.md`
- Implementation plan (executed): `docs/superpowers/plans/2026-08-18-logbook-vault.md`
- Deployment guide: `docs/deploy.md`
