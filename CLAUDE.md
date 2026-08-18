# verder — project notes for Claude

## Homelab access
- SSH: `ssh homelab` (key-based, user is a sudoer). This is the deployment target: fast disk/mem/CPU, AMD Radeon 16 GB VRAM (ROCm), Ollama installed, cloudflared tunnel + CF API key present.
- Production stack runs there via `docker-compose.prod.yml` (see `docs/deploy.md`).

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
