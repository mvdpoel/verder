/**
 * Which slice of the money series the dashboard block shows.
 *
 * The dashboard has room for one account and half a year, and /money has room
 * for everything — so this picks, and the picking rule is worth a test of its
 * own. It is pure and structural (no api or component imports) so it can be
 * unit-tested without a database and without React.
 *
 * Accounts are never merged here either: this returns ONE account's months,
 * never a sum across accounts. Under bewind that sum would draw a collapse at
 * the handover that never happened.
 */

/** Half a year: enough to see a trend, small enough for a dashboard card. */
export const DASHBOARD_MONTHS = 6;

interface SliceMonth {
  month: string;
  inCents: number;
  outCents: number;
}

interface SliceAccount {
  accountIban: string | null;
  months: SliceMonth[];
}

/** Total money moved by an account, in integer cents. A magnitude, never shown. */
function volumeCents(months: SliceMonth[]): number {
  return months.reduce((sum, m) => sum + Math.abs(m.inCents) + Math.abs(m.outCents), 0);
}

/**
 * The account with the newest data, and its last six months.
 *
 * "Newest data" first, because the account the money runs through today is the
 * one worth the space — after the handover that is the leefgeldrekening even
 * though the beheerrekening has years of history behind it. Ties (the handover
 * month itself, when both accounts have rows) go to the account that moved the
 * most money, and a remaining tie goes to the lower IBAN so the answer never
 * depends on the order the router happened to return the series in.
 *
 * Returns null when there is nothing to draw — the state production is in.
 */
export function dashboardMoneySlice<S extends SliceAccount>(
  series: readonly S[],
  monthCount: number = DASHBOARD_MONTHS
): { account: S; accountIban: string | null; months: S["months"] } | null {
  const candidates = series.filter((s) => s.months.length > 0);
  if (candidates.length === 0) return null;

  const newestMonth = (s: S) => s.months[s.months.length - 1].month;
  // "" sorts below every IBAN, which is also how the unknown account is keyed
  // in buildMoneySeries — the tie-break is arbitrary but it is not random.
  const ibanKey = (s: S) => s.accountIban ?? "";

  const account = [...candidates].sort(
    (a, b) =>
      newestMonth(b).localeCompare(newestMonth(a)) ||
      volumeCents(b.months) - volumeCents(a.months) ||
      ibanKey(a).localeCompare(ibanKey(b))
  )[0];

  return {
    account,
    accountIban: account.accountIban,
    months: account.months.slice(-monthCount),
  };
}
