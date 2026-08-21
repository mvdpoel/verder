import { describe, expect, it } from "vitest";
import {
  coverageForMonths, incomeLines, monthKey, outSeries, splitInternalTransfers,
  type MoneyTx,
} from "./money-series";

// bookedAt is Omit-ted from the Partial before the override: intersecting
// `bookedAt?: Date` with `bookedAt: string` yields `Date & string`, i.e. never,
// and no call site can satisfy it. Dates are written as ISO strings here so a
// fixture reads as a date at a glance.
const tx = (
  o: Omit<Partial<MoneyTx>, "bookedAt"> & { id: string; bookedAt: string; amountCents: number }
): MoneyTx => ({
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
    // A belastingteruggave arrives once, from its own payer. It never forms a
    // group of two, so it never becomes an income line and falls through to
    // `incidentalCents` instead.
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("v", "2026-05-22T00:00:00Z", 184_200, "Belastingdienst teruggaaf", "NL29INGB0000123456"),
    ];
    const lines = incomeLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].transactionIds).not.toContain("v");
  });

  // KNOWN GAP — this is the plan's own fixture and its assertions, unchanged,
  // marked `.fails` because the module does NOT yet do this. Vakantiegeld is
  // paid by the employer from the SAME IBAN as the salary, and detectRecurring
  // groups by mandate ▸ IBAN ▸ name, so "v" joins the salary group: its 30/28-day
  // gaps read as monthly, and at 23.7% below the median it sits inside
  // detectRecurring's 40% similarity band (571_040 <= 965_216). Two visible
  // symptoms: the row is counted as fixed income instead of surfacing in
  // `incidentalCents`, and the line is labelled "TrueFullstaq BV vakantiegeld"
  // because the group's name is taken from its last row.
  //
  // The spec (§Money in, rule 1) asserts detectRecurring "already implements
  // exactly the needed rule"; for this case it does not, and rules 1 and 5
  // contradict each other. Closing it needs a derivation rule that is in
  // neither the spec nor the plan, with a threshold nobody has measured against
  // Martin's real ABN export — so it is raised rather than guessed at here.
  // When it is fixed, THIS TEST WILL FAIL and the `.fails` must be removed.
  it.fails("drops a vakantiegeld paid from the employer's own IBAN", () => {
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
