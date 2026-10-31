ultracode

Continue building "verder for iPhone" on this Mac (`macbook-m5`, Apple Silicon).
The work was started on the old Intel MacBook and moved here on 2026-10-31.

Read first, in full:
- CLAUDE.md (every law and deploy trap applies)
- docs/superpowers/specs/2026-10-28-iphone-app-design.md (approved spec)
- docs/superpowers/specs/2026-10-28-iphone-app-goal-prompt.md (the original goal prompt; its hard rules still apply)
- docs/superpowers/plans/2026-10-28-iphone-app.md (Plan 1, tasks T1–T12)

Branch: `feat/iphone-app` (pushed to origin). Spec and plan commits are on `main`.

## Done and deployed to production (do NOT redo)

- T4 `apple-app-site-association` route (404 when `APPLE_TEAM_ID` unset). Live:
  `{"webcredentials":{"apps":["7RKC7FRL24.pro.vanderpoel.verder"]}}`.
- T8 `DOC_SOURCES` (`@verder/db/doc-sources`) + migration 0036 (`phone-scan`, `phone-share`), applied from the host.
- T9 `POST /api/mobile/v1/documents`, idempotent on `clientId` (`sourceRef = "phone:<clientId>"`), returns `{id, duplicate}`.
- Middleware fix: `/api/mobile/*` without a session answers JSON 401, never a 307 to /login
  (a native client would read the login page's 200 as a successful upload). Verified live.
- `.env.prod` has `APPLE_TEAM_ID=7RKC7FRL24` (backup `.env.prod.bak.2026-10-28-iphone`).
- nightly-verify OK after the deploy; ledger was 548 events on 2026-10-28.
- Plan T5 amended: the iOS client NEVER follows redirects; any 3xx maps to `.unauthorized`
  (test `redirectMapsToUnauthorized`).

## Next

1. **T1 toolchain on this Mac.** Install the newest stable Xcode (27.1 or later; Martin's iPhone runs
   iOS 27.2, so Xcode 26.x cannot deploy to it). `sudo xcodebuild -runFirstLaunch`,
   `xcodebuild -downloadPlatform iOS`, `brew install xcodegen`. Sign Xcode into Martin's paid Apple
   Developer team (Team ID 7RKC7FRL24). Plug in the iPhone 16 Pro, trust this Mac, and confirm
   `xcrun devicectl list devices` shows it `available`. The old devicectl id was
   4151AD85-3F8B-5DE7-9B5F-CCD2534206A5 (UDID 00008140-001430241432801C); re-read it here, a new Mac
   re-pairs. Developer Mode is already on. Ask Martin for anything that needs his Apple ID, his
   password or a tap on the phone.
2. **Launch the iOS workflow** for T2, T3, T5, T6, T7, T10, T11: one implement + one review agent per
   task, as in Plan 1. Device installs, signing and anything touching production stay in the main
   session, not in agents.
3. **T12 end to end** on the real phone and homelab: cold launch < 2 s; Martin scans 5 real letters
   (one crumpled) to measure the cleanup; a duplicate re-send returns `duplicate: true`; record the
   numbers and add the iPhone app entry to CLAUDE.md. Report to Martin in Europe/Amsterdam time.
4. Then write Plans 2 and 3 (spec slices 4–8). (Done 2026-10-31: APNs key NUYA9JS566 created,
   .p8 in homelab `secrets/`; weekly leefgeld answered, € 100, spec §13.)

## Standing rules (verbatim from Martin)

- "filing and linking documents is fine, sending always needs approval" — nothing outbound without
  his OK on the final text, test sends included.
- Every e-mail from Verder bewindvoering Regio 3, Demi, or anyone else at that organisation gets his attention.
- Face ID: sign-in via passkey (confirmed with Face ID) and the Face ID app lock with a 5-minute grace — both already in Plan 1 (T6, T7).
- Never read, print or log `secrets/loondossier.json` or Martin's Claude OAuth token. Destructive actions are asked first.
- Deploys: `next build` locally first; rsync with the exact CLAUDE.md exclude list, `--dry-run --info=del` first,
  every `deleting` line read; never put the rsync command in a zsh variable (no word-splitting, the dry run silently does nothing).
  Migrations from the homelab HOST before images. Run builds with `env -u NODE_ENV`.
- Talk to Martin in English; the app UI is Dutch. Anything he copies goes in a plain ```text block.

## Open items outside the app

- CZ: € 4.193,23 total arrears (letter 22-10-2026), party + debt recorded, mailed to Regio 3 on
  2026-10-28 13:54 CET. Waiting on Regio 3's reply.
- The queue still holds the name suggestion "Betalingsachterstand CZ" for `scan0051.pdf`.

## Moving from the old Mac

`~/Workspace` is synced by Syncthing (MacbookPro ↔ macbook-m5), so the working tree, `.env`,
`apps/web/.env.local`, the traineddata files and the untracked docs are already here.
`~/Workspace/.stignore` EXCLUDES `.git`, `node_modules`, `.next` and build output, so this Mac needs
its own git repo and its own install. If `git status` fails here, attach the full repo (all
branches tracked, all tags) without touching the synced files, then install:

    bash ops/git-init.sh feat/iphone-app   # expect "0 modified, 10 untracked"
    pnpm install

The 10 untracked are AGENTS.md, the docs/mail-* files, the 2026-09-02 mail specs,
PROMPT-mail-reanalysis.md and ops/cloudflare/. Re-run the script any time to pick up new remote branches.

Commits move between Macs by push/pull only. Edits made here show up as uncommitted changes in the
old Mac's git, so work on one Mac at a time. Not synced, and still needed by hand:

- Claude memory: `~/.claude/projects/-Users-martin-Workspace-mp-verder/memory/`.
- The `~/.ssh` key for `ssh homelab` (or add a new key on the homelab).
