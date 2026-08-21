import { describe, expect, it } from "vitest";
import {
  buildMoneySeries, coverageForMonths, incomeLines, monthKey, outSeries,
  splitInternalTransfers, type MoneyTx,
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

  // Vakantiegeld is paid by the employer from the SAME IBAN as the salary, and
  // detectRecurring groups by mandate ▸ IBAN ▸ name, so "v" joins the salary
  // group: its 30/28-day gaps read as monthly, and at 23.7% below the median it
  // sits inside detectRecurring's 40% similarity band (571_040 <= 965_216).
  // The eviction pass is what takes it back out again.
  it("drops a vakantiegeld paid from the employer's own IBAN", () => {
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("v", "2026-05-22T00:00:00Z", 184_200, "TrueFullstaq BV vakantiegeld", "NL02ABNA0123456789"),
    ];
    const lines = incomeLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].transactionIds).not.toContain("v");
    // …and the line keeps the salary's name, not the one-off's. detectRecurring
    // names a group after its LAST row, which would have read
    // "TrueFullstaq BV vakantiegeld" on a chart of fixed income.
    expect(lines[0].labels).toEqual(["TrueFullstaq BV"]);
  });

  it("keeps a line whose amounts genuinely drift, evicting nothing", () => {
    // 6% either side of the median: a pay rise, not a one-off. Evicting here
    // would understate the income bar and invent an incidenteel that is not one.
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 227_000, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("b", "2026-04-24T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("c", "2026-05-25T00:00:00Z", 255_000, "TrueFullstaq BV", "NL02ABNA0123456789"),
    ];
    const lines = incomeLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].transactionIds).toEqual(["a", "b", "c"]);
  });

  it("never evicts a row out of a pair — two rows are the whole evidence", () => {
    // A group of two has no majority to be an outlier against: whichever row
    // you call the one-off, the other one is equally far from the median.
    const rows = [
      credit("a", "2026-03-25T00:00:00Z", 241_304, "TrueFullstaq BV", "NL02ABNA0123456789"),
      credit("v", "2026-04-24T00:00:00Z", 184_200, "TrueFullstaq BV", "NL02ABNA0123456789"),
    ];
    expect(incomeLines(rows)[0].transactionIds).toEqual(["a", "v"]);
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

describe("buildMoneySeries", () => {
  const items = [
    { id: "i1", name: "Vattenfall", category: "energy", monthlyCents: 21_000, status: "allowed" },
    { id: "i2", name: "IPTV Totaal", category: "streaming", monthlyCents: 9_600, status: "to-cancel" },
    { id: "i3", name: "Oude sportschool", category: "other", monthlyCents: 3_000, status: "canceled" },
  ];

  it("splits accounts and never draws one series through both", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-25T00:00:00Z", amountCents: 241_304,
           counterpartyIban: "NL02ABNA0123456789", accountIban: "NL91ABNA0417164300" }),
      tx({ id: "b", bookedAt: "2026-07-25T00:00:00Z", amountCents: 241_304,
           counterpartyIban: "NL02ABNA0123456789", accountIban: "NL91ABNA0417164300" }),
      // VerderGroep pays leefgeld weekly.
      tx({ id: "c", bookedAt: "2026-08-07T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-08-14T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
    ];
    const series = buildMoneySeries({ transactions: rows, items });
    expect(series.map((s) => s.accountIban).sort())
      .toEqual(["NL44RABO0555444333", "NL91ABNA0417164300"]);
    const leefgeld = series.find((s) => s.accountIban === "NL44RABO0555444333")!;
    expect(leefgeld.incomeLines).toHaveLength(1); // the leefgeld line
    expect(leefgeld.months.every((m) => m.month >= "2026-08")).toBe(true);
    // The salary never leaks into the leefgeld account's own series.
    expect(leefgeld.incomeLines[0].transactionIds).toEqual(["c", "d"]);
  });

  it("detects a weekly leefgeld line", () => {
    const rows = [
      tx({ id: "c", bookedAt: "2026-08-07T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-08-14T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
    ];
    const [leefgeld] = buildMoneySeries({ transactions: rows, items });
    expect(leefgeld.incomeLines).toHaveLength(1);
    expect(leefgeld.incomeLines[0].cadence).toBe("weekly");
  });

  it("projects a weekly line as a monthly figure, in integer cents", () => {
    // €250 a week is not €250 a month: 52 payments across 12 months.
    const rows = [
      tx({ id: "a", bookedAt: "2026-08-01T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "b", bookedAt: "2026-08-08T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "c", bookedAt: "2026-08-15T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-08-31T00:00:00Z", amountCents: 25_000,
           counterpartyIban: "NL10VERD0001112223", accountIban: "NL44RABO0555444333" }),
    ];
    const [leefgeld] = buildMoneySeries({ transactions: rows, items: [], horizonMonths: 1 });
    expect(leefgeld.lastCompleteMonth).toBe("2026-08");
    expect(leefgeld.projected[0].inCents).toBe(108_333); // trunc(25_000 * 52 / 12)
  });

  it("projects each account's own contracted costs, never the registry twice", () => {
    // The whole reason the account dimension exists: after the handover the
    // beheerrekening pays the contracts and the leefgeldrekening pays groceries.
    // Broadcasting the registry total to both would show a bewindvoerder a cost
    // projection of roughly twice the contracted total.
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -21_000,
           financialItemId: "i1", accountIban: "NL91ABNA0417164300" }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -9_600,
           financialItemId: "i2", accountIban: "NL91ABNA0417164300" }),
      tx({ id: "c", bookedAt: "2026-06-01T00:00:00Z", amountCents: -4_000,
           accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-06-30T00:00:00Z", amountCents: -3_500,
           accountIban: "NL44RABO0555444333" }),
    ];
    const series = buildMoneySeries({ transactions: rows, items, horizonMonths: 1 });
    const beheer = series.find((s) => s.accountIban === "NL91ABNA0417164300")!;
    const leefgeld = series.find((s) => s.accountIban === "NL44RABO0555444333")!;
    expect(beheer.projected[0].outCents).toBe(30_600);
    expect(beheer.projected[0].outAfterCancelCents).toBe(21_000);
    // Groceries are real debits but no contract: nothing to project.
    expect(leefgeld.projected[0].outCents).toBe(0);
    expect(leefgeld.projected[0].outAfterCancelCents).toBe(0);
    // The registry total, counted once across the accounts.
    expect(beheer.projected[0].outCents + leefgeld.projected[0].outCents).toBe(30_600);
  });

  it("projects an item nobody has been seen paying onto the account that pays", () => {
    // A registry seeded from the mail before a single statement links to it.
    // Dropping it would understate the projection; the account with the debits
    // is the only evidence there is about who will pay it.
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -12_000,
           accountIban: "NL91ABNA0417164300" }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -8_000,
           accountIban: "NL91ABNA0417164300" }),
      tx({ id: "c", bookedAt: "2026-06-01T00:00:00Z", amountCents: -1_000,
           accountIban: "NL44RABO0555444333" }),
      tx({ id: "d", bookedAt: "2026-06-30T00:00:00Z", amountCents: -900,
           accountIban: "NL44RABO0555444333" }),
    ];
    const series = buildMoneySeries({ transactions: rows, items, horizonMonths: 1 });
    const beheer = series.find((s) => s.accountIban === "NL91ABNA0417164300")!;
    const leefgeld = series.find((s) => s.accountIban === "NL44RABO0555444333")!;
    expect(beheer.projected[0].outCents).toBe(30_600);
    expect(leefgeld.projected[0].outCents).toBe(0);
  });

  it("projects costs without canceled items and shows the to-cancel saving", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -21_000, financialItemId: "i1" }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -9_600, financialItemId: "i2" }),
    ];
    const [series] = buildMoneySeries({ transactions: rows, items, horizonMonths: 2 });
    expect(series.lastCompleteMonth).toBe("2026-06");
    expect(series.projected).toHaveLength(2);
    // canceled i3 is gone entirely; to-cancel i2 counts until it is cancelled
    expect(series.projected[0].outCents).toBe(30_600);
    expect(series.projected[0].outAfterCancelCents).toBe(21_000);
  });

  it("projects from the last COMPLETE month, so the projection overlaps a partial one", () => {
    // The normal shape of real data: the newest statement ends mid-month, so
    // July is real but partial and June is the last complete month — which
    // puts the first projected month ON TOP of a month that already has bank
    // rows. That is correct here (a partial month is not a base to project
    // from), and it is exactly why the chart must not draw both: see
    // apps/web/src/lib/money-columns.ts.
    const rows = [
      tx({ id: "a", bookedAt: "2026-06-01T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "b", bookedAt: "2026-06-30T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "c", bookedAt: "2026-07-01T00:00:00Z", amountCents: -1_000, statementSha256: "stmt-b" }),
      tx({ id: "d", bookedAt: "2026-07-14T00:00:00Z", amountCents: -1_000, statementSha256: "stmt-b" }),
    ];
    const [series] = buildMoneySeries({ transactions: rows, items: [], horizonMonths: 3 });
    expect(series.months.map((m) => `${m.month}:${m.coverage}`)).toEqual([
      "2026-06:complete", "2026-07:partial",
    ]);
    expect(series.lastCompleteMonth).toBe("2026-06");
    expect(series.projected.map((p) => p.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("reports a month with no rows as none, not zero", () => {
    const rows = [
      tx({ id: "a", bookedAt: "2026-05-01T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "b", bookedAt: "2026-05-31T00:00:00Z", amountCents: -1_000 }),
      tx({ id: "c", bookedAt: "2026-07-01T00:00:00Z", amountCents: -1_000, statementSha256: "s2" }),
      tx({ id: "d", bookedAt: "2026-07-31T00:00:00Z", amountCents: -1_000, statementSha256: "s2" }),
    ];
    const [series] = buildMoneySeries({ transactions: rows, items: [] });
    expect(series.months.find((m) => m.month === "2026-06")!.coverage).toBe("none");
    expect(series.months.find((m) => m.month === "2026-06")!.outCents).toBe(0);
    expect(series.lastCompleteMonth).toBe("2026-07");
  });

  it("returns nothing at all for an empty database", () => {
    expect(buildMoneySeries({ transactions: [], items: [] })).toEqual([]);
  });
});
