import { describe, expect, it } from "vitest";
import { coverageForMonths, monthKey, outSeries, type MoneyTx } from "./money-series";

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
