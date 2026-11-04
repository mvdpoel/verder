import { mobileGet } from "@/lib/mobile-route";
import { dashboardMoneySlice } from "@/lib/dashboard-money-slice";
import { addDays, dayKey, weekBounds } from "@grip/api/src/amsterdam";
import { leefgeldWeek, type LeefgeldWeek } from "@grip/api/src/leefgeld-week";
import type { MonthSeries } from "@grip/api/src/money-series";
import { monthMeta, type MonthMeta } from "@/lib/mobile-money-meta";

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
  accounts: {
    accountIban: string | null;
    /**
     * Each month as /money builds it, plus the captions under the phone's two
     * headline numbers (`monthMeta`): additive fields an older phone ignores.
     */
    months: (MonthSeries & MonthMeta)[];
    /**
     * This account's own newest readable booking (Amsterdam day), or null.
     * Two statements of two accounts end on different days, so the phone's
     * per-account card must not borrow the table-wide `newestBooking`.
     */
    newestBooking: string | null;
    /**
     * Whether this is the leefgeldrekening: LEEFGELD_IBAN, else the account
     * the leefgeld week recognised. Read even with no weekly amount set, so
     * the phone can name the account without guessing.
     */
    isLeefgeldAccount: boolean;
  }[];
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

  // Each account's own newest readable booking: a parse-error row carries a
  // borrowed date (the import's earliest booking), never one the bank wrote.
  const newestByAccount = new Map<string | null, Date>();
  for (const t of txs) {
    if (t.parseError) continue;
    const prev = newestByAccount.get(t.accountIban);
    if (!prev || t.bookedAt > prev) newestByAccount.set(t.accountIban, t.bookedAt);
  }

  const today = dayKey(new Date());
  // The previous week is judged WHOLE: its "today" is its own last day, the
  // day before this week starts. "Today minus seven" would cut it at the
  // same weekday and report a finished week as partial.
  const lastDayOfPreviousWeek = addDays(weekBounds(today, weekStartsOn).from, -1);
  const week = (day: string) =>
    leefgeldWeek({ txs, series, weeklyCents, configuredIban, today: day, weekStartsOn });

  const leefgeld = week(today);
  const recognised = leefgeld.state === "complete" || leefgeld.state === "partial" || leefgeld.state === "geen-data"
    ? leefgeld.accountIban : null;
  const leefgeldIban = configuredIban ?? recognised;

  const ownIbans = new Set(series.map((s) => s.accountIban).filter((i): i is string => i !== null));

  return {
    accounts: series.map((s) => {
      const newest = newestByAccount.get(s.accountIban);
      const meta = monthMeta(s, txs, ownIbans);
      return {
        accountIban: s.accountIban,
        // dashboardMoneySlice on ONE account is just its six newest months; it
        // never chooses between accounts here.
        months: (dashboardMoneySlice([s])?.months ?? []).map((m) => ({
          ...m, ...(meta.get(m.month) ?? { outRows: 0, inSources: [] }),
        })),
        newestBooking: newest ? dayKey(newest) : null,
        isLeefgeldAccount: s.accountIban !== null && s.accountIban === leefgeldIban,
      };
    }),
    leefgeld,
    previousWeek: week(lastDayOfPreviousWeek),
    newestBooking,
  };
});
