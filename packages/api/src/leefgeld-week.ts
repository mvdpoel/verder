/**
 * "Leefgeld over deze week". PURE: no database, no I/O, no environment reads —
 * the caller passes the budget, the configured IBAN and the week start in.
 *
 * The figure is only ever shown for days the bank statements PROVABLY cover,
 * using the same merged Amsterdam-day ranges as /money's months
 * (`coveredRanges`). An uncovered week reads `geen-data`, never € 100 left:
 * an invented figure is exactly what the money law forbids.
 *
 * Accounts are never merged. The figure belongs to ONE account — the
 * leefgeldrekening — chosen as follows, with the reason always returned:
 *   1. `configuredIban` (LEEFGELD_IBAN) when set → "configured";
 *   2. else the single account WITH A KNOWN IBAN that has a weekly income line
 *      (VerderGroep's weekly payout; `detectRecurring` emits `weekly` for
 *      credits only) → "weekly-income". The NULL-IBAN "unknown account" series
 *      is never a candidate: it may mix accounts;
 *   3. zero or several candidates → `no-account`, no figure.
 *
 * Spent is every readable debit in the covered part of the week (as on /money's
 * costs bar), deposits every readable credit in it. Both are returned as row
 * lists and each total is summed FROM its list, so the figure reconciles.
 * `leftCents` may be negative; it is never amber — amber is for what waits on
 * Martin.
 */
import { dayKey, weekBounds } from "./amsterdam";
import {
  byBookedAtThenId, coveredRanges, disclosedRow,
  type AccountSeries, type DisclosedRow, type MoneyTx,
} from "./money-series";

export type LeefgeldAccountReason = "configured" | "weekly-income";

export type LeefgeldWeek =
  | { state: "no-budget" }
  | { state: "no-account"; candidates: string[] }
  | {
      state: "geen-data"; accountIban: string; accountReason: LeefgeldAccountReason;
      week: { from: string; to: string }; newestBooking: string | null;
    }
  | {
      state: "complete" | "partial"; accountIban: string; accountReason: LeefgeldAccountReason;
      week: { from: string; to: string }; coveredThrough: string;
      budgetCents: number; spentCents: number; leftCents: number;
      /** The debits behind `spentCents`, oldest first, amounts as booked (negative). */
      spentRows: DisclosedRow[];
      depositCents: number;
      /** The credits behind `depositCents`, oldest first. */
      depositRows: DisclosedRow[];
    };

export function leefgeldWeek(input: {
  txs: MoneyTx[]; series: AccountSeries[];
  weeklyCents: number | null; configuredIban: string | null;
  /** Amsterdam day key, "YYYY-MM-DD". */
  today: string;
  /** ISO weekday the week starts on (LEEFGELD_WEEK_START); default Monday. */
  weekStartsOn?: number;
}): LeefgeldWeek {
  if (input.weeklyCents === null) return { state: "no-budget" };

  let accountIban: string;
  let accountReason: LeefgeldAccountReason;
  if (input.configuredIban) {
    accountIban = input.configuredIban;
    accountReason = "configured";
  } else {
    const candidates = input.series
      .filter((s) => s.accountIban !== null && s.incomeLines.some((l) => l.cadence === "weekly"))
      .map((s) => s.accountIban as string)
      .sort();
    if (candidates.length !== 1) return { state: "no-account", candidates };
    accountIban = candidates[0];
    accountReason = "weekly-income";
  }

  const week = weekBounds(input.today, input.weekStartsOn ?? 1);
  const accountTxs = input.txs.filter((t) => t.accountIban === accountIban);
  const readable = accountTxs.filter((t) => !t.parseError);

  // The week counts only from a range that contains its first day. A statement
  // starting mid-week leaves the week geen-data even with rows in it — the
  // same safe direction as a month.
  const range = coveredRanges(accountTxs).find((r) => r.from <= week.from && r.to >= week.from);
  if (!range) {
    const newest = readable.reduce<string | null>((acc, t) => {
      const d = dayKey(t.bookedAt);
      return acc === null || d > acc ? d : acc;
    }, null);
    return { state: "geen-data", accountIban, accountReason, week, newestBooking: newest };
  }

  const wantedThrough = week.to < input.today ? week.to : input.today;
  const complete = range.to >= wantedThrough;
  const coveredThrough = complete ? wantedThrough : range.to;

  const inWindow = readable.filter((t) => {
    const d = dayKey(t.bookedAt);
    return d >= week.from && d <= coveredThrough;
  });
  const spentRows = inWindow.filter((t) => t.amountCents < 0).map(disclosedRow).sort(byBookedAtThenId);
  const depositRows = inWindow.filter((t) => t.amountCents > 0).map(disclosedRow).sort(byBookedAtThenId);
  const spentCents = spentRows.reduce((s, r) => s - r.amountCents, 0);
  const depositCents = depositRows.reduce((s, r) => s + r.amountCents, 0);

  return {
    state: complete ? "complete" : "partial",
    accountIban, accountReason, week, coveredThrough,
    budgetCents: input.weeklyCents,
    spentCents,
    leftCents: input.weeklyCents - spentCents,
    spentRows, depositCents, depositRows,
  };
}
