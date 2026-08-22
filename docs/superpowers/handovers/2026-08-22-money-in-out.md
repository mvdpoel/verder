# Handover — Money In / Money Out (sub-project 5)

**Written:** 2026-08-22
**State:** built, tested, pushed to `origin/main` at `bd0e617`. **Not deployed.**
**Spec:** `docs/superpowers/specs/2026-08-21-money-in-out-design.md`
**Plan:** `docs/superpowers/plans/2026-08-21-money-in-out.md`

## Where things stand

`/money` charts income against costs per month, per bank account, with a
projection. 16 commits are on `main`; the workspace is green (665 tests,
`pnpm -r typecheck` clean). **Migration 0022 is applied to the LOCAL dev
database only — production has never seen it, and no image has been rebuilt.**

The feature was built by a multi-agent workflow against a plan, then two rounds
of correction against Martin's **real bank data**, which broke assumptions the
design had made. What follows is the list of what is still wrong, in priority
order, plus the evidence needed to fix it honestly.

## The evidence everything is measured against

Two documents Martin supplied on 2026-08-21 (read-only; they live in his
Downloads, not in the repo):

- ABN statement, period 24-04-2026 t/m 02-08-2026, account **`56.65.67.741`**
- Salarisspecificatie juli 2026, Saurens Marketing B.V., paid to
  **`NL12ABNA0566567741`** — the same account, the official notation

His real credits, now the regression fixture in
`packages/api/src/money-series.real.test.ts`:

| Date | Counterparty | Amount | Note |
|---|---|---|---|
| 24-04 | TrueFullstaq B.V. | € 648,00 | |
| 22-05 | TrueFullstaq B.V. | € 2.660,68 | a full month |
| 27-05 | Belastingdienst | € 1.665,49 + € 32,14 | teruggave — incidenteel |
| 25-06 | TrueFullstaq B.V. | € 1.118,65 | part-month; he left 10 June |
| 28-06 | Saurens Marketing | € 2.487,71 | part-month; started 10 June |
| 28-07 | Saurens Marketing | € 3.556,42 | first full salary |

Cross-check that makes the fixture trustworthy: the payslip's cumulative netto
is € 6.044,13, and 2.487,71 + 3.556,42 = **6.044,13** exactly.

Other facts that shaped the design and must not be re-derived:

- **Rent** is WOONHAVE BELEGGINGEN by incasso on the 1st: € 1.740,09 (1 June) →
  € 1.816,65 (1 July).
- **Vakantiegeld at Saurens is paid monthly** (8% = € 420 inside € 5.250 gross),
  so no May lump sum is coming.
- **VerderGroep took over the ABN account in early August 2026**; Martin now has
  a leefgeldrekening. Income and fixed costs after the handover land on the
  beheerrekening, which he cannot export. `buildMoneySeries` returns one series
  per account and must never merge them.
- **Leefgeld is paid weekly.** `cadenceOf` gained a 5–9 day `weekly` band, gated
  to the CREDIT direction only, because `apps/worker/src/registry-mine.ts`
  writes `cadence` straight into the `billing_cycle` Postgres enum, which has no
  `weekly` value. Adding weekly to the debit direction needs a migration.

## Open work, in priority order

### 1. One debit can be spent twice (`splitInternalTransfers`)

`packages/api/src/money-series.ts`. `debits.find(...)` never consumes its match,
so one € 500 transfer out can disqualify **two** € 500 credits from income.
Reproduced: one −50000 debit plus two +50000 credits yields
`internalCents: 100000`. This both understates income — which the spec forbids
in as many words — and overstates the disclosure.

Fix: track consumed debit ids in a `Set`, prefer the nearest-in-time unmatched
leg rather than array order. The discard sub-project already got this discipline
right ("matched rows are CONSUMED, so an identical duplicate cannot vouch for
two events" — see `resolveDocumentUpdatedHashes` in `verification.ts`); carry it
over. Test: two credits against one debit, exactly one marked internal.

### 2. The UI hides what the engine knows

- **The continuation line is rendered nowhere.** `incomeLines` produces
  `labels: ["TrueFullstaq B.V.", "Saurens Marketing B.V."]` — the feature the
  spec argues hardest for — and `grep incomeLines apps/web/src` returns nothing.
  Martin should see *"TrueFullstaq → Saurens Marketing"* on the income bar.
- **Excluded internal transfers are totalled, not listed.** The spec says
  "listed beneath the chart"; only a cent figure is shown. A reader cannot see
  which credits were dropped or why.
- **"blijft over" is asymmetric and unmarked.** `inCents` counts recurring
  income only; `outCents` counts every debit. In any month with an incidental
  credit the header subtracts all spending from part of the income. Mark the
  figure, or make the disclosure adjacent to it rather than two screens down.
- **The two account cards must not be added together.** Leefgeld appears as
  income on the leefgeldrekening and as an `overig` cost on the beheerrekening.
  That is correct per "accounts are never merged", and a reader will still add
  them. Say so on the page.

### 3. Tests that do not exist yet

- **900 lines of UI have zero rendering tests** (`money-chart.tsx` 524,
  `money/page.tsx` 281, `dashboard-money.tsx` 72). Only the extracted pure
  helpers `money-columns.ts` and `dashboard-money-slice.ts` are covered — that
  extraction was done well; continue it rather than adding a DOM testing stack.
  Unasserted today: the `geen data` gap never renders a zero bar; the hatch
  paints on partial months; projected bars are outline-only; the `na opzeggen`
  outline appears; the account boundary lands between the right two columns; the
  legend link round-trips `?cat=`.
- **`money.test.ts` asserts no monetary figure at all** — three tests, none
  checking `inCents`, `outCents`, `incidentalCents` or `lastCompleteMonth`. The
  spec asked for two accounts spanning the handover; it seeds one.
- **The router-level empty state was ticked as manually verified but cannot have
  been** — the shared dev database always has transactions. Either assert it
  where it is provable or record honestly that it is not.

### 4. Correctness edges, each measured and each failing safe

- **One unreadable row invents a permanent phantom account.** Import errors are
  written with `accountIban: null, bookedAt: new Date()`, so a single malformed
  line puts an "onbekende rekening" card on `/money`, hatched, dated today,
  forever.
- **Abutting statements do not merge.** `coverageForMonths` merges on
  `r.from <= last.to` — strict overlap — so a June split across statements
  (1–15, 16–30) reads `partial` though the union covers the month. Merge on
  `<= last.to + DAY_MS`.
- **`monthBounds` builds UTC instants while `monthKey` buckets in Amsterdam.**
  Invisible while `bookedAt` is date-only midnight, which every current parser
  produces. Either fix or write the assumption down.
- **`fullPeriodAmount` would project from a lump vakantiegeld larger than the
  monthly salary.** Does not affect Martin (his is monthly), but it is a known
  hole: the largest amount sets the band. Consider falling back to the median of
  the rest when exactly one amount sits in the top band and the line has ≥3 rows.

### 5. Performance, harmless today and not tomorrow

`money.series` and `money.month` each `SELECT *` from `transactions` with no
filter and no bound, then filter in JS; `money.month` re-reads the whole table
on every drill click. `loadItems` fires one `effectiveStatus` query **per
registry item** (N+1) and runs on both procedures — and on every dashboard
render, since the compact block is on the home page. `byAccount.set(key, [...])`
copies the whole array per transaction, O(n²). Production has 0 transactions
today; three years of statements plus a seeded registry is the real load.

### 6. Documentation drift

The plan and the spec both predate two evidence-driven rule changes and now
disagree with the tree:

- `detectRecurring`'s amount gate is **skipped for credits** (commit `14fc32a`).
  The spec still describes eviction of one-off credits; the actual rule is that
  money from a counterparty with a cadence is that line's income whatever its
  size, and "recurring only" is enforced by the counterparty having a cadence.
- `INCOME_CONTINUATION_TOLERANCE` is gone, replaced by
  `INCOME_CONTINUATION_TOLERANCE_NUM/DEN` (1/2), **measured** from Martin's real
  33,7% raise rather than guessed at 0.25.
- Task 6 and Task 7 fixtures in the plan were replaced during execution; the
  plan still prints the originals with `[x]` ticks.

Update the spec first, then the plan, and note in `CLAUDE.md` that
`money-series.real.test.ts` is the oracle for this sub-project.

## Deploying (only after the above is green)

Martin has given standing authorization to ssh, push and deploy. Destructive
actions — dropping data, rewriting evidence tables, force-push, anything that
breaks the append-only ledger — still get confirmed first.

```bash
# 1. migration FIRST, from the homelab HOST, or every /money request 500s
ssh homelab 'cd ~/apps/verder && pnpm --filter @verder/db migrate'
# 2. then rsync the tree and rebuild web + worker
# 3. then verify, and report the real numbers, not an assumption
ssh homelab 'cd ~/apps/verder && docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T worker pnpm --filter worker nightly-verify'
```

Migration 0022 is additive and nullable, so old code ignores it — but new code
against an unmigrated database fails. This is the same trap 0020 and 0021 both
carried.

`/money` will be **empty** after deploy: production has 0 transactions. The
first real import is also the first real test — expect the numbers above.

## Project laws that constrain every fix here

- Evidence tables are append-only; every evidence mutation appends a
  `ledger_events` row in the same transaction. **This sub-project appends none
  and must keep it that way** — it derives, it never asserts.
- Integer cents everywhere. No floats. Tolerances as integer ratios, the way
  `detectRecurring` does it.
- Run every build and test with `env -u NODE_ENV`.
- `pnpm --filter <pkg> test -- <name>` does **not** filter vitest — the bare `--`
  is swallowed and the whole package suite runs. Use
  `cd <pkg> && env -u NODE_ENV pnpm exec vitest run <path>`.
- **Vitest does not typecheck.** A green suite is not evidence that the change
  compiles; run `pnpm -r typecheck` too. This caught real breakage twice.
- Tone toward Martin: supportive, never judging. This is his bewindvoering case,
  not a demo. A number that is wrong in the pessimistic direction — telling him
  he has no income when € 4.358 arrived — is the worst failure this app can have.

## One open item that is not code

The statement Martin sent is named "incl. huurbetaling 1 augustus" but contains
**no August rent payment** — its last booking is 31 July. 1 August 2026 was a
Saturday, so the incasso would have been collected Monday 3 August, after the
statement closed. If that document is meant as proof the August rent was paid,
it does not do that job, and there is an eviction and a moratorium in play. By
5 August VerderGroep held the account, so the proof may sit on the
beheerrekening. Worth chasing before more chart work.
