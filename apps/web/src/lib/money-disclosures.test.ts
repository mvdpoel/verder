import { describe, expect, it } from "vitest";
import {
  incomeLineSummaries, INCOME_LINE_ARROW, type SummarisableIncomeLine,
} from "./money-disclosures";

const line = (
  key: string,
  labels: string[],
  typicalAmountCents = 355_642,
  cadence: SummarisableIncomeLine["cadence"] = "monthly"
): SummarisableIncomeLine => ({ key, labels, cadence, typicalAmountCents });

describe("incomeLineSummaries", () => {
  it("joins a folded chain with an arrow and marks it as continued", () => {
    // Martin's real 2026 job change, straight out of money-series.real.test.ts:
    // incomeLines folds Saurens into TrueFullstaq and returns both labels on
    // one line. Printing only the first would say his income stopped in June;
    // printing them as two lines would say he has two jobs.
    const [summary] = incomeLineSummaries([
      line("k1", ["TrueFullstaq B.V.", "Saurens Marketing B.V."]),
    ]);
    expect(summary.label).toBe(`TrueFullstaq B.V.${INCOME_LINE_ARROW}Saurens Marketing B.V.`);
    expect(summary.continued).toBe(true);
  });

  it("leaves a single-employer line unadorned", () => {
    const [summary] = incomeLineSummaries([line("k1", ["Saurens Marketing B.V."])]);
    expect(summary.label).toBe("Saurens Marketing B.V.");
    expect(summary.continued).toBe(false);
  });

  it("collapses a chain that folded one name onto itself", () => {
    // Two detectRecurring groups that modalName names identically — the same
    // employer, worded differently on the statement. The arrow would draw a job
    // change that never happened.
    const [summary] = incomeLineSummaries([
      line("k1", ["TrueFullstaq B.V.", "TrueFullstaq B.V."]),
    ]);
    expect(summary.label).toBe("TrueFullstaq B.V.");
    expect(summary.continued).toBe(false);
  });

  it("keeps a return to an earlier employer as a real chain", () => {
    // Only CONSECUTIVE duplicates collapse: leaving and coming back is three
    // hops of one income, and flattening it would hide the middle job.
    const [summary] = incomeLineSummaries([
      line("k1", ["TrueFullstaq B.V.", "Saurens Marketing B.V.", "TrueFullstaq B.V."]),
    ]);
    expect(summary.label.split(INCOME_LINE_ARROW)).toHaveLength(3);
    expect(summary.continued).toBe(true);
  });

  it("ignores blank names, and drops a line that has nothing but blanks", () => {
    expect(incomeLineSummaries([line("k1", ["  ", "Saurens Marketing B.V."])])[0].label)
      .toBe("Saurens Marketing B.V.");
    expect(incomeLineSummaries([line("k1", ["", "   "])])).toEqual([]);
  });

  it("carries cadence and the full-period amount through untouched, in engine order", () => {
    // No money math here and no re-sorting: the amount is what the engine
    // measured for a full period, and the order is the chart's reading order.
    const summaries = incomeLineSummaries([
      line("oud", ["Werk B.V."], 266_068, "monthly"),
      line("leefgeld", ["VerderGroep"], 7_500, "weekly"),
    ]);
    expect(summaries.map((s) => [s.key, s.cadence, s.typicalAmountCents])).toEqual([
      ["oud", "monthly", 266_068],
      ["leefgeld", "weekly", 7_500],
    ]);
  });
});
