# Logbook + Document Vault — Design Spec

**Date:** 2026-08-18
**Status:** Approved design, pending implementation plan
**Sub-project:** 1 of the verder platform (see `docs/braindump.md` for full vision)

## Purpose

Give Martin an irrefutable, tamper-evident record of every contact moment and every document in his Bewindvoering/WSNP process with VerderGroep, plus a document vault that both humans and (later) the proactive agent can draw from. This sub-project is the evidence foundation the rest of the platform (agent, knowledge base, tasks, multi-user) attaches to.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| First sub-project | Logbook + document vault (agent, knowledge base, subscriptions, tasks, multi-user come later) |
| Users in v1 | Martin only; single login. `users` table exists so multi-user needs no migration |
| Evidence bar | Append-only + SHA-256 hash chain. No external anchoring yet (can be added without redesign) |
| Log capture in v1 | Manual entry form + Gmail auto-watch (worker suggests entries; Martin approves) |
| Document capture in v1 | Web upload + NAS scan-folder watch + attachments from watched emails; all through one review inbox |
| AI in v1 | Ollama-only on the homelab GPU (ROCm). Provider kept behind an interface so hosted models can slot in later. All AI output is suggestion-only; nothing enters the ledger without Martin's approval |
| Stack | Next.js 15 (React 19) + tRPC monorepo, Postgres + Drizzle, pg-boss job queue, better-auth, Docker Compose on the homelab, cloudflared tunnel + Cloudflare Access |
| Architecture | Approach A: modular monolith, append-only tables, one global ledger hash chain, content-addressed file storage |
| Mobile | Expo app later in the same monorepo, calling the same tRPC routers. Not in v1; v1 uses web push for notifications |
| Design workflow | Key screens designed in Figma (via Figma MCP) before implementation; design-to-code by hand-guided translation, Code Connect as the component library grows |

## The Golden Rule (project law)

Any AI involved must try to self-improve: every model suggestion, Martin's verdict on it (approved / edited / rejected, including the edit diff), model name, and prompt version are recorded. Errors, timeouts, and performance data are logged. This dataset drives prompt tuning and model selection. A nightly job checks Ollama/HuggingFace for newer versions of models in use.

## Data model

### The ledger (evidence core)

`ledger_events` — one global append-only hash chain. Every write of consequence (entry created, document ingested, correction made, suggestion approved) appends one row:

- `seq` (monotonic, serialized appends — no forks)
- `event_type`, `entity_type`, `entity_id`
- `payload_hash` — SHA-256 of the entity's canonical JSON
- `prev_hash`, `event_hash = sha256(prev_hash ‖ payload_hash ‖ metadata)`
- `created_at`

One chain to verify, one chain to export. Tampering with any entity, file, or ledger row breaks the chain provably.

### Entity tables (insert-only; UPDATE/DELETE revoked at the Postgres-grant level)

- **`log_entries`** — a contact moment: `occurred_at` vs `recorded_at` (both evidentially relevant), `channel` (call, meeting, email, whatsapp, voicemail, letter, other), `direction`, `summary`, full notes, `source` (manual / gmail-watch / nas-watch) + `source_ref` (e.g. Gmail message id), `supersedes_id` for corrections.
- **`parties`** — people and organizations (Martin, VerderGroep staff/teams, debtors, utilities…). Joined to entries via **`entry_participants`**.
- **`documents`** — content-addressed files: `sha256` (doubles as storage filename → dedup for free), mime, size, `doc_type`, `received_at`, `source` (upload / nas-scan / email-attachment), `status` (`inbox` → `filed`). Joined to entries via **`entry_documents`**.
- **`action_items`** — agreements from a contact moment: owner, description, due date, clarity flag (`clear` / `ambiguous` / `already-provided`), status.
- **`suggestions`** — the watcher review queue: raw source payload, model's proposed entry/title/action items, model name + prompt version, Martin's verdict and edit diff. Doubles as the golden-rule dataset.
- **`users`** — Martin only for now.
- **`worker_runs`** — watcher heartbeats and outcomes (also serves error/self-improvement logging).

### File storage

Files live on the homelab filesystem in a content-addressed tree (`/vault/ab/cd/<sha256>.<ext>`), NAS-backed. Postgres stores metadata only. Backup = `pg_dump` + `rsync` of one directory.

## System components

Monorepo: pnpm workspaces + Turborepo.

- **`apps/web`** — Next.js 15. Pages: Dashboard (queue count, recent entries/documents, open action items, watcher health), Logbook (timeline + filters, entry detail), New entry form, Vault (inbox + filed library, viewer), Suggestions review queue, Verify page (chain check + court-ready PDF export of any date range).
- **`packages/api`** — all tRPC routers and business logic. The only code that writes to Postgres. Every mutation appends its ledger event in the same transaction. Consumed by web now, Expo later.
- **`packages/db`** — Drizzle schema + migrations. App DB role has no UPDATE/DELETE grants on evidence tables.
- **`apps/worker`** — one Node process, three loops: Gmail watcher (poll every few minutes; VerderGroep senders always relevant, others by rules), NAS watcher (hash + ingest new scans), Ollama pipeline (classify/summarize into `suggestions`). Jobs via pg-boss in Postgres — no Redis; jobs survive restarts.
- **`packages/auth`** — better-auth, session cookies, single user; passkeys available for later.

**Deployment:** one `docker-compose.yml` on the homelab: `web`, `worker`, `postgres`; worker talks to the existing Ollama over the local network. Exposed via the existing cloudflared tunnel with Cloudflare Access in front. Nightly cron container: pg_dump, vault rsync, full chain verification, model-update check; results posted to the dashboard.

## Key flows

- **Manual entry:** quick form (channel, who, when, what, action items, attachments) → one transaction (entry + participants + action items + ledger event). Target: under a minute to log.
- **Gmail auto-watch:** poll → relevant email → persist raw message (full headers) and attachments (to vault inbox) *before* AI runs → Ollama drafts a suggested entry → review queue → approve/edit/reject. Only approval writes to the ledger. Edit diffs are stored for self-improvement.
- **NAS scan:** new file in watched folder → hash + copy into content-addressed storage → vault inbox → Ollama suggests title/type from OCR text → Martin confirms, optionally links to an entry.
- **Correction:** evidence is never edited. "Correct" pre-fills a new entry saved with `supersedes_id`; both remain visible, the original badged "corrected by #N".
- **Verify & export:** verifier walks the chain, recomputes every hash, reports the first break. Export: chronological PDF with participants, linked documents with SHA-256 fingerprints, chain head hash on the cover.
- **Notifications:** web push when the review queue grows. Native push arrives with the Expo app.

## Error handling

Theme: never lose evidence, never lie about state.

- Ingestion is idempotent (Gmail message id / file sha256 as keys) — crashes and re-polls never duplicate; the worker can die at any moment and resume.
- Raw sources are persisted before AI touches them; if Ollama is down, items land in the queue as "needs manual summary" instead of vanishing.
- Entity insert + ledger append are one transaction; ledger appends are serialized so the chain cannot fork.
- `worker_runs` heartbeats surface on the dashboard ("Gmail watcher last ran 3 min ago ✓") — silence is a visible failure.
- Nightly job verifies the full chain and backups.

## Testing

- **Unit (Vitest):** hash-chain construction/verification, canonical JSON serialization (hash stability is critical — key order must be deterministic), suggestion parsing, idempotency keys.
- **Integration (real Postgres in Docker):** append-only grants actually reject UPDATE/DELETE; transactional rollback; pg-boss retry behavior.
- **Verifier property tests (crown jewel):** tamper with any byte — row, file, or hash — and verification must fail, pointing at the right location.
- **Watcher tests:** faked Gmail/filesystem fixtures incl. Dutch email samples; Ollama mocked. Plus a small eval script running real prompts against sample emails — the accuracy baseline for the golden rule.

## Out of scope for this sub-project

Proactive agent actions (auto-replying with documents), knowledge graph / RAG memory systems, subscriptions registry, task management beyond `action_items`, multi-user invites/roles/2FA, Expo mobile app, external chain anchoring. Each becomes its own spec → plan → build cycle.

## Tone of voice (product-wide requirement)

UI copy and (later) agent messaging towards Martin: supportive, encouraging, judgement-free — assistant/guide/coach. Towards any other user: short, simple, professional, official register.
