/**
 * The words the phone's Geld card writes under its two headline numbers
 * (Figma "money · final", Geld): how many bookings the spending bar holds, and
 * where the income bar's money came from — "14 boekingen", "Atelier
 * Sterrenwacht", "5× weekbedrag · van beheerrekening".
 *
 * Pure and additive: it reads the series exactly as `buildMoneySeries` built
 * them and the same rows, and decides NOTHING about which money counts. The
 * counts come from the same predicates the bars do — `outRows` is every
 * readable debit of the month (`outSeries`' own filter) and each `inSources`
 * entry is a group of the rows `incomeLines` counted in — so a caption can
 * never describe a bar it is not under. Accounts are never merged: an account
 * only ever names ANOTHER account as a source, it never adds one to itself.
 */
import { monthKey, type AccountSeries, type MoneyTx } from "@grip/api/src/money-series";

export interface InSource {
  /** The counterparty as the bank wrote it most often this month, or null. */
  label: string | null;
  /** How many of the month's counted-in rows came from this line. */
  count: number;
  cadence: AccountSeries["incomeLines"][number]["cadence"];
  /**
   * The payer, when every row of this group came from ONE of Martin's own
   * other accounts in this summary (the beheerrekening paying the weekly
   * leefgeld). Null for anyone else, so the phone never names a stranger's
   * IBAN.
   */
  fromAccountIban: string | null;
}

export interface MonthMeta {
  outRows: number;
  inSources: InSource[];
}

function modal(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && v < best)) { best = v; bestCount = c; }
  }
  return best;
}

/** One account's captions per month ("YYYY-MM"). */
export function monthMeta(series: AccountSeries, txs: MoneyTx[], ownIbans: ReadonlySet<string>): Map<string, MonthMeta> {
  const mine = txs.filter((t) => (t.accountIban ?? null) === series.accountIban && !t.parseError);
  const lineOf = new Map<string, number>();
  series.incomeLines.forEach((l, i) => { for (const id of l.transactionIds) lineOf.set(id, i); });

  const out = new Map<string, MonthMeta>();
  for (const m of series.months) {
    const rows = mine.filter((t) => monthKey(t.bookedAt) === m.month);
    const groups = new Map<number, MoneyTx[]>();
    for (const t of rows) {
      const line = lineOf.get(t.id);
      if (line === undefined || t.amountCents <= 0) continue;
      groups.set(line, [...(groups.get(line) ?? []), t]);
    }
    const inSources: InSource[] = [...groups].map(([line, g]) => {
      const payers = new Set(g.map((t) => t.counterpartyIban));
      const [payer] = [...payers];
      const own = payers.size === 1 && payer && payer !== series.accountIban && ownIbans.has(payer) ? payer : null;
      return {
        label: modal(g.map((t) => t.counterpartyName)),
        count: g.length,
        cadence: series.incomeLines[line].cadence,
        fromAccountIban: own,
      };
    }).sort((a, b) => b.count - a.count || (a.label ?? "").localeCompare(b.label ?? ""));
    out.set(m.month, { outRows: rows.filter((t) => t.amountCents < 0).length, inSources });
  }
  return out;
}
