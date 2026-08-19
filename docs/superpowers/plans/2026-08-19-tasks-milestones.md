# Tasks + Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build sub-project 3 — task management with ledgered status history (parties as assignees, live registry blockers, AI-mined action items through the queue) and the WSNP milestone timeline on the dashboard — then deploy to the homelab.

**Architecture:** Extends the shipped verder monorepo. Editable fact tables (`tasks`, `milestones`) + insert-only ledgered `task_status_changes`, cloning the hardened registry-decision discipline (seq-ordered latest status, per-row `FOR UPDATE`, byte-recomputable ledger payloads). Task mining piggybacks on the Gmail suggest.entry flow; suggestions-only AI throughout.

**Tech Stack:** existing stack (Next.js 15, tRPC v11, Drizzle, Postgres 17, pg-boss, Ollama via `LlmPort`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-tasks-milestones-design.md` — read in full before any task. Also read `CLAUDE.md` and skim the two prior plans' Global Constraints (all still apply).

## Global Constraints

- All sub-project 1+2 constraints apply: append-only evidence, same-transaction ledger appends, canonical JSON hashing via `@verder/core`, suggestion-only AI, idempotent ingestion, no new truncation, tests assert only on rows they created, `env -u NODE_ENV` for every build/test.
- `task_status_changes` is an EVIDENCE table: INSERT+SELECT only for `verder_app`/`verder_worker`. `tasks`, `milestones` get SELECT+INSERT+UPDATE, no DELETE.
- Ledger event type `"task.status"`, entityType `"task_status_change"`.
- Sub-project 2 lessons are BINDING (they were confirmed bugs there): "latest" rows order by ledger seq, never `createdAt`; status-mutating services take `SELECT … FOR UPDATE` on the parent row before reading effective status; transition tables use `Object.hasOwn` (prototype-safe); suggestion dedup keys are namespaced; approve procedures are single-shot (`FOR UPDATE` + open-status guard), validate every referenced id exists (fail loudly, roll back), and compute the edit-diff over ALL fields present in the proposed payload.
- Existing patterns are law — study before writing: `packages/api/src/registry-decide.ts` + `registry-status.ts` (the exact discipline to clone), `verification.ts` (`registryDecisionPayloadHash`), `routers/registry.ts` (list/get/decide/validNext/stats shapes, `decisionTimeline`), `routers/suggestions.ts` (`approveRegistryItem` — the hardened approve pattern, `unchangedFromProposal`), `apps/worker/src/registry-mine.ts` (namespaced keys, error isolation, `recordRun`), `apps/web/src/components/registry-list.tsx` + `decision-form.tsx` + `suggestion-card.tsx`.
- Tone: task/milestone UI copy toward Martin supportive and judgement-free.

## File Structure

```
packages/db/src/schema.ts                  # + wsnpStageEnum, tasks, taskStatusChanges, milestones; suggestion_kind + 'task'
packages/db/drizzle/0010_*, 0011_*         # generated + grants migrations (follow existing numbering)
packages/api/src/task-status.ts            # isValidTaskTransition (pure)
packages/api/src/task-decide.ts            # setTaskStatus + effectiveTaskStatus
packages/api/src/verification.ts           # + taskStatusPayloadHash + task.status recompute dispatch
packages/api/src/wsnp-timeline.ts          # deriveTimeline (pure)
packages/api/src/routers/tasks.ts          # tasks router (+ exported taskFields)
packages/api/src/routers/milestones.ts     # milestones router
packages/api/src/routers/registry.ts       # + blockingTasks in items.get
packages/api/src/routers/suggestions.ts    # + approveTask
apps/worker/src/task-mine.ts               # suggestTask (action-item mining)
apps/worker/src/prompts.ts                 # + TASK_PROMPT_VERSION, buildTaskPrompt
apps/worker/src/index.ts                   # suggest.entry job also calls suggestTask
apps/worker/src/eval/samples-task.json     # + eval/run-task-eval.ts (script task-eval)
apps/web/src/app/(app)/tasks/page.tsx, new/page.tsx, [id]/page.tsx
apps/web/src/app/(app)/milestones/page.tsx
apps/web/src/app/(app)/dashboard/page.tsx  # + tasks tile + timeline strip
apps/web/src/app/(app)/registry/[id]/page.tsx  # + live blocker banner
apps/web/src/components/task-list.tsx, task-form.tsx, task-status-form.tsx,
  milestone-editor.tsx, wsnp-timeline.tsx, suggestion-card.tsx (+ task branch)
```

## Parallel execution graph (for the ultracode orchestrator)

Run tasks in waves; tasks inside a wave are independent (disjoint files, dependencies satisfied by earlier waves) and run as **parallel implementers in isolated git worktrees**, each with its own review chain before merging:

- **Wave 1:** Task 1 (schema) — solo; everything depends on it. Runs on main directly.
- **Wave 2 (parallel ×3):** Task 2 (status service + verifier), Task 4 (timeline + milestones router), Task 5 (task mining). File overlap: none (Task 4 registers its router in `root.ts`; Tasks 2/5 don't touch it).
- **Wave 3 (parallel ×2):** Task 3 (tasks router; needs 2), Task 10 (eval; needs 5). Task 3 edits `root.ts` — merge after Wave 2.
- **Wave 4 (parallel ×4):** Task 6 (approveTask + queue card; needs 3), Task 7 (task screens; needs 3), Task 8 (milestones screen + dashboard; needs 3+4), Task 9 (registry blockers; needs 3). File overlap: none (nav link added only by Task 7; dashboard only Task 8; registry files only Task 9; suggestions files only Task 6).
- **Wave 5:** Task 11 (deploy) — solo, after everything is merged and the full suite is green on main.

Worktree rules: implementer + its reviewers + fixer all operate in that task's worktree branch (`sp3/task-N`); the orchestrator merges to main in task-number order at wave end (expected conflicts: none; `root.ts`/`layout.tsx` touched by one task each per wave), then runs the FULL cross-package suite on main before starting the next wave. All worktrees share the one dev Postgres — migrations run once in Wave 1; tests must tolerate concurrent suites (they already do: own-rows-only assertions, `fileParallelism: false` per package).

Tasks 1–3: data + decisions + API. Tasks 4, 8: milestones. Tasks 5, 10: mining + eval. Tasks 6, 7, 9: queue + screens. Task 11: deploy.

---

### Task 1: Schema + grants + suggestion kind

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: generated migration + grants migration (follow existing numbering in `packages/db/drizzle/`, currently at 0009)
- Test: `packages/db/src/task-schema.test.ts`

**Interfaces (produces — later tasks rely on these exact names):**
```ts
export const wsnpStageEnum = pgEnum("wsnp_stage", ["application","accepted","onboarding","wsnp-start","settlement","clean-slate"]);
tasks: { id uuid pk defaultRandom, title text notnull, details text?, assigneePartyId uuid→parties?, dueAt timestamptz?, entryId uuid→entries?, financialItemId uuid→financialItems?, debtId uuid→debts?, documentId uuid→documents?, createdBy uuid→users notnull, createdAt timestamptz defaultNow notnull }
taskStatusChanges: { id, taskId uuid→tasks notnull, status text notnull, note text?, overrideReason text?, createdBy uuid→users notnull, createdAt }
milestones: { id, stage wsnpStageEnum notnull, title text notnull, happenedAt timestamptz?, expectedAt timestamptz?, done boolean notnull default false, note text?, entryId uuid→entries?, documentId uuid→documents?, createdAt }
// suggestion_kind: ALTER TYPE suggestion_kind ADD VALUE 'task' (same migration mechanics as 'registry-item' in 0009 — read how that landed first)
```
- Grants (both `verder_app` and `verder_worker`): `GRANT SELECT, INSERT ON task_status_changes`; `GRANT SELECT, INSERT, UPDATE ON tasks, milestones`; no DELETE anywhere.

- [ ] **Step 1:** Failing integration test `task-schema.test.ts` (mirror `registry-schema.test.ts`, APP role URL, `pool.end()` in afterAll): inserts a task, a status change, a milestone; asserts `db.update(taskStatusChanges)` and `db.delete(tasks)` reject with permission denied; asserts a suggestion with `kind: "task"` inserts.
- [ ] **Step 2:** Run → FAIL. Add schema, `pnpm --filter @verder/db generate`, grants migration, `migrate` against dev Postgres.
- [ ] **Step 3:** Run → PASS (also run @verder/api suite as schema-consumer safety check). Commit `feat(db): tasks, task status ledger, milestones schema and grants`.

### Task 2: Task status service + verifier extension

**Files:**
- Create: `packages/api/src/task-status.ts`, `packages/api/src/task-decide.ts`
- Modify: `packages/api/src/verification.ts`
- Test: `packages/api/src/task-status.test.ts`, `packages/api/src/task-decide.test.ts`

**Interfaces:**
```ts
// task-status.ts (pure; Object.hasOwn edge table)
export type TaskStatus = "open"|"in-progress"|"waiting"|"done"|"dropped";
export function isValidTaskTransition(from: string, to: string): boolean;
// edges: open→{in-progress,waiting,done,dropped}; in-progress↔waiting; in-progress→{done,dropped}; waiting→{done,dropped}; done→(none); dropped→(none)
// task-decide.ts — CLONE registry-decide.ts discipline exactly (FOR UPDATE on tasks row, effective status by ledger-seq join, insert + appendLedgerEvent same transaction)
export async function setTaskStatus(db: Db, userId: string, input: { taskId: string; status: string; note?: string; overrideReason?: string }): Promise<TaskStatusChange>;
export async function effectiveTaskStatus(db: Db, taskId: string): Promise<string>; // default "open"
// canonical ledger payload keys: { id, taskId, status, note: x|null, overrideReason: x|null, createdBy, createdAt: ISO }
// verification.ts: export function taskStatusPayloadHash(row): string; dispatch "task.status" in runFullVerification
```

- [ ] **Step 1:** Failing unit tests: full edge matrix both directions, unknown status → false, prototype keys ("constructor","toString","__proto__") → false without throwing.
- [ ] **Step 2:** Failing integration tests for `setTaskStatus`: happy path appends ledger event with exact recomputable payload hash; invalid transition throws and records nothing; override stores reason; effectiveTaskStatus latest-by-seq (two changes in ONE transaction — the sub-project 2 tie case — must return the second); two parallel setStatus calls → exactly one winner; nonexistent taskId → clear not-found error.
- [ ] **Step 3:** Failing verifier tests: admin-role tamper on a status-change row → `runFullVerification`-level recompute detects `payload_hash_mismatch` at that seq — assert via a DIRECT `runFullVerification`-path test over events this test created (scoped recompute callback, as registry-decide.test.ts does with verifyChain, PLUS a test that exercises the actual `runFullVerification` dispatch line for `task.status` — the untested-dispatch gap flagged in sub-project 2 must not recur; if whole-chain verification cannot run green on the shared dev DB, extract and test the dispatch mapping itself).
- [ ] **Step 4:** Implement; `env -u NODE_ENV pnpm --filter @verder/api test` → PASS. Commit `feat(api): ledger-backed task status with transition validation`.

### Task 3: Tasks tRPC router

**Files:**
- Create: `packages/api/src/routers/tasks.ts`
- Modify: `packages/api/src/root.ts` (register `tasks: tasksRouter`)
- Test: `packages/api/src/routers/tasks.test.ts`

**Interfaces:**
```ts
export const taskFields = z.object({ title: z.string().min(1), details: z.string().nullish(), assigneePartyId: z.string().uuid().nullish(), dueAt: z.coerce.date().nullish(), entryId: z.string().uuid().nullish(), financialItemId: z.string().uuid().nullish(), debtId: z.string().uuid().nullish(), documentId: z.string().uuid().nullish() });
tasks.list({ filter?: "open"|"waiting"|"done" }) → (Task & { effectiveStatus, assigneeName: string|null })[]
  // filter open={open,in-progress}, waiting={waiting}, done={done,dropped}; order: non-done first, dueAt asc nulls last, then createdAt asc
tasks.create(taskFields) → Task; tasks.update({ id, ...partial }) → Task
tasks.get({ id }) → task + effectiveStatus + statusTimeline (newest first, seq-ordered) + linked entry/item/debt/document summaries (id + title/name only)
tasks.setStatus({ taskId, status, note?, overrideReason? }) → change   // status: z.enum of the 5 statuses (garbage strings never reach the ledger)
tasks.validNext({ from }) → string[]
tasks.stats() → { openCount, overdueCount, waitingOnOthersCount }
  // open = effective in {open,in-progress,waiting}; overdue = open ∧ dueAt < now; waitingOnOthers = effective "waiting"
```

- [ ] **Step 1:** Failing integration tests: create → list shows effectiveStatus "open"; setStatus walk open→in-progress→waiting→done incl. one override; get returns seq-ordered timeline + linked entry summary; list filters and ordering (overdue/dueAt-null cases); stats before/after deltas (shared dev DB — delta assertions only).
- [ ] **Step 2:** Implement (thin router over Task 2 services, registry.ts style). Run → PASS. Commit `feat(api): tasks router`.

### Task 4: WSNP timeline derivation + milestones router

**Files:**
- Create: `packages/api/src/wsnp-timeline.ts`, `packages/api/src/routers/milestones.ts`
- Modify: `packages/api/src/root.ts` (register `milestones: milestonesRouter`)
- Test: `packages/api/src/wsnp-timeline.test.ts`, `packages/api/src/routers/milestones.test.ts`

**Interfaces:**
```ts
// wsnp-timeline.ts (pure, no DB)
export const WSNP_STAGES = ["application","accepted","onboarding","wsnp-start","settlement","clean-slate"] as const;
export interface TimelineStage { stage: string; state: "done"|"current"|"future"|"empty"; milestones: MilestoneRow[] }
export function deriveTimeline(rows: MilestoneRow[], now: Date): { stages: TimelineStage[]; countdown: { endsAt: Date; daysLeft: number } | null };
// stage with no rows → "empty" (rendered, skipped in done/current derivation); "done" = has rows, all done;
// "current" = first non-empty stage (stage order) not all-done; stages after current → "future"; before → "done" only if all-done else they'd be current
// countdown: earliest happenedAt among DONE milestones of stage "wsnp-start", +547 days; daysLeft = ceil((endsAt - now)/86400s); null when no such milestone
// milestones router: list() → rows grouped by stage in WSNP_STAGES order; create(fields)/update({id,...partial}); timeline() → deriveTimeline(all rows, new Date())
```

- [ ] **Step 1:** Failing unit tests for `deriveTimeline`: empty input (all stages empty, countdown null); mixed done/pending picks correct current; all done → last stage done, none current; countdown math exact on a fixed `now` (+547 days, ceil), ignores non-done wsnp-start rows.
- [ ] **Step 2:** Failing router integration tests (create/update/list grouping/timeline round-trip). Implement both files. Run → PASS. Commit `feat(api): WSNP milestones and timeline derivation`.

### Task 5: Action-item mining → task suggestions

**Files:**
- Create: `apps/worker/src/task-mine.ts`
- Modify: `apps/worker/src/prompts.ts` (add `TASK_PROMPT_VERSION = "task-v1"`, `buildTaskPrompt(subject, bodyText)` — strict JSON `{ isTask: boolean, title, details, dueAt: "YYYY-MM-DD"|null, assigneeHint: "martin"|"verdergroep"|"other" }`; Dutch context; explicit instruction: FYI/informational mails are NOT tasks), `apps/worker/src/index.ts` (suggest.entry job calls `suggestTask` after `suggestEntry`, error-isolated so a task-mine failure never fails the entry suggestion)
- Test: `apps/worker/src/task-mine.test.ts`

**Interfaces:**
```ts
export async function suggestTask(deps: { db: Db; llm: LlmPort }, rawEmailId: string): Promise<void>;
```
Flow (mirror registry-mine.ts discipline): load rawEmail; dedup key `task:${rawEmailId}:${normalizeName(title)}` — but the pre-LLM guard is per-email: skip entirely if ANY suggestion (any status, incl. rejected) exists with kind "task" and proposed.rawEmailId === rawEmailId (one mining attempt per email — convergence is per-email, not per-title); call LLM with buildTaskPrompt; `isTask: false` → record in workerRuns detail, insert nothing; LLM error/unparseable → record failure in workerRuns, insert nothing (the entry suggestion already surfaces the email; there is no deterministic candidate to degrade to needs-manual — spec §Testing); `isTask: true` → insert suggestion `{ kind: "task", proposed: { key, title, details, dueAt, assigneeHint, rawEmailId }, model, promptVersion: TASK_PROMPT_VERSION }`. `recordRun("task-mine", …)`.

- [ ] **Step 1:** Failing tests with fake LlmPort: action-item email → suggestion with correct payload/key; second call same email → 0 new (convergence); rejected suggestion for the email → still 0 new; `isTask:false` → nothing; LLM throws → nothing inserted, run recorded as failed, no exception escapes; index.ts isolation covered by unit-calling suggestTask with a throwing llm.
- [ ] **Step 2:** Implement + wire into index.ts. Worker suite → PASS (existing gmail tests stay green). Commit `feat(worker): action-item mining into task suggestions`.

### Task 6: approveTask + queue card

**Files:**
- Modify: `packages/api/src/routers/suggestions.ts` (add `approveTask`), `apps/web/src/components/suggestion-card.tsx` (task branch)
- Test: extend `packages/api/src/routers/suggestions.test.ts`

**Interfaces:**
```ts
suggestions.approveTask({ id, task: taskFields-input }) → Task
// single-shot: SELECT suggestion FOR UPDATE, status must be pending|needs-manual else CONFLICT;
// every non-null link id in input (entryId/financialItemId/debtId/documentId/assigneePartyId) must exist — SELECT-verify inside the transaction, throw → full rollback;
// insert tasks row; verdict approved vs edited via unchangedFromProposal over ALL taskFields keys present in proposed payload; finalPayload = the inserted values; reuse the existing reject (already guarded)
```
Card branch (kind "task"): editable title + details, date input for dueAt, assignee select (parties list, preselected by assigneeHint: "verdergroep" → party whose name matches /verder/i if present, else blank), source line ("From email · <subject-ish detail from payload>"), buttons "Add task" / "Not a task" (reuses reject). Buttons disabled while sibling mutation pending.

- [ ] **Step 1:** Failing API tests: approve creates task + marks approved; edited title → verdict "edited"; approve-after-reject → CONFLICT; concurrent double-approve (two pool connections) → exactly one task row; nonexistent assigneePartyId → throws, no task row, suggestion still open.
- [ ] **Step 2:** Implement procedure + card branch. API suite + `env -u NODE_ENV pnpm --filter web build` → PASS. Commit `feat: task queue cards with single-shot approval`.

### Task 7: Task screens

**Files:**
- Create: `apps/web/src/app/(app)/tasks/page.tsx`, `tasks/new/page.tsx`, `tasks/[id]/page.tsx`, `apps/web/src/components/task-list.tsx`, `task-form.tsx`, `task-status-form.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (nav "Tasks" link)

**Requirements (server-component + `serverCaller`, vault/registry page style):** `/tasks` tabs Open | Waiting on others | Done via `?tab=` (map to list filters open/waiting/done); rows: status badge (open slate, in-progress blue, waiting amber, done green, dropped gray strikethrough), title → detail link, assignee chip, dueAt (overdue red "was due <date>"), link icons when entryId/financialItemId/debtId/documentId set. Supportive empty state ("No tasks here — that's a good thing."). `/tasks/new`: task-form (title, details, due date, assignee party select, optional links) posting `tasks.create`. `/tasks/[id]`: editable facts panel (task-form in edit mode → `tasks.update`), status timeline (newest first: badge + note + date), `task-status-form` (select constrained via `tasks.validNext`; explanation-style note optional; invalid target picked → override-reason field appears, mirroring decision-form.tsx), linked evidence panel.

- [ ] Manual verification: create a task via the form, walk open→in-progress→waiting→done with one override, timeline renders all, tabs filter correctly, nav link present. `env -u NODE_ENV pnpm --filter web build` green. Commit `feat(web): task screens with ledgered status flow`.

### Task 8: Milestones screen + dashboard tile & timeline

**Files:**
- Create: `apps/web/src/app/(app)/milestones/page.tsx`, `apps/web/src/components/milestone-editor.tsx`, `wsnp-timeline.tsx`
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx` (tasks tile + timeline strip; timeline links to `/milestones`)

**Requirements:** `/milestones`: stages in fixed order as sections; each milestone row inline-editable (title, expectedAt, happenedAt, done checkbox, note) via `milestones.update`; "+ milestone" per stage via `milestones.create`. Dashboard: `wsnp-timeline.tsx` renders `milestones.timeline()` — six stage nodes left-to-right, done (green check), current (accent ring), future (muted), empty (dashed); milestone dots with dates underneath current stage; countdown chip "WSNP: N days left" when countdown non-null. Tasks tile: "Tasks: N open · N overdue · N waiting on others" from `tasks.stats()`, links `/tasks`. Copy supportive ("Stap voor stap" vibe, English UI).

- [ ] Manual verification: seed milestones across three stages (one done stage, one current with mixed rows), dashboard strip shows done/current/future correctly, countdown appears when a done wsnp-start milestone exists, tasks tile counts match `/tasks`. Build green. Commit `feat(web): milestone timeline and dashboard tasks tile`.

### Task 9: Live registry blockers

**Files:**
- Modify: `packages/api/src/routers/registry.ts` (`items.get` + `blockingTasks`), `apps/web/src/app/(app)/registry/[id]/page.tsx` (banner + nudge)
- Test: extend `packages/api/src/routers/registry.test.ts`

**Interfaces:**
```ts
// items.get return gains: blockingTasks: { id, title, effectiveStatus, dueAt }[]
// = tasks with financialItemId === item.id AND effective status in {open, in-progress, waiting}, seq-ordered effective status like everywhere else
```
UI: amber banner shows when latest decision has `blockerNote` OR blockingTasks non-empty; lists blocking tasks with status badges linking to `/tasks/[id]`. When latest decision HAS a blockerNote but blockingTasks is empty (all completed/none linked), banner turns green-tinted: "Blocker cleared — ready to decide?" with a link to the decision form anchor.

- [ ] **Step 1:** Failing API test: item + linked open task → get returns it in blockingTasks; task set to done → gone from blockingTasks.
- [ ] **Step 2:** Implement + banner. API suite + web build → PASS. Manual: item with blockerNote + open task shows amber with live status; completing the task flips to the cleared nudge. Commit `feat: live task blockers on registry items`.

### Task 10: Task eval extension

**Files:**
- Create: `apps/worker/src/eval/samples-task.json`, `apps/worker/src/eval/run-task-eval.ts`
- Modify: `apps/worker/package.json` (script `task-eval`)

**Requirements:** ≥6 samples with expected `{ isTask, title?, assigneeHint? }`: Dutch document request ("graag kopie paspoort opsturen"), deadline mail, VerderGroep task-for-them mail, and ≥2 FYI-only negatives (newsletter-ish, status update with no ask — targeting entry-v1's known invented-action-item weakness). Runner mirrors `run-registry-eval.ts`: scores isTask match (+ assigneeHint when isTask), prints score with `TASK_PROMPT_VERSION`.

- [ ] Implement; run against homelab Ollama (`OLLAMA_URL=http://homelab:11434`, best-of-3, record range honestly). Commit `feat(worker): action-item eval (baseline: N/M over 3 runs)`.

### Task 11: Deploy to homelab + post-deploy verification

**Files:** none new (ops) — read `CLAUDE.md` and `docs/deploy.md` first.

- [ ] Full suite green on main (`env -u NODE_ENV pnpm -r --if-present test`), builds green.
- [ ] Rsync (same exclude list as prior deploys), `pnpm install --frozen-lockfile` on homelab.
- [ ] Migrations as admin role (0010+0011), verify grants via psql (task_status_changes: no UPDATE/DELETE for app/worker roles).
- [ ] `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker`.
- [ ] Verify: `/tasks` + dashboard render via origin with session; worker logs show suggest.entry running with task mining attached; nightly-verify chain green (now incl. task.status recompute); `./ops/nightly.sh` → NAS backup includes tasks, task_status_changes, milestones.
- [ ] Run all three evals on homelab (entry, registry, task — 3 runs each, record honest ranges); update CLAUDE.md baselines + deployed-note; commit `docs: sub-project 3 deploy + eval baselines`, push. Commit nothing on homelab.

---

## Post-plan notes for the executor

- Dependency edges (drive the waves): 1 → {2,4,5}; 2 → 3; 5 → 10; 3 → {6,7,8,9}; 4 → 8; all → 11.
- Read the ACTUAL repo code before every task — three sub-projects have shipped with reviewed deviations; the repo is the truth, this plan names the patterns.
- The `ALTER TYPE suggestion_kind ADD VALUE` mechanics were already solved in migration 0009 (Task 7 of sub-project 2) — copy how that landed, including the migrate-on-dev verification.
- Adversarial review focus where it pays: Task 2 (payload reproducibility, tamper at right seq, concurrency), Task 5 (per-email convergence, rejected-stays-gone), Task 6 (single-shot approve, link validation, truthful edit-diff), Task 4 (timeline derivation edge cases, countdown math).
- Worktree merges: `root.ts` and `layout.tsx` are each touched by exactly one task per wave by design — if a merge conflict appears anywhere else, a task exceeded its file list; stop and reconcile before continuing.
- After Task 11, record all three golden-rule eval baselines in `CLAUDE.md` (ranges, not lucky runs).
