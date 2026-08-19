# Tasks + Milestones — Design Spec

**Date:** 2026-08-19
**Status:** Approved design, pending implementation plan
**Sub-project:** 3 of the verder platform (1: logbook + vault, shipped 2026-08-18; 2: financial registry, shipped 2026-08-19)

## Purpose

Track every task in the Bewindvoering/WSNP process — Martin's, VerderGroep's, and other parties' — with a tamper-proof status history, and show the process itself as a milestone timeline on the dashboard (which stage we're in, what's done, and the 18-month settlement countdown). Implements the braindump's pillars 4 (task management) and the dashboard timeline from pillar 6, plus the blocker-until-task-complete example from pillar 3.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Assignees | **Parties**, not users — a task is assigned to any `parties` row (Martin, VerderGroep, individuals). No user accounts pulled forward; when user management (pillar 5) lands, users map to parties |
| Evidence regime | **Mixed, mirroring the registry**: `tasks` fact table is editable; status changes (`task_status_changes`) are insert-only and hash-chain ledgered |
| Linking | Tasks optionally link to a logbook entry, registry item, debt, and/or document (any combination). Registry blockers become live: item detail shows open blocking tasks; completing the last one surfaces a "blocker cleared" nudge |
| Population | Manual entry + AI-mined action items from email, through the existing suggestions queue (`kind: "task"`); nothing created without Martin's approval |
| Milestones | Fixed WSNP stage set, manually entered milestone rows; **not** ledgered (display aid — the underlying facts are logbook/vault evidence) |
| AI role | Suggestion-only, prompt version recorded (`task-v1`), corrections recorded per the golden rule |

## Data model

### `tasks` (editable; SELECT+INSERT+UPDATE, no DELETE)

`id`, `title` (not null), `details` (nullable), `assigneePartyId` → parties (nullable = unassigned), `dueAt` timestamptz (nullable), `entryId` → entries (nullable, "where this was agreed"), `financialItemId` → financial_items (nullable), `debtId` → debts (nullable), `documentId` → documents (nullable), `createdBy` → users (not null), `createdAt`. Links are independent — no exactly-one constraint; a task may reference both the entry that created it and the registry item it blocks.

### `task_status_changes` (insert-only; INSERT+SELECT grants only)

`id`, `taskId` (not null) → tasks, `status` text, `note` (nullable), `overrideReason` (nullable), `createdBy` (not null), `createdAt`. Every insert appends a `ledger_events` row (`eventType: "task.status"`, `entityType: "task_status_change"`) in the same transaction; canonical payload byte-recomputable from the live row (registry.decision discipline: explicit `?? null` mapping, canonicalJson, hash of the returned row).

Statuses: `open / in-progress / waiting / done / dropped`. Transitions: `open → {in-progress, waiting, done, dropped}`; `in-progress ↔ waiting`; `in-progress → {done, dropped}`; `waiting → {done, dropped}`; `done → (none)`; `dropped → (none)`. Effective status = latest change ordered by ledger seq (not createdAt — sub-project 2 lesson), defaulting to `open` for a task with no rows. Invalid transition throws unless `overrideReason` given (reason recorded). `setTaskStatus` serializes per task via `SELECT … FOR UPDATE` on the tasks row. Transition tables prototype-safe (`Object.hasOwn`).

### `milestones` (editable; SELECT+INSERT+UPDATE, no DELETE)

`id`, `stage` (pgEnum `wsnp_stage`: `application / accepted / onboarding / wsnp-start / settlement / clean-slate`), `title` (not null), `happenedAt` timestamptz (nullable), `expectedAt` timestamptz (nullable), `done` boolean not null default false, `note` (nullable), `entryId` (nullable), `documentId` (nullable), `createdAt`. No ledger events.

## Services + API

- `packages/api/src/task-status.ts` (pure): `isValidTaskTransition(from, to)`; unknown statuses → false, never throws.
- `packages/api/src/task-decide.ts`: `setTaskStatus(tx, userId, { taskId, status, note?, overrideReason? })` + `effectiveTaskStatus(db, taskId)` — clones the hardened registry `decide()` (FOR UPDATE, seq-ordered latest, same-transaction ledger append). Verifier extended to recompute `task.status` payloads; the `runFullVerification` dispatch for the new event type gets a direct test (closes the untested-dispatch minor from sub-project 2).
- `packages/api/src/routers/tasks.ts`:
  - `tasks.list({ filter?: "open" | "waiting" | "done" })` → tasks + effectiveStatus + assignee party name + link summaries; open-first, then due date ascending (nulls last). Filter `open` = {open, in-progress}; `waiting` = {waiting}; `done` = {done, dropped}.
  - `tasks.create` / `tasks.update` / `tasks.get({id})` (facts + status timeline newest-first + linked entry/item/debt/document details).
  - `tasks.setStatus` (protected wrapper), `tasks.validNext({from})`.
  - `tasks.stats()` → `{ openCount, overdueCount, waitingOnOthersCount }`. Overdue = effective status in {open, in-progress, waiting} and `dueAt` past. Waiting-on-others = effective status `waiting` (the status itself means "ball is in someone else's court" — no user↔party mapping exists or is needed).
- `packages/api/src/routers/milestones.ts`: `list()` (grouped by stage in fixed order), `create`, `update`, `timeline()` → per-stage status (`done` when the stage has milestones and all are done; `current` = first stage, in fixed order, that is not done; later stages `future`; a stage with no milestones is skipped in the done/current derivation but still rendered) + countdown: `settlement` end = earliest `happenedAt` of a done `wsnp-start` milestone + 547 days, exposed when set.
- Registry integration: `registry.items.get` additionally returns `blockingTasks` (open/in-progress/waiting tasks with `financialItemId = item.id`). No registry schema change.

## Mining + queue

- `suggestionKindEnum` + `"task"` (ALTER TYPE migration, as done for registry kinds).
- The worker's Gmail entry-suggestion flow already asks the model about action items (entry-v1 eval). Extend the flow: when the classification reports a clear action item, also insert a `kind: "task"` suggestion — payload `{ title, details, dueAt: iso|null, assigneeHint: "martin"|"verdergroep"|"other", rawEmailId, key }`. Prompt version `TASK_PROMPT_VERSION = "task-v1"` recorded.
- Dedup: namespaced key `task:<rawEmailId>:<normalized title>`; considers rejected suggestions (never resurrect); per-candidate error isolation; convergent on re-runs.
- Queue card (`kind: "task"`): editable title/details, due-date input, assignee select seeded from the hint, "Add task" / "Not a task". `suggestions.approveTask` follows the hardened single-shot pattern: `SELECT … FOR UPDATE`, open-status guard, truthful edit-diff over **all** submitted fields vs proposed payload, verdict + payloads recorded.
- FYI-only emails must NOT produce task suggestions — this is the known entry-v1 weakness (invented action item on FYI email) and gets targeted eval samples.

## Screens

- **`/tasks`** — tabs Open | Waiting on others | Done (`?tab=`); rows: status badge, title, assignee chip, due date (overdue red), link icons to entry/item/debt/document; "+ Add" form (`/tasks/new`). Supportive empty state.
- **`/tasks/[id]`** — editable facts panel; status timeline (read-only, newest first: badge + note + date); status-change form constrained to valid next statuses with the override-reason path for invalid targets; linked evidence panel.
- **Registry item detail** — blocker banner extended: lists open blocking tasks with live status; when the latest decision has a `blockerNote` or blocking tasks exist the banner shows; when the last blocking task completes, item page and dashboard show a "blocker cleared — ready to decide?" nudge.
- **`/milestones`** — single maintenance screen: stages in fixed order, milestone rows editable inline (title, dates, done, note, links). No detail pages.
- **Dashboard** — tasks tile ("N open · N overdue · N waiting on others") linking to `/tasks`; milestone timeline strip across the top: six stages with done/current/future styling, milestone dots with dates, 18-month countdown chip once wsnp-start is done.

## Error handling

- Status transitions validated with recorded overrides; insert + ledger append atomic; per-task serialization.
- Task mining idempotent and convergent; rejected suggestions never reappear; approve procedures single-shot with strict link validation (nonexistent entry/item/debt/document ids fail loudly, roll back).
- Timeline derivation is pure and total: any milestone data (empty stages, all done, nothing done) renders without error.

## Testing

- Transition-matrix unit tests (full edge matrix, unknown/prototype-key statuses).
- `setTaskStatus` integration: ledger payload hash exactness, tamper test breaking verification at the right seq, concurrency (two parallel setStatus → one winner), override recording. Direct `runFullVerification` test covering a `task.status` event.
- Mining: convergence (Nth run → 0 new), rejected stays gone, FYI email → no task suggestion, LLM failure → no task suggestion but failure recorded in the worker run (the email's entry suggestion still surfaces it to Martin — there is no deterministic task candidate to degrade to needs-manual), error isolation.
- Approve: double-approve race, edit-diff truthfulness on every field, stale/invalid link ids fail loudly.
- Timeline derivation unit tests (current-stage logic, countdown math on 547 days).
- Eval: ≥6 action-item samples (Dutch document requests, deadline mails, 2+ FYI-only negatives) with expected `{isTask, title, assigneeHint}`; runner `task-eval`, score recorded with `TASK_PROMPT_VERSION`.

## Out of scope

User accounts/invites for VerderGroep (pillar 5), email/push task reminders, recurring tasks, agent auto-replies or auto-created tasks without approval, editing milestones from the dashboard strip, WSNP boedelafdracht math.

## Tone

Task UI toward Martin: supportive, judgement-free (an overdue task is a nudge, not a failure). Any copy that could be seen by others (none planned this sub-project) stays formal.
