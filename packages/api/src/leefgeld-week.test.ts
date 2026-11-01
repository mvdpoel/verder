import { describe, expect, it } from "vitest";
import { leefgeldWeek, type LeefgeldWeek } from "./leefgeld-week";
import { buildMoneySeries, type MoneyTx } from "./money-series";

const LEEF = "NL02ABNA0123456789";
const BEHEER = "NL91ABNA0417164300";
const OTHER = "NL55INGB0001234567";
const VERDER = "NL20RABO0300065264";

const tx = (
  o: Omit<Partial<MoneyTx>, "bookedAt"> & { id: string; bookedAt: string; amountCents: number }
): MoneyTx => ({
  accountIban: LEEF, counterpartyName: null, counterpartyIban: null,
  mandateId: null, parseError: false, financialItemId: null, statementSha256: "stmt-a",
  ...o, bookedAt: new Date(o.bookedAt),
});

/** VerderGroep's weekly € 100 on the leefgeldrekening, Mondays. */
const payout = (id: string, day: string, extra: Omit<Partial<MoneyTx>, "bookedAt"> = {}) =>
  tx({
    id, bookedAt: `${day}T10:00:00Z`, amountCents: 10000,
    counterpartyName: "VerderGroep", counterpartyIban: VERDER, ...extra,
  });

const debit = (id: string, day: string, cents: number, extra: Omit<Partial<MoneyTx>, "bookedAt"> = {}) =>
  tx({ id, bookedAt: `${day}T12:00:00Z`, amountCents: -cents, ...extra });

// Today: Thursday 29 October 2026. The Monday week is 26 Oct – 1 Nov.
const TODAY = "2026-10-29";

function run(txs: MoneyTx[], over: Partial<Parameters<typeof leefgeldWeek>[0]> = {}): LeefgeldWeek {
  return leefgeldWeek({
    txs, series: buildMoneySeries({ transactions: txs, items: [] }),
    weeklyCents: 10000, configuredIban: null, today: TODAY, ...over,
  });
}

/** A statement covering 12 Oct through today, with the week's payout and two debits. */
const covered = (): MoneyTx[] => [
  payout("p1", "2026-10-12"),
  payout("p2", "2026-10-19"),
  debit("d0", "2026-10-21", 2500), // last week: never counted
  payout("p3", "2026-10-26"),
  debit("d1", "2026-10-26", 1250),
  debit("d2", "2026-10-28", 3000),
  debit("d3", TODAY, 500),
];

function figure(w: LeefgeldWeek) {
  if (w.state !== "complete" && w.state !== "partial") throw new Error(`no figure: ${w.state}`);
  return w;
}

describe("leefgeldWeek", () => {
  it("shows a complete week from covered days", () => {
    const w = figure(run(covered()));
    expect(w.state).toBe("complete");
    expect(w.accountIban).toBe(LEEF);
    expect(w.accountReason).toBe("weekly-income");
    expect(w.week).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(w.coveredThrough).toBe(TODAY);
    expect(w.spentCents).toBe(4750);
    expect(w.leftCents).toBe(5250);
    expect(w.depositCents).toBe(10000);
  });

  it("uncovered week shows no figure", () => {
    const txs = [payout("p1", "2026-10-12"), payout("p2", "2026-10-19"), debit("d0", "2026-10-20", 900)];
    const w = run(txs);
    expect(w.state).toBe("geen-data");
    if (w.state !== "geen-data") return;
    expect(w.accountIban).toBe(LEEF);
    expect(w.newestBooking).toBe("2026-10-20");
    expect(w).not.toHaveProperty("spentCents");
    expect(w).not.toHaveProperty("leftCents");
  });

  it("statement starting Wednesday leaves the week geen-data", () => {
    const txs = [
      payout("p1", "2026-10-12"), payout("p2", "2026-10-19"),
      // A second statement that begins on Wednesday: Monday and Tuesday are
      // not provably covered, so the week has no figure even with rows in it.
      debit("d1", "2026-10-28", 3000, { statementSha256: "stmt-b" }),
      debit("d2", TODAY, 500, { statementSha256: "stmt-b" }),
    ];
    expect(run(txs).state).toBe("geen-data");
  });

  it("partial week sums only covered days", () => {
    const txs = [
      payout("p1", "2026-10-12"), payout("p2", "2026-10-19"),
      payout("p3", "2026-10-26"), debit("d1", "2026-10-27", 2000),
      // A separate statement for today alone does not cover the 28th, so it
      // neither extends the range nor counts.
      debit("d2", TODAY, 7000, { statementSha256: "stmt-b" }),
    ];
    const w = figure(run(txs));
    expect(w.state).toBe("partial");
    expect(w.coveredThrough).toBe("2026-10-27");
    expect(w.spentCents).toBe(2000);
    expect(w.spentRows.map((r) => r.id)).toEqual(["d1"]);
  });

  it("spent sums from its own row list", () => {
    const w = figure(run(covered()));
    expect(w.spentRows.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
    expect(w.spentCents).toBe(w.spentRows.reduce((s, r) => s - r.amountCents, 0));
    expect(w.depositRows.map((r) => r.id)).toEqual(["p3"]);
    expect(w.depositCents).toBe(w.depositRows.reduce((s, r) => s + r.amountCents, 0));
    expect(w.leftCents).toBe(w.budgetCents - w.spentCents);
  });

  it("two weekly-income accounts give no-account", () => {
    const txs = [
      ...covered(),
      payout("q1", "2026-10-12", { accountIban: OTHER }),
      payout("q2", "2026-10-19", { accountIban: OTHER }),
    ];
    const w = run(txs);
    expect(w).toEqual({ state: "no-account", candidates: [LEEF, OTHER] });
  });

  it("the null-IBAN series is never chosen", () => {
    const txs = covered().map((t) => ({ ...t, accountIban: null }));
    expect(run(txs)).toEqual({ state: "no-account", candidates: [] });
  });

  it("configured IBAN wins and is disclosed", () => {
    const txs = [
      ...covered(),
      payout("q1", "2026-10-12", { accountIban: OTHER }),
      payout("q2", "2026-10-19", { accountIban: OTHER }),
    ];
    const w = figure(run(txs, { configuredIban: LEEF }));
    expect(w.accountIban).toBe(LEEF);
    expect(w.accountReason).toBe("configured");
    expect(w.spentCents).toBe(4750);
  });

  it("unset budget gives no-budget", () => {
    expect(run(covered(), { weeklyCents: null })).toEqual({ state: "no-budget" });
  });

  it("overspend gives negative left", () => {
    const txs = [...covered(), debit("big", "2026-10-27", 10000)];
    const w = figure(run(txs));
    expect(w.spentCents).toBe(14750);
    expect(w.leftCents).toBe(-4750);
  });

  it("parse-error rows never count", () => {
    const txs = [
      ...covered(),
      debit("bad", "2026-10-27", 6000, { parseError: true }),
      tx({ id: "badin", bookedAt: "2026-10-27T12:00:00Z", amountCents: 6000, parseError: true }),
    ];
    const w = figure(run(txs));
    expect(w.spentCents).toBe(4750);
    expect(w.depositCents).toBe(10000);
    expect(w.spentRows.map((r) => r.id)).not.toContain("bad");
  });

  it("accounts are never merged", () => {
    const txs = [
      ...covered(),
      debit("b1", "2026-10-27", 50000, { accountIban: BEHEER, statementSha256: "stmt-beheer" }),
      tx({
        id: "b2", bookedAt: "2026-10-27T12:00:00Z", amountCents: 9999,
        accountIban: BEHEER, statementSha256: "stmt-beheer",
      }),
    ];
    const w = figure(run(txs));
    expect(w.accountIban).toBe(LEEF);
    expect(w.spentCents).toBe(4750);
    expect(w.depositCents).toBe(10000);
  });

  it("starts the week on the payout weekday when told to", () => {
    // A Thursday week: 29 Oct – 4 Nov. The 26th and 28th belong to last week.
    const w = figure(run(covered(), { weekStartsOn: 4 }));
    expect(w.week).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(w.spentRows.map((r) => r.id)).toEqual(["d3"]);
    expect(w.depositCents).toBe(0);
  });
});
