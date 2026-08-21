import { describe, expect, it } from "vitest";
import { buildMoneySeries, incomeLines, type MoneyTx } from "./money-series";

/**
 * Martin's real credits, read from the ABN statement 24-04-2026 t/m 02-08-2026
 * and cross-checked against the July payslip (cumulative netto € 6.044,13 =
 * € 2.487,71 + € 3.556,42, to the cent).
 *
 * This file exists because the first implementation, measured against these
 * exact rows, drew € 0,00 income for April and May — months in which € 5.006,31
 * arrived — and projected € 3.022,06 when the real forward salary is € 3.556,42.
 * Every assertion below is a fact about a real bank statement, not a fixture
 * someone invented, which is why it is kept separate from money-series.test.ts.
 *
 * The shape that broke it:
 *   - TrueFullstaq paid wildly varying amounts (€ 648,00 / € 2.660,68 /
 *     € 1.118,65) — the last one a part-month, because Martin left on 10 June.
 *   - Saurens Marketing started 10 June: a part-month on 28 June, the first
 *     full salary on 28 July.
 * Part-months are normal at BOTH ends of a job change. An income rule that
 * needs stable amounts cannot survive one.
 */

const ACCOUNT = "NL12ABNA0566567741"; // the payslip's "Betaald op rekeningnummer"
const TFS = "NL50RABO0312059892";
const SAURENS = "NL02REVO6821156565";
const BELASTINGDIENST = "NL86INGB0002445588";
const WOONHAVE = "NL27ZZZ619752300000";

const row = (
  id: string, day: string, cents: number, name: string, iban: string
): MoneyTx => ({
  id, accountIban: ACCOUNT, bookedAt: new Date(day), amountCents: cents,
  counterpartyName: name, counterpartyIban: iban,
  mandateId: null, parseError: false, financialItemId: null, statementSha256: "abn-2026-08-03",
});

const CREDITS: MoneyTx[] = [
  row("c1", "2026-04-24T00:00:00Z", 64_800, "TrueFullstaq B.V.", TFS),
  row("c2", "2026-05-22T00:00:00Z", 266_068, "TrueFullstaq B.V.", TFS),
  row("c3", "2026-05-27T00:00:00Z", 166_549, "BELASTINGDIENST", BELASTINGDIENST),
  row("c4", "2026-05-27T00:00:00Z", 3_214, "BELASTINGDIENST", BELASTINGDIENST),
  row("c5", "2026-06-25T00:00:00Z", 111_865, "TrueFullstaq B.V.", TFS),
  row("c6", "2026-06-28T00:00:00Z", 248_771, "Saurens Marketing B.V.", SAURENS),
  row("c7", "2026-07-28T00:00:00Z", 355_642, "Saurens Marketing B.V.", SAURENS),
];

const RENT: MoneyTx[] = [
  row("r1", "2026-06-01T00:00:00Z", -174_009, "WOONHAVE BELEGGINGEN", WOONHAVE),
  row("r2", "2026-07-01T00:00:00Z", -181_665, "WOONHAVE BELEGGINGEN", WOONHAVE),
];

const monthOf = (txs: MoneyTx[], month: string) => {
  const [s] = buildMoneySeries({ transactions: txs, items: [] });
  const m = s.months.find((x) => x.month === month);
  if (!m) throw new Error(`no month ${month}`);
  return m;
};

describe("Martin's real ABN statement", () => {
  it("never reports a month as zero income when salary arrived", () => {
    // April € 648,00 and May € 2.660,68 are salary from TrueFullstaq. The first
    // implementation rendered both months as € 0,00 vast inkomen.
    expect(monthOf(CREDITS, "2026-04").inCents).toBe(64_800);
    expect(monthOf(CREDITS, "2026-05").inCents).toBe(266_068);
  });

  it("counts a part-month at both ends of the job change", () => {
    // 25 June: TrueFullstaq's final part-month. 28 June: Saurens' first.
    // Both are salary; June's bar is the sum.
    expect(monthOf(CREDITS, "2026-06").inCents).toBe(111_865 + 248_771);
    expect(monthOf(CREDITS, "2026-07").inCents).toBe(355_642);
  });

  it("keeps a tax refund out of fixed income and discloses it", () => {
    const may = monthOf(CREDITS, "2026-05");
    expect(may.incidentalCents).toBe(166_549 + 3_214);
  });

  it("holds one income line across the employer change", () => {
    const lines = incomeLines(CREDITS);
    const salary = lines.find((l) => l.labels.includes("Saurens Marketing B.V."));
    expect(salary).toBeDefined();
    expect(salary!.labels).toEqual(["TrueFullstaq B.V.", "Saurens Marketing B.V."]);
  });

  it("projects the latest full salary, not an average that includes a ramp-in", () => {
    const [s] = buildMoneySeries({ transactions: [...CREDITS, ...RENT], items: [] });
    // € 3.556,42 is the July netto on the payslip and the 28-07 bank credit.
    // € 3.022,06 — the mean of the part-month and the full month — is the
    // number the first implementation projected, and it under-reported by
    // € 534,36 a month.
    expect(s.projected[0].inCents).toBe(355_642);
  });
});
