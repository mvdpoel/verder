# Money In / Money Out — Design Spec

**Date:** 2026-08-21
**Status:** Approved design, pending implementation plan
**Sub-project:** 5 of the verder platform
**Builds on:** sub-project 2 (financial registry — `docs/superpowers/specs/2026-08-18-financial-registry-design.md`, shipped 2026-08-19)

## Purpose

One page that answers three questions Martin cannot answer today: what comes in, what goes out, and what is left. Month by month, from evidence already in the ledger — actual bank rows for the past, the registry's contracted costs for the near future, and a second projected line showing what the `to-cancel` decisions would give back if they land.

Subscriptions and contracts already exist as a registry (`financial_items` + `registry_decisions`, with the mandatory → allowed → requested → to-cancel → canceled workflow). Income has never been modelled at all. This sub-project adds the income side and the visual surface. It adds **one additive column and no new tables**, appends no `ledger_events`, and asserts nothing: every figure on the page is derived from evidence that is already there.

## Evidence behind these decisions

Read from Gmail (read-only) on 2026-08-21. These are facts about Martin's actual situation, and each one forced a design decision:

| Observed | Consequence for the design |
|---|---|
| 18 Aug 2026, regio3@verderbewindmidden.nl: betaalpas for the **leefgeldrekening** sent; 5 Aug: Martin asks whether VerderGroep has already taken over the ABN account | From ~early August income lands on the **beheerrekening** and VerderGroep pays the fixed costs. Charting one undifferentiated stream would draw a collapse in August that never happened. Forces the account dimension (see Data model). |
| Employer change: loonstrook June 2026 from TrueFullstaq / The Digital Neighborhood; Docusign arbeidsovereenkomst completed 9 June 2026 with a new employer; 30 July: "nog geen loonstrook, wel al salaris" | Recurring-income detection keyed on counterparty identity breaks precisely across May–August. Forces the continuation rule. |
| OpsMate: BTW-aangifte Q2 2026, zakelijke Odido factuur, Trust & Law / PLM Investments II collection re Qred | Business income is irregular by construction and is excluded by the recurring-only rule. Must be disclosed per month, not silently dropped. |
| 12 Aug 2026: aanvraag bijzondere bijstand for bewindvoeringskosten + individuele inkomenstoeslag | A new recurring cost and a new recurring income line are already in flight; neither may require code changes to appear. |
| Contracts visible in mail: Vattenfall, Vattenfall InCharge, Vitens, zorgpolis 2026, RISK via Geencentteveel, TransIP, Odido, IPTV Totaal, Amazon Prime, Bright Pensioen | Free seed list for the (currently empty) registry. Not part of this sub-project's code, but recorded here so the work isn't redone. |

Production state at design time: `financial_items`, `debts`, `transactions` and `registry_decisions` all hold **0 rows**. The page must therefore treat "empty" as its normal first state, and the migration below costs no backfill.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Income model | **Actuals only** — no income table. Income is derived from positive `transactions` rows. |
| Which credits count | **Recurring only.** One-off credits (vakantiegeld, 13e maand, belastingteruggave, OpsMate invoices) are excluded from the bars and disclosed as a per-month footnote. |
| Chart shape | **Trend over months**, in versus out, not a Sankey or a waterfall. |
| Costs side | **Actuals for the past, projection for the future** — solid bars from real debits, dashed bars from registry contracts, plus a second dashed series with the `to-cancel` items removed. |
| Interaction | Month click → categories → items → bank rows → statement in the vault; **plus** category focus from the legend, carried in the URL. |
| Where the arithmetic lives | **Derived on read.** A `money` tRPC router over a pure `money-series` module. No rollup table, no materialization, no ledger events. |
| Accounts | New additive `transactions.account_iban`; the chart marks the bewind handover instead of drawing through it. |

## Data model

### One additive migration

`0022_transactions_account_iban` — `ALTER TABLE transactions ADD COLUMN account_iban text;` Nullable, no default, no backfill (production holds zero transactions; this is the cheapest this change will ever be). Same additive shape as 0020 and 0021.

The parsers must populate it:

- **CAMT.053** — `Stmt/Acct/Id/IBAN`. Today `camt053.ts` reads only the *counterparty* IBAN (`CdtrAcct`/`DbtrAcct`, around line 139); the statement's own account is discarded.
- **ABN TSV** and **ABN XLS** — the account column present in each export.
- Rows whose account cannot be determined keep `NULL` and are treated as belonging to an **unknown account**, which is rendered as its own series rather than merged into a known one.

### Nothing else is added

No income table, no rollup table, no new evidence table, no new `ledger_events` type. The page reads:

- `transactions` — signed cents, `bookedAt`, `financialItemId`, `parseError`, `statementSha256`, and now `accountIban`
- `financial_items` — `category` and `monthlyCents()` (already exported from `packages/api/src/routers/registry.ts`)
- `registry_decisions` — effective status via the existing `packages/api/src/registry-status.ts`

Because the view only derives, `/verify` and the hash chain are untouched by this sub-project.

## Derivation rules

All of the following lives in a pure, dependency-free `packages/api/src/money-series.ts`, taking rows in and returning a series out, so every rule below is unit-testable without a database.

### Money out

Every debit in the month, grouped by the `category` of the `financial_item` its `financialItemId` points at. Unlinked debits accumulate into **overig**. Items decided `canceled` keep their historical bars — history is history; only the projection changes.

### Money in

1. Credits are grouped by `detectRecurring` in `@verder/parsers`, which already implements exactly the needed rule (mandate ▸ counterparty IBAN ▸ normalized name; ≥2 charges; stable cadence with day-drift tolerance; similar amounts). It currently hard-filters `amountCents < 0`. It gains an option `direction: "debit" | "credit"` **defaulting to `"debit"`**, so every existing caller is unaffected.
2. **Continuation rule.** Group B continues group A — rendering as a single income line labelled with both names ("TrueFullstaq → Saurens Marketing") — when all three hold:
   - B's first credit falls within `1.5 ×` A's cadence of A's last credit,
   - the two medians differ by no more than `INCOME_CONTINUATION_TOLERANCE`,
   - A has no credit at or after B's first.

   Chains resolve iteratively, so two successive employer changes still form one line. `INCOME_CONTINUATION_TOLERANCE` starts at **0.25** (25% of the earlier median) and is a **named constant carrying a comment that this value is a guess until measured against Martin's real ABN export** — the same discipline as `SEMANTIC_MAX_DISTANCE` in `search/retrieve.ts`. A wrong tolerance is visible, not silent: too tight splits one salary into two lines, too loose merges a salary with a toeslag.
3. Leefgeld needs no special case: it arrives as a recurring credit from VerderGroep on the leefgeldrekening and is detected like any other income line.
4. **Internal transfers** are excluded: a credit whose counterparty IBAN also appears as a debit within ±5 days whose absolute amount is within 1% of the credit. Excluded rows are listed beneath the chart — never silently dropped.
5. Credits that are neither recurring nor internal are **incidenteel**: excluded from the bars, summed into a per-month footnote ("€1.842 incidenteel niet meegeteld"), so the arithmetic still reconciles.

### Projection

Three months beyond the last complete month, rendered dashed. The **last complete month** is the latest calendar month entirely inside the statement coverage union — not the month containing the newest transaction, which is almost always half-imported and would project from a partial figure. Projection is drawn **per account**, from that account's own history: after the handover the beheerrekening projects income and contracted costs, while the leefgeldrekening projects only the leefgeld line it actually receives.

- **in** — each active income line at its cadence amount. A line with no credit in the last completed period stops projecting; a job that ended must not keep paying on a chart.
- **out** — `Σ monthlyCents(item)` over items whose effective status is not `canceled`.
- **out, after cancelling** — a second dashed series with `to-cancel` items removed as well, labelled *na opzeggen*. This is **a target, not a schedule**: `financial_items.notice_period` is free text and is deliberately not parsed into a date claim.

### Months, accounts and coverage

- A month is a calendar month in Europe/Amsterdam.
- Series are **per account**. The bewind handover is drawn as a labelled boundary — beheerrekening before, leefgeld after — and no series is drawn through it as if it were one continuous story.
- **Coverage:** for each `statementSha256`, min/max `bookedAt` is that statement's covered range. A month not fully inside the union of those ranges renders **hatched** and labelled *mogelijk incompleet*. A month with no rows at all renders as a **gap** reading *geen data* — never as €0.
- `parseError` rows count toward no total, and each affected month reports how many were unreadable.

## Screens

### `/money`

- **Header** — for the last complete month: in, out, what's left; each figure naming its account.
- **Chart** — months across, in and out per month. Four visually distinct bar states: **solid** (actual), **dashed** (projected), **hatched** (coverage incomplete), **gap** (no data). The account handover is a marked vertical boundary with a label on each side.
- **Legend / category focus** — clicking a category refocuses the chart to that category over time. The focus lives in the URL (`/money?cat=energie`) so the view is linkable and survives a reload rather than hiding in client state.
- **Drill panel** — clicking a month opens a panel below: categories → the registry items inside each → the bank rows behind each item, every row linking to its statement document in the vault.
- **Disclosures** — beneath the chart: incidental credits not counted, internal transfers excluded, unreadable rows, and coverage gaps. Everything the bars leave out is visible on the same screen.
- **Empty state** — production has no transactions. The page must say so plainly and link to `/registry/import`, never render empty axes.

### Dashboard

A compact six-month version of the same series, linking through to `/money`.

Colours for categories come from the `dataviz` skill at implementation time; they must read correctly in both light and dark themes.

## Error handling

- Every exclusion is disclosed on the page. The number VerderGroep reads must never be silently understated.
- A month with partial statement coverage is hatched, not shortened; a month with no data is a gap, not a zero.
- Rows with `parseError` are counted nowhere and reported per month.
- Rows whose `account_iban` is NULL form their own "unknown account" series and are never merged into a known account.
- **A discarded statement document must not erase its transactions.** The document link is evidence, not ownership. Given what shipped on 2026-08-20, this gets an explicit test.
- Integer cents throughout; `monthlyCents` already uses integer division. No floats anywhere in the series.

## Testing

- **Pure module** (`money-series.test.ts`): the continuation rule with Martin's June 2026 employer switch as the named fixture; cadence day-drift; amount drift; refunds and internal transfers excluded; incidental credits surfacing as footnote totals, not bars; coverage union math including a gap between two statements; a month with zero rows resolving to *geen data* rather than €0.
- **Parsers**: CAMT.053, ABN TSV and ABN XLS each yield the statement's own account IBAN; a statement without a recoverable account yields NULL and does not throw.
- **`detectRecurring`**: the new `direction` option defaults to `"debit"` and every existing caller's behaviour is unchanged; credit-direction grouping proven on a fixture.
- **Router** (`money.test.ts`): seeded DB across two accounts spanning the handover; the empty state asserted explicitly; transactions surviving the discard of their statement document.

## Out of scope for this sub-project

An income table or any manually entered income; notice-period parsing and therefore any dated cancellation forecast; a VerderGroep-facing printable export of this page; budget targets or advice ("you could save X"); anything predicting the WSNP boedelafdracht or the vrij te laten bedrag — that is VerderGroep's calculation, not this app's; bank API connections; automatic cancellation execution.

## Tone

Toward Martin: this page reports, it never judges. Statuses are process states, categories are facts, and a month that got worse is a fact too. The green *na opzeggen* line exists because the point of the page is that something can be done, not that something went wrong.
