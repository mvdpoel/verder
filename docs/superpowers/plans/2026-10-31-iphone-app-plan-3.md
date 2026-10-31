# verder for iPhone — Plan 3: Voor jou, autonomous filing, the extras

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **[main session]** need Martin (Face ID, a tap, approving a real send), the real phone or the homelab. Agents never run them.

**Goal:** Martin answers verder from his phone. Everything waiting on him sits in one ranked "Voor jou" list, and the badge, the widget and the amber colour all count the same thing. verder files documents on its own when it has measured that it is right, says so honestly, and lets him undo each one with one tap. The extras ship on top: share sheet, widget, voice quick-log, an offline pocket dossier, a money glance with "leefgeld over deze week", and a Sunday summary.

**Architecture:**
- **One definition of "waiting on Martin"** (spec §12.9) lives in `packages/api/src/waiting.ts` as a pure function plus one loader. The inbox route, the badge, the widget snapshot and the web dashboard all read it. Nothing else counts waiting items.
- **Read and write routes for the phone** are under `apps/web/src/app/api/mobile/v1/*`. They follow the pattern of the existing `documents/route.ts`: auth first, `serverCaller()`, hand-shaped DTOs and never raw router output.
- **The worker sends badges and silent refreshes** because the web app holds no pg-boss connection. A `badge.sync` cron compares the waiting count with the last one it sent.
- **Autonomous filing** is a new actor shape on `document_status_changes`: nullable `actor` and `suggestion_id` columns, a third payload shape, and a third candidate in `resolveDocumentUpdatedHashes`. Old rows hash exactly as before.
- **Pocket dossier sync** uses `ledger_events.seq` as its one monotonic cursor. Every document mutation already appends an event under advisory lock 42, so seq order is commit order.
- **Money glance** is derived on read from `buildMoneySeries` plus a new pure `leefgeldWeek`. It never merges accounts and never shows a figure for a week the statements do not cover.

**Tech Stack:** Swift 6 / SwiftUI, iOS 27, WidgetKit, UserNotifications, a Notification Service Extension, a Share Extension, Speech (`SpeechAnalyzer`/`SpeechTranscriber`), LocalAuthentication, Swift Testing, XcodeGen; Next 15 route handlers, tRPC routers, vitest, hand-written drizzle SQL migrations, pg-boss 10.4.2 (its `ScheduleOptions` has `tz`).

**Spec:** `docs/superpowers/specs/2026-10-28-iphone-app-design.md`. This plan covers §10 slices 6, 7 and 8. Plan 1 (`docs/superpowers/plans/2026-10-28-iphone-app.md`, slices 1–3) is done and verified on the phone. Plan 2 (`docs/superpowers/plans/2026-10-31-iphone-app-plan-2.md`, slices 4–5: APNs, `notify()`, Verder priority, proposals, sending) is written and this plan builds ON it; see "What this plan takes from Plan 2".

## What this plan takes from Plan 2

Plan 2 is written, and this plan reuses its files and interfaces rather than creating its own. **Task 0 checks each row against the MERGED code before any other task starts**, and stops if Plan 2 has not shipped: slice 6 is not useful without proposals, and slice 7's digest needs `notify()`.

| Plan 2 provides (task) | This plan uses it as-is in | This plan adds |
|---|---|---|
| `apps/worker/src/notify/notify.ts`: `notify(deps: NotifyDeps, n: NotifyInput)`, `NotifyKind` = `verder-mail\|creditor-mail\|proposal\|reminder\|follow-up\|task-due\|filing\|system\|weekly`, `CATEGORY` (`VERDER_MAIL`, `CREDITOR_MAIL`, `PROPOSAL`, `REMINDER`, `FOLLOW_UP`, `TASK_DUE`, `FILING`, `SYSTEM`, `WEEKLY`), `link` = `verder://<kind>/<uuid>`, `dedupKey` (P2 T4) | Tasks 5, 15, 26 | a `badge` on every alert, `options` for question proposals, and a device-level `pushToDevices` for badge-only and background pushes (Task 5). **No new `NotifyKind`, no new category id.** |
| `apps/worker/src/notify/apns.ts`: `ApnsSender`, `apnsPayload(ApnsAlert)`, `http2ApnsSender` (always `apns-push-type: alert`) (P2 T3) | Task 5 | `ApnsSender.sendRaw(env, token, { pushType, priority, payload })` for the badge-only and background pushes |
| Every existing alert already moved onto `notify()`, and the generic "Something new to review" push DELETED (P2 T5) | — | nothing: suggestions reach Martin through the badge and Voor jou only (spec §6.4) |
| `push_devices`, `notifications`, `notification_attempts` (P2 T2, migration 0037); `POST /api/mobile/v1/push/register` (P2 T6) | Tasks 5, 8, 23 | — |
| iOS `AppDelegate.swift` (`UIApplicationDelegateAdaptor`), `Push/NotificationCategories.swift`, `Push/DeepLink.swift` (`.proposal`, `.document`, `.none`, parsed from `userInfo["link"]`), `project.yml` with `aps-environment`, time-sensitive and `remote-notification` (P2 T7) | Tasks 8, 23 | `DeepLink` cases `.inbox`, `.suggestion`, `.task`; `didReceiveRemoteNotification`; the `q.<id>` answer categories |
| `proposals` (P2 T11, migration 0038): `kind` `reply\|question\|follow-up`; `status` `drafting\|draft-failed\|pending\|approved\|sending\|sent\|failed\|rejected\|superseded`; `verdict` a SEPARATE column; `priority` TEXT `verder\|creditor\|other` | Tasks 1, 26 | — |
| `proposals` router and its mobile routes `apps/web/src/app/api/mobile/v1/proposals/{route,[id]/route,[id]/approve,[id]/reject,[id]/answer}` (P2 T15): approve `{id, revision, payload:{to,cc,subject,body,attachmentDocumentIds}}`, answer `{id, option: number} \| {id, freeText: string}` | Tasks 4, 7, 8 | only the tests that pin "answer is for questions only" (Task 4) |
| iOS `Net/APIClient+JSON.swift` (`getJSON`/`postJSON`), `VerderTests/APIClientJSONTests.swift`, `Proposals/ProposalScreen.swift`, `ProposalModel`, `ApprovalGate` (P2 T19) | Tasks 6, 7 | the inbox store and the question, suggestion and task screens |
| Deploys D3 and D4 (P2 T8, T21) | — | this plan's deploys are named **P3-D1, P3-D2, P3-D3** so the two plans never collide |

The Face ID check: Plan 1 already has `DeviceOwnerAuthenticator` (`apps/ios/Verder/Auth/AppLock.swift:33`). This plan adds no third abstraction: it calls whatever `ApprovalGate` Plan 2 shipped, and if Plan 2's `Authenticator` protocol is still unbuilt when Task 0 runs, Task 0 notes that it should be `DeviceOwnerAuthenticator` with a fresh `LAContext` per call.

## Global Constraints

- Everything from Plan 1's Global Constraints still holds: iPhone only, iOS 27.0, bundle `pro.vanderpoel.verder`, App Group `group.pro.vanderpoel.verder`, Team `7RKC7FRL24`, Dutch UI, English code, amber (`attn`) only for what is waiting on Martin, no third-party Swift dependencies.
- **Nothing is ever sent outbound without Martin's explicit approval of the final text.** That includes test sends. No notification action can send. The phone sends only from a screen that shows the final text, behind a fresh Face ID check.
- **APNs:** the app is development-signed, so pushes go to the SANDBOX host `api.sandbox.push.apple.com`. Key `NUYA9JS566`, team `7RKC7FRL24`, key file `~/apps/verder/secrets/apns-NUYA9JS566.p8` on the homelab (`/repo/secrets/apns-NUYA9JS566.p8` inside the worker). Never read, print or log the `.p8`, `secrets/loondossier.json`, the Gmail tokens or Martin's Claude OAuth token.
- **Evidence tables stay append-only.** The only evidence writes this plan adds are `document_status_changes` rows (auto-apply and undo) with their `document.updated` events. Proposals, devices, notifications and suggestions are not evidence.
- **Every reader of document state uses the effective status, title, type and sender** (`effectiveDocument`, `packages/api/src/effective-status.ts`). Discards are never written back. Purge is its own predicate (`notPurgedSql`), and every list needs it next to `notDiscardedSql`. Write "not discarded" as `IS DISTINCT FROM 'discarded'`, never `<>`.
- **Money:** integer cents, accounts never merged at any layer (the widget included), the hatched and `geen data` states kept, and every total summed from its disclosed row list. `packages/api/src/money-series.real.test.ts` is the oracle and must stay green unchanged.
- **Migrations are hand-written SQL plus a hand-added entry in `packages/db/drizzle/meta/_journal.json`.** Snapshots stop at 0032, so `drizzle-kit generate` would re-emit 0033+. Update `packages/db/src/schema.ts` by hand to match. Separate statements with `--> statement-breakpoint`.
- **Deploy order is never interchangeable:** `next build` locally, then rsync (dry run first), then migrate from the homelab HOST, then rebuild web+worker, then `nightly-verify`, then check the ledger head. The rsync is written out literally every time, never in a variable or array, and uses Homebrew's rsync (macOS's openrsync rejects `--info=del`):

  ```text
  /opt/homebrew/bin/rsync -av --delete --dry-run --info=del --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.turbo' --exclude '.serena' --exclude 'nightly.log' --exclude '.env.prod*' --exclude 'secrets' --exclude 'vault-files' --exclude '.env' --exclude '.env.local' --exclude '*.traineddata' --exclude '.superpowers' --exclude '.gstack' --exclude '.claude' --exclude 'next-env.d.ts' --exclude '*.tsbuildinfo' --exclude 'apps/ios/build' --exclude '*.xcodeproj' ./ homelab:~/apps/verder/
  ```

  Read every `deleting` line. Then run the same command without `--dry-run --info=del`.
- **Migrate from the HOST:**

  ```text
  ssh homelab
  cd ~/apps/verder && set -a && . ./.env.prod && set +a && DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" pnpm --filter @verder/db migrate
  ```
- **Ledger head check**, before and after each deploy:

  ```text
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder -Atc "select max(seq), count(*), (select event_hash from ledger_events order by seq desc limit 1) from ledger_events"
  ```

  **"Head unchanged" is never the prediction in production**, because live ingest keeps appending while a step runs: every new document appends `document.ingested`, auto-name appends a `document.updated` for it, and from P3-D2 auto-file may too. So every prediction in this plan names (a) the event types THIS STEP is expected to append, with counts, and (b) the TOLERATED BACKGROUND: `document.ingested`, and `document.updated` whose matching `document_status_changes` row has `actor = 'verder'` (before Task 11 lands: any `document.updated` whose `worker_runs` shows an `auto-name` `renamed: true` for that document). Check it by grouping what was appended since the recorded `seq`:

  ```text
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres psql -U verder -d verder -Atc "select e.event_type, coalesce((select c.actor from document_status_changes c where c.document_id = e.entity_id order by c.created_at desc limit 1), '-') as actor, count(*) from ledger_events e where e.seq > <recorded seq> group by 1, 2 order by 1, 2"
  ```

  Before M-A (Task 11) is applied the `actor` column does not exist: use `select event_type, count(*) … group by 1` and match `document.updated` rows against `auto-name` `worker_runs` by entity id instead. Any type outside (a) ∪ (b), or more of a type than (a) predicts once the background is subtracted, is a STOP.
- **`nightly-verify`:** `docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify`.
- **Only `next build` typechecks `apps/web`.** Run `env -u NODE_ENV pnpm --filter web build` locally before every deploy that touches a `packages/api` type. Adding a `WorkerKind` member would break `apps/web/src/lib/worker-row-label.ts`, so this plan adds none.
- **Every new scheduled job** gets a `DECLS` entry in `packages/api/src/worker-health.ts`, with its cadence copied from its `boss.schedule`. A name written in one package and read in another goes in `packages/api/src/worker-names.ts`.
- **The watchdog undoes a `docker compose stop` within about 10 minutes.** Comment out its cron line before any planned stop.
- **DB tests use `crypto.randomUUID()` in fixture names and tokens** (the dev DB is never truncated). A fixture document needs a `document_texts` row with extractor `none`, or it grows `pendingDocMeta`'s backlog.
- **iOS builds:** `cd apps/ios && xcodegen && xcodebuild test -scheme Verder -destination 'platform=iOS Simulator,name=iPhone 17'`. Device installs use `apps/ios/scripts/install.sh` and are **[main session]**.
- Times reported to Martin are in Europe/Amsterdam.

## Review Focus

1. **The badge never drains.** A docmeta suggestion on a PURGED document stays in `suggestions.list` and in `dashboard.stats.pendingSuggestions` today, because both exclude discarded but not purged. Expected: Task 1 test `purged document's suggestion is not waiting` passes, and the count matches what Voor jou lists.
2. **`in-progress` tasks.** Spec §12.9 names `open` (as opposed to `waiting`) and does not mention `in-progress`. The plan's default is to count `in-progress` too, because he is the one doing it, but that deviates from the spec, so **Task 0 Step 4 asks Martin BEFORE Task 1 and records his answer in spec §12.9**. Whatever he says becomes one constant, `WAITING_TASK_STATUSES` in `waiting.ts`.
3. **A notification that sends.** Expected: no registered `UNNotificationAction` reaches a send path. A forged `answer` call on a `reply` proposal is refused by the server (Task 4 test `answer refuses a reply proposal`), and the iOS test `onlyQuestionActionsWorkInBackground` passes.
4. **An old ledger row that changes hash.** Expected: `nightly-verify` is OK on the full pre-existing chain after migration M-A, and an admin UPDATE that sets `actor` on an old row is reported as a mismatch (Task 11 test `setting actor on an old row is detected`).
5. **Undo overwrites Martin.** He renames a document after verder filed it, then taps undo on verder's change. Expected: 409 `al aangepast`, and nothing is appended (Task 15 test `undo refuses when a newer change exists`). The same for a document purged since (`vernietigd`), and an auto-NAME is never offered as undoable at all, because the name also lives on the NAS share (Task 15).
6. **A leefgeld figure invented from missing data.** Expected: a week with no statement coverage renders `geen data`, never `€ 100,00 over` (Task 17 test `uncovered week shows no figure`).
7. **The phone keeps what the server destroyed.** Expected: a purge or discard on the web removes the document from the phone at the next sync (Task 20 tests `purged id comes back as a tombstone` and `undone discard comes back as an upsert`).

---

## Slice 6 — Voor jou on the phone

### Task 0: Rescope against the merged Plan 2

**Files:**
- Modify: this file only (plus spec §12.9 for Step 4).

This plan was already rescoped once against the WRITTEN Plan 2 (2026-10-31). This task repeats the check against the MERGED code, because a plan is not what shipped.

- [ ] **Step 1:** For every row of "What this plan takes from Plan 2", confirm the file and the signature exist with `grep -rn` in `apps/worker/src`, `packages/api/src`, `packages/db/src/schema.ts`, `apps/web/src/app/api/mobile/v1` and `apps/ios`. Where the merged code differs from Plan 2's text, rewrite this file. Where a file this plan would create already exists, the task MODIFIES it instead; this plan never creates a second file for a type Plan 2 owns.
- [ ] **Step 2:** Run `ls packages/db/drizzle/*.sql | tail -3` and read the last entry of `meta/_journal.json`. Renumber migrations M-A (Task 11) and M-B (Task 24) to the next free numbers. **Expected: M-A = 0039, M-B = 0040.** Both journal `when` values must be larger than 0038's `1793692800000`.
- [ ] **Step 3:** Confirm on the homelab that Plan 2's migrations are applied: `select count(*) from drizzle.__drizzle_migrations`. **Expected 39** (0000–0038; 37 today plus Plan 2's two). After M-A it is 40, after M-B 41. If it is not 39, stop.
- [ ] **Step 4: Ask Martin before Task 1** whether an `in-progress` task counts as "waiting on you" (spec §12.9 names `open` only). Record his answer, dated, in spec §12.9, and set `WAITING_TASK_STATUSES` from it.
- [ ] **Step 5:** Commit: `docs(plan-3): rescope against the merged Plan 2`.

### Task 1: One definition of "waiting on Martin" (server)

**Files:**
- Create: `packages/api/src/waiting.ts`, `packages/api/src/waiting.test.ts`, `packages/api/src/waiting-load.test.ts`, `packages/api/src/routers/inbox.ts`
- Modify: `packages/api/src/root.ts` (mount `inbox`), `packages/api/src/routers/tracks.ts:136-157` (extract the row load), `packages/api/src/routers/dashboard.ts:14-21` (add the purge predicate), `packages/api/src/routers/suggestions.ts:49-72` (drop purged documents next to discarded ones)

**Interfaces:**
- Produces, in `waiting.ts` (pure, no DB imports):
  - `export const WAITING_TASK_STATUSES = ["open", "in-progress"] as const;` (default; Task 0 Step 4's answer from Martin decides whether `in-progress` stays)
  - `export type WaitingKind = "proposal" | "question" | "suggestion" | "task" | "stop";`
  - `export interface WaitingItem { kind: WaitingKind; id: string; title: string; subtitle: string | null; priority: 1 | 2 | 3; at: string /* ISO */; dueAt: string | null; verder: boolean }`
  - `export function waitingOnMartin(input: { proposals: ProposalRow[]; suggestions: SuggestionRow[]; tasks: TaskRow[]; currentStop: StopRow | null; now: Date }): WaitingItem[]`. It returns the ranked list.
- Ranking (spec §7.2):
  1. Verder-priority proposals (Plan 2's `priority === "verder"`; item `verder: true`).
  2. Other proposals and questions (`priority` `"creditor"` or `"other"`), newest first.
  3. Pending suggestions (`pending` and `needs-manual`), newest first.
  4. Tasks in `WAITING_TASK_STATUSES`, by `dueAt` ascending with nulls last, then `createdAt`.
  5. The map's current open stop.

  A task due within 24 h gets `priority: 1`.
- Produces, in `waiting.ts` too, a loader: `export async function loadWaiting(db: Db, now = new Date()): Promise<WaitingItem[]>`.
  - Proposals: `status = 'pending'` only. `drafting`, `draft-failed`, `approved`, `sending` wait on verder, not on Martin; the verdict is Plan 2's separate column and is never read here.
  - Suggestions: `status IN ('pending','needs-manual')`. A row whose document is discarded (`IS DISTINCT FROM`) or purged is not waiting.
  - **One purge definition for every DISPLAY surface: the `document_purges` ROW**, as `/files` uses (`purgedSql`). The ledger-EVENT definition stays only where `/verify` semantics are needed (`runFullVerification`), because there the question is "can a forged row hide evidence"; on a display surface a forged row can only hide something, which is the conservative direction. `loadWaiting`, `suggestions.list` (via `effectiveDocument(...).purge`, which reads the row) and `dashboard.stats.pendingSuggestions` therefore agree by construction. `purgedSql` assumes an unaliased `documents`, so the dashboard's `suggestions s` query gets an explicit `AND NOT EXISTS (SELECT 1 FROM document_purges p WHERE p.document_id = s.document_id)` instead.
  - Tasks: effective status by ledger seq, as `effectiveTaskStatus` (`packages/api/src/task-decide.ts:43`) does, but batched in one query and not N+1.
  - Current stop: `buildTrackMap(await loadTrackMapRows(db)).currentStopId`. This is the TOPMOST open stop on the vertical map (`track-map.ts:617-622`). Spec §6.8's "furthest-right" is out of date. No evidence lookup.
  - **One piece of work counts once.** An open stop routinely carries the task that holds the work (`stops.task_id`; "the outstanding answer lives on the linked task"). When `currentStop.taskId` is among the waiting tasks, the stop is NOT a separate item: its title becomes that task item's `subtitle`, so the badge, the widget and the list count the task once.
- Produces, in `routers/tracks.ts`: `export async function loadTrackMapRows(db: Db): Promise<{ tracks: TrackRow[]; stops: StopRow[] }>`, used by `tracks.map` and by `loadWaiting`.
- Produces `inbox` router: `inbox.list: protectedProcedure.query(() => WaitingItem[])` and `inbox.count: protectedProcedure.query(() => number)`. `count` is `list().length` and never a second SQL count, so the two can never disagree.

- [ ] **Step 1: Failing tests.**
  - `waiting.test.ts` (pure):
    - `verder proposal ranks above every other kind`;
    - `task due within 24h is priority 1 and amber-worthy`;
    - `waiting task is not waiting on Martin`;
    - `in-progress task is waiting on Martin`;
    - `done and dropped tasks are absent`;
    - `no open stop adds nothing`;
    - `current stop linked to an open task counts once`;
    - `ranking is stable for equal timestamps` (ties break on id).
  - `waiting-load.test.ts` (dev DB, `verder_app` role):
    - `purged document's suggestion is not waiting`;
    - `discarded document's suggestion is not waiting`;
    - `dashboard pendingSuggestions agrees with suggestions.list on a purged document` (the two display surfaces, one definition);
    - `count equals list length`.
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter @verder/api test -- waiting`. Expected: FAIL.
- [ ] **Step 3:** Implement. Extract `loadTrackMapRows` without changing `tracks.map`'s output (its tests stay green unchanged). Add the explicit `NOT EXISTS (… p.document_id = s.document_id)` to `dashboard.ts` `pendingSuggestions`. In `suggestions.list`, filter out `document.purge !== null` next to the existing discarded filter.
- [ ] **Step 4:** Run `env -u NODE_ENV pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): one server-side definition of what waits on Martin`.

### Task 2: The web reads the same count

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx:150-215` (fetch `inbox.count` in the existing `Promise.all`; the hero's `wacht op jou` label gets the count), `apps/web/src/app/(app)/queue/page.tsx` (heading shows `inbox.count`)

- [ ] **Step 1:** Add `caller.inbox.count()` to the dashboard's parallel fetch. The existing amber `wacht op jou` label (line 205) renders only inside `currentStop ? …`, so a count attached to it would vanish whenever no stop is open. Render the count INDEPENDENTLY: when `count > 0`, a `wacht op jou · {count}` line in the same `text-attn` class, shown whether or not a stop is open (inside the stop branch it replaces the bare label, outside it stands alone). No other amber is added.
- [ ] **Step 1b:** On `/queue`, which lists suggestions only, keep the heading's own suggestions count. Where it also shows `inbox.count`, label it as the whole set: "{count} wachten op je in totaal", so a heading never claims a number the list below it cannot show.
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter web build`. Expected: success.
- [ ] **Step 3:** Commit: `feat(web): the dashboard counts what Voor jou counts`.

### Task 3: Mobile read routes

**Files:**
- Create: `apps/web/src/lib/mobile-route.ts`, `apps/web/src/lib/mobile-dto.ts`, `apps/web/src/lib/mobile-dto.test.ts`, and these route/test pairs:
  - `apps/web/src/app/api/mobile/v1/inbox/route.ts`
  - `apps/web/src/app/api/mobile/v1/suggestions/[id]/route.ts`
  - `apps/web/src/app/api/mobile/v1/tasks/route.ts`
  - `apps/web/src/app/api/mobile/v1/dashboard/summary/route.ts`
- Modify: `packages/api/src/routers/suggestions.ts` (add `get`)

**Interfaces:**
- `mobile-route.ts`: `export function mobileGet(handler: (caller: Caller, req: Request, params: Record<string,string>) => Promise<unknown>): (req: Request, ctx: { params: Promise<Record<string,string>> }) => Promise<NextResponse>`.
  - It calls `getSessionUserId()` first (`apps/web/src/lib/trpc-server.ts:15`); null gives JSON 401.
  - It maps `TRPCError` `UNAUTHORIZED` to 401 and `NOT_FOUND` to 404.
  - It sets `cache-control: no-store`.
  - Every existing mobile route keeps its own code, Plan 2's proposal routes included; only new routes use the helper.
- **No proposal route here.** `GET /api/mobile/v1/proposals/:id` and `/proposals` are Plan 2 Task 15's, and the phone reads proposal detail from them.
- `suggestions.get: protectedProcedure.input(z.object({ id: z.string().uuid() }))`. It returns the same enriched row `list` produces (`rawEmail`, `document` via `effectiveDocument`, `documentRequest`), or NOT_FOUND.
- DTOs in `mobile-dto.ts`, plain JSON with dates as ISO strings and every field named:
  - `InboxDTO = { count: number; items: WaitingItem[]; doneByVerder: VerderActionDTO[] /* filled by Task 15, [] until then */ }`
  - `SuggestionDTO = { id; kind; status; createdAt; proposed: unknown; trigger: { from: string | null; subject: string | null; sentAt: string | null } | null; document: { id; title; docType; status } | null; retrievedRefs: unknown[] }`
  - `TaskDTO = { id; title; details; dueAt; status; assigneeName; validNext: string[] }`
  - `DashboardSummaryDTO = { headline: { stopTitle; trackTitle; happenedAt; note } | null; waitingCount: number; tasks: { openCount; overdueCount; waitingOnOthersCount } }`
- Routes:
  - `GET /api/mobile/v1/inbox` returns `InboxDTO`.
  - `GET /suggestions/:id` returns `SuggestionDTO`.
  - `GET /tasks?filter=open` returns `TaskDTO[]` from `tasks.list` and `tasks.validNext`.
  - `GET /dashboard/summary` returns `DashboardSummaryDTO`, from `loadTrackMapRows` + `buildTrackMap` + `tasks.stats` + `inbox.count`.

- [ ] **Step 1: Failing tests**, in the mock style of `apps/web/src/app/api/mobile/v1/documents/route.test.ts` (`vi.mock("@/lib/trpc-server")`):
  - for every route, `401 without a session, before any router call`;
  - `inbox count equals items length`;
  - `suggestion 404 maps from NOT_FOUND`;
  - `dates serialise as ISO strings`;
  - `summary headline is null when no stop is open`;
  - `mobile-dto.test.ts`: `toSuggestionDTO never leaks raw documents.status` (it uses `effectiveStatus`).
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter web test -- mobile`. Expected: FAIL. Implement. Run again; expected PASS.
- [ ] **Step 3:** Run `env -u NODE_ENV pnpm --filter web build`. Commit: `feat(web): mobile read routes for Voor jou`.

### Task 4: Mobile write routes (approve, reject, answer, task status)

**Files:**
- Create: `apps/web/src/app/api/mobile/v1/suggestions/[id]/approve/route.ts`, `…/suggestions/[id]/reject/route.ts`, `…/tasks/[id]/status/route.ts`, a `route.test.ts` beside each
- Create also: `packages/api/src/entry-from-proposed.ts` (+ test)
- Modify: `apps/web/src/lib/mobile-route.ts` (add `mobilePost`), `apps/web/src/components/suggestion-card.tsx` (call `entryFromProposed`), Plan 2's `apps/web/src/app/api/mobile/v1/proposals/[id]/answer/route.test.ts` and `packages/api/src/routers/proposals.test.ts` (add the question-only tests below; the routes themselves are Plan 2 Task 15's and are not recreated)

**Interfaces:**
- `mobilePost(handler)`: auth before the body, as `mobileGet`. A body over 64 KB answers 413, and invalid JSON answers 400.
- Suggestion approve dispatches on the suggestion's stored `kind`, never on a client-sent kind. **The phone never sends a whole procedure input.** Its body is `{ edits?: Record<string, unknown> }`: only the fields Martin changed on the card. The route loads the suggestion (`suggestions.get`), builds the full input as `{ ...proposed, ...edits }`, parses it with the procedure's OWN zod schema (so an unknown or wrongly-typed edit is a 400, never silently dropped), and calls:
  - `log-entry` → `suggestions.approveEntry({ id, entry })`. `proposed` is NOT `entryForApproval`'s shape (it has `attachmentDocumentIds`, no `source`), and today the mapping lives inline in `SuggestionCard` (`apps/web/src/components/suggestion-card.tsx:213-218`). Extract it into a pure `entryFromProposed(suggestion, edits)` in `packages/api/src/entry-from-proposed.ts`, used by BOTH the card and this route, so web and phone cannot build different entries: `documentIds` from `attachmentDocumentIds`, `source` derived from the suggestion and never from the client (`"gmail-watch"` when it has a `raw_email_id`, `"manual"` for a `voice-v1` suggestion, Task 24), then `entryForApproval.parse`. A `source` key in `edits` is a 400. Editable: `occurredAt`, `channel`, `direction`, `summary`, `details`, `participantPartyIds`, `attachmentDocumentIds`.
  - `document-meta` → `approveDocumentMeta({ id, title, docType })` from `proposed.title`/`proposed.docType` overlaid with `edits.title`/`edits.docType`.
  - `debt` → `approveDebt({ id, debt })`, `debt` = `debtFields.parse({ ...proposed, ...edits })` (`packages/api/src/routers/registry.ts`).
  - `task` → `approveTask({ id, task })`, `task` = `taskFields.parse({ ...proposed, ...edits })` (`packages/api/src/routers/tasks.ts`).
  - `registry-item` → 409 `{ error: "open op de website" }`, because the card has no phone form.
- Proposal approve and reject are Plan 2's routes, unchanged: approve `{ revision, payload: { to, cc, subject, body, attachmentDocumentIds } }`. The phone has already shown the final text and asked for Face ID. The server never sends from that request; the worker sends.
- Proposal answer is Plan 2's route, `{ option: number } | { freeText: string }`. Plan 2's router already restricts it to `kind = 'question'`; this task adds the tests that PIN that, because it is the server half of "a notification may never send": a non-question answers 409.
- Task status → `tasks.setStatus({ taskId, status })` (`packages/api/src/routers/tasks.ts:165`; input `{ taskId, status, note?, overrideReason? }`). The route body is `{ status, note? }`, and an `overrideReason` key is a 400: it is never offered from the phone.

- [ ] **Step 1: Failing tests:**
  - `401 before reading the body`, on every route;
  - `approve dispatches on stored kind, ignoring client kind`;
  - per kind: `log-entry approve builds entry from proposed plus edits`, `entryFromProposed matches what SuggestionCard sent before the extraction` (in `packages/api`), `log-entry approve refuses an edited source`, `document-meta approve overlays title and docType`, `debt approve parses through debtFields`, `task approve parses through taskFields`, `an unknown edit key is 400`;
  - `registry-item answers 409`;
  - in Plan 2's files: `answer refuses a reply proposal`, `answer refuses a follow-up proposal` (router and route);
  - `task status passes taskId, never id`;
  - `task status rejects an override reason field`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Run `env -u NODE_ENV pnpm --filter web build`.
- [ ] **Step 3:** Commit: `feat(web): mobile suggestion and task routes; pin answer to questions`.

### Task 5: Badge, question options and silent refresh (worker)

**Files:**
- Create: `apps/worker/src/badge-sync.ts`, `apps/worker/src/badge-sync.test.ts`
- Modify (all Plan 2's files, extended, never duplicated): `apps/worker/src/notify/apns.ts` + `apns.test.ts` (`ApnsAlert` gains `badge?` and `options?`; `ApnsSender.sendRaw`), `apps/worker/src/notify/notify.ts` + `notify.test.ts` (badge on every alert; extract `pushToDevices`), `apps/worker/src/index.ts` (queue + schedule + worker), `packages/api/src/worker-health.ts` (`DECLS`), `packages/api/src/worker-names.ts`

**Interfaces:**
- **No new `NotifyKind` and no new category id.** A question is a Plan 2 proposal (`kind = 'question'`), so its push is Plan 2's `proposal` kind and `PROPOSAL` category. What makes it answerable is the `options` key plus `mutable-content`, which the service extension (Task 8) turns into a per-proposal `q.<id>` category.
- `ApnsAlert` (Plan 2) gains `badge?: number` and `options?: string[]`. `apnsPayload` then emits `aps.badge` when given, and, only when `options` is present, `aps["mutable-content"] = 1` and a top-level `options` beside Plan 2's top-level `link`. `options` holds at most 4 entries of at most 40 characters each, cut on build. The deep link stays Plan 2's `link: "verder://proposal/<uuid>"`.
- `notify()` reads `badge` itself, via `loadWaiting(db).length`, so a caller can never pass a stale number. A failure to compute it omits the key (the icon keeps its last value) and never fails the notify.
- Plan 2's proposals-store passes `options: question.options.map((o) => o.label)` when a `question` proposal becomes `pending` (one line in `apps/worker/src/ops/proposals-store.ts`).
- `ApnsSender.sendRaw(env, token, { pushType: "alert" | "background", priority: 5 | 10, payload: object })`, the same session, token cache and timeout as `send`.
- `pushToDevices(deps, raw)`, extracted from `notify()`'s device loop so the session check, the 410/`BadDeviceToken` revoke and the attempt accounting exist once. It writes NO `notifications` row (a badge change is not an alert) and therefore no `notification_attempts` row either (its `notification_id` is NOT NULL); it returns `{ delivered, failed, skipped }` and the caller's run row carries them. The 410 revoke still happens.
- `badge-sync.ts`: `export async function syncBadge(db: Db, deps: { push: (raw) => Promise<{ delivered; failed; skipped }> }): Promise<{ count: number; sent: boolean }>`.
  - It reads the previous count from the newest `badge-sync` `worker_runs` row's `detail.count`.
  - On a change it sends TWO distinct pushes, because Apple says a background push must not carry a badge, and background pushes are throttled and never delivered to a force-quit app:
    1. **the badge:** apns-push-type `alert`, priority 5, payload exactly `{ aps: { badge: N } }`. No `alert`, no `sound`. iOS updates the icon even when the app was force-quit.
    2. **the refresh:** apns-push-type `background`, priority 5, payload exactly `{ aps: { "content-available": 1 } }`. It refreshes the widget snapshot and the inbox cache when iOS lets it, and nothing depends on it arriving.
  - It records `badge-sync` `ok` with `{ count, sent, delivered, failed }` on every tick, because a watcher's silence must mean failure.
- Schedule: `boss.schedule("badge.sync", "*/5 * * * *")`. DECLS: `"badge-sync": { kind: "watcher", everyMs: 5 * MINUTE }`.

- [ ] **Step 1: Failing tests:**
  - `apns.test.ts`:
    - `proposal with options carries options and mutable-content`;
    - `alert without options never carries options or mutable-content`;
    - `options are capped at four and forty characters`;
    - `badge is emitted when given`;
    - `sendRaw background sets apns-push-type background and priority 5`.
  - `notify.test.ts`: `every alert carries the waiting count as badge`; `a failing badge count omits the key and still delivers`.
  - `badge-sync.test.ts` (dev DB, `verder_worker`, injected `push`):
    - `first run sends`;
    - `unchanged count does not send but still records`;
    - `changed count sends one badge push and one background push`;
    - `badge payload is alert-type with only aps.badge` (no `alert`, no `sound`, no `content-available`);
    - `background payload carries no badge`.
  - `worker-health` test: `badge-sync is a 5-minute watcher`.
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter worker test -- badge apns notify` and `env -u NODE_ENV pnpm --filter @verder/api test -- worker-health`. Expected: FAIL. Implement. Run again; expected PASS.
- [ ] **Step 3:** There is NO caller repointing here. Plan 2 Task 5 already moved every alert onto `notify()` and deliberately deleted the generic "something new" suggestion push (spec §6.4: never just "nieuwe mail"; spec §4's anti-goals). Suggestions reach Martin through the badge and Voor jou only. `grep -rn "Iets nieuws\|Something new" apps/worker/src` must return nothing.
- [ ] **Step 4:** Commit: `feat(worker): badge on every alert, badge sync, answerable question pushes`.
- [ ] **Step 5: Deploy P3-D1 [main session].** No migration.
  1. Record the ledger `max(seq)`, count and head.
  2. Run `env -u NODE_ENV pnpm --filter web build` locally.
  3. Rsync (dry run, read every `deleting` line, then the real run).
  4. Run `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker`.
  5. Expected: within 10 minutes `worker_runs` holds two `badge-sync` rows, the first with `sent: true` and `delivered ≥ 1`.
  6. **Predicted ledger delta from this step: none.** Tolerated background only (Global Constraints). `nightly-verify` OK.

### Task 6: iOS data layer

**Files:**
- Create:
  - `apps/ios/Verder/Inbox/InboxModels.swift`
  - `apps/ios/Verder/Inbox/InboxStore.swift`
  - `apps/ios/Verder/Shared/WidgetSnapshot.swift` (compiled into the app AND the widget target in Task 23)
  - `apps/ios/VerderTests/InboxStoreTests.swift`
  - `apps/ios/VerderTests/WidgetSnapshotTests.swift`
- Modify (Plan 2 Task 19's, not recreated): `apps/ios/Verder/Net/APIClient+JSON.swift`, `apps/ios/VerderTests/APIClientJSONTests.swift`

**Interfaces:**
- The JSON client is Plan 2's `getJSON`/`postJSON`. This task only adds what the inbox needs and Plan 2 may not have: a decoder that accepts ISO 8601 WITH and WITHOUT fractional seconds (Postgres `timestamptz` serialised by `Date.toISOString()` carries milliseconds). If Plan 2's decoder already does, Step 1's first test passes immediately and nothing changes.
- `struct WaitingItem: Codable, Identifiable, Equatable`, `InboxDTO`, `SuggestionDTO`, `TaskDTO`, `DashboardSummaryDTO`, mirroring Task 3 field for field. Proposal detail uses Plan 2's `ProposalDTO` (`apps/ios/Verder/Proposals/ProposalDTO.swift`).
- `@MainActor @Observable final class InboxStore { var inbox: InboxDTO?; var lastError: APIError?; func refresh() async; }`.
  - `refresh` writes a `WidgetSnapshot` and calls `UNUserNotificationCenter.current().setBadgeCount(count)`.
- `struct WidgetSnapshot: Codable, Equatable { let count: Int; let topTitle: String?; let topKind: String?; let headline: String?; let updatedAt: Date }`.
  - `static func write(_:to dir: URL, writer: (Data, URL, Data.WritingOptions) throws -> Void = { try $0.write(to: $1, options: $2) }) throws` and `static func read(from dir: URL) -> WidgetSnapshot?`. The writer is injected so a test can assert the OPTIONS passed: the simulator does not enforce data protection, and `FileAttributeKey.protectionKey` is often nil there, so reading the attribute back proves nothing.
  - The file is `<group>/widget/snapshot.json`, written atomically with `.completeFileProtectionUntilFirstUserAuthentication`. The widget renders while the phone is locked, so this one small file cannot be `.complete`.

- [ ] **Step 1: Failing tests:**
  - `getJSONDecodesFractionalAndPlainISODates` (in Plan 2's `APIClientJSONTests`);
  - `refreshWritesSnapshotWithTopItem`;
  - `refreshSetsTheBadgeToTheCount`;
  - `snapshotRoundTrip`;
  - `snapshotIsWrittenAtomicallyUntilFirstUserAuthentication` (the injected writer records `[.atomic, .completeFileProtectionUntilFirstUserAuthentication]`, and never `.completeFileProtection`).
  - The on-disk protection class is checked on the DEVICE in Task 9, not in the simulator.
- [ ] **Step 2:** Run `xcodebuild test …`. Expected: FAIL. Implement. Run again; expected PASS (129 + new).
- [ ] **Step 3:** Commit: `feat(ios): inbox store and widget snapshot`.

### Task 7: The Voor jou tab and its detail screens

**Files:**
- Create:
  - `apps/ios/Verder/Inbox/VoorJouTab.swift`
  - `apps/ios/Verder/Inbox/QuestionView.swift`
  - `apps/ios/Verder/Inbox/SuggestionDetailView.swift`
  - `apps/ios/Verder/Inbox/TaskRowView.swift`
  - `apps/ios/VerderTests/InboxRankingTests.swift`
  - `apps/ios/VerderTests/QuestionViewModelTests.swift`
- Modify: `apps/ios/Verder/App/RootView.swift` (the Voor jou tab shows `VoorJouTab` in place of Plan 2's `ProposalListView`; it stays `.lockGated(by: lock)`)
- **Not created, reused from Plan 2 Task 19:** the reply/follow-up proposal screen (`Proposals/ProposalScreen.swift`, `ProposalModel`) and the send gate (`ApprovalGate`). This task adds no Face ID abstraction of its own: there is already `DeviceOwnerAuthenticator` (Plan 1) and whatever Plan 2's `ApprovalGate` wraps.

**Interfaces:**
- Screens (Dutch copy):
  - **List.** Rows in server order (the phone never re-ranks). Amber dot only on rows in the list; a collapsed "Door verder gedaan" section (filled by Task 15) is never amber. Pull to refresh. Empty state: "Niets wacht op je."
  - **Reply or follow-up proposal.** A tap pushes Plan 2's `ProposalScreen` unchanged. Versturen, Aanpassen, Afwijzen and the fresh Face ID on every send are its behaviour, not this task's.
  - **Question** (`QuestionView`, new). The prompt, the options as buttons, and a free-text field "Anders, namelijk". It posts Plan 2's answer body: `{ option: <index> }` or `{ freeText }`. An answer runs a ledgered action on Martin's behalf (`tasks.setStatus`, `registry.debts.linkDocument`, `tasks.create`) but sends nothing outbound, so it asks no Face ID inside the app lock's grace.
  - **Suggestion.** Per kind, mirroring `/queue`'s `SuggestionCard` (`apps/web/src/components/suggestion-card.tsx:107`): log-entry, document-meta (title + soort), debt, task. Buttons "Klopt zo", "Aanpassen" and "Niet relevant". Approve posts `{ edits }` with only the changed fields (Task 4). `registry-item` shows "Open op de website".
  - **Task.** The status picker offers only `validNext`.
- Never: a send outside Plan 2's `ApprovalGate`, an approve from the list row, or an auto-advance after a send.

- [ ] **Step 1: Failing tests:**
  - `InboxRankingTests.rendersServerOrderUnchanged`;
  - `InboxRankingTests.doneByVerderIsNeverAmber`;
  - `InboxRankingTests.replyRowOpensPlan2ProposalScreen`;
  - `QuestionViewModelTests.optionPostsIndexNotLabel` and `freeTextPostsFreeText` (via `StubProtocol`);
  - `SuggestionDetailTests.approveSendsOnlyChangedFields`.
- [ ] **Step 2:** Run them (FAIL), implement, and run them (PASS).
- [ ] **Step 3:** Commit: `feat(ios): Voor jou with question, suggestion and task screens`.

### Task 8: Notifications on the phone

**Files:**
- Create:
  - `apps/ios/Verder/Push/NotificationRouter.swift`
  - `apps/ios/Verder/Push/QuestionCategories.swift` (compiled into the app AND the extension)
  - `apps/ios/VerderNotify/NotificationService.swift`
  - `apps/ios/VerderTests/QuestionCategoriesTests.swift`
  - `apps/ios/VerderTests/NotificationRouterTests.swift`
- Modify (Plan 2 Task 7's files, extended): `apps/ios/Verder/Push/NotificationCategories.swift` (exposes its static set as `NotificationCategories.all` so the extension can union with it), `apps/ios/Verder/Push/DeepLink.swift` (cases `.inbox`, `.suggestion(UUID)`, `.task(UUID)`; also parses a URL for the widget), `apps/ios/Verder/App/AppDelegate.swift` (`application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` calls `InboxStore.refresh()`; `userNotificationCenter(_:didReceive:)` hands to `NotificationRouter`), `apps/ios/project.yml` (new target `VerderNotify`, type `app-extension`, bundle `pro.vanderpoel.verder.notify`, App Group entitlement; URL scheme `verder` under `info.properties` `CFBundleURLTypes` if Plan 2 did not add it, for the widget's `widgetURL`)

**Interfaces:**
- The static categories are Plan 2's nine (`VERDER_MAIL` … `WEEKLY`), unchanged. Their actions are all `.foreground` ("Bekijken").
- `QuestionCategories.make(proposalId: String, options: [String]) -> UNNotificationCategory` builds `q.<proposalId>`: one action per option, each `.authenticationRequired` and NOT `.foreground`.
- `QuestionCategories.merged(existing: Set<UNNotificationCategory>, adding: UNNotificationCategory, keep: Int = 20) -> Set<UNNotificationCategory>`, pure. `setNotificationCategories` REPLACES the whole set, so the extension never calls it with just its own category: it reads `getNotificationCategories()`, passes the result through `merged`, and writes the union. `merged` always keeps every non-`q.` category, keeps at most the `keep` newest `q.*` (newest = the order they were added; the ids carry no date, so the order is kept in a small App Group list `push/q-order.json`), and drops the rest.
- The app re-registers the union of Plan 2's static set and the current `q.*` set on every launch, so a lost static category heals at the next open.
- `NotificationService` (the Notification Service Extension):
  - For a push with a top-level `options` array and a `link` of `verder://proposal/<uuid>`, it registers `q.<uuid>` through `merged` and rewrites the content's `categoryIdentifier` to it.
  - It never makes a network call.
  - **This is a fourth target beyond spec §7's three.** iOS fixes a category's action titles when the category is registered. A question's options are known only once its push arrives, and the service extension is the one piece of code that runs before the notification is shown.
- `NotificationRouter.handle(response:)`:
  - default tap → Plan 2's `DeepLink(userInfo:)` (`userInfo["link"]`), which selects the Voor jou tab and pushes the detail screen;
  - a `q.*` action → `POST /api/mobile/v1/proposals/:id/answer { option: <index> }` (Plan 2's body). Nothing else is reachable from an action.

- [ ] **Step 1: Failing tests:**
  - `onlyQuestionActionsWorkInBackground`: every action in `NotificationCategories.all` has `.foreground`;
  - `questionCategoryActionsRequireAuthentication`, on a category built by `QuestionCategories.make`;
  - `extensionKeepsStaticCategories`: `merged(existing: NotificationCategories.all, adding: q)` contains all nine static ids plus `q`;
  - `questionCategoriesAreCappedAtTwenty`: 25 additions keep the 20 newest `q.*` and every static one;
  - `routerMapsReplyTapToDetailNotSend`;
  - `routerSendsAnswerOnlyForQCategories` (and with Plan 2's `{ option }` body);
  - `deepLinkParsesInboxSuggestionTask`.
- [ ] **Step 2:** Run them (FAIL), implement, and run them (PASS).
- [ ] **Step 3: Measure the extension on the device [main session].**
  - Martin approves a test question push to his own phone. It is a push to his own device, but the standing rule covers test sends, so ask first and show him the exact title, body and options. It is sent through `notify()` with a `dedupKey` of `test-question-<date>` and a `link` to a proposal id that does not exist, so tapping an option answers 404 and runs nothing.
  - Expected: the lock-screen notification shows the option buttons, and the Bekijken action on a later ordinary push still works (the static set survived).
  - Record whether iOS 27.2 used the category registered inside the extension for that same notification. If it did not, ship the fallback: question notifications get only "Bekijken", and record the measured reason in the commit.
- [ ] **Step 4:** Commit: `feat(ios): answerable question notifications, deep links, background refresh`.

### Task 9: Slice 6 on the phone [main session]

**Files:**
- Modify: `CLAUDE.md` (a slice 6 entry)

- [ ] **Step 1:** Run `apps/ios/scripts/install.sh`. Open Voor jou. Expected: the same count as the web dashboard's `wacht op jou · N`, and the same order as `GET /api/mobile/v1/inbox`.
- [ ] **Step 2: The badge, on a decision Martin actually wants to make.** Approving a suggestion is an evidence write, so it is never done "for the test": pick a pending suggestion Martin WANTS to decide, with his OK, and predict its delta first — a document-meta approve appends **+1 `document.updated`**, a log-entry approve **+1 `entry.created`**, a "Niet relevant" **nothing** (the cheapest honest choice if one is genuinely irrelevant). Record the `max(seq)` before. Then lock the phone and decide it on the web. Expected: within 5 minutes plus delivery time, the icon badge drops by one (the alert-type badge push from `badge.sync`). Record the measured delay, and **record whether the app had been force-quit** (swiped away in the app switcher) at the time: the badge push must arrive either way, while the background refresh is expected NOT to reach a force-quit app. Check the ledger against the prediction plus the tolerated background.
- [ ] **Step 3:** Check the widget snapshot's protection class on the DEVICE (the simulator cannot): from Xcode's Devices window, download the app container and confirm `widget/snapshot.json` is `NSFileProtectionCompleteUntilFirstUserAuthentication`, or read it from a debug-only log line the app prints once.
- [ ] **Step 4:** If a real pending proposal exists, Martin opens it, reads it and decides. **Nothing is approved for sending unless Martin chooses to, on his own text.** No test send is made for this check.
- [ ] **Step 5:** CLAUDE.md entry: what shipped, the measured badge delay (and whether the app was force-quit), the extension measurement from Task 8, and Martin's `in-progress` decision. Commit: `docs: record Voor jou on the phone`.

---

## Slice 7 — autonomous filing with undo

### Task 10: An honest docmeta verdict first

**Files:**
- Modify: `packages/api/src/routers/suggestions.ts:117-142` (`approveDocumentMeta`)
- Create: `packages/api/src/routers/suggestions-docmeta.test.ts`

Today `approveDocumentMeta` always writes `approved`, even when Martin edited the card. The auto-apply threshold is measured against this history, so it has to stop lying first.

- [ ] **Step 1: Failing tests** (dev DB):
  - `edited title records edited`;
  - `unchanged records approved`;
  - `second approve of a decided suggestion is refused and appends nothing` (count `ledger_events` before and after);
  - `approve on a purged document is refused`;
  - `approve on a discarded document is refused`.
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter @verder/api test -- suggestions-docmeta`. Expected: FAIL.
- [ ] **Step 3:** Implement, copying `approveEntry` (lines 74-115):
  1. `SELECT … FOR UPDATE`.
  2. Require status `pending` or `needs-manual`.
  3. Take `pg_advisory_xact_lock(hashtextextended(documentId, 0))` as `documents.update` does (line 456+).
  4. Refuse discarded or purged documents.
  5. `status = unchanged ? "approved" : "edited"`. `unchanged` compares `title` exactly and `docType` through `docTypeKey` (`doc-type.ts`), because the soort key folds case and whitespace.
- [ ] **Step 4:** Run (PASS). Commit: `fix(api): docmeta approval records edited and cannot be approved twice`.

### Task 11: Migration M-A, `auto-applied` and the verder actor (server)

**Files:**
- Create: `packages/db/drizzle/0039_auto_applied.sql` (number from Task 0), `packages/db/src/auto-applied.test.ts`, `packages/api/src/verification-actor.test.ts`
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts:15` (enum) and `:98-106` (`documentStatusChanges` gains `actor`, `suggestionId`), `packages/api/src/verification.ts:99-191`, `packages/api/src/routers/suggestions.ts:50` (zod status enum), `apps/web/src/app/(app)/queue/page.tsx`

**Interfaces:**
- Migration, four statements, each separated by a breakpoint. The columns are new and empty, so the constraints are added plain (no `NOT VALID` + `VALIDATE` dance, which only pays on a populated column):

  ```sql
  ALTER TYPE "public"."suggestion_status" ADD VALUE 'auto-applied';
  --> statement-breakpoint
  ALTER TABLE "document_status_changes" ADD COLUMN "actor" text, ADD COLUMN "suggestion_id" uuid REFERENCES "suggestions"("id");
  --> statement-breakpoint
  ALTER TABLE "document_status_changes" ADD CONSTRAINT "dsc_actor_ck" CHECK ("actor" IS NULL OR "actor" = 'verder');
  --> statement-breakpoint
  ALTER TABLE "document_status_changes" ADD CONSTRAINT "dsc_suggestion_needs_actor_ck" CHECK ("actor" IS NOT NULL OR "suggestion_id" IS NULL);
  ```

  `dsc_suggestion_needs_actor_ck` exists because `suggestion_id` is not part of the hash of an `actor IS NULL` row (Martin's rows hash in the narrow or wide shape, neither of which reads it). Without the check, an admin UPDATE setting `suggestion_id` on a Martin row would pass `/verify` and could make an ordinary rename look like verder's work in "Door verder gedaan".

  No grant changes. The table already has `SELECT, INSERT` for both roles and still has no UPDATE. A header comment says why the columns are nullable: every existing row is Martin's or a pre-actor machine row, and a backfill would change what those rows hash to.
- `verification.ts`:
  - New: `export function documentStatusChangePayloadByVerder(c) { return { ...documentStatusChangePayloadWithParty(c), actor: "verder", suggestionId: c.suggestionId }; }`. `suggestionId` is a key that is always present, null for an auto-name row.
  - `resolveDocumentUpdatedHashes` candidates:
    - `actor IS NULL`: exactly today's narrow (when `party_id IS NULL`) and wide candidates;
    - `actor = 'verder'`: ONLY the verder shape.

    The narrow and wide shapes never read `actor`. Offering them for a verder row would let an UPDATE that cleared `actor` still match, and offering the verder shape for a null row would let an UPDATE that set it still match. The same reasoning as the existing `party_id IS NULL` guard (lines 138-155).
  - The consumption rule is unchanged: one row vouches for one event.
- `/queue` keeps listing only `pending` and `needs-manual`. `auto-applied` rows appear only in "Door verder gedaan" (Task 15).

- [ ] **Step 1: Failing tests.**
  - `auto-applied.test.ts` (admin DB, following `doc-source-phone.test.ts`):
    - `enum_range(NULL::suggestion_status)` includes `auto-applied`;
    - `actor other than verder is rejected by the check`;
    - `suggestion_id without actor is rejected by the check`;
    - `verder_app still has no UPDATE on document_status_changes`.
  - `verification-actor.test.ts`:
    - `verder row verifies`;
    - `old row still verifies` (a row written with the wide shape before the column existed);
    - `setting actor on an old row is detected`;
    - `clearing actor on a verder row is detected`;
    - `changing suggestion_id on a verder row is detected`.

    The last three each do an admin UPDATE and assert a `payload_hash_mismatch` through `makeLedgerRecompute`, never by calling the resolver directly, because an untested dispatch line is the sub-project 2 lesson.
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter @verder/db test -- auto-applied` and `pnpm --filter @verder/api test -- verification`. Expected: FAIL.
- [ ] **Step 3:** Write the migration and journal entry. Run `pnpm --filter @verder/db migrate` against dev. Update `schema.ts`. Implement the verification change.
- [ ] **Step 4:** Run `env -u NODE_ENV pnpm -r test` and `env -u NODE_ENV pnpm --filter web build`. Expected: green. Then run `pnpm --filter worker nightly-verify` against dev. Expected: OK on the whole dev chain.
- [ ] **Step 5:** Commit: `feat(db): auto-applied verdict and a verder actor that old rows never hash`.

### Task 12: `docmeta-v2` with a confidence signal, and a docmeta eval

**Files:**
- Create:
  - `apps/worker/src/eval/run-docmeta-eval.ts`
  - `apps/worker/src/eval/docmeta-score.ts`
  - `apps/worker/src/eval/docmeta-score.test.ts`
  - `apps/worker/src/ops/export-docmeta-samples.ts`
- Modify: `apps/worker/src/prompts.ts:80-89` (`DOCMETA_PROMPT_VERSION = "docmeta-v2"`, the prompt asks for `{"title","docType","confident":true|false}`, as auto-name does in `ops/normalize-filenames.ts:83`, where `confident` is stated to mean "the SOORT is certain", because the soort is the only metadata auto-apply writes, Task 14), `apps/worker/src/ollama.ts:92-120` (`llmDocSchema` gains `confident: z.boolean().default(false)`, stored in `proposed.confident`; and `buildDocMetaPrompt` is given the document's EFFECTIVE title (`effectiveDocument(db, id).effectiveTitle`) instead of the raw `doc.title` at line 107, because auto-name has usually renamed it by then in the same job, `index.ts:268-282`), `apps/worker/package.json` (scripts `docmeta-eval`, `export-docmeta-samples`)

There is no docmeta eval today: `apps/worker/src/eval/` has entry, registry, task and retrieval evals only. Spec §6.6's "the existing docmeta eval" does not exist, so this task builds it.

**Interfaces:**
- `export-docmeta-samples.ts` (hand-run, worker role):
  - It selects decided `document-meta` suggestions: `approved`, `edited` (after Task 10) and older `approved` rows whose `proposed` differs from `final_payload`.
  - It excludes needs-manual-origin rows (their `proposed.title` equals the document's raw title and `proposed.docType` is null), rejected rows ("Niet relevant" is about relevance, not metadata), and discarded or purged documents.
  - It joins `document_texts.text` (first 4000 chars) and writes `{ documentId, text, promptTitle, expected: { title, docType } }[]` to the path in `DOCMETA_EVAL_SAMPLES`. `promptTitle` is the document's CURRENT effective title, which is what docmeta-v2 is shown; for old samples it approximates what the model saw, and the CLAUDE.md record says so.
  - **The file holds Martin's real document text and is never committed.** It lives at `/srv/verder/eval/docmeta-samples.json` on the homelab, outside `~/apps/verder`, so `rsync --delete` cannot touch it.
- `docmeta-score.ts` (pure): `scoreDocMeta(out, expected): { docTypeExact: boolean; titleExact: boolean; gate: boolean }`. `docTypeExact` compares through `docTypeKey`. **`gate = docTypeExact`**, and ONLY that: the gate scores exactly what auto-apply writes (soort, with status `filed`), and auto-apply never writes a title (Task 14). `titleExact` is reported for information; an exact-title gate on a free-form title would put precision near zero and measure something nothing applies.
- `run-docmeta-eval.ts` prints, per run:
  - n;
  - n_confident;
  - gate precision (soort) among `confident: true`;
  - gate precision among all samples;
  - title exact-match rate (information only);
  - timeouts.

  It must run from the homelab HOST (Ollama at `localhost:11434`; the samples file is not mounted into the worker).

- [ ] **Step 1: Failing tests.** `docmeta-score.test.ts`:
  - `docType compares through the soort fold` (`"Loonstrook "` equals `"loonstrook"`);
  - `gate ignores the title` (a wrong title with the right soort passes the gate, and `titleExact` is false);
  - `null expected docType matches empty output`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS).
- [ ] **Step 3:** Commit: `feat(worker): docmeta-v2 reports confidence; a docmeta eval over real verdicts`.

### Task 13: Measure the threshold [main session]

**Files:**
- Modify: `CLAUDE.md` (eval baselines block)

- [ ] **Step 0: Put Task 10 and Task 12's code on the homelab, without deploying it.** Nothing else in this plan has rsynced since P3-D1, and both scripts run from the HOST tree.
  1. Run the Global Constraints rsync: dry run with `--dry-run --info=del`, read every `deleting` line, then the real run. This only writes files: the running web and worker containers keep their images, so production behaviour does not change until P3-D2 rebuilds them.
  2. On the host: `cd ~/apps/verder && pnpm install --frozen-lockfile` (no-op unless the lockfile moved; this plan adds no dependency).
  3. Every host-side command in this task runs with this environment, which keeps the password out of argv and the terminal: the worker role (it holds SELECT on `suggestions`, `documents`, `document_status_changes`, `document_purges` and `document_texts`; the app role has no rights it lacks here), and Postgres and Ollama on the host's loopback rather than the compose names `postgres` and `ollama`:

     ```text
     cd ~/apps/verder && set -a && . ./.env.prod && set +a && export DATABASE_URL="${WORKER_DATABASE_URL/@postgres:/@127.0.0.1:}" OLLAMA_URL=http://localhost:11434 DOCMETA_EVAL_SAMPLES=/srv/verder/eval/docmeta-samples.json
     ```

     Check first, without printing it: `[[ "$DATABASE_URL" == postgres://verder_worker:*@127.0.0.1:5432/verder ]] && echo ok`. Expected `ok`. Create the directory once with `sudo install -d -o "$USER" -m 700 /srv/verder/eval`.
  4. Note that prod history holds no `edited` verdicts yet (Task 10 is not deployed until P3-D2), so the export relies on its "older `approved` rows whose `proposed` differs from `final_payload`" rule for every edit.
- [ ] **Step 1:** In that environment, run `pnpm --filter worker export-docmeta-samples`. Record n, and how many are edited versus approved-unchanged.
- [ ] **Step 2:** Before running, record the GPU conditions: `curl -s localhost:11434/api/ps` (`size_vram` vs `size`) and `rocm-smi --showpids`. CLAUDE.md shows the 120 s timeouts are VRAM-driven.
- [ ] **Step 3:** In the same environment, run `pnpm --filter worker docmeta-eval` until there are **three completed runs**. Rerun a crashed run; never trust it. Record for each run: n, n_confident, gate precision among confident, gate precision overall, the title exact-match rate, timeouts. **"Gate" covers the soort only** (Task 12), because the soort plus status `filed` is all auto-apply writes; the title rate is recorded and decides nothing.
- [ ] **Step 4: The decision rule, fixed before looking.** Auto-apply is enabled only if, in **every** one of the three runs, `n_confident ≥ 20` and gate (soort) precision among confident `≥ 0.90`. Otherwise it ships switched off (`DOCMETA_AUTO_APPLY` unset) and the numbers are recorded as the reason. Real history also counts: in the same session, run the spec map's acceptance query (`proposed.docType` vs `final_payload.docType` through the soort fold, on decided `document-meta` rows) and record the plain soort acceptance rate, so history measures the same field as the gate. If history and eval disagree by more than 15 points, stop and show Martin both numbers.
- [ ] **Step 5:** Record the range, the conditions and the decision in CLAUDE.md's eval baselines block in its house style. Commit: `docs: docmeta-v2 baseline and the auto-apply decision`.

### Task 14: Auto-apply in the worker, and auto-name on the actor path

**Files:**
- Create: `apps/worker/src/auto-file.ts`, `apps/worker/src/auto-file.test.ts`
- Modify: `apps/worker/src/ollama.ts:94-120` (call `autoApplyDocMeta` after a successful pending insert), `apps/worker/src/auto-name.ts:96-109` (write `actor: "verder"`, `suggestionId: null`, and emit the verder payload shape), `packages/api/src/worker-health.ts` (`"auto-file": { kind: "on-demand" }`), `.env.example` (`DOCMETA_AUTO_APPLY=`)

**Interfaces:**
- `export async function autoApplyDocMeta(db: Db, suggestionId: string, env = process.env): Promise<{ applied: boolean; reason: string }>`. One transaction:
  1. If `env.DOCMETA_AUTO_APPLY !== "on"`, return `{applied:false, reason:"disabled"}` without writing.
  2. Lock the suggestion `FOR UPDATE`. Require `kind = 'document-meta'`, `status = 'pending'` (never `needs-manual`), `prompt_version = 'docmeta-v2'` and `proposed.confident === true`.
  3. Take `pg_advisory_xact_lock(hashtextextended(documentId, 0))`.
  4. Read `effectiveDocument`. Require effective status `inbox`, not purged, and NO change row with `actor IS NULL` since ingest. If Martin has touched it, verder does not.
  5. Insert a `document_status_changes` row `{status:"filed", title: current.effectiveTitle, docType: proposed.docType, partyId: current.effectivePartyId, actor:"verder", suggestionId}`, and append `document.updated` with `documentStatusChangePayloadByVerder`. **The title is the CURRENT effective title, never `proposed.title`.** Auto-name ran earlier in the same job (`apps/worker/src/index.ts:268-282`) and wrote a name that passed `looksLikeProse`, `validateName`/`retainsIdentifiers` and a collision check against every effective title; docmeta's free-form "short, descriptive" title passed none of those, and applying it would overwrite a guarded name with an unguarded one that can collide or drop an identifier (the Rabobank year incident recorded in `auto-name.ts`). The suggestion's proposed title stays visible in "Door verder gedaan" as information.
  6. Update the suggestion: `status = 'auto-applied'`, `verdictAt = now`, `finalPayload = { title: current.effectiveTitle, docType, before: { status, title, docType }, changeId }`.
  7. Record `auto-file` `ok` with `{ suggestionId, applied, reason }`.
- **Not auto-applied, by design:**
  - The title (see step 5). Naming is auto-name's job and keeps its own guards.
  - Sender party. The docmeta prompt proposes none, and spec §12.5 says an OCR sender is an unconfirmed guess.
  - Links of any kind. No producer of automatic links exists. An `entry_documents` link has no DELETE grant and would sit permanently in an entry's citation set and the signed export, so it could never be undone. `stops.document_id` and `tasks.document_id` would overwrite Martin's link with no history.

  All of these stay manual until a later plan gives them a producer and an undo.

- [ ] **Step 1: Failing tests** (dev DB, worker role):
  - `disabled appends nothing`;
  - `needs-manual never applies`;
  - `not confident never applies`;
  - `applies once and appends exactly one document.updated`;
  - `keeps the effective title and applies only status and soort` (an auto-named document keeps auto-name's name even when `proposed.title` differs);
  - `second call is a no-op`;
  - `a Martin change since ingest blocks it`;
  - `purged document blocks it`;
  - `verder row verifies under nightly recompute`;
  - `auto-name now writes actor verder` (in `auto-name.test.ts`).
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter worker test -- auto-file auto-name`. Expected: FAIL. Implement. Run again; expected PASS.
- [ ] **Step 3:** Commit: `feat(worker): verder files a document on its own only when it measured it can`.

### Task 15: "Door verder gedaan" with one-tap undo

**Files:**
- Create:
  - `packages/api/src/routers/verder-actions.ts`
  - `packages/api/src/routers/verder-actions.test.ts`
  - `apps/web/src/components/done-by-verder.tsx`
  - `apps/web/src/app/api/mobile/v1/verder-actions/[changeId]/undo/route.ts` (+ test)
  - `apps/worker/src/autofile-digest.ts`
  - `apps/worker/src/autofile-digest.test.ts`
  - `apps/ios/Verder/Inbox/DoneByVerderSection.swift`
- Modify: `packages/api/src/root.ts`, `apps/web/src/app/(app)/queue/page.tsx` (render `DoneByVerder` below the pending cards), `apps/web/src/lib/mobile-dto.ts` + `inbox/route.ts` (fill `doneByVerder`), `apps/worker/src/index.ts` (queue `autofile.digest`, `boss.schedule("autofile.digest", "0 19 * * *", undefined, { tz: "Europe/Amsterdam" })`), `packages/api/src/worker-health.ts` (`"autofile-digest": { kind: "nightly" }`: a once-a-day job is exactly what the `nightly` kind's reasoned 26 h bound is for, while `watcher` would multiply the cadence by 3 and tolerate 72 h of silence; `worker-health.ts` defines only `MINUTE`, so there is no `HOUR` to write anyway)

**Interfaces:**
- `verderActions.list({ sinceDays = 7 })` returns `VerderActionDTO[] = { changeId, documentId, documentTitle, at, kind: "auto-file" | "auto-name", before: {status,title,docType}, after: {status,title,docType}, undone: boolean, undoable: boolean }`.
  - The source is `document_status_changes WHERE actor = 'verder'`.
  - `before` is the effective state from the rows strictly older than the change.
  - `undoable` is false when a newer change row exists for the document, when the document is purged, and ALWAYS for `kind: "auto-name"`. The DTO carries `notUndoableReason: "al aangepast" | "vernietigd" | "naam staat ook op de NAS" | null`, shown on web and phone beside a disabled button.
  - **Why auto-name is not undoable here.** Auto-name also renames the file on the NAS share and journals it (`auto-name.ts:84-94`), which is why `normalize-names --undo` exists. A DB-only undo would leave `/scans` holding the new name while the dossier holds the old one, and `nas-known.ts` matches share files against the EFFECTIVE title, so the two would disagree about the file's name. The web container does not mount the share, so it cannot do the rename itself. Reversing a name stays `pnpm --filter worker normalize-names --undo`, and the row says so.
- `verderActions.undo({ changeId })`, one transaction:
  1. Take the document's advisory lock.
  2. Refuse with `CONFLICT "al aangepast"` when any newer change row exists. That covers an undo already done, so a double tap is harmless. Refuse with `CONFLICT "vernietigd"` when the document is purged: a purge writes no change row, so the newer-row check alone would append a `document.updated` restoring `inbox` onto destroyed content. Refuse with `BAD_REQUEST` for an `auto-name` change (see `list`).
  3. Insert a Martin row (`actor NULL`) restoring `before`: status, title, and `docType` as `""` when it was null. Under the newest-opinion rule a soort can never return to NULL, and `docTypeKeySql` folds `""` and NULL to the same "Zonder soort" key.
  4. Append `document.updated` (wide shape).
  5. Write the undo into the suggestion's `finalPayload.undo = { at, changeId }` when there is one. The ledgered row is the honest record; this is the learning signal.
- Mobile: `POST /api/mobile/v1/verder-actions/:changeId/undo`. The iOS section has one "Ongedaan maken" button per row, with no Face ID: undo reveals nothing and sends nothing.
- `autofile-digest`: daily at 19:00 Amsterdam.
  - When the last 24 h holds verder actions, it calls Plan 2's `notify(deps, { kind: "filing", level: "passive", title: "Door verder gedaan", body: "3 documenten opgeborgen", link: "verder://inbox", dedupKey: "autofile:<dayKey>" })`. Counts only; no titles on the lock screen. The `dedupKey` (`dayKey` from `packages/api/src/amsterdam.ts`) makes a pg-boss retry a no-op instead of a second push.
  - It always records `autofile-digest` `ok` with `{ count }`.

- [ ] **Step 1: Failing tests:**
  - `list shows before and after`;
  - `undo restores title, soort and inbox`;
  - `undo refuses when a newer change exists`;
  - `undo refuses a purged document and appends nothing`;
  - `auto-name changes are listed but not undoable, with the reason`;
  - `double undo appends one event`;
  - `undo of null soort writes empty soort and the tree shows Zonder soort`;
  - `digest sends nothing on a quiet day but records`;
  - `digest retry on the same day sends one push` (dedupKey);
  - mobile route `401 first`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Run `env -u NODE_ENV pnpm --filter web build`.
- [ ] **Step 3:** Commit: `feat: Door verder gedaan, with one-tap undo through the append-only change table`.

### Task 16: The law amendment, and deploy P3-D2

**Files:**
- Modify: `CLAUDE.md:39` (Project laws), plus a new deploy entry

- [ ] **Step 1:** Replace the second Project law with:

  ```text
  - AI output is suggestion-only; nothing enters the ledger without Martin's approval — with ONE amendment Martin made on 2026-10-28: verder may FILE a document on its own (apply a document-meta suggestion's soort and set status filed; never its title, which stays auto-name's) when the measured gate in `apps/worker/src/auto-file.ts` passes. Every such change is a `document_status_changes` row with `actor = 'verder'`, ledgered in its own payload shape, listed under "Door verder gedaan" and undoable in one tap. Auto-name rows carry the same actor and are listed there too, but are reversed with `normalize-names --undo` because the name also lives on the NAS share. Sending ALWAYS needs Martin's approval of the final text. Debts, amounts, registry decisions, log entries, task status, discard and purge never happen on verder's own. Model suggestion + verdict + edit diff are always recorded (golden rule: self-improvement).
  ```
- [ ] **Step 2: Deploy P3-D2 [main session].**
  1. Record the ledger `max(seq)`, count and head.
  2. Run `env -u NODE_ENV pnpm --filter web build` locally.
  3. Rsync (dry run, read every `deleting` line, then the real run).
  4. **Migrate M-A from the HOST BEFORE the images.** Expected `drizzle.__drizzle_migrations` count **40** afterwards. The blast radius of getting this wrong is far wider than docmeta: drizzle's `select().from(documentStatusChanges)` names every schema column, so with the new images and no migration EVERY reader of that table fails on `column "actor" does not exist` — `effectiveDocument` and every caller of it (`/files`, `/files/[id]`, the queue, `documents.list`, search's document rendering), `resolveDocumentUpdatedHashes` and therefore `/verify` and `nightly-verify`, auto-name, the docmeta sweep — plus `invalid input value for enum suggestion_status` on every docmeta job and a dashboard 500 on the zod enum.
  5. Rebuild web and worker with `DOCMETA_AUTO_APPLY` still unset.
  6. **Predicted ledger delta from this step: none.** Tolerated background only (from now on, an auto-name `document.updated` carries `actor = 'verder'`, which the grouping query shows). `nightly-verify` OK on the full pre-existing chain. This run is the proof spec §12.4 asks for.
- [ ] **Step 3: Switch on [main session], only if Task 13 decided yes.**
  1. Back up `.env.prod` as `.env.prod.bak.2026-MM-DD-autofile`.
  2. Add `DOCMETA_AUTO_APPLY=on`.
  3. Run `up -d worker`.
  4. **Predicted ledger delta from then on:** per new document, `+1 document.ingested`, `+0–1 document.updated` (auto-name, `actor = 'verder'`) and `+0–1 document.updated` (auto-file, `actor = 'verder'`); per undo, `+1 document.updated` with `actor` NULL. Any other type is a stop. After the first auto-file: `nightly-verify` OK, and the document shows under "Door verder gedaan" on web and phone. With Martin's OK, he taps undo once on that one to prove it: predicted `+1 document.updated`, actor NULL, and the document back in the inbox.
- [ ] **Step 4:** Commit: `docs: amend the suggestion-only law for filing; record deploy P3-D2`.

---

## Slice 8 — the extras

### Task 17: Amsterdam weeks and "leefgeld over deze week" (pure)

**Settled 2026-10-31, no gate:** Martin answered spec §13 with "€ 100 per week" and wants the figure built. (His "leave it for now" in the same message referred to moving the APNs key file into his password manager, not to the leefgeld.) Build Tasks 17–19 as written, with `LEEFGELD_WEEKLY_CENTS=10000` in P3-D3. Spec §13 keeps its ONE answer text; this task only checks that text against what was built.

**Files:**
- Create: `packages/api/src/leefgeld-week.ts`, `packages/api/src/leefgeld-week.test.ts`
- Modify: `packages/api/src/amsterdam.ts` (week helpers), `packages/api/src/amsterdam.test.ts`, `packages/api/src/money-series.ts:89-124` (extract `coveredRanges`), `docs/superpowers/specs/2026-10-28-iphone-app-design.md` (§7.6 and §13)

**What counts, precisely:**
- **The week** is seven Amsterdam civil days: `weekBounds(dayKey, startsOn: 1..7 = 1) → { from: "YYYY-MM-DD", to }`, computed on the day-key strings and never on instants (the `nextDay` discipline at `money-series.ts:60-63`). `isoWeekKey(dayKey) → "2026-W44"` is always ISO (Monday) and is what Task 26 uses.
  - **The leefgeld week starts on the PAYOUT weekday, not on Monday**, when the statements show one: "over deze week" means "since VerderGroep last paid", and a Monday week would read nearly full on a Friday payout and empty the day after. Step 0 measures it, and `LEEFGELD_WEEK_START` (ISO weekday, default `1`) carries the answer. Until measured, Monday.
- **The account** is the leefgeldrekening. No table names accounts (`routers/money.ts` `accountLabels` maps IBAN → IBAN), so it is chosen in this order, and the reason is always shown:
  1. `LEEFGELD_IBAN` when set → `accountReason: "configured"`;
  2. otherwise the single account WITH A KNOWN IBAN whose `incomeLines` contain a `cadence: "weekly"` line → `accountReason: "weekly-income"`. `detectRecurring` emits `weekly` only for credits, and its comment names VerderGroep's weekly leefgeld. The NULL-IBAN "unknown account" series is never a candidate: it may mix accounts, and `accountIban` is typed `string`;
  3. zero or several such accounts → no figure (`state: "no-account"`).
- **The budget** is `LEEFGELD_WEEKLY_CENTS` (Martin's answer, 2026-10-31: `10000`). Unset → `state: "no-budget"`, and no figure.
- **Spent** is the sum of `|amountCents|` over that account's rows with `!parseError && amountCents < 0` and `dayKey(bookedAt)` within `[from, coveredThrough]`. Every debit counts, as on /money's costs bar (`splitInternalTransfers` marks only credits internal). The rows are returned, and the total is summed from that list.
- **Deposits** are the credits in the same window, returned as rows and summed. They are shown beside the figure, so a week where VerderGroep paid something other than € 100 is visible rather than hidden behind the budget.
- **Coverage** comes from `coveredRanges(accountTxs)`, the merged Amsterdam-day statement ranges `coverageForMonths` already computes, extracted unchanged and used by both:
  - no merged range contains Monday → `state: "geen-data"`, no figure;
  - a range contains Monday and reaches `min(to, today)` → `state: "complete"`;
  - a range contains Monday but ends earlier → `state: "partial"` with `coveredThrough`, rendered hatched as "t/m <dag>".
  - A statement whose first booking falls after Monday leaves the week `geen-data`, even with rows in it. That is the safe direction, the same as months.
- **Left** = `budgetCents − spentCents`, only for `complete` and `partial`. It may be negative and is then shown as "€ X meer uitgegeven dan het weekbedrag". It is never amber: amber is for what waits on Martin.

**Interfaces:**
- `export function leefgeldWeek(input: { txs: MoneyTx[]; series: AccountSeries[]; weeklyCents: number | null; configuredIban: string | null; today: string }): LeefgeldWeek`, where:

  ```ts
  type LeefgeldWeek =
    | { state: "no-budget" }
    | { state: "no-account"; candidates: string[] }
    | { state: "geen-data"; accountIban: string; accountReason: "configured" | "weekly-income"; week: { from: string; to: string }; newestBooking: string | null }
    | { state: "complete" | "partial"; accountIban: string; accountReason: "configured" | "weekly-income"; week: { from: string; to: string }; coveredThrough: string; budgetCents: number; spentCents: number; leftCents: number; spentRows: DisclosedRow[]; depositCents: number; depositRows: DisclosedRow[] };
  ```

- [ ] **Step 0: Measure the payout weekday [main session, homelab, read-only].** `select account_iban, extract(isodow from booked_at at time zone 'Europe/Amsterdam') as dow, count(*), min(amount_cents), max(amount_cents) from transactions where amount_cents > 0 group by 1, 2 order by 1, 2`. Record the result. If one account shows a clear weekly credit on one weekday, that weekday is `LEEFGELD_WEEK_START`; if the table is empty or shows no weekly pattern, keep Monday and record why. Never guess a weekday.
- [ ] **Step 1: Failing tests:**
  - `amsterdam.test.ts`:
    - `week of a Sunday is the Monday before`;
    - `week starting Thursday contains the Wednesday after`;
    - `week across the DST change has seven days` (2026-10-25);
    - `isoWeekKey at year end` (2026-12-31 → `2026-W53`).
  - `leefgeld-week.test.ts`:
    - `uncovered week shows no figure`;
    - `statement starting Wednesday leaves the week geen-data`;
    - `partial week sums only covered days`;
    - `spent sums from its own row list`;
    - `two weekly-income accounts give no-account`;
    - `the null-IBAN series is never chosen`;
    - `configured IBAN wins and is disclosed`;
    - `unset budget gives no-budget`;
    - `overspend gives negative left`;
    - `parse-error rows never count`;
    - `accounts are never merged` (a debit on the beheerrekening does not touch the leefgeld figure).
- [ ] **Step 2:** Run `env -u NODE_ENV pnpm --filter @verder/api test -- amsterdam leefgeld money-series`. Expected: the new tests FAIL, and `money-series.real.test.ts` PASSES before and after the `coveredRanges` extraction. If it fails, the extraction is wrong, never the test.
- [ ] **Step 3:** Implement. Then update the spec (§13 already records the answer, added 2026-10-31 with this plan):
  - §7.6: replace "No 'leefgeld left this week' number until Martin supplies the weekly leefgeld amount" with a pointer to `leefgeld-week.ts` and its rules.
  - §13: already updated (2026-10-31); check that its wording still matches what was built.
- [ ] **Step 4:** Commit: `feat(api): leefgeld over deze week, from covered days only`.

### Task 18: `GET /api/mobile/v1/money/summary`

**Files:**
- Create: `apps/web/src/app/api/mobile/v1/money/summary/route.ts` (+ test)
- Modify: `packages/api/src/routers/money.ts` (add `glance`), `packages/api/src/routers/money.test.ts`, `.env.example` (`LEEFGELD_WEEKLY_CENTS=`, `LEEFGELD_IBAN=`, `LEEFGELD_WEEK_START=`), `docs/deploy.md` (all three)

**Interfaces:**
- Response: `{ accounts: { accountIban: string | null; months: MonthSeries[] /* last 6, the series' own objects */ }[]; leefgeld: LeefgeldWeek; previousWeek: LeefgeldWeek; newestBooking: string | null }`.
- `money.series` returns only `{ series, accountLabels }`, and `leefgeldWeek` needs the raw `txs`. So a new `money.glance` query reads the transactions and items ONCE (the same reads `series` does at `routers/money.ts:64-67`, extracted into one private `loadMoneyInputs(db)` both call), builds the series from them, and returns `{ series, txs, newestBooking }`. The route calls `money.glance`, then `leefgeldWeek` for today and for the day seven days before, both on that one read. The month cut reuses `dashboardMoneySlice` (`apps/web/src/lib/dashboard-money-slice.ts:45`) per account. The disclosure rows (`incidentalRows`, `internalRows`) travel with each month.
- `newestBooking` is always present. Transactions arrive only from hand-imported ABN statements (`routers/registry-import.ts`), so "deze week" is only as fresh as the last import, and the screen says so.

- [ ] **Step 1: Failing tests:** `money.glance series equals money.series` (router, dev DB); `401 first`; `accounts are listed separately`; `missing env gives no-budget`; `months keep their disclosure rows`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Run `env -u NODE_ENV pnpm --filter web build`. Commit: `feat(web): mobile money summary with the leefgeld week`.
- [ ] **Step 3: [main session]** Count prod data before relying on it: `select account_iban, count(*), max(booked_at) from transactions group by 1`. Record the result beside Task 17 Step 0's weekday measurement. If the count is 0, the glance ships showing `geen data` and that is correct.

### Task 19: Money glance on the phone

**Files:**
- Create: `apps/ios/Verder/Money/MoneyGlanceView.swift`, `apps/ios/Verder/Money/MoneyFormat.swift`, `apps/ios/VerderTests/MoneyFormatTests.swift`, `apps/ios/VerderTests/LeefgeldCardTests.swift`
- Modify: `apps/ios/Verder/App/MoreTab.swift` (the entry "Geld")

**Interfaces:**
- `enum MoneyFormat { static func euro(cents: Int) -> String }` gives `"€ 1.234,56"`, using integer arithmetic on cents and never `Double`.
- Leefgeld card states:
  - `complete`: "Leefgeld over deze week: € 37,60" plus "uitgegeven € 62,40 · ontvangen € 100,00";
  - `partial`: the same, hatched, with "t/m do 29 okt" (29 October 2026 is a Thursday; the test builds the weekday from the date rather than hard-coding the string);
  - `geen-data`: "geen data — laatste afschrift t/m <newestBooking>";
  - `no-account`: "Leefgeldrekening niet herkend";
  - `no-budget`: the card is hidden.
- Account cards, one per IBAN and never summed: a 6-month bar list with `complete` solid, `partial` hatched and `none` "geen data". Each month's incidental and internal rows sit under the bars.

- [ ] **Step 1: Failing tests:** `euroFormatsDutch`; `partialWeekdayMatchesTheDate` (2026-10-29 renders `do`); `negativeLeftReadsOverspent`; `geenDataShowsNoAmount` (the rendered text contains no "€"); `noBudgetHidesCard`; `cardsAreNeverSummed` (the view model exposes no total across accounts).
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Commit: `feat(ios): money glance per account, with the leefgeld week`.

### Task 20: Pocket dossier sync (server)

**Files:**
- Create: `packages/api/src/routers/dossier-sync.ts`, `packages/api/src/routers/dossier-sync.test.ts`, and route/test pairs:
  - `apps/web/src/app/api/mobile/v1/documents/sync/route.ts`
  - `apps/web/src/app/api/mobile/v1/documents/[id]/file/route.ts`
  - `apps/web/src/app/api/mobile/v1/documents/texts/route.ts`
- Modify: `packages/api/src/root.ts`

**Interfaces:**
- `dossierSync.delta({ cursor: number /* ≥0 */, limit: number /* ≤50 */ })` returns `{ cursor: number; more: boolean; upserts: DossierDoc[]; tombstones: { id: string; reason: "discarded" | "purged" }[] }`.
  - Query: `SELECT entity_id, max(seq) AS seq FROM ledger_events WHERE entity_type = 'document' AND seq > $cursor GROUP BY entity_id ORDER BY seq LIMIT $limit`.
  - Each id is resolved to its CURRENT effective state through `effectiveDocument`.
  - Purged means a `document_purges` ROW exists: the one display-surface definition Task 1 fixed, the same one `/files` and `effectiveDocument(...).purge` use. The event-based definition stays `/verify`'s. Every real purge also appends `document.purged`, which is what moves the document's `seq` past the phone's cursor.
  - The new cursor is the largest `seq` on the page, so a page never skips a document whose event committed late: `appendLedgerEvent` holds advisory lock 42 until commit, so seq order is commit order.
- `DossierDoc = { id; title; docType; status: "inbox" | "filed"; receivedAt; mime; sizeBytes; sha256; hasText: boolean }`. Both `inbox` and `filed` are cached; Step 3 measures whether filed-only would be enough.
- `GET /documents/:id/file`: auth, `effectiveDocument`, 410 `{error:"purged"}` for a purged document and 404 for a discarded one, then the bytes with `safeMime`, the effective-title `Content-Disposition` and `nosniff`, as `apps/web/src/app/api/files/[sha256]/route.ts` does. It sits under `/api/mobile/` so a missing cookie gets JSON 401 and not a 307.
- `GET /documents/texts?ids=a,b` (at most 20) returns `{ id, text, truncated }[]`. Extraction happens after ingest and appends no ledger event, so a document synced before its text existed asks again for it here; the phone keeps a set of ids still lacking text.

- [ ] **Step 1: Failing tests** (dev DB):
  - `new document arrives as an upsert`;
  - `purged id comes back as a tombstone`;
  - `discarded id comes back as a tombstone`;
  - `undone discard comes back as an upsert`;
  - `purged id resolves through the same predicate as /files` (one definition, Task 1);
  - `cursor never skips`: two documents, page size 1, and both arrive in order;
  - `each id appears once per page with its newest seq`;
  - route tests `file 410 for purged`, `401 first` on all three.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Run `env -u NODE_ENV pnpm --filter web build`. Commit: `feat: pocket dossier delta sync on the ledger seq`.
- [ ] **Step 3: [main session]** Measure in prod: `select <effective status>, count(*) from documents group by 1`, using `effectiveDocStatusSql` and `notPurgedSql`. Record the counts and the total bytes of non-discarded, non-purged documents. If `filed` alone is under half of them, keep `inbox` too, which is the default above, and record why.

### Task 21: Pocket dossier on the phone

**Files:**
- Create:
  - `apps/ios/Verder/Dossier/DossierStore.swift`
  - `apps/ios/Verder/Dossier/DossierSearch.swift`
  - `apps/ios/Verder/Dossier/DossierTab.swift`
  - `apps/ios/Verder/Dossier/DocumentViewer.swift`
  - `apps/ios/VerderTests/DossierStoreTests.swift`
  - `apps/ios/VerderTests/DossierSearchTests.swift`
- Modify: `apps/ios/Verder/App/RootView.swift` (replace the `dossier` `ComingSoon`; it stays lock-gated)

**Interfaces:**
- `actor DossierStore { init(dir: URL /* Application Support/dossier, NOT the App Group */); func sync(client: APIClient) async throws; func documents() -> [DossierDoc]; func fileURL(_ id: String) -> URL? }`.
  - Tombstones are applied first: the file, its text and its index entry are deleted.
  - Then upserts: the bytes download only when `sha256` changed.
  - The cursor is saved only after the page is applied.
  - Every file is written with `.completeFileProtection`.
  - Sync runs only in the foreground after unlock. A silent push never syncs the dossier, because `.complete` files cannot be written while the phone is locked.
- `enum DossierSearch { static func search(_ q: String, in: [IndexedDoc]) -> [IndexedDoc] }`: case- and diacritic-insensitive matching over title plus text, entirely in memory. When online, the Dossier tab also offers "Zoek op de server", which calls the existing `search.query` in `mode: fast` through a new `GET /api/mobile/v1/search?q=` (same `mobileGet` pattern, with hits mapped to app routes instead of the web `href`).
- `DossierTab` shows: the headline from `/dashboard/summary` ("waar het nu op wacht"), open tasks, then documents. The read-only vertical case map is a stretch goal and deferred unless time remains.

- [ ] **Step 1: Failing tests:**
  - `tombstoneDeletesFileAndText`;
  - `cursorSavedOnlyAfterApply` (a throwing download leaves the cursor unchanged);
  - `filesAreCompleteProtection`;
  - `unchangedShaDoesNotRedownload`;
  - `searchFindsTextIgnoringDiacritics` (`"beschikking"` finds `"Beschíkking"`).
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Commit: `feat(ios): pocket dossier with tombstones and on-device search`.
- [ ] **Step 3: [main session]** On the phone:
  1. Run a full sync. Record the time and the bytes.
  2. Time a search over the real corpus. If it is above 100 ms, record it and move to SQLite FTS5 (`sqlite3` is in the SDK, so no dependency).
  3. A purge is irreversible and blocks those exact bytes from the vault forever (`documents.sha256` is UNIQUE), so it is never done to a real document. With Martin's OK, upload a THROWAWAY: a one-page PDF generated for this test whose text holds the date and a fresh `uuidgen`, so its sha256 can never collide with a real letter. Predict and check each step against the tolerated background: the upload **+1 `document.ingested`** (+0–1 auto-name `document.updated`, `actor = 'verder'`); let the phone sync it; then purge it on the web, **+1 `document.purged`**. Reopen the app. Expected: it is gone from the phone, and `nightly-verify` reports it among the purged with 0 left on disk.

### Task 22: Share extension

**Files:**
- Create:
  - `apps/ios/VerderShare/ShareViewController.swift`
  - `apps/ios/VerderShare/Info.plist` keys via `project.yml`
  - `apps/ios/Verder/Upload/IncomingDrop.swift` (compiled into the app and the extension)
  - `apps/ios/VerderTests/IncomingDropTests.swift`
- Modify:
  - `apps/ios/project.yml`: target `VerderShare` (`app-extension`, bundle `pro.vanderpoel.verder.share`); App Group and `keychain-access-groups` entitlements; `VerderKeychainAccessGroup` in ITS OWN Info.plist, because `KeychainSessionStore` reads `Bundle.main`, which is the extension; `NSExtensionActivationRule` for PDFs, images and file URLs, at most 10.
  - `apps/ios/Verder/Upload/UploadQueue.swift`: see "The queue learns other file types" below.
  - `apps/ios/Verder/Upload/BackgroundUploader.swift:25` (`UploadRequest.build` sends `item.resolvedMime`, never the hard-coded `"application/pdf"`, and reads the bytes from `fileURL(item)`).
  - `apps/ios/Verder/Upload/UploadCenter.swift` (import incoming on launch and foreground).

**The queue learns other file types, without losing the queue it has.** Today `UploadItem` has no mime, every file is stored as `<id>.pdf`, and the uploader hard-codes `mime: "application/pdf"`, so a shared `.xlsx` or `.docx` would be labelled a PDF. And `UploadQueue.init` decodes with `try? … ?? Index()`: a non-optional field added to a `Codable` struct makes the existing `queue.json` fail to decode, which SILENTLY EMPTIES the queue and loses every pending scan. So:
- `UploadItem` gains `mime: String?` and `fileExtension: String?`, both OPTIONAL. Synthesized `Decodable` treats a missing optional key as nil, so an old `queue.json` still decodes. `resolvedMime` is `mime ?? "application/pdf"` and `resolvedExtension` is `fileExtension ?? "pdf"`. `fileName` already exists and carries the shared file's real name for a share.
- `fileURL(_ item:)` is `<id>.<resolvedExtension>`; `pdfURL(_:)` stays as `fileURL` for an item without an extension, and `claimDue`'s existence check and the uploader both use `fileURL`.
- `enqueue(file: Data, id: UUID = UUID(), fileName: String, mime: String, fileExtension: String, capturedAt: Date, source: String)`. The `id` parameter is what lets the drop's UUID become the `clientId`. If an item with that `id` is already queued, `enqueue` returns it and writes nothing (that is what makes `importIncoming` idempotent). `enqueue(pdf:capturedAt:source:)` stays as a wrapper, so `ScanTab` does not change.

**Interfaces:**
- The extension never touches `queue.json`, because `UploadQueue` loads it once and the last writer would win.
- `IncomingDrop.write(file:fileName:mime:capturedAt:to groupDir:) throws -> UUID` writes `<group>/uploads/incoming/<uuid>.bin` and then `<uuid>.json`. The JSON is written last, so the app never reads half a drop.
- Images become one PDF through `PDFAssembler.makePDF`. PDFs and other files pass through unchanged. The server accepts any mime (`documents/route.ts` stores `file.type`).
- After writing, the extension tries one foreground upload of that item with the shared session (source `phone-share`, `clientId` = the drop's UUID) and writes `<uuid>.sent` on a 2xx.
- The app's `importIncoming()` enqueues every drop with `enqueue(file:id: dropUUID, …)`, so the drop's UUID is the `clientId`. If the extension already sent it, the server answers `duplicate: true` through the existing `phone:<clientId>` idempotency. So the double path cannot create a second document.
- **Cleanup of `incoming/`.** After `enqueue` has persisted the item, `importIncoming` deletes `<uuid>.json` FIRST (the drop is then invisible), then `<uuid>.bin` and `<uuid>.sent`. A crash between the two leaves a `.bin` with no `.json`, which is never imported; `importIncoming` deletes such orphans once they are older than 24 h, so a drop the extension is still writing is never touched.
- **The spec's optional one-line note (§7.8) is DEFERRED, and recorded as such in spec §7.8.** `POST /api/mobile/v1/documents` has no note field and `documents` has no note column; a note would need a place to live that does not yet exist (a `document_status_changes` row is the wrong shape, a log entry is evidence). It comes back when one is designed.

- [ ] **Step 1: Failing tests:**
  - `dropIsInvisibleUntilJsonWritten`;
  - `importIncomingKeepsTheDropUUIDAsClientId`;
  - `importIsIdempotent` (import twice gives one queue item);
  - `importDeletesTheDropAfterEnqueue` and `orphanBinIsSweptOnlyAfter24h`;
  - `imagesBecomeOnePDF`;
  - `oldQueueJsonStillDecodes` (a `queue.json` fixture captured from the current build, with no `mime`/`fileExtension`, decodes with every item intact and resolves to PDF);
  - `sharedXlsxIsUploadedWithItsOwnMime` (the multipart part carries the item's mime and file name, not `application/pdf`).
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Commit: `feat(ios): share extension into the same upload queue`.
- [ ] **Step 3: [main session]** On the phone:
  1. Share a PDF from Mail and two photos from Photos.
  2. Expected: two documents in `/files` under bron "Gedeeld", and no duplicate after the app opens.
  3. **Predicted ledger delta from this step: +2 `document.ingested`**, plus up to one auto-name `document.updated` each and, if auto-file is on, up to one auto-file `document.updated` each (all `actor = 'verder'`). Anything else is a stop.
  4. Record whether the extension's own upload finished before dismissal on 4G for a 5 MB file.

### Task 23: Widget

**Files:**
- Create: `apps/ios/VerderWidget/VerderWidget.swift`, `apps/ios/VerderWidget/WidgetViews.swift`, `apps/ios/VerderTests/WidgetEntryTests.swift`
- Modify: `apps/ios/project.yml` (target `VerderWidget`, bundle `pro.vanderpoel.verder.widget`, App Group entitlement, sources include `Verder/Shared/WidgetSnapshot.swift` and `Verder/Theme/Tokens.swift`), `apps/ios/Verder/Inbox/InboxStore.swift` (call `WidgetCenter.shared.reloadAllTimelines()` after writing the snapshot)

**Interfaces:**
- `struct VerderEntry: TimelineEntry { let date: Date; let snapshot: WidgetSnapshot? }`. The provider reads `WidgetSnapshot.read(from:)` with a `.after(now + 30 min)` policy. It never calls the network; the silent push and the app refresh the snapshot.
- Families:
  - `systemSmall`: the count plus "wacht op jou".
  - `systemMedium`: the count, the top item's title and the map headline.
  - **The titles are `.privacySensitive()`.** Home-screen widgets also render in StandBy and other always-on surfaces while the phone is LOCKED, where the app lock does not apply. The widget's view model marks the top title and the headline `sensitive: true`, and the view applies `.privacySensitive()` to every sensitive line, so iOS redacts them whenever the device is locked. The count and "wacht op jou" are not sensitive.
  - `accessoryCircular` and `accessoryRectangular` (lock screen): the count and "wacht op jou" only. The lock screen is visible to anyone holding the phone, and the app lock does not apply to widgets.
- Amber only when `count > 0`. A tap deep-links `verder://inbox`.
- No snapshot, or one older than 24 h: "Open verder om bij te werken", in ink and never amber.

- [ ] **Step 1: Failing tests:** `lockScreenEntryHasNoTitles`; `mediumTitlesAreMarkedPrivacySensitive` (the model marks the top title and the headline sensitive, and the count not); `redactedMediumShowsNoTitleText` (render the medium view with `.redacted(reason: .privacy)` through `ImageRenderer`'s accessibility text or a snapshot of the view's text content, and assert neither title appears); `zeroCountIsNotAmber`; `staleSnapshotSaysOpenApp`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Commit: `feat(ios): home and lock screen widget from the App Group snapshot`.
- [ ] **Step 3: [main session]** Martin adds the widget. With the phone locked and in StandBy, check that the medium widget's titles are redacted. Then, on a suggestion Martin WANTS to decide (with his OK, never one approved for the test), predict its delta as in Task 9 Step 2, record the `max(seq)`, and decide it on the web with the phone locked. Expected: the widget count drops after the next `badge.sync` background push, or at the next 30-minute timeline reload when iOS withholds the background push. Record which happened, the delay, and whether the app had been force-quit.

### Task 24: Voice quick-log (server) and migration M-B

**Files:**
- Create:
  - `packages/db/drizzle/0040_doc_source_phone_voice.sql` (number from Task 0)
  - `packages/db/src/doc-source-voice.test.ts`
  - `packages/api/src/voice-summary.ts`
  - `packages/api/src/voice-summary.test.ts`
  - `apps/web/src/app/api/mobile/v1/entries/voice/route.ts` (+ test)
  - `apps/web/src/app/api/mobile/v1/parties/route.ts` (+ test)
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/doc-sources.ts` (`DOC_SOURCES` gains `"phone-voice"`), the four Dutch label maps that spell every doc source today — `apps/web/src/components/files-tree.tsx:9` ("Spraak"), `apps/web/src/components/bundle-form.tsx:30` ("spraak"), `packages/api/src/bundle-rule.ts:36` ("spraak") and `apps/web/src/lib/entry-labels.ts:57` ("spraak") — found with `grep -rn '"phone-share"' apps/web/src packages/api/src` so none is missed, `packages/api/src/routers/suggestions.ts` (add `createVoice`), `apps/worker/src/index.ts:268-282` (`suggest.docmeta` stores extractor `none` and skips `suggestDocMeta` for `audio/*`, so a kept recording does not raise a docmeta suggestion in Voor jou)

**Interfaces:**
- Migration, two statements separated by `--> statement-breakpoint`:

  ```sql
  ALTER TYPE "public"."doc_source" ADD VALUE 'phone-voice';
  --> statement-breakpoint
  CREATE UNIQUE INDEX "suggestions_voice_client_uq" ON "suggestions" ((proposed->>'clientId')) WHERE kind = 'log-entry' AND prompt_version = 'voice-v1';
  ```

  The index is what makes `createVoice` idempotent under two CONCURRENT retries; a select-then-insert would let both insert. Ordering trap as 0036: migrate from the HOST before the images, or a kept recording fails on `invalid input value for enum doc_source`. Expected `drizzle.__drizzle_migrations` count **41** afterwards.
- `voiceSummary(transcript: string): string` returns the first sentence, cut at 120 characters on a word boundary.
- `suggestions.createVoice({ clientId, occurredAt, partyId, channel = "call", transcript, audioDocumentId? })` inserts a suggestion:
  - `kind: "log-entry"`, `status: "pending"`, `model: "apple-speech-on-device"`, `promptVersion: "voice-v1"`;
  - `proposed: { clientId, occurredAt, channel, direction: "inbound", summary: voiceSummary(transcript), details: transcript, participantPartyIds: [partyId], participantNames: [party.name], attachmentDocumentIds: audioDocumentId ? [audioDocumentId] : [], actionItems: [] }`.
  - It is idempotent on `proposed->>'clientId'`: `INSERT … ON CONFLICT ((proposed->>'clientId')) WHERE kind = 'log-entry' AND prompt_version = 'voice-v1' DO NOTHING`, then select the existing row, backed by `suggestions_voice_client_uq`.
  - Its approval goes through `entryFromProposed` (Task 4), which gives it `source: "manual"`, never `"gmail-watch"`.
  - **It never inserts a log entry.** Martin approves it in Voor jou through the existing `approveEntry`.
- `POST /api/mobile/v1/entries/voice` (multipart): fields `clientId`, `occurredAt`, `partyId`, `channel`, `transcript`, and an optional `audio` file. Audio goes through `readGuardedFile` → `storeFile` → `registerUpload({ source: "phone-voice", sourceRef: "phone:<clientId>" })`.
- `GET /api/mobile/v1/parties?recent=1` lists parties ordered by their newest `log_entries.occurred_at` through `entry_participants`, then by name.

- [ ] **Step 1: Failing tests:**
  - `enum has phone-voice`;
  - `summary cuts at a word under 120`;
  - `voice creates a pending log-entry suggestion and no entry` (without audio; count `log_entries` and `ledger_events` before and after: unchanged);
  - `kept audio appends exactly one document.ingested and no entry`;
  - `same clientId twice gives one suggestion`;
  - `two concurrent createVoice calls with one clientId give one suggestion` (`Promise.all`);
  - `audio is stored as phone-voice`;
  - `401 first`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Run `env -u NODE_ENV pnpm --filter web build`. Commit: `feat: voice quick-log arrives as a log-entry suggestion`.

### Task 25: Voice quick-log (iOS)

**Files:**
- Create: `apps/ios/Verder/Voice/VoiceLogView.swift`, `apps/ios/Verder/Voice/Transcriber.swift`, `apps/ios/VerderTests/VoiceLogModelTests.swift`
- Modify: `apps/ios/project.yml` (`NSMicrophoneUsageDescription` "verder neemt je stem op om een gesprek vast te leggen.", `NSSpeechRecognitionUsageDescription` "verder zet je opname op je telefoon om in tekst."), `apps/ios/Verder/App/MoreTab.swift` (entry "Gesprek vastleggen")

**Interfaces:**
- `protocol Transcribing { func transcribe(_ audio: URL) async throws -> String }`, implemented by `OnDeviceTranscriber` with `SpeechAnalyzer` + `SpeechTranscriber(locale: Locale(identifier: "nl_NL"))`. It installs the locale's assets through `AssetInventory` on first use. No audio leaves the phone unless Martin taps "bewaar opname".
- The flow:
  1. Hold to record.
  2. Transcribe.
  3. Show the transcript, editable.
  4. Party picker, most recent first.
  5. Channel `call` by default.
  6. "Verstuur als voorstel".

  The audio is deleted after the call unless kept.

- [ ] **Step 1: Measure first [main session].** On the phone, check that `SpeechTranscriber.supportedLocales` contains `nl_NL` and that the asset installs. **If Dutch is not supported on iOS 27.2, stop and ask Martin.** Never fall back to server transcription without asking; the spec chose on-device so that no audio leaves the phone.
- [ ] **Step 2: Failing tests:** `transcriptIsEditableBeforeSend`; `audioDeletedUnlessKept`; `sendBuildsMultipartWithoutAudioByDefault`.
- [ ] **Step 3:** Run (FAIL), implement, and run (PASS). Commit: `feat(ios): voice quick-log, transcribed on the phone`.
- [ ] **Step 4: [main session]** Martin logs one real call. Expected: one pending log-entry suggestion in Voor jou and, from this step, **no event** until he approves it (or **+1 `document.ingested`** if he tapped "bewaar opname"); on his approval, **+1 `entry.created`** with `source = 'manual'`. Tolerated background only otherwise.

### Task 26: Weekly summary

**Files:**
- Create:
  - `apps/worker/src/weekly-summary.ts`
  - `apps/worker/src/weekly-summary.test.ts`
  - `apps/web/src/app/api/mobile/v1/weekly/route.ts` (+ test)
  - `apps/ios/Verder/Weekly/WeeklyView.swift`
  - `apps/ios/VerderTests/WeeklyDTOTests.swift`
- Modify: `apps/worker/src/index.ts` (queue `weekly.summary`, `boss.schedule("weekly.summary", "0 18 * * 0", undefined, { tz: "Europe/Amsterdam" })`), `apps/worker/package.json` (script `weekly-summary` for a hand-run `--dry`), `packages/api/src/worker-health.ts` (`"weekly-summary": { kind: "watcher", everyMs: 7 * 24 * 60 * MINUTE }` — `worker-health.ts` defines only `MINUTE`. The watcher rule is cadence×3, so this tolerates TWO missed Sundays and goes amber on the third, 21 days after the last run. That is deliberate and the DECLS comment says so: the summary is a passive convenience, one missed Sunday is a slow week rather than a fault worth amber, and the `monthly` kind's 35 days would be looser still; a hard failure is still `down` for 26 h through the ordinary error rule), `packages/api/src/worker-names.ts` (`WEEKLY_SUMMARY_WORKER_NAME`)

**Interfaces:**
- `composeWeekly(input): WeeklySummary` is pure. `loadWeekly(db, week)` is in the worker, because "received" needs `ownMailboxAddresses()` and `senderAddress` (`apps/worker/src/mail/relevance.ts:117`, `gmail.ts:109`), which live only there. Gmail-era `from_addr` is a whole header, so it is never matched with SQL `lower()`.
- `WeeklySummary = { week: "2026-W44"; from; to; sent: number; received: number; filedByMartin: number; filedByVerder: number; tasksDone: number; waiting: number; topWaiting: WaitingItem[] /* ≤3 */ }`. Its sources:
  - `sent` = outbound `log_entries` in the week, plus Plan 2's proposals with `sent_at` in the week that have no log entry yet;
  - `received` = `raw_emails` in the week whose sender is not Martin's own;
  - `filed` = documents that TRANSITIONED into `filed` during the week: a `document_status_changes` row with `status = 'filed'` whose previous effective status (the row before it, or `documents.status` when it is the first) was not `filed`, counted once per document and split by that row's `actor`. Counting every `status = 'filed'` row would count a rename or retype of an already-filed document again, because every change row restates the status;
  - `tasksDone` = `task_status_changes` to `done`;
  - `waiting` = `loadWaiting().length`.

  Week membership: SQL widened by two days, decided in JS with `weekBounds`, the `money.month` rule.
- The job:
  1. Composes the summary.
  2. Records `weekly-summary` `ok` with `{ summary }` in `detail`. This is the stored copy `/weekly` reads, the same data-in-detail precedent as `rateLimitedUntil`, and no new table.
  3. Calls Plan 2's `notify(deps, { kind: "weekly", level: "passive", title: "Je week", body: "3 verstuurd · 7 binnen · 5 opgeborgen · 2 taken klaar — 4 wachten op jou", link: "verder://inbox", dedupKey: "weekly:<isoWeekKey>" })`. Counts only. The `dedupKey` makes a pg-boss retry a no-op instead of a second push.
- `GET /api/mobile/v1/weekly` returns the newest `weekly-summary` row's `detail.summary`, or 404 before the first Sunday.

- [ ] **Step 1: Failing tests:**
  - `week boundaries are Amsterdam Monday to Sunday`;
  - `own outbound mail is not received`;
  - `a Gmail-era whole From header is parsed, not substring-matched`;
  - `filed splits by actor`;
  - `renaming an already-filed document does not count as filed again`;
  - `a retried job sends one push` (same `dedupKey`);
  - `body holds counts only`;
  - route `401 first`, `404 before any summary`.
- [ ] **Step 2:** Run (FAIL), implement, and run (PASS). Commit: `feat: Sunday summary at 18:00 Amsterdam`.
- [ ] **Step 3: [main session]** Run `pnpm --filter worker weekly-summary --dry` in the container. It sends nothing and prints the summary. Show Martin the exact body text. **The first scheduled Sunday push is his OK'd text.** After the first Sunday, check that `worker_runs` holds a `weekly-summary` row dated Sunday 17:00 UTC (18:00 CET) and that the push arrived. A job is not scheduled until `worker_runs` says it ran.

### Task 27: Deploy P3-D3 and the record [main session]

**Files:**
- Modify: `CLAUDE.md` (the slice 8 entry), `apps/ios/README.md` (the four new targets and their bundle ids)

- [ ] **Step 1:** Record the ledger `max(seq)`, count and head. Run `env -u NODE_ENV pnpm -r test` and `env -u NODE_ENV pnpm --filter web build` locally.
- [ ] **Step 2:** Back up `.env.prod` as `.env.prod.bak.2026-MM-DD-extras`. Add `LEEFGELD_WEEKLY_CENTS=10000` (only if Task 17's gate said build it) and `LEEFGELD_WEEK_START=<Task 17 Step 0's weekday>`. Add `LEEFGELD_IBAN` only if Task 18 Step 3 showed that the weekly-income rule picks no single account and Martin names the IBAN.
- [ ] **Step 3:** Rsync (dry run, read every `deleting` line, then the real run). **Migrate M-B from the HOST before the images**; expected `drizzle.__drizzle_migrations` count **41**. Rebuild web and worker.
- [ ] **Step 4: Predicted ledger delta from the deploy itself: none.** Tolerated background only, checked with the grouping query. `nightly-verify` OK. Then, from use: +1 `document.ingested` per shared file or kept recording (each with up to one auto-name and, if on, one auto-file `document.updated`, `actor = 'verder'`), and +1 `entry.created` per approved voice suggestion. Any other type is a stop.
- [ ] **Step 5:** Install on the phone. Run the spec §9 checks that belong to these slices:
  - a push arrives on the locked phone in a Focus mode, and a time-sensitive one breaks through;
  - an auto-applied filing shows in "Door verder gedaan", and undo works (if switched on);
  - a web purge removes the document from the phone at the next sync;
  - every new scheduled job (`badge.sync`, `autofile.digest`, `weekly.summary`) has a row in `worker_runs` from its schedule.
- [ ] **Step 6:** CLAUDE.md entry in the house style:
  - what shipped;
  - each measured number (badge delay, the extension measurement, the threshold decision and its three-run range, the dossier sync time and size, search time, share upload on 4G, the Dutch speech check);
  - the decisions: Martin's `in-progress` answer, `inbox` documents cached, title, sender and links not auto-applied, auto-name not undoable from the app, the fourth target, the share note deferred, and the leefgeld figure as built (€ 100/week, `LEEFGELD_WEEKLY_CENTS`);
  - the ordering traps of M-A and M-B;
  - the leefgeld rules and the measured payout weekday;
  - one purge definition (the row) for display surfaces, the event for `/verify`.

  Commit: `docs: record the iPhone app slices 6–8`. Report to Martin with times in Europe/Amsterdam.
