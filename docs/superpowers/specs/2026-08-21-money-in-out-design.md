# Money In / Money Out — Design Spec

**Date:** 2026-08-21
**Status:** Built. Amended 2026-08-22 against Martin's real ABN export — the income rules below (Money in 1, 2 and 4) and the coverage arithmetic say what the code does, which is not what this document first proposed.
**Oracle:** `packages/api/src/money-series.real.test.ts` — his actual credits, cross-checked against the July payslip to the cent. Every income rule here was measured against it; none may be re-tuned without it.
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
| Which credits count | **Recurring only — and "recurring" is a fact about the PAYER, not about the amounts.** Money from a counterparty that pays on a cadence is that line's income whatever its size. A credit from a payer with no cadence (a belastingteruggave, an OpsMate invoice) never reaches a bar and is disclosed per month. Amended on evidence: see Money in rule 1. |
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
- `registry_decisions` — effective status via the existing `packages/api/src/registry-decide.ts`. One addition, and it is a read: `effectiveStatuses` resolves a batch of items in one `DISTINCT ON` query instead of one query per item, because `money.series` runs on every dashboard render. It must stay in lockstep with `effectiveStatus` — same join, same "latest is the ledger `seq` of the `registry.decision` event", same `identified` default.

Because the view only derives, `/verify` and the hash chain are untouched by this sub-project.

## Derivation rules

All of the following lives in a pure, database-free `packages/api/src/money-series.ts` — no I/O and no import from `@verder/db` — taking rows in and returning a series out, so every rule below is unit-testable without a database.

### Money out

Every debit in the month, grouped by the `category` of the `financial_item` its `financialItemId` points at. Unlinked debits accumulate into **overig**. Items decided `canceled` keep their historical bars — history is history; only the projection changes.

### Money in

1. Credits are grouped by `detectRecurring` in `@verder/parsers` (mandate ▸ counterparty IBAN ▸ normalized name; ≥2 charges; stable cadence with day-drift tolerance). It hard-filtered `amountCents < 0`; it gains an option `direction: "debit" | "credit"` **defaulting to `"debit"`**, so every existing caller is unaffected.

   **The amount gate is SKIPPED for credits** (commit `14fc32a`). detectRecurring rejects a non-mandate group in which any charge sits more than 40% from the median, which is right for a subscription and wrong for a wage: TrueFullstaq paid Martin **€ 648,00 / € 2.660,68 / € 1.118,65** in three consecutive months — a real monthly salary with a part-month at the end, because he left on 10 June — and the gate threw the whole group away, drawing **€ 0,00 income for April and May** in months where € 5.006,31 arrived. For credits the signal is the counterparty plus the cadence, and the size is left to the caller. This is what makes "recurring only" a statement about the payer: an outlier inside a cadenced line (a vakantiegeld from the employer's own IBAN) is still that month's income, it just never sets the figure projected forward (rule 2). A one-off from a stranger forms no group of two and so never reaches a bar at all.
2. **Continuation rule.** Group B continues group A — rendering as a single income line labelled with both names ("TrueFullstaq → Saurens Marketing") — when all three hold:
   - B's first credit falls within `1.5 ×` A's cadence of A's last credit,
   - their **full-period amounts** differ by no more than `INCOME_CONTINUATION_TOLERANCE_NUM / _DEN`,
   - A has no credit at or after B's first.

   Chains resolve iteratively, so two successive employer changes still form one line. The tolerance is **1/2, held as an integer numerator and denominator** the way `detectRecurring` spells its own bands — the comparison is in cents and money math here never touches a float. It is **measured, not guessed**: the original 0.25 refused Martin's own June 2026 job change, a 33,7% raise from € 2.660,68 to € 3.556,42, so the chart told him his income had ended and something smaller had begun. 1/2 clears that with room, and the link still needs the same cadence, a stopped predecessor and a start within one cadence — three conditions a toeslag arriving beside a salary cannot satisfy.

   The compared figure is `fullPeriodAmount`, **not** the median: a part-month is normal at *both* ends of a job change and drags a median down. The rule is the median of every amount within 15% of the line's largest. **The known hole:** a lump vakantiegeld bigger than the monthly salary is alone in that top band and would set it, so the line projects forward at holiday pay. It does not touch Martin (Saurens pays his 8% monthly, inside the € 5.250 gross). **The obvious fix — fall back to the median of the rest when exactly one amount is in the top band and the line has ≥3 rows — is REFUSED on measurement:** TrueFullstaq's real triple is exactly that trigger, the fallback returns € 883,32 instead of € 2.660,68, the continuation link to Saurens then fails its size test, and the projection becomes € 4.439,74 by counting a job he had already left. The hole stays open until a rule closes it without touching a real part-month.
3. Leefgeld needed one special case after all: it is paid **weekly**, and `cadenceOf` knew only monthly, quarterly and yearly, so the leefgeldrekening had no income line at all. A 5–9 day `weekly` band exists in the **credit direction only** — `registry-mine.ts` writes a cadence straight into the `billing_cycle` enum, which has no `weekly` value, and this sub-project adds no migration beyond 0022.
4. **Internal transfers** are excluded: a credit whose counterparty IBAN also appears as a debit within ±5 days whose absolute amount is within 1% of the credit. **A matched debit is CONSUMED** — the discipline `resolveDocumentUpdatedHashes` in `verification.ts` had to learn, for the same reason: without it one € 500 transfer out disqualified *two* € 500 credits, erasing € 1.000 of income and disclosing twice what had moved. Understating income is the failure this page exists to prevent, so the pairing is one-to-one: credits are walked oldest-first and each takes the nearest-in-time unclaimed leg, so neither the answer nor the disclosure depends on row order. Excluded rows are listed beneath the chart — never silently dropped.
5. Credits that are neither recurring nor internal are **incidenteel**: excluded from the bars and disclosed per month — the total *and the rows behind it*, dated and named, never truncated. A cent figure on its own cannot be checked: it does not say which credit was left out, so a belastingteruggave and a credit the rules got wrong look identical. Both totals are summed **from** those lists rather than filtered a second time, so the figure and the rows cannot drift apart.

### Projection

Three months beyond the last complete month, rendered dashed. The **last complete month** is the latest calendar month entirely inside the statement coverage union — not the month containing the newest transaction, which is almost always half-imported and would project from a partial figure. Projection is drawn **per account**, from that account's own history: after the handover the beheerrekening projects income and contracted costs, while the leefgeldrekening projects only the leefgeld line it actually receives.

- **in** — each active income line at its cadence amount. A line with no credit in the last completed period stops projecting; a job that ended must not keep paying on a chart.
- **out** — `Σ monthlyCents(item)` over items whose effective status is not `canceled`.
- **out, after cancelling** — a second dashed series with `to-cancel` items removed as well, labelled *na opzeggen*. This is **a target, not a schedule**: `financial_items.notice_period` is free text and is deliberately not parsed into a date claim.

### Months, accounts and coverage

- A month is a calendar month in Europe/Amsterdam.
- Series are **per account**. The bewind handover is drawn as a labelled boundary — beheerrekening before, leefgeld after — and no series is drawn through it as if it were one continuous story.
- **Coverage:** for each `statementSha256`, min/max `bookedAt` is that statement's covered range. A month not fully inside the union of those ranges renders **hatched** and labelled *mogelijk incompleet*. A month with no rows at all renders as a **gap** reading *geen data* — never as €0.
- The coverage arithmetic is in **Amsterdam calendar days**, not instants, and **abutting statements merge**. Both are measured corrections: a period exported in two halves (1–15 and 16–30 June) never overlaps, so merging on overlap alone hatched a June Martin has every row of; and comparing UTC instants against months bucketed in Amsterdam disagreed by the offset, so a statement whose first booking is 01:00 UTC on the 1st failed a `<= UTC midnight` test for a month it demonstrably starts in. A one-day hole between two statements still reads *partial* — one day of bookings nobody can see.
- `parseError` rows count toward no total, and each affected month reports how many were unreadable. An account's month range is taken from the rows that could be **read**; an account with nothing but unreadable rows keeps its import-dated range, because a failed import must be visible rather than silently absent.

## Screens

### `/money`

- **Header** — for the last complete month: in, out, what's left; each figure naming its account. That subtraction is asymmetric on purpose — *vast inkomen* is recurring credits only while *uitgaven* is every debit — so in a month with an incidental credit *blijft over* reads worse than the bank does, and the card says so **next to the figure**. The rule is measured and stays; what cannot stay is meeting the shortfall two screens before the footnote that explains it. Where there is more than one account the cards carry a line saying they must not be added: leefgeld is income on the leefgeldrekening and an `overig` cost on the beheerrekening — the same money from both ends.
- **Chart** — months across, in and out per month. Four visually distinct bar states: **solid** (actual), **dashed** (projected), **hatched** (coverage incomplete), **gap** (no data). The account handover is a marked vertical boundary with a label on each side. The projection starts after the last **complete** month, which is normally the partial newest month already drawn as an actual, so that first projected column is dropped per account: two adjacent columns both labelled *jul '26* read as five months of a four-month history. The real bank rows win.
- **Where the fixed income comes from** — the income lines themselves, per account: the joined label, a *voortgezet* tag where a successor was folded in, the cadence and what one full period pays. The continuation fold is the single feature that keeps Martin's chart from reporting his income as ended in June 2026; a bar he cannot trace back to a name is a number he has to take on faith.
- **Legend / category focus** — clicking a category refocuses the chart to that category over time. The focus lives in the URL (`/money?cat=energie`) so the view is linkable and survives a reload rather than hiding in client state.
- **Drill panel** — clicking a month opens a panel below: categories → the registry items inside each → the bank rows behind each item, every row linking to its statement document in the vault.
- **Disclosures** — beneath the chart: incidental credits not counted, internal transfers excluded, unreadable rows, and coverage gaps. Everything the bars leave out is visible on the same screen, as a total **with its rows under it** — date, tegenpartij, bedrag, never truncated, because a list that stops at five hides exactly the row someone went looking for.
- **Empty state** — production has no transactions. The page must say so plainly and link to `/registry/import`, never render empty axes.

### Dashboard

A compact six-month version of the same series, linking through to `/money`.

Colours for categories come from the `dataviz` skill at implementation time; they must read correctly in both light and dark themes.

## Error handling

- Every exclusion is disclosed on the page. The number VerderGroep reads must never be silently understated.
- A month with partial statement coverage is hatched, not shortened; a month with no data is a gap, not a zero.
- Rows with `parseError` are counted nowhere and reported per month.
- Rows whose `account_iban` is NULL form their own "unknown account" series and are never merged into a known account.
- **A row that could not be parsed still knows which statement it came out of, and that is evidence.** The importer gives an error row the statement's own account when every readable row in the file names the same one (an ABN export is one account per file; rows that disagree, or a source with no account at all, keep NULL), and the **earliest readable booking of that import** rather than `new Date()`. Written the old way, a single malformed line put a permanent hatched "onbekende rekening" card on `/money`, dated today. The date is a placeholder that puts the row inside the period the statement covers; `rawRow` keeps the truth that its real date is unknown.
- **A discarded statement document must not erase its transactions.** The document link is evidence, not ownership. Given what shipped on 2026-08-20, this gets an explicit test.
- Integer cents throughout; `monthlyCents` already uses integer division. No floats anywhere in the series.

## Testing

- **The oracle** (`money-series.real.test.ts`): Martin's actual credits from the ABN statement 24-04 t/m 02-08-2026, cross-checked against the July payslip (cumulative netto € 6.044,13 = € 2.487,71 + € 3.556,42, to the cent). It is kept apart from the invented fixtures because every assertion in it is a fact about a real bank statement. It exists because the first implementation, measured against these rows, drew € 0,00 for April and May and projected € 3.022,06 where the real forward salary is € 3.556,42. **No income rule may be changed without measuring against it**, and no rule may be tuned to make any other test pass.
- **Pure module** (`money-series.test.ts`): the continuation rule with Martin's June 2026 employer switch as the named fixture; cadence day-drift; a cadenced outlier counted as income but never projected from; internal transfers excluded, and one debit never spent twice; incidental and internal disclosures listing their rows, each summing to its own total; coverage union math including abutting statements, a real gap, and the Amsterdam-day boundary; a month with zero rows resolving to *geen data* rather than €0. `fullPeriodAmount([64_800, 266_068, 111_865])` is pinned here so a rewrite has to face the numbers behind the refused fallback.
- **Chart rules** are extracted into pure modules and unit-tested without React or a DOM stack — `money-columns.ts` (which columns, in what order), `money-marks.ts` (what each column paints: gap, hatch, dim, outline), `money-disclosures.ts` (how an income line is labelled). The components map those decisions to SVG and JSX and decide nothing about money.
- **Parsers**: CAMT.053, ABN TSV and ABN XLS each yield the statement's own account IBAN; a statement without a recoverable account yields NULL and does not throw.
- **`detectRecurring`**: the new `direction` option defaults to `"debit"` and every existing caller's behaviour is unchanged; credit-direction grouping proven on a fixture.
- **Router** (`money.test.ts`): a seeded DB across two accounts spanning the handover, every assertion scoped to IBANs and statement digests the run invents, because the dev postgres is shared; transactions surviving the discard of their statement document. The **empty state is asserted against a stubbed `Db`, not the dev database** — the shared database always has transactions, and deleting rows to see the empty state would mean rewriting an append-only table to pass a test.

## Out of scope for this sub-project

An income table or any manually entered income; notice-period parsing and therefore any dated cancellation forecast; a VerderGroep-facing printable export of this page; budget targets or advice ("you could save X"); anything predicting the WSNP boedelafdracht or the vrij te laten bedrag — that is VerderGroep's calculation, not this app's; bank API connections; automatic cancellation execution.

## Tone

Toward Martin: this page reports, it never judges. Statuses are process states, categories are facts, and a month that got worse is a fact too. The green *na opzeggen* line exists because the point of the page is that something can be done, not that something went wrong.
