# Financial Registry — Design Spec

**Date:** 2026-08-18
**Status:** Approved design, pending implementation plan
**Sub-project:** 2 of the verder platform (sub-project 1: logbook + vault, shipped 2026-08-18 — see `docs/superpowers/specs/2026-08-18-logbook-vault-design.md`)

## Purpose

Give Martin and VerderGroep one complete, evidence-backed picture of his financial obligations: every subscription and recurring contract (with the mandatory→canceled decision workflow), and every debt (with its settlement status) — populated by manual entry plus automated discovery from bank statements, PayPal, and email receipts. Solves the "I lost track" problem and produces the overview VerderGroep needs during Bewindvoering/WSNP onboarding.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Evidence regime | **Mixed**: fact tables (`financial_items`, `debts`, `transactions`) are editable; status decisions + explanations (`registry_decisions`) are insert-only and hash-chain ledgered |
| Coverage | Everything: subscriptions, recurring contracts (rent, energy, insurance, telecom…), AND debts (creditors, amounts, settlement status) |
| Population | All three: manual entry + bank-statement mining + email-receipt mining |
| Statement sources | ABN AMRO CAMT.053 (XML, preferred — has creditor IBAN + direct-debit mandate IDs), ABN AMRO TSV, PayPal activity CSV |
| Aggregators | `APPLE.COM/BILL` and PayPal statement lines are resolved into real subscriptions via targeted Gmail receipt searches around each charge date |
| Review | Miners never write to the registry; all candidates flow through the existing suggestions review queue as new kinds (`registry-item`, `debt`). Nothing becomes record without Martin's approval |
| AI role | Ollama classifies (display name, category, debt-collector flag) — never decides. Corrections recorded per the golden rule |

## Data model

### Editable fact tables (normal UPDATE allowed — a typo is a typo)

- **`financial_items`** — one row per subscription/contract: `name`, `category` (energy, insurance, telecom, streaming, software, housing, other), `providerPartyId` → parties, `amountCents` + `billingCycle` (monthly/quarterly/yearly/irregular), `paymentChannel` (direct-debit, paypal, apple, invoice), `contractStart`/`contractEnd`, `noticePeriod`, `cancellationMethod` (email/phone/letter/portal) + free-text cancellation details, `accountNumber`/customer reference, `discoveredVia` (manual, bank, paypal, apple, email).
- **`debts`** — one row per creditor relationship: `creditorPartyId` → parties, `principalCents`, `claimedCents` (diverges from principal with collection fees), `references` (dossier/invoice numbers), `origin` (business/private) + free-text origin story.
- **`transactions`** — imported statement rows: `source` (abn-camt053, abn-tsv, paypal-csv), `bookedAt`, `amountCents` (signed), counterparty name + IBAN, description, direct-debit `mandateId` (when present), `statementSha256` (the vault file this row came from) + `rowIndex`, `parseError` flag with raw row text for unparseable rows, optional `financialItemId` link. Idempotency key: (`statementSha256`, `rowIndex`).

All money in **integer cents**. Never floats.

### Ledger-backed decision spine (insert-only; UPDATE/DELETE revoked by grants)

- **`registry_decisions`** — points at exactly one of `financialItemId` | `debtId`: `status` — for items `mandatory / allowed / requested / to-cancel / canceled`; for debts `identified / acknowledged / disputed / in-settlement / settled` — plus `explanation` (Martin's "why this must stay / alternative suggestion" text), optional `documentId` (cancellation letter, creditor claim), optional `blockerNote` (e.g. "keep until mailbox migration complete"). Every insert appends a `ledger_events` row in the same transaction (event types `registry.decision`). Current status = latest decision row; items/debts without decisions default to `identified`.
- Status transitions validated (e.g. no `canceled` without prior `to-cancel`); explicit override allowed but the override reason is itself recorded in the decision row.

### Suggestions (existing table, new kinds)

- `kind: "registry-item"` — proposed payload: `{ name, category, amountCents, billingCycle, paymentChannel, counterpartyName, counterpartyIban, mandateId, evidenceTransactionIds, receiptRawEmailIds, aggregator: null | "apple" | "paypal", resolved: boolean }`.
- `kind: "debt"` — proposed payload: `{ creditorName, claimedCents, references, evidence… }`.
- Dedup includes previously **rejected** suggestions — a rejected candidate must not reappear on every re-mine.

## Mining pipeline

1. **Statement upload** (`/registry/import`): raw file → vault first (content-addressed, `document.ingested` ledger event), then parsed. Parse summary shown ("214 transactions, 12 recurring candidates, 3 aggregator lines"). Unparseable rows kept with `parseError` + raw text, never dropped. Encodings handled explicitly: ABN latin-1, PayPal UTF-8 BOM.
2. **Recurring detection** (plain code, no AI): group by mandate ID ▸ counterparty IBAN ▸ normalized name; candidate = ≥2 charges, stable cadence (tolerance for day drift), similar amounts (tolerance for e.g. energy bill drift); refunds/credits not counted as charges.
3. **Aggregator resolution**: candidates whose counterparty is Apple/PayPal are flagged unresolved; targeted Gmail searches fire per charge date (`from:apple.com receipt after:X before:Y`; PayPal equivalents). Receipts ingest through the normal evidence-first email path (raw RFC822 → vault); their line items become resolved candidates linked to both receipt and statement line. If no receipt found: candidate surfaces as needs-manual ("payee unknown, needs your eyes") — never dropped.
4. **Classification** (Ollama): display name, category, debt-collector flag (incasso/deurwaarder detection). Model, prompt version, and Martin's corrections recorded (golden rule).
5. **Dedup**: candidates matched to existing `financial_items` by mandate/IBAN/name-similarity; matches auto-link the new transactions as evidence instead of creating duplicate suggestions.

## Screens

- **`/registry`** — tabs Subscriptions & contracts | Debts; grouped by status with monthly-cost rollups per group and headline totals ("€412/mo total, €180 to-cancel"); filters by category/status; discovery-source badges; "+ Add" and "Import statement".
- **`/registry/[id]`** (item) — editable facts panel; read-only ledger-backed decision timeline (every status + explanation, newest first); linked evidence (transactions, receipts, contract documents); status-change form (new status + explanation + optional document). Blockers get an amber "keep until…" banner.
- **`/registry/debts/[id]`** — creditor, principal vs claimed, references, settlement timeline, auto-surfaced logbook entries + documents involving that creditor (via parties link).
- **`/registry/import`** — drag-and-drop statement upload with parse summary; candidates go to the queue.
- **`/queue`** — two new card types: registry-item (charge-history evidence inline, editable name/category, Add / Not a subscription) and debt cards.
- **VerderGroep export** — print-styled report (like the logbook court report): all items + statuses + costs + explanations + chain head hash. Formal professional register (tone rule).
- **Dashboard tile** — "Registry: N items · €X/mo · N decisions pending."

## Error handling

- Parsers fail loudly per file; malformed files still stored in vault; per-row parse status reported.
- All ingestion idempotent (statement sha256+row; suggestion dedup incl. rejected).
- Aggregator resolution degrades to needs-manual, never silent drop.
- `registry_decisions` insert + ledger append in one transaction; transition validation with recorded overrides.
- Integer cents everywhere.

## Testing

- Parser fixtures: anonymized ABN CAMT.053, ABN TSV, PayPal CSV — encoding traps, negative amounts, refunds.
- Recurring-detection property tests: day-drift cadence, amount drift, refunds excluded, aggregator flagging.
- Dedup tests: IBAN match, renamed counterparty, near-miss names that must NOT merge.
- Ledger: verifier suite extended to `registry.decision` events — tampering must break verification.
- Eval extension: payee-classification samples (Dutch energy, incasso bureaus, streaming) added to the golden-rule eval set.

## Out of scope for this sub-project

Automatic cancellation execution (writing cancellation letters/emails — agent territory), bank API connections (PSD2/open banking — manual exports only for v1), debt settlement calculations (WSNP boedelafdracht math — VerderGroep's job), multi-user visibility of the registry, non-ABN bank parsers.

## Tone

Registry UI toward Martin: supportive, judgement-free (statuses are process states, not failures). VerderGroep export: formal, professional, official register.
