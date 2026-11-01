import { mobileGet } from "@/lib/mobile-route";
import { dashboardMoneySlice } from "@/lib/dashboard-money-slice";
import { addDays, dayKey, weekBounds } from "@verder/api/src/amsterdam";
import { leefgeldWeek, type LeefgeldWeek } from "@verder/api/src/leefgeld-week";
import type { MonthSeries } from "@verder/api/src/money-series";

/**
 * The phone's money glance (Plan 3 Task 18, spec §7.6): each account's last
 * six months, and "leefgeld over deze week" with the week before it.
 *
 * ONE read: `money.glance` returns the series exactly as /money builds them
 * plus the raw rows, and both leefgeld weeks are computed from that one read.
 * Accounts are never merged — there is no total across them in this answer —
 * and each month carries its incidental and internal rows, because a bar
 * without its disclosures does not reconcile.
 */

interface MoneySummaryDTO {
  accounts: { accountIban: string | null; months: MonthSeries[] }[];
  leefgeld: LeefgeldWeek;
  previousWeek: LeefgeldWeek;
  /** Newest readable booking (Amsterdam day): "deze week" is only as fresh as the last import. */
  newestBooking: string | null;
}

/**
 * The weekly budget in integer cents, or null. Only a plain run of digits
 * counts: "100,00", "1e4" or a negative is a typo, and a typo must read as
 * "no budget" (the card is hidden), never as a budget of 0 or 100 cents.
 */
function weeklyCentsFromEnv(raw: string | undefined): number | null {
  const v = raw?.trim() ?? "";
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** ISO weekday 1..7; anything else is Monday, the measured default (Task 17 Step 0). */
function weekStartFromEnv(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  return /^[1-7]$/.test(v) ? Number(v) : 1;
}

export const GET = mobileGet(async (caller): Promise<MoneySummaryDTO> => {
  const { series, txs, newestBooking } = await caller.money.glance();

  const weeklyCents = weeklyCentsFromEnv(process.env.LEEFGELD_WEEKLY_CENTS);
  const configuredIban = process.env.LEEFGELD_IBAN?.trim() || null;
  const weekStartsOn = weekStartFromEnv(process.env.LEEFGELD_WEEK_START);

  const today = dayKey(new Date());
  // The previous week is judged WHOLE: its "today" is its own last day, the
  // day before this week starts. "Today minus seven" would cut it at the
  // same weekday and report a finished week as partial.
  const lastDayOfPreviousWeek = addDays(weekBounds(today, weekStartsOn).from, -1);
  const week = (day: string) =>
    leefgeldWeek({ txs, series, weeklyCents, configuredIban, today: day, weekStartsOn });

  return {
    accounts: series.map((s) => ({
      accountIban: s.accountIban,
      // dashboardMoneySlice on ONE account is just its six newest months; it
      // never chooses between accounts here.
      months: dashboardMoneySlice([s])?.months ?? [],
    })),
    leefgeld: week(today),
    previousWeek: week(lastDayOfPreviousWeek),
    newestBooking,
  };
});
