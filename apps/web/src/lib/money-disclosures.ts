/**
 * How /money names the income lines behind its bars.
 *
 * Pure and structural (no api or component imports, no React) so the rule can
 * be unit-tested without a database and without rendering — the same habit as
 * `money-columns.ts` and `dashboard-money-slice.ts`.
 *
 * `incomeLines` in packages/api/src/money-series.ts folds a successor line into
 * its predecessor when a job change replaces the counterparty, and returns the
 * chain in `labels`, oldest first. That fold is the single reason Martin's
 * chart does not report his income ending in June 2026 — and until now it was
 * rendered nowhere, so the page kept the one thing it most needed to show. This
 * turns the chain into the line the page prints.
 */

/** The cadences `detectRecurring` can report. Widening it there breaks here, loudly. */
export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * Joins the chain. An arrow, not a comma: "TrueFullstaq B.V. → Saurens
 * Marketing B.V." reads as one income continuing into the next, which is what
 * the fold asserts. A comma would read as two incomes side by side, which is
 * exactly the story the fold exists to prevent.
 */
export const INCOME_LINE_ARROW = " → ";

/** The parts of an IncomeLine this list needs; the rest stays with the engine. */
export interface SummarisableIncomeLine {
  key: string;
  labels: string[];
  cadence: Cadence;
  typicalAmountCents: number;
}

export interface IncomeLineSummary {
  key: string;
  /** The chain, joined: "TrueFullstaq B.V. → Saurens Marketing B.V.". */
  label: string;
  /** True when this is a chain: one income that continued under a new name. */
  continued: boolean;
  cadence: Cadence;
  /** What one FULL period pays. Integer cents; this file does no money math. */
  typicalAmountCents: number;
}

export function incomeLineSummaries(
  lines: readonly SummarisableIncomeLine[]
): IncomeLineSummary[] {
  const out: IncomeLineSummary[] = [];
  for (const line of lines) {
    const names: string[] = [];
    for (const raw of line.labels) {
      const name = raw.trim();
      if (name === "") continue;
      // Consecutive duplicates collapse. A fold can join two groups that
      // `modalName` names identically — one employer whose statement wording
      // changed enough to split detectRecurring's grouping — and
      // "TrueFullstaq B.V. → TrueFullstaq B.V." draws a job change that never
      // happened. CONSECUTIVE only: going back to a previous employer is a real
      // chain and keeps both hops.
      if (name === names[names.length - 1]) continue;
      names.push(name);
    }
    // A line nobody can name cannot be pointed at, and an arrow between blanks
    // says less than nothing. Its money is still in the bars — the engine
    // counted it — so dropping it here hides no euro, only an empty row.
    if (names.length === 0) continue;
    out.push({
      key: line.key,
      label: names.join(INCOME_LINE_ARROW),
      continued: names.length > 1,
      cadence: line.cadence,
      typicalAmountCents: line.typicalAmountCents,
    });
  }
  // Engine order is kept: incomeLines sorts by firstAt, oldest first, which is
  // the direction the chart above this list is read in.
  return out;
}
