/**
 * Which columns the /money chart draws, and in which order.
 *
 * Pure and structural (no api or component imports, no React) so the rule can
 * be unit-tested without a database and without rendering — the same habit as
 * `dashboard-money-slice.ts`.
 *
 * One column per account per month, actual months first and then the
 * projection, because the chart reads left to right through time.
 *
 * A month is never drawn twice for the same account. `buildMoneySeries` starts
 * its projection at the month AFTER the last COMPLETE month, and the newest
 * real month is normally partial (the statement ends mid-month) — so the first
 * projected month is usually a month that is already there as a hatched
 * actual. Two adjacent columns both labelled "jul '26", one hatched and one
 * dashed, is not a disclosure: it reads as five months of a four-month
 * history. The real bank rows win, and the projection resumes after them.
 */

export interface ColumnMonth {
  month: string;
  coverage: "complete" | "partial" | "none";
  inCents: number;
  outByCategory: { category: string; cents: number }[];
  outCents: number;
}

export interface ColumnProjectedMonth {
  month: string;
  inCents: number;
  outCents: number;
  outAfterCancelCents: number;
}

export interface ColumnAccount {
  accountIban: string | null;
  months: ColumnMonth[];
  projected: ColumnProjectedMonth[];
}

export type MoneyColumn =
  | {
      kind: "actual";
      account: string | null;
      month: string;
      coverage: "complete" | "partial" | "none";
      inCents: number;
      outByCategory: { category: string; cents: number }[];
      outCents: number;
    }
  | {
      kind: "projected";
      account: string | null;
      month: string;
      inCents: number;
      outCents: number;
      outAfterCancelCents: number;
    };

export function moneyColumns(series: readonly ColumnAccount[]): MoneyColumn[] {
  const cols: MoneyColumn[] = [];
  for (const s of series) {
    for (const m of s.months) {
      cols.push({
        kind: "actual", account: s.accountIban, month: m.month, coverage: m.coverage,
        inCents: m.inCents, outByCategory: m.outByCategory, outCents: m.outCents,
      });
    }
    // Per account: another account's August says nothing about this one's.
    const drawn = new Set(s.months.map((m) => m.month));
    for (const p of s.projected) {
      if (drawn.has(p.month)) continue;
      cols.push({
        kind: "projected", account: s.accountIban, month: p.month,
        inCents: p.inCents, outCents: p.outCents, outAfterCancelCents: p.outAfterCancelCents,
      });
    }
  }
  return cols;
}
