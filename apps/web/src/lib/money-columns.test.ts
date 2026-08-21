import { describe, expect, it } from "vitest";
import { moneyColumns, type ColumnAccount } from "./money-columns";

const month = (
  m: string,
  coverage: "complete" | "partial" | "none" = "complete",
  inCents = 0,
  outCents = 0
) => ({ month: m, coverage, inCents, outCents, outByCategory: [{ category: "overig", cents: outCents }] });

const projected = (m: string, inCents = 0, outCents = 0) => ({
  month: m, inCents, outCents, outAfterCancelCents: outCents,
});

const account = (
  accountIban: string | null,
  months: ColumnAccount["months"],
  projection: ColumnAccount["projected"] = []
): ColumnAccount => ({ accountIban, months, projected: projection });

describe("moneyColumns", () => {
  it("draws each account's actual months first, then its projection", () => {
    const cols = moneyColumns([
      account("NL01", [month("2026-06"), month("2026-07")], [projected("2026-08")]),
      account("NL02", [month("2026-07")], [projected("2026-08")]),
    ]);
    expect(cols.map((c) => `${c.account}/${c.kind}/${c.month}`)).toEqual([
      "NL01/actual/2026-06",
      "NL01/actual/2026-07",
      "NL01/projected/2026-08",
      "NL02/actual/2026-07",
      "NL02/projected/2026-08",
    ]);
  });

  it("never draws a month twice for one account, even when the newest month is partial", () => {
    // The normal shape of real data, taken from buildMoneySeries: the newest
    // statement ends mid-month, so July is a real but PARTIAL month, the last
    // COMPLETE month is June, and the projection therefore starts at July —
    // a month that is already on the chart as a hatched actual. Drawing both
    // gives two adjacent columns labelled "jul '26" with different heights.
    const cols = moneyColumns([
      account(
        "NL01",
        [month("2026-06", "complete", 300_000, 210_000), month("2026-07", "partial", 150_000, 90_000)],
        [projected("2026-07", 300_000, 205_000), projected("2026-08", 300_000, 205_000),
         projected("2026-09", 300_000, 205_000)]
      ),
    ]);
    expect(cols.map((c) => c.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    // The real month wins: July keeps its bank rows and its hatch.
    const july = cols.filter((c) => c.month === "2026-07");
    expect(july).toHaveLength(1);
    expect(july[0].kind).toBe("actual");
  });

  it("keeps a projected month that another account happens to have as an actual", () => {
    // The overlap is per account. The leefgeldrekening's projected August is
    // its own column and must not be swallowed by the beheerrekening's August.
    const cols = moneyColumns([
      account("NL01", [month("2026-08")], []),
      account("NL02", [month("2026-06")], [projected("2026-07"), projected("2026-08")]),
    ]);
    expect(cols.map((c) => `${c.account}/${c.kind}/${c.month}`)).toEqual([
      "NL01/actual/2026-08",
      "NL02/actual/2026-06",
      "NL02/projected/2026-07",
      "NL02/projected/2026-08",
    ]);
  });

  it("gives every column a key no other column shares", () => {
    // The chart keys its marks and its month labels on this; a repeated key is
    // a React warning, an unreliable reconciliation, and a selection highlight
    // that lights up two columns at once.
    const cols = moneyColumns([
      account("NL01", [month("2026-06"), month("2026-07", "partial")],
        [projected("2026-07"), projected("2026-08")]),
      account(null, [month("2026-07")], [projected("2026-08")]),
    ]);
    const keys = cols.map((c) => `${c.kind}-${c.account}-${c.month}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
