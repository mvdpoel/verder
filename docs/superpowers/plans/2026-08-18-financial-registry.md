# Financial Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build sub-project 2 — the financial registry (subscriptions/contracts + debts) with ledger-backed decisions, statement mining (ABN CAMT.053/TSV, PayPal CSV), aggregator resolution via Gmail receipts, and registry screens — then deploy to the homelab.

**Architecture:** Extends the shipped verder monorepo (see repo CLAUDE.md). Editable fact tables (`financial_items`, `debts`, `transactions`) + insert-only ledger-backed `registry_decisions`. Miners run in `apps/worker`, propose into the existing `suggestions` review queue; nothing writes to the registry without approval. All money in integer cents.

**Tech Stack:** existing stack (Next.js 15, tRPC v11, Drizzle, Postgres 17, pg-boss, Ollama via `LlmPort`). New dep: `fast-xml-parser` for CAMT.053.

**Spec:** `docs/superpowers/specs/2026-08-18-financial-registry-design.md` — read it in full before any task. Also read `CLAUDE.md` (homelab access, env quirks) and skim `docs/superpowers/plans/2026-08-18-logbook-vault.md` §Global Constraints (all still apply).

## Global Constraints

- All sub-project 1 constraints still apply (append-only evidence, same-transaction ledger appends, canonical JSON hashing via `@verder/core`, suggestion-only AI, idempotent ingestion, evidence-first raw storage).
- `registry_decisions` is an EVIDENCE table: INSERT+SELECT only for `verder_app`/`verder_worker` (grants migration). Fact tables `financial_items`, `debts`, `transactions` get SELECT+INSERT+UPDATE, **no DELETE**.
- Ledger event type for decisions: `"registry.decision"`, entityType `"registry_decision"`.
- ALL amounts are integer cents (`amountCents`, signed for transactions). Parsing must never produce floats (parse decimal strings → cents via string math, not `parseFloat*100`).
- Transaction idempotency key: (`statementSha256`, `rowIndex`) — unique index.
- Suggestion dedup must consider REJECTED suggestions (a rejected candidate never reappears).
- Existing patterns are law: study `packages/api/src/routers/documents.ts` (effective-status pattern), `entries.ts` (insertEntry + ledger payload), `apps/worker/src/gmail.ts` (evidence-first, error isolation), `apps/worker/src/ollama.ts` (LlmPort + needs-manual fallback), `apps/web/src/components/suggestion-card.tsx` (queue cards).
- Build/test with `env -u NODE_ENV` (shell exports NODE_ENV=development). Dev DB via `docker compose up -d postgres`; run new migrations before integration tests.
- Tone: UI copy toward Martin supportive/judgement-free; the VerderGroep export page formal/professional.

## File Structure

```
packages/db/src/schema.ts            # + enums, financial_items, debts, transactions, registry_decisions
packages/db/drizzle/000X_registry*   # generated migration + custom grants migration
packages/api/src/routers/registry.ts # items+debts+decisions+transactions routers
packages/api/src/registry-status.ts  # effectiveStatus + transition validation (pure)
packages/api/src/verification.ts     # extend: recompute registry.decision payloads
packages/worker-shared? — NO: parsers live in packages/api? NO →
packages/parsers/                    # NEW package @verder/parsers (pure, fixture-tested)
  src/camt053.ts src/abn-tsv.ts src/paypal-csv.ts src/types.ts src/money.ts
  src/recurring.ts                   # detectRecurring (pure)
  fixtures/*.xml|tsv|csv
apps/worker/src/registry-mine.ts     # mining job: candidates→dedup→classify→suggestions
apps/worker/src/receipts.ts          # aggregator resolution via targeted Gmail search
apps/worker/src/prompts.ts           # + REGISTRY_PROMPT_VERSION, buildRegistryPrompt
apps/web/src/app/(app)/registry/page.tsx, [id]/page.tsx, debts/[id]/page.tsx, import/page.tsx
apps/web/src/app/(app)/registry/export/  # VerderGroep report (print-styled, own layout like verify/export)
apps/web/src/components/registry-*.tsx, statement-upload.tsx
apps/web/src/components/suggestion-card.tsx  # + registry-item and debt card branches
apps/web/src/app/api/registry-import/route.ts # statement upload (vault-first)
apps/worker/src/eval/samples-registry.json    # payee classification eval
```

Tasks 1–3: data + decisions + API. Tasks 4–8: parsers + mining. Tasks 9–12: UI + export. Task 13: deploy.

---

### Task 1: Schema + grants for the registry

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: generated migration + custom grants migration (follow existing numbering in `packages/db/drizzle/`)
- Test: `packages/db/src/registry-schema.test.ts`

**Interfaces (produces — later tasks rely on these exact names):**
```ts
// enums
export const itemCategoryEnum = pgEnum("item_category", ["energy","insurance","telecom","streaming","software","housing","other"]);
export const billingCycleEnum = pgEnum("billing_cycle", ["monthly","quarterly","yearly","irregular"]);
export const paymentChannelEnum = pgEnum("payment_channel", ["direct-debit","paypal","apple","invoice"]);
export const discoverySourceEnum = pgEnum("discovery_source", ["manual","bank","paypal","apple","email"]);
export const itemStatusEnum = pgEnum("item_status", ["identified","mandatory","allowed","requested","to-cancel","canceled"]);
export const debtStatusEnum = pgEnum("debt_status", ["identified","acknowledged","disputed","in-settlement","settled"]);
export const txSourceEnum = pgEnum("tx_source", ["abn-camt053","abn-tsv","paypal-csv"]);
// tables (drizzle, timestamptz, uuid pk defaultRandom as elsewhere)
financialItems: { id, name text notnull, category itemCategoryEnum notnull, providerPartyId uuid→parties nullable, amountCents integer notnull, billingCycle notnull, paymentChannel notnull, contractStart date?, contractEnd date?, noticePeriod text?, cancellationMethod text?, cancellationDetails text?, accountNumber text?, discoveredVia discoverySourceEnum notnull default 'manual', createdAt }
debts: { id, creditorPartyId uuid→parties nullable, creditorName text notnull, principalCents integer?, claimedCents integer notnull, references_ text? (column "references"), origin text? , originStory text?, createdAt }
transactions: { id, source txSourceEnum notnull, bookedAt timestamptz notnull, amountCents integer notnull, counterpartyName text?, counterpartyIban text?, description text?, mandateId text?, statementSha256 text notnull, rowIndex integer notnull, parseError boolean notnull default false, rawRow text?, financialItemId uuid→financialItems nullable, uniqueIndex tx_stmt_row_uq (statementSha256,rowIndex) }
registryDecisions: { id, financialItemId uuid→financialItems nullable, debtId uuid→debts nullable, status text notnull, explanation text notnull, documentId uuid→documents nullable, blockerNote text?, overrideReason text?, createdBy uuid→users notnull, createdAt } // CHECK: exactly one of financialItemId|debtId set
```
- Grants (custom migration, both `verder_app` and `verder_worker`): `GRANT SELECT, INSERT ON registry_decisions`; `GRANT SELECT, INSERT, UPDATE ON financial_items, debts, transactions`; no DELETE anywhere.

- [ ] **Step 1:** Write failing integration test `registry-schema.test.ts` (style of existing router tests, APP role URL): inserts an item, a debt, a transaction, a decision; asserts unique index rejects duplicate (statementSha256,rowIndex); asserts `db.update(registryDecisions)` and `db.delete(financialItems)` reject with permission denied; asserts CHECK rejects a decision with both/neither target set.
- [ ] **Step 2:** Run → FAIL. Add schema, `pnpm --filter @verder/db generate`, write custom grants migration (`drizzle-kit generate --custom --name=registry_grants`, follow how `0001_grants.sql` was journaled), `migrate`.
- [ ] **Step 3:** Run → PASS. Commit `feat(db): financial registry schema and grants`.

### Task 2: Decision service + status logic + verifier extension

**Files:**
- Create: `packages/api/src/registry-status.ts`, `packages/api/src/registry-decide.ts`
- Modify: `packages/api/src/verification.ts` (or wherever `runFullVerification` lives — read it first)
- Test: `packages/api/src/registry-status.test.ts`, `packages/api/src/registry-decide.test.ts`

**Interfaces:**
```ts
// registry-status.ts (pure)
export type ItemStatus = "identified"|"mandatory"|"allowed"|"requested"|"to-cancel"|"canceled";
export type DebtStatus = "identified"|"acknowledged"|"disputed"|"in-settlement"|"settled";
export function isValidTransition(kind: "item"|"debt", from: string, to: string): boolean;
// item edges: identified→{mandatory,allowed,requested,to-cancel}; mandatory↔allowed; allowed→{requested,to-cancel}; requested→{allowed,to-cancel}; to-cancel→{canceled,allowed}; canceled→(none)
// debt edges: identified→{acknowledged,disputed}; acknowledged↔disputed; acknowledged→in-settlement; disputed→in-settlement; in-settlement→settled; settled→(none)
// registry-decide.ts
export async function decide(tx: Db, userId: string, input: {
  financialItemId?: string; debtId?: string; status: string; explanation: string;
  documentId?: string; blockerNote?: string; overrideReason?: string;
}): Promise<RegistryDecision>;
// - loads current status (latest decision row, default "identified")
// - invalid transition WITHOUT overrideReason → throw; WITH overrideReason → allowed, reason stored
// - inserts decision + appendLedgerEvent({eventType:"registry.decision", entityType:"registry_decision", entityId: decision.id, payload}) SAME transaction
// canonical ledger payload (exact keys, sorted handled by canonicalJson):
// { id, financialItemId: x|null, debtId: x|null, status, explanation, documentId: x|null, blockerNote: x|null, overrideReason: x|null, createdBy, createdAt: ISO }
export async function effectiveStatus(db: Db, target: {financialItemId?: string; debtId?: string}): Promise<string>;
```
- Verifier: extend the payload-recompute callback so `registry.decision` events rebuild the canonical payload from the live `registry_decisions` row (mirror how `entry.created` recompute works — read that code first). Tamper test: admin-role UPDATE on a decision row → verification must fail at that seq (guarded truncate/test-db rules already exist — reuse `assertSafeToTruncate` style, but do NOT truncate; create fresh rows and tamper only rows created by the test via the admin role).

- [ ] **Step 1:** Failing unit tests for `isValidTransition` (full edge matrix, both kinds, unknown status → false).
- [ ] **Step 2:** Failing integration tests for `decide`: happy path appends ledger event (verify chain still ok via `verifyChain` over all events); invalid transition throws; override stores reason; effectiveStatus reflects latest.
- [ ] **Step 3:** Failing verifier tamper test. Implement all; run `pnpm --filter @verder/api test` → PASS. Commit `feat(api): ledger-backed registry decisions with transition validation`.

### Task 3: Registry tRPC routers

**Files:**
- Create: `packages/api/src/routers/registry.ts`
- Modify: `packages/api/src/root.ts` (register `registry: registryRouter`)
- Test: `packages/api/src/routers/registry.test.ts`

**Interfaces (procedures consumed by web + worker):**
```ts
registry.items.list() → (FinancialItem & { effectiveStatus, monthlyCents })[]  // monthlyCents normalizes cycle: monthly=amount, quarterly=/3, yearly=/12 (integer division), irregular=0
registry.items.create(input: item fields minus id/createdAt) → FinancialItem  // plain insert (editable table), discoveredVia respected
registry.items.update({ id, ...partial fields }) → FinancialItem
registry.items.get({ id }) → item + effectiveStatus + decisions[] (newest first) + linked transactions + evidence docs
registry.debts.list() / create / update / get({id}) → debt + decisions + related logbook entries (join entry_participants via creditorPartyId) + documents
registry.decide(input of Task 2 decide) → decision   // protectedProcedure wrapping decide()
registry.transactions.listByItem({ financialItemId })
registry.transactions.link({ transactionId, financialItemId })  // UPDATE transactions.financialItemId
registry.stats() → { itemCount, monthlyTotalCents, toCancelMonthlyCents, pendingDecisions: count of items+debts still at "identified" }
```

- [ ] **Step 1:** Failing integration tests: create item → list shows effectiveStatus "identified" and correct monthlyCents for each cycle; decide → status changes; get returns decision timeline; debts.get surfaces a logbook entry whose participant is the creditor party; stats math.
- [ ] **Step 2:** Implement (thin router over Task 2 services + drizzle queries; follow documents.ts style). Run → PASS. Commit `feat(api): registry routers`.

### Task 4: `@verder/parsers` — statement parsers with fixtures

**Files:**
- Create: `packages/parsers/` package (package.json like @verder/core: type module, main src/index.ts, vitest; deps: `fast-xml-parser@^4`, `@verder/core` not needed), `src/types.ts`, `src/money.ts`, `src/camt053.ts`, `src/abn-tsv.ts`, `src/paypal-csv.ts`, `src/index.ts`, `fixtures/abn.camt053.xml`, `fixtures/abn.tsv`, `fixtures/paypal.csv`
- Test: `src/money.test.ts`, `src/camt053.test.ts`, `src/abn-tsv.test.ts`, `src/paypal-csv.test.ts`

**Interfaces:**
```ts
// types.ts
export interface ParsedRow { rowIndex: number; bookedAt: Date; amountCents: number; // signed: debits negative
  counterpartyName: string | null; counterpartyIban: string | null;
  description: string | null; mandateId: string | null; }
export interface ParseResult { rows: ParsedRow[]; errors: { rowIndex: number; raw: string; message: string }[] }
export type StatementSource = "abn-camt053" | "abn-tsv" | "paypal-csv";
export function detectSource(filename: string, head: Buffer): StatementSource | null;
// money.ts — STRING math, never parseFloat
export function decimalToCents(s: string): number; // "142,80"→14280, "142.80"→14280, "-13,99"→-1399, "1.234,56" (NL thousands)→123456; throws on garbage
// each parser: export function parseCamt053(buf: Buffer): ParseResult  (etc.)
```
- **CAMT.053** (fast-xml-parser): iterate `BkToCstmrStmt/Stmt/Ntry`; amount `Amt` (+`@_Ccy`, only EUR), sign from `CdtDbtInd` (DBIT→negative); date `BookgDt/Dt`; per `NtryDtls/TxDtls`: counterparty `RltdPties/Cdtr/Nm` (debits) else `Dbtr/Nm` (credits), IBAN `RltdPties/CdtrAcct/Id/IBAN` (resp. DbtrAcct); `Refs/MndtId`; description from `RmtInf/Ustrd` (join array). One Ntry with multiple TxDtls → one row per TxDtls.
- **ABN TSV**: latin-1 decode (`Buffer.toString("latin1")`), tab-separated, NO header row; columns: [0] account, [1] currency, [2] date YYYYMMDD, [3] balance-before, [4] balance-after, [5] value date, [6] amount (comma decimal, sign leading), [7] description. Counterparty/IBAN/mandate extracted from description via regexes: `/(?:Naam|Name):\s*(.+?)(?:\s{2,}|$)/`, `/IBAN:\s*([A-Z]{2}\d{2}[A-Z0-9]+)/`, `/(?:Machtiging|Mandate):\s*(\S+)/` — also handle the `/TRTP/SEPA` slash-format (`/NAME/x/IBAN/y/MARF/z`). Null when absent.
- **PayPal CSV**: strip UTF-8 BOM; quoted CSV with header row; use columns `Date` (DD-MM-YYYY or MM/DD/YYYY — detect by >12 first segment else assume DD-MM), `Name`, `Type`, `Status` (only `Completed`), `Currency` (only EUR), `Gross` (comma or dot decimal), `Transaction ID` → description `"paypal:<Type> <TransactionID>"`, counterpartyIban null, mandateId null.
- **Fixtures**: write realistic anonymized samples exercising: NL thousands separator, negative amounts, a refund (positive credit from a known payee), a CAMT entry with mandate id, an ABN row with `Naam:`/`IBAN:` description and one slash-format row, a PayPal BOM + `Completed` and `Pending` rows, one malformed row per format (→ errors[]).

- [ ] **Step 1:** `money.test.ts` first (all formats + garbage throws) → FAIL → implement `decimalToCents` via string parsing (split on last separator; validate digits) → PASS. Commit `feat(parsers): exact decimal-to-cents`.
- [ ] **Step 2:** Per-format: write fixture + failing test asserting exact rows (count, first/last row fields, error rows listed not thrown) → implement parser → PASS → commit per format (`feat(parsers): camt053|abn-tsv|paypal-csv`).

### Task 5: Statement import (vault-first) + import API

**Files:**
- Create: `packages/api/src/routers/registry-import.ts` (procedures `registry.import.ingest`, `registry.import.list`), `apps/web/src/app/api/registry-import/route.ts` (multipart upload)
- Modify: `packages/api/src/root.ts`, `packages/api/src/routers/registry.ts` (nothing — keep import separate)
- Test: `packages/api/src/routers/registry-import.test.ts`

**Interfaces:**
```ts
registry.import.ingest({ sha256, filename }) → { statementSha256, inserted, skipped, errors: n, source }
// - file must already be in vault (upload route stores it first, same as /api/upload incl. auth+size guards — reuse getSessionUserId + MAX_UPLOAD_BYTES)
// - registers the file as a document (ingestDocument, source "upload", docType "bank-statement") if not already
// - detectSource + parse; inserts transactions with onConflictDoNothing on (statementSha256,rowIndex) → skipped count
// - parse errors inserted as rows with parseError=true, rawRow set, amountCents 0, bookedAt = now
// - enqueues worker job "registry.mine" with { statementSha256 } (pg-boss send via a new api-side helper? NO — the web cannot reach pg-boss cleanly; instead insert a row into a tiny `mine_requests`? NO — keep it simple: the worker polls: add cron job "registry.mine" every 2 min that mines ALL un-mined transactions; ingest just inserts rows)
registry.import.list() → past imports (group transactions by statementSha256 with counts + the document title)
```
Decision locked: **no direct enqueue from web**; the worker's `registry.mine` cron (Task 7) sweeps new transactions every 2 min. Simpler, idempotent, matches watcher architecture.

- [ ] **Step 1:** Failing integration test: put fixture bytes through `storeFile` + `ingest` → transaction counts match fixture; re-ingest → all skipped; malformed rows present with parseError.
- [ ] **Step 2:** Implement + upload route (mirror `/api/upload` exactly, then call ingest). Run → PASS. Commit `feat(api): statement import with vault-first evidence`.

### Task 6: Recurring detection (pure)

**Files:**
- Create: `packages/parsers/src/recurring.ts`
- Test: `packages/parsers/src/recurring.test.ts`

**Interfaces:**
```ts
export interface RecurringCandidate {
  key: string;                       // mandateId ?? iban ?? normalized name
  groupBy: "mandate" | "iban" | "name";
  counterpartyName: string | null; counterpartyIban: string | null; mandateId: string | null;
  cadence: "monthly" | "quarterly" | "yearly";
  typicalAmountCents: number;        // median of charge amounts (negative)
  chargeCount: number; firstAt: Date; lastAt: Date;
  transactionIds: string[];
  aggregator: "apple" | "paypal" | null;  // APPLE.COM/BILL name match or source==paypal-csv aggregate line in bank statement (PayPal Europe S.a r.l. counterparty)
}
export function detectRecurring(txs: (ParsedRow & { id: string })[]): RecurringCandidate[];
```
Rules (implement exactly): only debits (amountCents<0); group by mandate ▸ IBAN ▸ `normalizeName` (lowercase, strip digits/punctuation/whitespace runs); candidate needs ≥2 charges; cadence: median gap 25–35d monthly, 80–100d quarterly, 350–380d yearly, else not recurring; amount similarity: every charge within 40% of median OR identical mandate (energy varies, mandates prove identity); refunds (positive rows in group) ignored for counting but kept out of typicalAmount; aggregator detection: name matches `/apple\.com\/bill/i` → "apple", `/paypal/i` on a bank-sourced row → "paypal".

- [ ] **Step 1:** Failing property-style tests: day-drift monthly (28th/30th/1st), quarterly, yearly; amount drift within/beyond 40%; mandate overrides amount rule; refunds excluded; <2 charges never; aggregator flags; deterministic key. → implement → PASS. Commit `feat(parsers): recurring charge detection`.

### Task 7: Mining job → suggestions (dedup + Ollama classify)

**Files:**
- Create: `apps/worker/src/registry-mine.ts`
- Modify: `apps/worker/src/prompts.ts` (add `REGISTRY_PROMPT_VERSION="registry-v1"`, `buildRegistryPrompt(candidate)` — asks strict JSON `{ name, category(one of enum), isDebtCollector: boolean }`, Dutch context: incasso/deurwaarder/gerechtsdeurwaarder ⇒ debt collector), `apps/worker/src/index.ts` (queue `registry.mine`, cron `*/2 * * * *`), `packages/db/src/schema.ts` + migration (extend `suggestionKindEnum` with `"registry-item"`, `"debt"` — Postgres: `ALTER TYPE suggestion_kind ADD VALUE`, custom migration)
- Test: `apps/worker/src/registry-mine.test.ts`

**Interfaces:**
```ts
export async function mineRegistry(deps: { db: Db; llm: LlmPort }): Promise<{ candidates: number; suggested: number }>;
```
Flow (mirror gmail.ts discipline): load all transactions with `financialItemId IS NULL AND parseError=false`; `detectRecurring`; for each candidate: **dedup** — skip if (a) an existing `financial_items` row matches mandate OR iban OR normalizeName(name), → instead UPDATE those transactions' `financialItemId` to link them (auto-evidence); or (b) an existing suggestion of kind registry-item/debt (ANY status incl. rejected) whose proposed.key equals candidate.key. Surviving candidates → Ollama classify (needs-manual fallback: insert suggestion with `status:"needs-manual"`, proposed name = counterparty name, category "other") → insert suggestion `kind: isDebtCollector ? "debt" : "registry-item"` with proposed payload (spec shape: include `key`, evidence `transactionIds`, `aggregator`, `resolved: aggregator===null`). recordRun("registry-mine", ...) with counts; per-candidate error isolation like gmail.ts. Aggregator candidates additionally enqueue `receipts.resolve` (Task 8) — queue created there; guard send in try/catch until Task 8 lands (queue may not exist yet: create the queue in THIS task's index.ts change too).

- [ ] **Step 1:** Failing integration tests with fake LlmPort: fixture transactions inserted → mine → suggestion created with correct kind/payload; second mine → 0 new (dedup); rejected suggestion stays gone; existing item match links transactions instead of suggesting; llm failure → needs-manual.
- [ ] **Step 2:** Implement + register cron + enum migration. Run worker tests → PASS. Commit `feat(worker): registry mining with dedup and classification`.

### Task 8: Aggregator resolution via targeted Gmail receipts

**Files:**
- Create: `apps/worker/src/receipts.ts`
- Modify: `apps/worker/src/index.ts` (queue `receipts.resolve`, worker registration)
- Test: `apps/worker/src/receipts.test.ts`

**Interfaces:**
```ts
export async function resolveAggregator(deps: { db: Db; gmail: GmailPort; llm: LlmPort; vaultDir: string }, suggestionId: string): Promise<void>;
```
Flow: load suggestion (kind registry-item, proposed.aggregator ∈ apple|paypal, resolved=false); for each of the last ≤3 charge dates build targeted query — apple: `from:apple.com after:<date-2d> before:<date+2d>`; paypal: `from:paypal.nl OR from:paypal.com after:… before:…` (dates as YYYY/MM/DD Gmail format); fetch via `gmail.listMessageIds` + `getMessage`, ingest each through the SAME evidence-first path as pollGmail (extract that transaction block into an exported `ingestRawEmail(deps, msg)` helper in gmail.ts — refactor, keep tests green) but do NOT enqueue suggest.entry for receipts; Ollama extracts line items from receipt bodyText (`strict JSON [{name, amountCents}]`, prompt `RECEIPT_PROMPT_VERSION="receipt-v1"`); UPDATE the suggestion's proposed payload: `resolved: true`, `receiptRawEmailIds`, and if line items found, replace name/amount with the resolved subscription per line item (multiple line items → insert additional suggestions, one per item, same evidence). No receipts found → UPDATE suggestion status to `needs-manual` (payload note "payee unknown — check PayPal/Apple account"). recordRun("receipts", ...).

- [ ] **Step 1:** Failing tests with fake GmailPort+LlmPort: apple candidate + fake receipt → resolved suggestion with real name; multi-line receipt → extra suggestions; nothing found → needs-manual; receipt raw email stored in vault (byte-check like gmail.test.ts does).
- [ ] **Step 2:** Implement (incl. the `ingestRawEmail` refactor; existing gmail tests must stay green). Commit `feat(worker): aggregator resolution via targeted receipt search`.

### Task 9: Registry overview screen

**Files:**
- Create: `apps/web/src/app/(app)/registry/page.tsx`, `apps/web/src/components/registry-list.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` nav (add "Registry" link), `apps/web/src/app/(app)/dashboard/page.tsx` (registry tile from `registry.stats`)

**Requirements (follow the exact server-component + `serverCaller` pattern of `vault/page.tsx`):** two tabs via `?tab=items|debts` searchParam; items grouped by effectiveStatus in workflow order with per-group monthly rollup (`€${(cents/100).toFixed(2)}`, but compute in cents); headline totals from `registry.stats`; status badges (identified slate, mandatory red, allowed green, requested amber, to-cancel orange, canceled gray strikethrough); discovery-source badge per row; buttons "+ Add" (→ `/registry/new`, simple client form posting `registry.items.create` — include it in this task, mirroring `entry-form.tsx` structure but smaller) and "Import statement" (→ `/registry/import`). Debts tab: creditor, claimed amount, status timeline-latest. Supportive empty state ("Nothing here yet — import a bank statement and let's find out together what's out there.").

- [ ] Manual verification: seed one item + one debt via a caller script or the forms; both tabs render, rollups correct, nav link present, dashboard tile shows counts. `env -u NODE_ENV pnpm --filter web build` green. Commit `feat(web): registry overview with status rollups`.

### Task 10: Item + debt detail screens with decision flow

**Files:**
- Create: `apps/web/src/app/(app)/registry/[id]/page.tsx`, `apps/web/src/app/(app)/registry/debts/[id]/page.tsx`, `apps/web/src/components/decision-form.tsx`, `apps/web/src/components/item-facts-form.tsx`

**Requirements:** item page = editable facts panel (client form → `registry.items.update`), decision timeline (read-only, newest first, each row: status badge + explanation + date + linked doc link), evidence section (linked transactions table: date/amount/counterparty; linked documents), `DecisionForm` (status select constrained to valid next statuses from current — expose `isValidTransition` via a tiny `registry.validNext({kind,from})` query added to the router; explanation textarea REQUIRED; optional document select from vault; optional blocker note; override path: when an invalid target is picked show the override-reason field instead of blocking). Blocker banner (amber) when latest decision has blockerNote. Debt page: same shape + principal-vs-claimed display + auto-surfaced related logbook entries. Copy: supportive, statuses framed as process steps.

- [ ] Manual verification: full decision walk identified→allowed→to-cancel→canceled on a test item incl. one override; timeline renders all four; verify page still green (chain intact). Build green. Commit `feat(web): registry detail screens with ledgered decisions`.

### Task 11: Import screen + queue cards

**Files:**
- Create: `apps/web/src/app/(app)/registry/import/page.tsx`, `apps/web/src/components/statement-upload.tsx`
- Modify: `apps/web/src/components/suggestion-card.tsx` (add `registry-item` + `debt` branches), `packages/api/src/routers/suggestions.ts` (add `approveRegistryItem({id, item: itemCreateInput})` → creates financial_items row with `discoveredVia` from payload + links evidence transactions + marks suggestion approved/edited (deep-compare like approveEntry); `approveDebt({id, debt: debtCreateInput})` likewise)
- Test: extend `packages/api/src/routers/suggestions.test.ts` with both approve paths

**Requirements:** upload component mirrors `upload-drop.tsx` but posts to `/api/registry-import` and renders the ingest summary (inserted/skipped/errors, link to queue). Registry-item card: proposed name+category editable, charge evidence inline ("12 charges · €142,80/mo · last Aug 3", from payload transactionIds count + typicalAmount), unresolved-aggregator notice when `resolved:false` ("Waiting for receipt lookup — you can also fill it in yourself"), buttons "Add to registry" / "Not a subscription". Debt card: creditor + claimed amount + "This looks like a debt collector" note, "Add as debt" / "Not a debt".

- [ ] Failing API tests for both approve procedures first (incl. evidence-transaction linking + rejected suggestions unaffected) → implement → PASS. Manual: upload the ABN fixture through the UI, watch candidates reach the queue (run mine manually or wait for cron in dev worker), approve one into the registry. Build green. Commit `feat: statement import UI and registry queue cards`.

### Task 12: VerderGroep export + eval extension

**Files:**
- Create: `apps/web/src/app/registry/export/page.tsx` (+ passthrough layout — OUTSIDE the `(app)` group exactly like `verify/export`), `apps/worker/src/eval/samples-registry.json`, `apps/worker/src/eval/run-registry-eval.ts` (script `registry-eval`)
- Modify: `apps/web/src/app/(app)/registry/page.tsx` (add "Export report" link)

**Requirements:** print-styled report, formal register, header "Financieel overzicht — M. van der Poel" + generation date + chain head hash; sections: per status group a table (item, provider, cost/cycle, monthly-normalized, latest explanation), debts table (creditor, claimed, status), totals row; footer identical hash-chain statement to the logbook export. Eval: ≥8 payee samples (Dutch energy/telecom/streaming/insurance + 2 incasso) with expected `{category, isDebtCollector}`; runner mirrors `run-eval.ts`, prints score with `REGISTRY_PROMPT_VERSION`.

- [ ] Manual: export renders with seeded data, print-preview clean, no app nav. Run registry eval against homelab Ollama, record `N/M` in the commit message. Commit `feat: VerderGroep registry export and payee-classification eval (baseline: N/M)`.

### Task 13: Deploy to homelab + post-deploy verification

**Files:** none new (ops task) — read `CLAUDE.md` and `docs/deploy.md` first.

- [ ] Sync repo: `rsync -a --delete --exclude node_modules --exclude .next --exclude .turbo --exclude vault-files --exclude '.env' --exclude '.env.local' --exclude '.env.prod' --exclude secrets ./ homelab:~/apps/verder/`, then on homelab `pnpm install --frozen-lockfile`.
- [ ] Migrations as admin (source `secrets/role-passwords`, `POSTGRES_PASSWORD` from `.env.prod`): `DATABASE_URL="postgres://verder:$POSTGRES_PASSWORD@127.0.0.1:5432/verder" pnpm --filter @verder/db migrate`.
- [ ] `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web worker`.
- [ ] Verify: `/registry` reachable through the tunnel (curl with session like earlier deploys); worker logs show `registry.mine` cron registered; run nightly-verify (chain green); run `./ops/nightly.sh` → NAS backup includes new tables.
- [ ] Commit nothing on homelab; report status. Mac-side: commit any deploy-doc updates, push.

---

## Post-plan notes for the executor

- Order: 1→2→3 strictly; 4 is independent of 1–3 (parallel-safe); 5 needs 1+4; 6 needs 4; 7 needs 3(enum? no — needs 1 schema + 6 + suggestions table)+5+6; 8 needs 7; 9–12 need 3 (and 11 needs 7's kinds); 13 last.
- Read the ACTUAL repo code before every task — sub-project 1 shipped with reviewed deviations from its own plan; the repo is the truth, this plan names the patterns to follow.
- Dev DB: never truncate shared tables (append-only!); tests assert only on rows they created. `assertSafeToTruncate` exists for the one legacy verify test — do not add new truncation.
- The suggestions enum ALTER (Task 7) cannot run inside a transaction block in Postgres <16 style tooling — if drizzle wraps it, use a custom migration with `-- custom` raw statements outside a transaction, verify with a fresh migrate on dev.
- After Task 13, run the golden-rule evals (entry + registry) on the homelab and record both scores in `CLAUDE.md`.


