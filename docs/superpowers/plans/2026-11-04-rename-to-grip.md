# Rename the apps to Grip

Date: 2026-11-04. Decided by Martin: "the name verder is too ambiguous … the bewindvoering company is also Verder. Lets rename our apps to Grip" — scope **full rename** (code, packages, database, containers, paths, domain, bundle id, repo), and the new feature is **Vraag Grip**.

## The one rule that makes this safe

**Grip is the app. Verder is the bewindvoerder. "verder" is also a Dutch word.** Every occurrence is one of three things, and only the first is renamed:

1. **The app** (lowercase `verder` in UI copy, `@verder/*`, `Verder` targets/types, `verder.vanderpoel.pro`, `/srv/verder`, `verder_app`, …) → **Grip** / `grip`.
2. **Verder the company** — VerderGroep, Verder Bewind, Verder Schuldhulpverlening, Team Opstart's employer, `@verdergroep.nl`, `@verderbewindmidden.nl`, `RELEVANT_SENDERS`, the `priority = 'verder'` proposal value (= "a mail from Verder"), `VERDER_MAIL` notification kind, `letterSender` `{kind:'verder'}`, case-history seed text, every real mail and document. **NEVER renamed.**
3. **The Dutch word** — "ga verder", "verder met", "verder lezen". **NEVER renamed.**

When in doubt, read the sentence: if it is the thing that runs on the phone/homelab, it is Grip.

## Kept on purpose, with the reason

| Kept | Why |
|---|---|
| `document_status_changes.actor = 'verder'` (stored value + `dsc_actor_ck`) | hashed into ledgered payloads (`verification.ts`, third shape). Changing it rewrites history and `/verify` reports tampering. The CODE writes the literal through one named constant (`APP_ACTOR = "verder"` with a comment) and the UI renders it as "Grip". |
| Message-IDs already sent (`@verder.vanderpoel.pro`) | they are in Verder's mailboxes. NEW mail generates `@grip.vanderpoel.pro`. Gmail replaces it anyway (measured 2026-10-31). |
| Applied migration files' meaning | drizzle tracks by timestamp, not hash, so old `.sql` files ARE edited to the new role names (a fresh database must build), but no new migration renames tables or values. The database and roles are renamed by an ops step, not a migration. |
| GCP project id `verder-gmail` | Google project ids cannot be renamed; its display name can. |
| GCP OAuth client `verder-worker` | a name inside that project that the stored tokens were minted for; renaming buys nothing. |
| NAS marker `.verder-nas` (`/mnt/nas-workspace/.verder-nas`, `ops/watchdog.sh` `MARKER`, `scanNasFolder`) | a file on the production NAS share that `nas.scan` and the watchdog refuse to run without. Renaming it in code without a matching `touch` on the share stops scanning; it is invisible to every user, so it stays. |
| Historical specs/plans in `docs/superpowers/` before 2026-11-04 | they are a record of what was decided under the old name. Living docs (CLAUDE.md, README, deploy.md, design-app, the iOS README) are renamed. |
| `docs/grip/` (pitch videos) | already Grip — no collision, it is the product. |

## Phase A — the code (one branch, `feat/grip-rename`, stacked on `feat/iphone-app`)

A1 (mechanical, one agent, scripted): `@verder/*` → `@grip/*` (package.json names, imports, tsconfig paths, `pnpm --filter`), the root package name, `apps/ios/Verder*` → `apps/ios/Grip*` (folders, targets `Grip`, `GripNotify`, `GripShare`, `GripWidget`, `GripTests`, scheme, `project.yml`), bundle ids `pro.vanderpoel.verder*` → `pro.vanderpoel.grip*`, App Group `group.pro.vanderpoel.grip`, keychain group, URL scheme `grip://` (the app ALSO keeps handling `verder://` for links already on the phone and in old push payloads), Swift type prefixes that name the app, docker-compose project `name: grip`, volume `grip_pgdata`, default paths `/srv/grip`, `/mnt/data/grip`, `~/apps/grip`, database `grip`, roles `grip`/`grip_app`/`grip_worker` (in every migration `.sql`, test, `docker-compose.yml`, `.env` examples), `APP_URL`/`PASSKEY_RP_ID` defaults `grip.vanderpoel.pro`, the AASA route's appIDs, the ops scripts and their state dirs (`~/.local/state/grip-*`), `worker_runs` names stay (they are data, not the app name). Builds and every suite green before A2.

A2 (copy, parallel by area, judgment per occurrence): web UI, iOS UI + fixtures + widgets + share + notify extension, worker (push text, proposal/brief/request prompts — the model is told it is Grip, working FOR Martin, and that Verder is his bewindvoerder), exports (inhoudsopgave, registry export), the design-app docs (Dutch), CLAUDE.md and the living docs. The copy rule from before ("lowercase verder = the app, capital Verder = the bewindvoerder") collapses into simply: Grip vs Verder.

A3 (verify): every suite, `next build`, the iOS build + tests, a fixture recapture of the key screens, and an AUDIT: every remaining `verder` in tracked files listed with its class (company / Dutch word / kept-on-purpose); anything unclassified is a miss.

## Phase B — the cutover (in this session, never by an agent)

Downtime ~15 min. Order matters:

1. Pause: comment out the five cron lines (watchdog FIRST, or it heals the stack we are stopping).
2. Backup: `ops/nightly.sh`-style dump to the NAS, check it ends in `PostgreSQL database dump complete`; record ledger count + head.
3. Stop web + worker (postgres stays up).
4. Rename in Postgres from the `postgres` maintenance DB: `ALTER DATABASE verder RENAME TO grip`, `ALTER ROLE verder_app RENAME TO grip_app`, `ALTER ROLE verder_worker RENAME TO grip_worker`, and the admin role (the container's POSTGRES_USER) — CHECK FIRST that the passwords are SCRAM (a rename CLEARS an MD5 password). Grants follow the OID and survive.
5. Volume: stop postgres, copy `verder_pgdata` → `grip_pgdata` (helper container, `cp -a`), start under project `grip`. The OLD volume is kept until Martin says delete.
6. Paths: `mv ~/apps/verder ~/apps/grip`, `/srv/verder` → `/srv/grip`, `/mnt/data/verder` → `/mnt/data/grip` (same filesystem, instant; Stalwart stopped first), NAS `verder-backups` → `grip-backups`, state dirs. `.env.prod` edited in place by `sed` on the KEYS that carry the name (never printed): DATABASE_URL users/db, APP_URL, PASSKEY_RP_ID, the dir variables, APNS_TOPIC.
7. Domain: add `grip.vanderpoel.pro` to the tunnel + DNS, move the WAF rate-limit rule, make `verder.vanderpoel.pro` a 301 to the new host (Cloudflare redirect rule), so old links and the old app version still land.
8. Rebuild + `up -d` under project `grip`; crontab rewritten to the new paths; nightly-verify must report the SAME event count and head as step 2.
9. Phone: install the new `pro.vanderpoel.grip` app (a NEW app: Martin signs in again, registers a passkey for the new domain, re-adds widgets), then removes the old one. Old push_devices rows go stale and are cleaned by the existing session check.
10. GitHub: rename `mvdpoel/verder` → `mvdpoel/grip` (GitHub redirects the old URL), update the remote.
11. Local: the folder `~/Workspace/mp/verder` → `~/Workspace/mp/grip` LAST, with Martin, because Syncthing, the Claude memory directory (keyed by path) and the M3/i9 copies follow it.

Rollback until step 8: the old volume and the old paths (renamed back) bring the old stack up unchanged.
