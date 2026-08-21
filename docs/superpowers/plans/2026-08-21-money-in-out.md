# Money In / Money Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/money` page that charts recurring income against actual and projected costs, month by month, per bank account, derived entirely from evidence already in the database.

**Architecture:** One additive column (`transactions.account_iban`) and no new tables. All arithmetic lives in a pure, database-free module `packages/api/src/money-series.ts`, exercised by unit tests; a thin `money` tRPC router feeds it rows and hands the result to a server-rendered page with a client-side SVG chart. Nothing is written, so no `ledger_events` and no change to `/verify`.

**Tech Stack:** TypeScript, pnpm 10 workspaces, Drizzle ORM + Postgres 17 (pgvector image), tRPC v11, Next.js App Router (React server components), Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-money-in-out-design.md`

## Global Constraints

- **Integer cents everywhere.** No floats, ever. Use `Math.trunc` for division; `monthlyCents` in `packages/api/src/routers/registry.ts` is the existing precedent.
- **Run every build and test with `env -u NODE_ENV`** — the shell exports `NODE_ENV=development`, which breaks `next build`.
- **Dev database:** `docker compose up -d postgres`. Router tests connect as `postgres://verder_app:verder_app@localhost:5432/verder` and must assert only about rows they created — the dev DB is shared between suites.
- **Migration 0022 must be applied from the homelab HOST before the new web/worker images go up**, exactly as 0020 and 0021 were. It is additive and nullable, so old code is unaffected by it, but new code reading the column against an unmigrated database fails.
- **This sub-project appends no `ledger_events` and creates no evidence.** If a task seems to need one, stop — the design is being violated.
- **Months are Europe/Amsterdam calendar months**, formatted `YYYY-MM`.
- **Tone in UI copy:** toward Martin, reporting and never judging. Dutch labels for money concepts the bank and VerderGroep use (`vast inkomen`, `incidenteel`, `leefgeld`, `geen data`, `mogelijk incompleet`, `na opzeggen`); English for app chrome, matching the existing pages.
- **`INCOME_CONTINUATION_TOLERANCE = 0.25`**, a named constant whose comment states the value is a guess until measured against Martin's real ABN export.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/drizzle/0022_transactions_account_iban.sql` | The additive column |
| `packages/db/src/schema.ts` (modify) | `accountIban` on `transactions` |
| `packages/parsers/src/types.ts` (modify) | `ParsedRow.accountIban` |
| `packages/parsers/src/camt053.ts` (modify) | Read `Stmt/Acct/Id/IBAN` |
| `packages/parsers/src/abn-rows.ts` (modify) | Read `cols[0]` |
| `packages/parsers/src/paypal-csv.ts` (modify) | Always `null` |
| `packages/parsers/src/recurring.ts` (modify) | `direction` option |
| `packages/api/src/routers/registry-import.ts` (modify) | Persist `accountIban` |
| `packages/api/src/money-series.ts` (create) | **All** derivation: months, coverage, categories, income lines, continuation, projection |
| `packages/api/src/money-series.test.ts` (create) | Unit tests for the above, no database |
| `packages/api/src/routers/money.ts` (create) | `series` + `month` queries |
| `packages/api/src/routers/money.test.ts` (create) | Router tests against the dev DB |
| `apps/web/src/components/money-chart.tsx` (create) | Client SVG chart + legend/focus |
| `apps/web/src/app/(app)/money/page.tsx` (create) | Server page, drill panel, disclosures |
| `apps/web/src/components/dashboard-money.tsx` (create) | Compact six-month block |

---

### Task 1: The account column

**Files:**
- Create: `packages/db/drizzle/0022_transactions_account_iban.sql`
- Modify: `packages/db/src/schema.ts:190-204`, `packages/db/drizzle/meta/_journal.json`
- Test: `packages/db/src/registry-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.transactions.accountIban` — `text("account_iban")`, nullable, no default.

- [x] **Step 1: Write the failing test**

Append to `packages/db/src/registry-schema.test.ts`:

```ts
it("transactions carry the account the statement belongs to", async () => {
  const [row] = await db.insert(schema.transactions).values({
    source: "abn-camt053",
    bookedAt: new Date("2026-07-25T00:00:00Z"),
    amountCents: 241_304,
    accountIban: "NL91ABNA0417164300",
    statementSha256: `acct-${Date.now()}`,
    rowIndex: 0,
  }).returning();
  expect(row.accountIban).toBe("NL91ABNA0417164300");

  // Nullable: a PayPal export has no account IBAN and must still import.
  const [unknown] = await db.insert(schema.transactions).values({
    source: "paypal-csv",
    bookedAt: new Date("2026-07-25T00:00:00Z"),
    amountCents: -1_200,
    statementSha256: `acct-null-${Date.now()}`,
    rowIndex: 0,
  }).returning();
  expect(unknown.accountIban).toBeNull();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter @verder/db test -- registry-schema`
Expected: FAIL — `accountIban` is not a known property / column `account_iban` does not exist.

- [x] **Step 3: Add the column to the schema**

In `packages/db/src/schema.ts`, inside `transactions` (after `mandateId`, before `statementSha256`):

```ts
  // Which account the statement belongs to — NOT the counterparty. Under
  // bewind the same person's money moves between a beheerrekening and a
  // leefgeldrekening; charting them as one stream draws a collapse that
  // never happened. NULL means the export did not reveal it (PayPal).
  accountIban: text("account_iban"),
```

- [x] **Step 4: Write the migration**

Create `packages/db/drizzle/0022_transactions_account_iban.sql`:

```sql
-- Which account a statement row belongs to. Additive and nullable: existing
-- rows keep NULL and every existing reader ignores the column, so this can be
-- applied before the new images go up (and must be — the new code reads it).
--
-- transactions is an editable fact table, not evidence: adding a column here
-- appends no ledger event and cannot affect the hash chain.
ALTER TABLE "transactions" ADD COLUMN "account_iban" text;
```

Register it in `packages/db/drizzle/meta/_journal.json` by appending to `entries`:

```json
  {
   "idx": 22,
   "version": "7",
   "when": 1787270000000,
   "tag": "0022_transactions_account_iban",
   "breakpoints": true
  }
```

- [x] **Step 5: Apply it and run the test**

Run: `env -u NODE_ENV pnpm --filter @verder/db migrate && env -u NODE_ENV pnpm --filter @verder/db test -- registry-schema`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0022_transactions_account_iban.sql packages/db/drizzle/meta/_journal.json packages/db/src/registry-schema.test.ts
git commit -m "feat(db): transactions remember which account they came from"
```

---

### Task 2: Parsers report the account

**Files:**
- Modify: `packages/parsers/src/types.ts:4-12`, `packages/parsers/src/camt053.ts:54-70`, `packages/parsers/src/abn-rows.ts:45`, `packages/parsers/src/paypal-csv.ts`
- Test: `packages/parsers/src/camt053.test.ts`, `packages/parsers/src/abn-tsv.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (parsers do not touch the database).
- Produces: `ParsedRow.accountIban: string | null` on every row from every parser.

- [x] **Step 1: Write the failing tests**

Append to `packages/parsers/src/camt053.test.ts`:

```ts
it("carries the statement's own account onto every row", () => {
  const result = parseCamt053(fixture("camt053-sample.xml"));
  expect(result.rows.length).toBeGreaterThan(0);
  const accounts = new Set(result.rows.map((r) => r.accountIban));
  expect(accounts.size).toBe(1);
  // The statement account, never a counterparty's.
  expect([...accounts][0]).toMatch(/^NL\d{2}[A-Z]{4}\d{10}$/);
  expect([...accounts][0]).not.toBe(result.rows[0].counterpartyIban);
});
```

Append to `packages/parsers/src/abn-tsv.test.ts`:

```ts
it("reads the account from the first column", () => {
  const result = parseAbnTsv(fixture("abn-mutations.tab"));
  expect(result.rows[0].accountIban).toBe(
    fixture("abn-mutations.tab").toString("latin1").split("\t")[0]
  );
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter @verder/parsers test`
Expected: FAIL — `accountIban` does not exist on `ParsedRow`.

- [x] **Step 3: Add the field to the row type**

In `packages/parsers/src/types.ts`, inside `ParsedRow` after `mandateId`:

```ts
  /**
   * The account THIS statement belongs to — not the counterparty. CAMT carries
   * it once per Stmt and it is copied onto each row; the ABN exports repeat it
   * in column 0 of every row; PayPal has no such thing and yields null.
   */
  accountIban: string | null;
```

- [x] **Step 4: Read it in the CAMT parser**

In `packages/parsers/src/camt053.ts`, inside the `for (const stmt of stmtList)` loop, before the entries loop:

```ts
    // Stmt/Acct/Id/IBAN is the statement's own account. A statement without one
    // is still parsed — the rows just carry null and surface as "unknown account".
    const accountIban = text(path(asNode(stmt), "Acct", "Id", "IBAN"));
```

Then add `accountIban,` to the object literal pushed into `rows`.

- [x] **Step 5: Read it in the shared ABN row mapper**

In `packages/parsers/src/abn-rows.ts`, inside `abnRowToParsed`, add to the returned object:

```ts
    // cols[0] is the account this export was taken from (see the column map above).
    accountIban: cols[0]?.trim() || null,
```

In `packages/parsers/src/paypal-csv.ts`, add `accountIban: null,` to each constructed row, with the comment:

```ts
    accountIban: null, // a PayPal activity export names no bank account
```

- [x] **Step 6: Run the parser suite**

Run: `env -u NODE_ENV pnpm --filter @verder/parsers test`
Expected: PASS, including every pre-existing test (a missing `accountIban` on any constructed row is a type error, so the compiler finds the ones tests do not).

- [x] **Step 7: Commit**

```bash
git add packages/parsers/src
git commit -m "feat(parsers): every statement row names the account it came from"
```

---

### Task 3: The import persists the account

**Files:**
- Modify: `packages/api/src/routers/registry-import.ts:102-114`
- Test: `packages/api/src/routers/registry-import.test.ts`

**Interfaces:**
- Consumes: `schema.transactions.accountIban` (Task 1), `ParsedRow.accountIban` (Task 2).
- Produces: imported transactions with `accountIban` populated.

- [x] **Step 1: Write the failing test**

Append to `packages/api/src/routers/registry-import.test.ts`:

```ts
it("stores the account each imported row belongs to", async () => {
  const sha = `import-acct-${Date.now()}`;
  await caller().registryImport.commit({
    filename: "camt053-sample.xml",
    sha256: sha,
    // ...the same fixture-upload shape the neighbouring tests use
  });
  const rows = await db.select({ accountIban: schema.transactions.accountIban })
    .from(schema.transactions)
    .where(eq(schema.transactions.statementSha256, sha));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.accountIban !== null)).toBe(true);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- registry-import`
Expected: FAIL — every `accountIban` is `null`.

- [x] **Step 3: Pass it through**

In `packages/api/src/routers/registry-import.ts`, in the `parsed.rows.map(...)` literal, add:

```ts
        accountIban: r.accountIban,
```

Leave the `parsed.errors.map(...)` literal alone: an unreadable row has no trustworthy account, and `null` correctly puts it in the unknown-account bucket rather than vouching for one.

- [x] **Step 4: Run the test**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- registry-import`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/api/src/routers/registry-import.ts packages/api/src/routers/registry-import.test.ts
git commit -m "feat(api): imports remember the account, not just the statement"
```

---

### Task 4: Recurring detection in both directions

**Files:**
- Modify: `packages/parsers/src/recurring.ts:60-62`, `packages/parsers/src/index.ts`
- Test: `packages/parsers/src/recurring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectRecurring(txs: InputTx[], opts?: { direction?: "debit" | "credit" }): RecurringCandidate[]`, defaulting to `"debit"`. In credit direction, `typicalAmountCents` is **positive**.

- [x] **Step 1: Write the failing test**

Append to `packages/parsers/src/recurring.test.ts`:

```ts
const salary = (i: number, day: string, cents: number) => ({
  id: `s${i}`, rowIndex: i, bookedAt: new Date(day), amountCents: cents,
  counterpartyName: "TrueFullstaq BV", counterpartyIban: "NL02ABNA0123456789",
  description: "salaris", mandateId: null, accountIban: "NL91ABNA0417164300",
});

it("finds recurring credits when asked, and ignores them by default", () => {
  const rows = [
    salary(0, "2026-03-25T00:00:00Z", 241_304),
    salary(1, "2026-04-24T00:00:00Z", 241_304),
    salary(2, "2026-05-25T00:00:00Z", 241_304),
  ];
  expect(detectRecurring(rows)).toEqual([]); // default: debits only

  const [line] = detectRecurring(rows, { direction: "credit" });
  expect(line.cadence).toBe("monthly");
  expect(line.typicalAmountCents).toBe(241_304);
  expect(line.chargeCount).toBe(3);
});

it("still ignores credits mixed into a debit-direction call", () => {
  const debits = [
    { ...salary(0, "2026-03-25T00:00:00Z", -4_999), counterpartyName: "Netflix" },
    { ...salary(1, "2026-04-25T00:00:00Z", -4_999), counterpartyName: "Netflix" },
  ];
  const rows = [...debits, salary(9, "2026-04-24T00:00:00Z", 241_304)];
  const found = detectRecurring(rows);
  expect(found).toHaveLength(1);
  expect(found[0].typicalAmountCents).toBe(-4_999);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u NODE_ENV pnpm --filter @verder/parsers test -- recurring`
Expected: FAIL — `detectRecurring` takes one argument; the credit call returns `[]`.

- [x] **Step 3: Add the option**

In `packages/parsers/src/recurring.ts`, replace the signature and the filter:

```ts
export interface DetectRecurringOptions {
  /**
   * Which side to group. Debits are charges (the default, and what every
   * caller before the money page wanted); credits are income. Defaults to
   * "debit" so existing callers cannot change behaviour by accident.
   */
  direction?: "debit" | "credit";
}

export function detectRecurring(
  txs: InputTx[], opts: DetectRecurringOptions = {}
): RecurringCandidate[] {
  const wantCredits = opts.direction === "credit";
  // One side only: a refund must never skew a charge group, and a charge must
  // never skew an income line.
  const charges = txs.filter((t) => (wantCredits ? t.amountCents > 0 : t.amountCents < 0));
```

Nothing else in the function changes: the median, cadence and 40% similarity rules are sign-agnostic because they compare against `Math.abs(typicalAmountCents)`.

- [x] **Step 4: Export the option type**

In `packages/parsers/src/index.ts`, extend the recurring export:

```ts
export {
  detectRecurring, normalizeName,
  type DetectRecurringOptions, type RecurringCandidate,
} from "./recurring";
```

- [x] **Step 5: Run the suite**

Run: `env -u NODE_ENV pnpm --filter @verder/parsers test`
Expected: PASS, all pre-existing recurring tests included.

- [x] **Step 6: Commit**

```bash
git add packages/parsers/src/recurring.ts packages/parsers/src/index.ts packages/parsers/src/recurring.test.ts
git commit -m "feat(parsers): detect recurring credits, not only charges"
```

- [x] **Step 7: Review correction — a weekly cadence (2026-08-21)**

`cadenceOf` knew only monthly (25–35 d), quarterly (80–100 d) and yearly
(350–380 d). VerderGroep pays leefgeld **weekly**, so a 7-day gap returned
`null` and the leefgeldrekening had no income line at all — which quietly
contradicts spec §Money in rule 3. A 5–9 day `weekly` band was added, **only in
the credit direction**: `registry-mine` writes `c.cadence` into the
`billing_cycle` Postgres enum (`monthly | quarterly | yearly | irregular`), and
this sub-project promised no migration beyond 0022. A weekly *debit* therefore
stays unrecognised, exactly as before, and `billingCycleOf` in `registry-mine.ts`
maps an (unreachable) weekly to `irregular` so the widened type cannot turn into
a runtime INSERT failure. Covered by *"finds a weekly credit line, but only in
the credit direction"*, which asserts both halves.

---

### Task 5: Months, coverage and the costs side

**Files:**
- Create: `packages/api/src/money-series.ts`, `packages/api/src/money-series.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no database, no imports from `@verder/db`).
- Produces:

```ts
export interface MoneyTx {
  id: string; accountIban: string | null; bookedAt: Date; amountCents: number;
  counterpartyName: string | null; counterpartyIban: string | null;
  mandateId: string | null; parseError: boolean;
  financialItemId: string | null; statementSha256: string;
}
export interface MoneyItem {
  id: string; name: string; category: string; monthlyCents: number; status: string;
}
export type Coverage = "complete" | "partial" | "none";
export interface MonthSeries {
  month: string; coverage: Coverage;
  inCents: number; outCents: number;
  outByCategory: { category: string; cents: number }[];
  incidentalCents: number; internalCents: number; parseErrorRows: number;
}
export function monthKey(d: Date): string;
export function coverageForMonths(txs: MoneyTx[], months: string[]): Map<string, Coverage>;
export function outSeries(txs: MoneyTx[], items: MoneyItem[]): Map<string, MonthSeries["outByCategory"]>;
```

- [x] **Step 1: Write the failing tests**

Create `packages/api/src/money-series.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { coverageForMonths, monthKey, outSeries, type MoneyTx } from "./money-series";

const tx = (o: Partial<MoneyTx> & { id: string; bookedAt: string; amountCents: number }): MoneyTx => ({
  accountIban: "NL91ABNA0417164300", counterpartyName: null, counterpartyIban: null,
  mandateId: null, parseError: false, financialItemId: null, statementSha256: "stmt-a",
  ...o, bookedAt: new Date(o.bookedAt),
});

describe("monthKey", () => {
  it("buckets by Amsterdam calendar month, not UTC", () => {
    // 23:30 UTC on 31 July is already 1 August in Amsterdam (CEST).
    expect(monthKey(new Date("2026-07-31T23:30:00Z"))).toBe("2026-08");
    expect(monthKey(new Date("2026-07-31T21:00:00Z"))).toBe("2026-07");
  });
});

describe("coverageForMonths", () => {
  it("marks a month complete only when the statements span all of it", () => {
    const txs = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -100 }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -100 }),
      tx({ id: "c", bookedAt: "2026-07-10T00:00:00Z", amountCents: -100, statementSha256: "stmt-b" }),
      tx({ id: "d", bookedAt: "2026-07-20T00:00:00Z", amountCents: -100, statementSha256: "stmt-b" }),
    ];
    const cov = coverageForMonths(txs, ["2026-05", "2026-06", "2026-07"]);
    expect(cov.get("2026-06")).toBe("complete");
    expect(cov.get("2026-07")).toBe("partial"); // statement starts on the 10th
    expect(cov.get("2026-05")).toBe("none");    // no rows at all — not zero
  });
});

describe("outSeries", () => {
  it("groups debits by the category of their linked item and pools the rest", () => {
    const items = [{ id: "i1", name: "Vattenfall", category: "energy", monthlyCents: 21_000, status: "allowed" }];
    const txs = [
      tx({ id: "a", bookedAt: "2026-07-05T00:00:00Z", amountCents: -21_000, financialItemId: "i1" }),
      tx({ id: "b", bookedAt: "2026-07-06T00:00:00Z", amountCents: -3_412 }),
      tx({ id: "c", bookedAt: "2026-07-07T00:00:00Z", amountCents: -1_000, parseError: true }),
      tx({ id: "d", bookedAt: "2026-07-08T00:00:00Z", amountCents: 500 }),
    ];
    expect(outSeries(txs, items).get("2026-07")).toEqual([
      { category: "energy", cents: 21_000 },
      { category: "overig", cents: 3_412 },
    ]);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: FAIL — module `./money-series` not found.

- [x] **Step 3: Write the module**

Create `packages/api/src/money-series.ts`:

```ts
/**
 * Derivation for the /money page. PURE: no database, no I/O, no imports from
 * @verder/db. Everything the page shows is a function of rows already in the
 * ledger, which is why this sub-project appends no evidence of its own.
 *
 * All money is integer cents. Amounts arrive signed (debits negative) and are
 * reported as positive magnitudes on both sides of the chart.
 */

export interface MoneyTx {
  id: string; accountIban: string | null; bookedAt: Date; amountCents: number;
  counterpartyName: string | null; counterpartyIban: string | null;
  mandateId: string | null; parseError: boolean;
  financialItemId: string | null; statementSha256: string;
}

export interface MoneyItem {
  id: string; name: string; category: string; monthlyCents: number; status: string;
}

export type Coverage = "complete" | "partial" | "none";

export interface MonthSeries {
  month: string; coverage: Coverage;
  inCents: number; outCents: number;
  outByCategory: { category: string; cents: number }[];
  incidentalCents: number; internalCents: number; parseErrorRows: number;
}

/** Debits with no registry item behind them pool here. */
export const UNCATEGORIZED = "overig";

const MONTH_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit",
});

/** "2026-07" in Amsterdam time — a 23:30 UTC booking on 31 July is August here. */
export function monthKey(d: Date): string {
  return MONTH_FMT.format(d).slice(0, 7);
}

/** [start, endExclusive) of a "YYYY-MM" as UTC instants of the Amsterdam month. */
function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  // Amsterdam is UTC+1/+2; building from UTC midnight and letting monthKey
  // decide membership keeps this free of a timezone library.
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return { start, end };
}

/**
 * Coverage is inferred per statement file: the first and last booking in it
 * bound the period it can speak for. This UNDERSTATES a quiet month (a
 * statement covering all of June whose first booking is the 4th reads as
 * partial), which is the safe direction: it says "possibly incomplete" when
 * unsure and never claims completeness it cannot support.
 */
export function coverageForMonths(txs: MoneyTx[], months: string[]): Map<string, Coverage> {
  const ranges = new Map<string, { from: Date; to: Date }>();
  for (const t of txs) {
    if (t.parseError) continue; // an unreadable row's date is not evidence of coverage
    const r = ranges.get(t.statementSha256);
    if (!r) ranges.set(t.statementSha256, { from: t.bookedAt, to: t.bookedAt });
    else {
      if (t.bookedAt < r.from) r.from = t.bookedAt;
      if (t.bookedAt > r.to) r.to = t.bookedAt;
    }
  }
  const merged = [...ranges.values()]
    .sort((a, b) => a.from.getTime() - b.from.getTime())
    .reduce<{ from: Date; to: Date }[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.from.getTime() <= last.to.getTime()) {
        if (r.to > last.to) last.to = r.to;
      } else acc.push({ from: new Date(r.from), to: new Date(r.to) });
      return acc;
    }, []);

  const out = new Map<string, Coverage>();
  for (const month of months) {
    const { start, end } = monthBounds(month);
    const lastDay = new Date(end.getTime() - 86_400_000);
    const hasRows = txs.some((t) => monthKey(t.bookedAt) === month);
    if (!hasRows) { out.set(month, "none"); continue; }
    const complete = merged.some((r) => r.from <= start && r.to >= lastDay);
    out.set(month, complete ? "complete" : "partial");
  }
  return out;
}

/** Debits per month, grouped by the category of the item they are linked to. */
export function outSeries(
  txs: MoneyTx[], items: MoneyItem[]
): Map<string, MonthSeries["outByCategory"]> {
  const categoryOf = new Map(items.map((i) => [i.id, i.category]));
  const perMonth = new Map<string, Map<string, number>>();
  for (const t of txs) {
    if (t.parseError || t.amountCents >= 0) continue;
    const month = monthKey(t.bookedAt);
    const category = (t.financialItemId && categoryOf.get(t.financialItemId)) || UNCATEGORIZED;
    const bucket = perMonth.get(month) ?? new Map<string, number>();
    bucket.set(category, (bucket.get(category) ?? 0) + Math.abs(t.amountCents));
    perMonth.set(month, bucket);
  }
  return new Map(
    [...perMonth].map(([month, bucket]) => [
      month,
      // UNCATEGORIZED sorts last; the rest alphabetically, so the stack order
      // is stable across months and the eye can follow a band.
      [...bucket].map(([category, cents]) => ({ category, cents })).sort((a, b) =>
        a.category === UNCATEGORIZED ? 1 : b.category === UNCATEGORIZED ? -1
          : a.category.localeCompare(b.category)),
    ])
  );
}
```

- [x] **Step 4: Run the tests**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add packages/api/src/money-series.ts packages/api/src/money-series.test.ts
git commit -m "feat(api): months, statement coverage and the costs side"
```

---

### Task 6: Income lines and the continuation rule

**Files:**
- Modify: `packages/api/src/money-series.ts`, `packages/api/src/money-series.test.ts`

**Interfaces:**
- Consumes: `detectRecurring(txs, { direction: "credit" })` (Task 4), `MoneyTx` and `monthKey` (Task 5).
- Produces:

```ts
export const INCOME_CONTINUATION_TOLERANCE = 0.25;
export interface IncomeLine {
  key: string; labels: string[];
  cadence: "monthly" | "quarterly" | "yearly";
  typicalAmountCents: number; firstAt: Date; lastAt: Date; transactionIds: string[];
}
export function splitInternalTransfers(txs: MoneyTx[]): { internal: Set<string>; internalCents: number };
export function incomeLines(txs: MoneyTx[]): IncomeLine[];
```

- [x] **Step 1: Write the failing tests**

Append to `packages/api/src/money-series.test.ts`:

```ts
import { incomeLines, splitInternalTransfers } from "./money-series";

const credit = (id: string, day: string, cents: number, name: string, iban: string): MoneyTx =>
  tx({ id, bookedAt: day, amountCents: cents, counterpartyName: name, counterpartyIban: iban });

describe("incomeLines", () => {
  it("keeps one line across an employer change", () => {
    // Martin's real June 2026: TrueFullstaq stops, a new employer starts.
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("c", "2026-05-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("d", "2026-06-25T00:00:00Z", 230_000, "Saurens Marketing BV", "NL77INGB0007654321"),
      credit("e", "2026-07-24T00:00:00Z", 230_000, "Saurens Marketing BV", "NL77INGB0007654321"),
    ];
    const lines = incomeLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].labels).toEqual(["TrueFullstaq BV", "Saurens Marketing BV"]);
    expect(lines[0].transactionIds).toHaveLength(5);
    expect(lines[0].typicalAmountCents).toBe(230_000); // the line that is still running
  });

  it("does not merge a toeslag into a salary", () => {
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("c", "2026-03-20T00:00:00Z", 18_700, "Belastingdienst Toeslagen", "NL29INGB0000123456"),
      credit("d", "2026-04-20T00:00:00Z", 18_700, "Belastingdienst Toeslagen", "NL29INGB0000123456"),
    ];
    expect(incomeLines(rows)).toHaveLength(2);
  });

  it("drops a one-off credit — recurring only, by design", () => {
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("v", "2026-05-22T00:00:00Z", 184_200, "TrueFullstaq BV vakantiegeld", "NL02ABNA0123456789"),
    ];
    const lines = incomeLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].transactionIds).not.toContain("v");
  });
});

describe("splitInternalTransfers", () => {
  it("excludes a credit matched by a same-size debit to the same IBAN", () => {
    const rows = [
      tx({ id: "out", bookedAt: "2026-07-01T00:00:00Z", amountCents: -50_000,
           counterpartyIban: "NL55ABNA0999888777" }),
      tx({ id: "back", bookedAt: "2026-07-03T00:00:00Z", amountCents: 50_000,
           counterpartyIban: "NL55ABNA0999888777" }),
      tx({ id: "salary", bookedAt: "2026-07-24T00:00:00Z", amountCents: 241_304,
           counterpartyIban: "NL02ABNA0123456789" }),
    ];
    const { internal, internalCents } = splitInternalTransfers(rows);
    expect([...internal]).toEqual(["back"]);
    expect(internalCents).toBe(50_000);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: FAIL — `incomeLines` and `splitInternalTransfers` are not exported.

- [x] **Step 3: Implement**

Append to `packages/api/src/money-series.ts`:

```ts
import { detectRecurring, type RecurringCandidate } from "@verder/parsers";

/**
 * How far a new counterparty's amount may sit from the old one and still count
 * as the same income continuing. 0.25 is a GUESS: it is wide enough for the
 * pay change Martin actually had in June 2026 and narrow enough that a toeslag
 * cannot be swallowed by a salary. Re-measure against the real ABN export
 * before trusting it — a wrong value fails visibly (one line splits in two, or
 * two lines merge into one), never silently.
 */
export const INCOME_CONTINUATION_TOLERANCE = 0.25;

const DAY_MS = 86_400_000;
/** How far apart a matched pair may sit before it stops looking like one move. */
const INTERNAL_WINDOW_DAYS = 5;
/** How far apart the two legs' amounts may sit: 1%, in integer math. */
const INTERNAL_AMOUNT_TOLERANCE = 0.01;

export interface IncomeLine {
  key: string; labels: string[];
  cadence: RecurringCandidate["cadence"];
  typicalAmountCents: number; firstAt: Date; lastAt: Date; transactionIds: string[];
}

/**
 * Money that left and came straight back (or the reverse) is not income. Both
 * legs must name the same counterparty IBAN, sit within five days, and match
 * in size to within 1%. Only the CREDIT leg is returned: the debit leg is a
 * real payment out of this account and stays in the costs bar.
 */
export function splitInternalTransfers(
  txs: MoneyTx[]
): { internal: Set<string>; internalCents: number } {
  const debits = txs.filter((t) => !t.parseError && t.amountCents < 0 && t.counterpartyIban);
  const internal = new Set<string>();
  let internalCents = 0;
  for (const credit of txs) {
    if (credit.parseError || credit.amountCents <= 0 || !credit.counterpartyIban) continue;
    const match = debits.find((d) =>
      d.counterpartyIban === credit.counterpartyIban &&
      Math.abs(d.bookedAt.getTime() - credit.bookedAt.getTime()) <= INTERNAL_WINDOW_DAYS * DAY_MS &&
      Math.abs(Math.abs(d.amountCents) - credit.amountCents) * 100 <=
        credit.amountCents * (INTERNAL_AMOUNT_TOLERANCE * 100)
    );
    if (match) { internal.add(credit.id); internalCents += credit.amountCents; }
  }
  return { internal, internalCents };
}

/** Cadence in days, for deciding whether one line picks up where another stopped. */
const CADENCE_DAYS: Record<RecurringCandidate["cadence"], number> = {
  monthly: 30, quarterly: 91, yearly: 365,
};

/**
 * Recurring credits, with successor lines folded into their predecessor.
 * A job change replaces the counterparty entirely; without this, the months
 * either side of the switch show no income at all.
 */
export function incomeLines(txs: MoneyTx[]): IncomeLine[] {
  const { internal } = splitInternalTransfers(txs);
  const credits = txs.filter((t) => !t.parseError && t.amountCents > 0 && !internal.has(t.id));
  const found = detectRecurring(
    credits.map((t) => ({
      id: t.id, rowIndex: 0, bookedAt: t.bookedAt, amountCents: t.amountCents,
      counterpartyName: t.counterpartyName, counterpartyIban: t.counterpartyIban,
      description: null, mandateId: t.mandateId, accountIban: t.accountIban,
    })),
    { direction: "credit" }
  );

  const lines: IncomeLine[] = found
    .map((c) => ({
      key: c.key, labels: [c.counterpartyName ?? c.key], cadence: c.cadence,
      typicalAmountCents: c.typicalAmountCents,
      firstAt: c.firstAt, lastAt: c.lastAt, transactionIds: [...c.transactionIds],
    }))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());

  // Fold successors into predecessors, oldest first, so a chain of two job
  // changes collapses into one line rather than two.
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    if (!a) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (!b) continue;
      const gapDays = (b.firstAt.getTime() - a.lastAt.getTime()) / DAY_MS;
      const withinOneCadence = gapDays > 0 && gapDays <= CADENCE_DAYS[a.cadence] * 1.5;
      const sizeDelta = Math.abs(b.typicalAmountCents - a.typicalAmountCents);
      const similar = sizeDelta <= a.typicalAmountCents * INCOME_CONTINUATION_TOLERANCE;
      if (!withinOneCadence || !similar || a.lastAt >= b.firstAt) continue;
      a.labels = [...a.labels, ...b.labels];
      a.transactionIds = [...a.transactionIds, ...b.transactionIds];
      a.lastAt = b.lastAt;
      // The running line's amount is what will be projected forward.
      a.typicalAmountCents = b.typicalAmountCents;
      a.cadence = b.cadence;
      lines[j] = undefined as unknown as IncomeLine;
    }
  }
  return lines.filter(Boolean);
}
```

- [x] **Step 4: Run the tests**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add packages/api/src/money-series.ts packages/api/src/money-series.test.ts
git commit -m "feat(api): income lines that survive a change of employer"
```

- [x] **Step 6: Review correction — evicting a one-off from inside a group (2026-08-21)**

Step 1's own fixture (a vakantiegeld from the employer's **own** IBAN) did not
pass: `detectRecurring` groups by mandate ▸ IBAN ▸ name, the 30/28-day gaps read
as monthly, and 23.7% below the median sits inside the 40% similarity band — so
the one-off was counted as fixed income and, because a group is named after its
LAST row, relabelled three months of salary "TrueFullstaq BV vakantiegeld". Both
violate the spec's scope table and §Money in rule 5.

`evictOneOffCredits` now drops a credit further than
`INCOME_OUTLIER_TOLERANCE_PCT` (**15**, whole percent so the comparison stays
integer cents, and a guess-until-measured constant in the same discipline as
`INCOME_CONTINUATION_TOLERANCE`) from its group's median, then re-detects on the
survivors so the median, cadence and first/last dates are recomputed without it.
Two guards keep it from eating real income: a group of two evicts nothing, and
the survivors must still read as the same cadence. `modalName` takes the label
from the most frequent counterparty name instead of the last row.

Three tests cover it: the vakantiegeld fixture (now passing, `.fails` removed,
plus a label assertion), *"keeps a line whose amounts genuinely drift"* (±6%
pay changes evict nothing), and *"never evicts a row out of a pair"*.

---

### Task 7: The full series, projection and account split

**Files:**
- Modify: `packages/api/src/money-series.ts`, `packages/api/src/money-series.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5 and 6.
- Produces:

```ts
export interface ProjectedMonth {
  month: string; inCents: number; outCents: number; outAfterCancelCents: number;
}
export interface AccountSeries {
  accountIban: string | null;
  months: MonthSeries[];
  projected: ProjectedMonth[];
  incomeLines: IncomeLine[];
  lastCompleteMonth: string | null;
}
export function buildMoneySeries(input: {
  transactions: MoneyTx[]; items: MoneyItem[]; horizonMonths?: number;
}): AccountSeries[];
```

- [x] **Step 1: Write the failing tests**

Append to `packages/api/src/money-series.test.ts`:

```ts
import { buildMoneySeries } from "./money-series";

describe("buildMoneySeries", () => {
  const items = [
    { id: "i1", name: "Vattenfall", category: "energy", monthlyCents: 21_000, status: "allowed" },
    { id: "i2", name: "IPTV Totaal", category: "streaming", monthlyCents: 9_600, status: "to-cancel" },
    { id: "i3", name: "Oude sportschool", category: "other", monthlyCents: 3_000, status: "canceled" },
  ];

  it("splits accounts and never draws one series through both", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-25T00:00:00Z", amountCents: 241_304,
           counterpartyIban: "NL02ABNA0123456789", accountIban: "NL91ABNA0417164300" }),
      tx({ id: "b", bookedAt: "2026-07-25T00:00:00Z", amountCents: 241_304,
           counterpartyIban: "NL02ABNA0123456789", accountIban: "NL91ABNA0417164300" }),
      tx({ id: "c", bookedAt: "2026-08-07T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-08-14T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
    ];
    const series = buildMoneySeries({ transactions: rows, items });
    expect(series.map((s) => s.accountIban).sort())
      .toEqual(["NL44RABO0555444333", "NL91ABNA0417164300"]);
    const leefgeld = series.find((s) => s.accountIban === "NL44RABO0555444333")!;
    expect(leefgeld.incomeLines).toHaveLength(1); // the leefgeld line, weekly-ish
    expect(leefgeld.months.every((m) => m.month >= "2026-08")).toBe(true);
  });

  it("projects costs without canceled items and shows the to-cancel saving", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -21_000, financialItemId: "i1" }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -9_600, financialItemId: "i2" }),
    ];
    const [series] = buildMoneySeries({ transactions: rows, items, horizonMonths: 2 });
    expect(series.lastCompleteMonth).toBe("2026-06");
    expect(series.projected).toHaveLength(2);
    // canceled i3 is gone entirely; to-cancel i2 counts until it is cancelled
    expect(series.projected[0].outCents).toBe(30_600);
    expect(series.projected[0].outAfterCancelCents).toBe(21_000);
  });

  it("reports a month with no rows as none, not zero", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-05-01T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "b", bookedAt: "2026-05-31T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "c", bookedAt: "2026-07-01T00:00:00Z", amountCents: -1_000, statementSha256: "s2" }),
      tx({ id: "d", bookedAt: "2026-07-31T00:00:00Z", amountCents: -1_000, statementSha256: "s2" }),
    ];
    const [series] = buildMoneySeries({ transactions: rows, items: [] });
    expect(series.months.find((m) => m.month === "2026-06")!.coverage).toBe("none");
    expect(series.months.find((m) => m.month === "2026-06")!.outCents).toBe(0);
    expect(series.lastCompleteMonth).toBe("2026-07");
  });

  it("returns nothing at all for an empty database", () => {
    expect(buildMoneySeries({ transactions: [], items: [] })).toEqual([]);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: FAIL — `buildMoneySeries` is not exported.

- [x] **Step 3: Implement**

Append to `packages/api/src/money-series.ts`:

```ts
export interface ProjectedMonth {
  month: string; inCents: number; outCents: number; outAfterCancelCents: number;
}

export interface AccountSeries {
  accountIban: string | null;
  months: MonthSeries[];
  projected: ProjectedMonth[];
  incomeLines: IncomeLine[];
  /** Newest month wholly inside the statement coverage — the projection's base. */
  lastCompleteMonth: string | null;
}

const DEFAULT_HORIZON_MONTHS = 3;

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y * 12) + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * One series per account. Accounts are never merged: under bewind the same
 * person's money moves between a beheerrekening and a leefgeldrekening, and a
 * single stream would draw a collapse at the handover that never happened.
 * Rows with no account (PayPal, unreadable rows) form their own series.
 */
export function buildMoneySeries(input: {
  transactions: MoneyTx[]; items: MoneyItem[]; horizonMonths?: number;
}): AccountSeries[] {
  const horizon = input.horizonMonths ?? DEFAULT_HORIZON_MONTHS;
  const byAccount = new Map<string, MoneyTx[]>();
  for (const t of input.transactions) {
    const key = t.accountIban ?? "";
    byAccount.set(key, [...(byAccount.get(key) ?? []), t]);
  }

  // CORRECTED AFTER REVIEW — the original plan computed ONE projectedOut over
  // all items and wrote it into every account's projected[], which double-counts
  // the contracted total the moment a second account exists (and the second
  // account is the whole reason this dimension exists). Contracted costs are
  // attributed to the account that pays them — see `accountOfItems` in the
  // shipped module — and an account that pays no contract projects 0.
  const liveItems = input.items.filter((i) => i.status !== "canceled");
  const itemAccount = accountOfItems(input.transactions, liveItems);
  const projectedOutByAccount = new Map<string, { out: number; afterCancel: number }>();
  for (const item of liveItems) {
    const key = itemAccount.get(item.id) ?? "";
    const bucket = projectedOutByAccount.get(key) ?? { out: 0, afterCancel: 0 };
    bucket.out += item.monthlyCents;
    if (item.status !== "to-cancel") bucket.afterCancel += item.monthlyCents;
    projectedOutByAccount.set(key, bucket);
  }

  const series: AccountSeries[] = [];
  for (const [accountKey, txs] of byAccount) {
    const monthsPresent = [...new Set(txs.map((t) => monthKey(t.bookedAt)))].sort();
    const months = monthRange(monthsPresent[0], monthsPresent[monthsPresent.length - 1]);
    const coverage = coverageForMonths(txs, months);
    const outByMonth = outSeries(txs, input.items);
    const lines = incomeLines(txs);
    const { internal } = splitInternalTransfers(txs);
    const countedIn = new Set(lines.flatMap((l) => l.transactionIds));

    const monthSeries: MonthSeries[] = months.map((month) => {
      const rows = txs.filter((t) => monthKey(t.bookedAt) === month);
      const outByCategory = outByMonth.get(month) ?? [];
      return {
        month,
        coverage: coverage.get(month) ?? "none",
        inCents: rows.filter((t) => countedIn.has(t.id))
          .reduce((s, t) => s + t.amountCents, 0),
        outCents: outByCategory.reduce((s, c) => s + c.cents, 0),
        outByCategory,
        // Disclosed, never counted: vakantiegeld, a 13e maand, an OpsMate
        // invoice. The footnote is how the month still reconciles.
        incidentalCents: rows
          .filter((t) => !t.parseError && t.amountCents > 0 &&
            !countedIn.has(t.id) && !internal.has(t.id))
          .reduce((s, t) => s + t.amountCents, 0),
        internalCents: rows.filter((t) => internal.has(t.id))
          .reduce((s, t) => s + t.amountCents, 0),
        parseErrorRows: rows.filter((t) => t.parseError).length,
      };
    });

    const lastCompleteMonth =
      [...monthSeries].reverse().find((m) => m.coverage === "complete")?.month ?? null;

    const projected: ProjectedMonth[] = [];
    if (lastCompleteMonth) {
      // A line with nothing in the last complete month has stopped: a job that
      // ended must not keep paying on a chart.
      const active = lines.filter((l) => monthKey(l.lastAt) >= lastCompleteMonth);
      // CORRECTED AFTER REVIEW — `weekly` was added to the cadence switch too
      // (52 payments over 12 months, truncated to integer cents).
      const inCents = active.reduce((s, l) => s + monthlyFromCadence(l), 0);
      const out = projectedOutByAccount.get(accountKey) ?? { out: 0, afterCancel: 0 };
      for (let n = 1; n <= horizon; n++) {
        projected.push({
          month: addMonths(lastCompleteMonth, n),
          inCents,
          outCents: out.out,
          outAfterCancelCents: out.afterCancel,
        });
      }
    }

    series.push({
      accountIban: accountKey === "" ? null : accountKey,
      months: monthSeries, projected, incomeLines: lines, lastCompleteMonth,
    });
  }
  return series.sort((a, b) => (a.accountIban ?? "").localeCompare(b.accountIban ?? ""));
}
```

- [x] **Step 4: Run the tests**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money-series`
Expected: PASS (11 tests).

- [x] **Step 5: Commit**

```bash
git add packages/api/src/money-series.ts packages/api/src/money-series.test.ts
git commit -m "feat(api): the full monthly series, per account, with a projection"
```

- [x] **Step 6: Review corrections (2026-08-21)**

A review gate rejected Tasks 4–7 on three findings; all three are fixed and
covered by tests that were watched failing first.

1. **Projection was broadcast, not attributed** (above). Two new tests:
   *"projects each account's own contracted costs, never the registry twice"*
   asserts the two accounts' projections sum to the registry total exactly once,
   and *"projects an item nobody has been seen paying onto the account that
   pays"* pins the evidence-free fallback. Without the fallback an item with no
   linked debit — a registry seeded from the mail before its first statement —
   would project onto no account at all and silently understate the total.
2. **Weekly cadence.** `cadenceOf` gained a 5–9 day band, **credit direction
   only**: `registry-mine` writes a candidate's cadence straight into the
   `billing_cycle` Postgres enum, which has no `weekly` value, and this
   sub-project adds no migration beyond 0022. `billingCycleOf` in
   `registry-mine.ts` degrades an (unreachable) weekly to `irregular` so the
   type widening cannot become a runtime INSERT failure. The `.fails` on
   *"detects a weekly leefgeld line"* is gone and the two-account fixture is
   back to the plan's original weekly pair.
3. **Vakantiegeld inside the salary group.** `evictOneOffCredits` drops a credit
   more than `INCOME_OUTLIER_TOLERANCE_PCT` (15%) from its group's median, and
   the line's label is now the group's *most frequent* counterparty name rather
   than its last row's. The review's suggested AND — amount outlier **and** off
   cadence — cannot work here and was not implemented: vakantiegeld is paid in
   the salary run, 28 days after the previous salary, so it sits exactly ON
   cadence, which is why detectRecurring swallowed it in the first place. Two
   guards replace it: a group of two evicts nothing (no majority to be an
   outlier against), and the survivors must still detect as the same cadence.

---

### Task 8: The money router

**Files:**
- Create: `packages/api/src/routers/money.ts`, `packages/api/src/routers/money.test.ts`
- Modify: `packages/api/src/root.ts`

**Interfaces:**
- Consumes: `buildMoneySeries` (Task 7), `monthlyCents` from `./registry`, `effectiveStatus` from `../registry-decide`, `schema.transactions.accountIban` (Task 1).
- Produces: `money.series()` → `{ series: AccountSeries[]; accountLabels: Record<string, string> }`, and `money.month({ accountIban, month })` → the drill payload.

- [x] **Step 1: Write the failing tests**

Create `packages/api/src/routers/money.test.ts`, following the `timeline.test.ts` shape:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared: every assertion below is scoped to the statement
// sha this suite invented, never to absolute totals.
describe("money router", () => {
  let db: Db; let userId: string; let sha: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `money${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    sha = `money-${Date.now()}`;
    await db.insert(schema.transactions).values([
      { source: "abn-camt053", bookedAt: new Date("2026-06-01T00:00:00Z"), amountCents: -21_000,
        accountIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 0 },
      { source: "abn-camt053", bookedAt: new Date("2026-06-30T00:00:00Z"), amountCents: 241_304,
        counterpartyIban: "NL02ABNA0123456789", counterpartyName: "TrueFullstaq BV",
        accountIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 1 },
    ]);
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("returns a series for the account the rows belong to", async () => {
    const { series } = await caller().money.series();
    const mine = series.find((s) => s.accountIban === "NL91ABNA0417164300");
    expect(mine).toBeDefined();
    expect(mine!.months.some((m) => m.month === "2026-06")).toBe(true);
  });

  it("month detail lists the bank rows behind a category", async () => {
    const detail = await caller().money.month({
      accountIban: "NL91ABNA0417164300", month: "2026-06",
    });
    const overig = detail.categories.find((c) => c.category === "overig");
    expect(overig!.transactions.some((t) => t.statementSha256 === sha)).toBe(true);
  });

  it("keeps transactions when their statement document is discarded", async () => {
    // Discard is a status change on the document, never a delete, and the
    // document link is evidence — not ownership of the rows.
    const [doc] = await db.insert(schema.documents).values({
      title: "afschrift.xml", source: "upload", sha256: sha,
      storagePath: `vault/${sha}`, mimeType: "application/xml", byteSize: 10,
    }).returning();
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: doc.id, status: "discarded", changedBy: userId });
    const detail = await caller().money.month({
      accountIban: "NL91ABNA0417164300", month: "2026-06",
    });
    expect(detail.categories.flatMap((c) => c.transactions).length).toBeGreaterThan(0);
  });
});
```

> If the local `documents` / `document_status_changes` insert shapes differ from the above, copy them verbatim from `packages/api/src/routers/documents.test.ts` — do not invent columns.

- [x] **Step 2: Run them and watch them fail**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money`
Expected: FAIL — `money` is not a property of the router.

- [x] **Step 3: Write the router**

Create `packages/api/src/routers/money.ts`:

```ts
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveStatus } from "../registry-decide";
import { monthlyCents } from "./registry";
import { buildMoneySeries, monthKey, UNCATEGORIZED, type MoneyTx } from "../money-series";

/**
 * Derived-on-read: this router owns no state, writes nothing and appends no
 * ledger events. Every figure is a function of transactions + registry rows.
 */

async function loadItems(db: Parameters<typeof effectiveStatus>[0]) {
  const items = await db.select().from(schema.financialItems);
  const statuses = await Promise.all(
    items.map((i) => effectiveStatus(db, { financialItemId: i.id }))
  );
  return items.map((i, n) => ({
    id: i.id, name: i.name, category: i.category,
    monthlyCents: monthlyCents(i), status: statuses[n],
  }));
}

function toMoneyTx(r: typeof schema.transactions.$inferSelect): MoneyTx {
  return {
    id: r.id, accountIban: r.accountIban, bookedAt: r.bookedAt, amountCents: r.amountCents,
    counterpartyName: r.counterpartyName, counterpartyIban: r.counterpartyIban,
    mandateId: r.mandateId, parseError: r.parseError,
    financialItemId: r.financialItemId, statementSha256: r.statementSha256,
  };
}

export const moneyRouter = router({
  series: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.transactions);
    const items = await loadItems(ctx.db);
    const series = buildMoneySeries({ transactions: rows.map(toMoneyTx), items });
    // A friendly name per account, taken from what the money looks like rather
    // than from a table we do not have: an account that mostly receives from
    // the bewindvoerder is the leefgeldrekening.
    const accountLabels: Record<string, string> = {};
    for (const s of series) {
      if (!s.accountIban) continue;
      accountLabels[s.accountIban] = s.accountIban;
    }
    return { series, accountLabels };
  }),

  month: protectedProcedure
    .input(z.object({
      accountIban: z.string().nullable(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    }))
    .query(async ({ ctx, input }) => {
      const rows = (await ctx.db.select().from(schema.transactions))
        .map(toMoneyTx)
        .filter((t) => (t.accountIban ?? null) === input.accountIban &&
          monthKey(t.bookedAt) === input.month);
      const items = await loadItems(ctx.db);
      const itemById = new Map(items.map((i) => [i.id, i]));

      const categories = new Map<string, {
        category: string; cents: number;
        transactions: { id: string; bookedAt: Date; amountCents: number;
          counterpartyName: string | null; itemName: string | null; statementSha256: string }[];
      }>();
      for (const t of rows) {
        if (t.parseError || t.amountCents >= 0) continue;
        const item = t.financialItemId ? itemById.get(t.financialItemId) : undefined;
        const category = item?.category ?? UNCATEGORIZED;
        const bucket = categories.get(category) ??
          { category, cents: 0, transactions: [] };
        bucket.cents += Math.abs(t.amountCents);
        bucket.transactions.push({
          id: t.id, bookedAt: t.bookedAt, amountCents: t.amountCents,
          counterpartyName: t.counterpartyName, itemName: item?.name ?? null,
          statementSha256: t.statementSha256,
        });
        categories.set(category, bucket);
      }
      return {
        month: input.month,
        accountIban: input.accountIban,
        categories: [...categories.values()].sort((a, b) => b.cents - a.cents),
        parseErrorRows: rows.filter((t) => t.parseError).length,
      };
    }),
});
```

Register it in `packages/api/src/root.ts` alongside the existing routers:

```ts
import { moneyRouter } from "./routers/money";
// ...inside appRouter:
  money: moneyRouter,
```

- [x] **Step 4: Run the tests**

Run: `env -u NODE_ENV pnpm --filter @verder/api test -- money`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add packages/api/src/routers/money.ts packages/api/src/routers/money.test.ts packages/api/src/root.ts
git commit -m "feat(api): money router — series and month detail, derived on read"
```

---

### Task 9: The `/money` page

**Files:**
- Create: `apps/web/src/components/money-chart.tsx`, `apps/web/src/app/(app)/money/page.tsx`
- Modify: the nav component that lists `/registry`, `/tasks`, `/timeline` (find it with `grep -rn "/timeline" apps/web/src/components`)

**Interfaces:**
- Consumes: `money.series` and `money.month` (Task 8) through `serverCaller()`.
- Produces: a page at `/money`, and `MoneyChart` — a client component taking `{ series, focusCategory }`.

- [ ] **Step 1: Load the dataviz skill**

Before writing any colour, invoke the `dataviz` skill and take the categorical palette from it. Categories are `energy`, `insurance`, `telecom`, `streaming`, `software`, `housing`, `other`, `overig` — eight bands that must stay distinguishable in both light and dark themes.

- [ ] **Step 2: Write the chart component**

Create `apps/web/src/components/money-chart.tsx` as a `"use client"` component rendering inline SVG — no chart library, matching the repo's zero-runtime-dependency habit on the web side. Requirements, each of which is visible in the markup:

- one column pair per month: income bar and a stacked costs bar;
- **solid** fill for actual months, **dashed outline** for projected months, a **hatch pattern** (`<pattern>` with diagonal lines) for `coverage === "partial"`, and a **gap with the label `geen data`** for `coverage === "none"` — never a zero-height bar;
- a labelled vertical boundary wherever consecutive series belong to different accounts;
- a second dashed outline in the projection for `outAfterCancelCents`, labelled `na opzeggen`;
- the legend renders each category as a `<Link href={`/money?cat=${category}`}>` so focus is a URL, not client state; the active category renders as a link back to `/money`.

- [ ] **Step 3: Write the page**

Create `apps/web/src/app/(app)/money/page.tsx` as a server component following `timeline/page.tsx`:

```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { MoneyChart } from "@/components/money-chart";

export default async function MoneyPage({
  searchParams,
}: { searchParams: Promise<{ cat?: string; month?: string; account?: string }> }) {
  const { cat, month, account } = await searchParams;
  const caller = await serverCaller();
  const { series } = await caller.money.series();

  if (series.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Geld in en uit</h1>
        <p className="text-slate-600">
          Nog geen afschriften ingelezen — zodra je een bankafschrift importeert
          bouwt dit overzicht zichzelf op.
        </p>
        <Link className="text-blue-600 underline" href="/registry/import">
          Afschrift importeren
        </Link>
      </div>
    );
  }
  const detail = month
    ? await caller.money.month({ accountIban: account ?? null, month })
    : null;
  // ...header totals for the last complete month, <MoneyChart/>, the drill
  // panel from `detail`, and the disclosures block described below.
}
```

The **disclosures block** sits under the chart and lists, for the visible months: incidental credits not counted (`incidentalCents`), internal transfers excluded (`internalCents`), unreadable rows (`parseErrorRows`), and any month whose coverage is not `complete`. Copy is Dutch and factual — *"€1.842 incidenteel niet meegeteld (vakantiegeld, eenmalige betalingen)"*.

Add `/money` to the nav, labelled **Geld**, next to Registry.

- [ ] **Step 4: Verify it renders against the dev database**

Run: `env -u NODE_ENV pnpm --filter web build`
Expected: build succeeds.

Then run the dev server, log in as martin@vanderpoel.pro / devpass, and confirm `/money` shows the empty state on a clean dev DB (the empty state is the state production is in, so it is the one that must be right).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/money apps/web/src/components/money-chart.tsx apps/web/src/components
git commit -m "feat(web): the money page — in, out, and what is left"
```

---

### Task 10: Dashboard block and documentation

**Files:**
- Create: `apps/web/src/components/dashboard-money.tsx`
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`, `CLAUDE.md`, `docs/deploy.md`

**Interfaces:**
- Consumes: `money.series` (Task 8).
- Produces: a compact six-month block linking to `/money`.

- [ ] **Step 1: Write the dashboard block**

Create `apps/web/src/components/dashboard-money.tsx`: the last six months of the account with the newest data, income and costs only, no drill, wrapped in a link to `/money`. Reuse `MoneyChart` in a `compact` mode rather than drawing a second chart — one chart implementation, two sizes.

- [ ] **Step 2: Mount it on the dashboard**

Add the block to `apps/web/src/app/(app)/dashboard/page.tsx` beside the existing registry tile.

- [ ] **Step 3: Verify**

Run: `env -u NODE_ENV pnpm --filter web build && env -u NODE_ENV pnpm -r test`
Expected: build succeeds; the whole workspace suite passes.

- [ ] **Step 4: Update the docs**

Add to `CLAUDE.md`, in the homelab bullet after the junk-document-discard sentence:

```
Money in/out (sub-project 5) — migration 0022, additive nullable
`transactions.account_iban`: apply `pnpm --filter @verder/db migrate` from the
homelab HOST BEFORE deploying web/worker, or /money 500s on an unknown column.
Nothing about this sub-project writes: no ledger events, no rollup table, the
whole page is derived on read by `packages/api/src/money-series.ts` (pure, no
DB imports, unit-tested without a database). THE TRAP: accounts are never
merged. Under bewind Martin's money moves between a beheerrekening and a
leefgeldrekening (VerderGroep took over the ABN account in early August 2026),
so one undifferentiated series draws a collapse at the handover that never
happened — `buildMoneySeries` returns one `AccountSeries` per `account_iban`
and rows with NULL form their own "unknown account" series rather than joining
a known one. A SECOND trap: income is RECURRING ONLY, so vakantiegeld, a 13e
maand and OpsMate invoices are excluded from the bars and disclosed as
`incidentalCents` per month — the disclosures block under the chart is what
makes the arithmetic reconcile, and removing it makes the page lie. Income
survives an employer change through the continuation rule in `incomeLines`
(Martin switched employers in June 2026, so without it May–August show no
income at all); `INCOME_CONTINUATION_TOLERANCE = 0.25` is a GUESS until
measured against a real ABN export. Statement coverage is inferred from each
statement's first and last booking, which understates a quiet month on purpose:
a month that is not provably complete renders hatched, and a month with no rows
renders `geen data`, never €0. `detectRecurring` in `@verder/parsers` gained a
`direction` option defaulting to `"debit"` so no existing caller changed.
```

Add to `docs/deploy.md` §7, after the discard backfill block:

```
Money in/out needs no backfill: `account_iban` is populated by the importer
from the next statement onward, and any row imported before it simply shows up
under "unknown account". Re-import a statement to fill it in — the import is
idempotent on (statementSha256, rowIndex), so drop those rows first if you
want them re-read.
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard-money.tsx apps/web/src/app/\(app\)/dashboard/page.tsx CLAUDE.md docs/deploy.md
git commit -m "feat(web): money on the dashboard, and the notes that go with it"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `transactions.account_iban`, migration 0022 | 1 |
| CAMT `Stmt/Acct/Id/IBAN`, ABN `cols[0]`, PayPal null | 2 |
| Import persists the account; error rows keep NULL | 3 |
| `detectRecurring` gains `direction`, default `"debit"` | 4 |
| Amsterdam months; coverage complete/partial/none | 5 |
| Costs by category, unlinked → `overig`; canceled items keep history | 5, 7 |
| Recurring-only income; continuation rule; tolerance constant | 6 |
| Internal transfers excluded and counted | 6 |
| Incidental credits disclosed, not counted | 7, 9 |
| Projection: 3 months, active lines only, to-cancel second series, no notice-period parsing | 7 |
| Per-account series, handover boundary | 7, 9 |
| Router derived on read, no ledger events | 8 |
| Drill: month → categories → items → rows → vault | 8, 9 |
| Category focus in the URL | 9 |
| Four bar states + `geen data` | 9 |
| Empty state | 9 (asserted in 7's unit test and checked in 9's step 4) |
| Dashboard block | 10 |
| Transactions survive their document's discard | 8 |
| Docs and deploy ordering | 10 |

**Placeholder scan:** Task 9 steps 2 and 3 describe the chart and page as requirement lists rather than complete JSX. That is deliberate — the palette comes from the `dataviz` skill at implementation time and the nav file must be located in the repo — but every requirement is concrete and checkable, and the page skeleton, props and empty-state copy are given verbatim. Everywhere else, code is literal.

**Type consistency:** `MoneyTx`, `MoneyItem`, `MonthSeries`, `IncomeLine`, `ProjectedMonth`, `AccountSeries` and `Coverage` are defined once in Task 5/6/7 and referenced unchanged afterwards. `monthKey`, `coverageForMonths`, `outSeries`, `splitInternalTransfers`, `incomeLines`, `buildMoneySeries` keep the same names and signatures in the interface blocks, the implementations, and the router. `UNCATEGORIZED` (`"overig"`) is used in Tasks 5, 8 and 9 with the same value. `detectRecurring`'s second parameter is `DetectRecurringOptions` in Task 4 and is called that way in Task 6.

**One open risk, flagged rather than hidden:** Task 6 feeds `MoneyTx` rows into `detectRecurring`, whose `InputTx` is `ParsedRow & { id, source? }`. `ParsedRow` gains `accountIban` in Task 2, so the object literal in `incomeLines` must satisfy it — the `rowIndex: 0` and `description: null` fillers in that literal exist for exactly that reason. If Task 2's shape changes, Task 6's literal changes with it.
