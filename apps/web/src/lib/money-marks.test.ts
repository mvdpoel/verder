import { describe, expect, it } from "vitest";
import { moneyColumns, type ColumnAccount, type MoneyColumn } from "./money-columns";
import {
  accountBoundaries, accountSpans, columnMarks, drillHref, legendHref,
} from "./money-marks";

const actual = (
  month: string,
  coverage: "complete" | "partial" | "none",
  inCents: number,
  bands: [string, number][] = []
): MoneyColumn => ({
  kind: "actual",
  account: "NL01",
  month,
  coverage,
  inCents,
  outByCategory: bands.map(([category, cents]) => ({ category, cents })),
  outCents: bands.reduce((sum, [, cents]) => sum + cents, 0),
});

const projected = (
  month: string,
  inCents: number,
  outCents: number,
  outAfterCancelCents = outCents
): MoneyColumn => ({
  kind: "projected", account: "NL01", month, inCents, outCents, outAfterCancelCents,
});

describe("columnMarks", () => {
  it("draws a gap for a month with no statement, and never a zero-height bar", () => {
    // "We don't know" and "nothing happened" are different facts. A month with
    // no rows gets the gap mark and nothing else — no income bar of height
    // zero, no empty band — because a flat bar on the baseline is the chart
    // saying the month was quiet, which is a claim we cannot make.
    const marks = columnMarks(actual("2026-05", "none", 0));
    expect(marks).toEqual([{ kind: "gap", paint: "none" }]);
    expect(marks.some((m) => m.paint === "fill")).toBe(false);

    // And the other way round: a month the statements DO cover in which no
    // money moved draws nothing at all. It is not a gap — we know.
    expect(columnMarks(actual("2026-05", "complete", 0))).toEqual([]);
  });

  it("hatches a partial month's marks and leaves a complete month's alone", () => {
    const partial = columnMarks(actual("2026-07", "partial", 355_642, [["housing", 181_665]]));
    expect(partial.map((m) => m.kind)).toEqual(["income", "band"]);
    expect(partial.every((m) => "hatched" in m && m.hatched)).toBe(true);

    const complete = columnMarks(actual("2026-06", "complete", 360_636, [["housing", 174_009]]));
    expect(complete.map((m) => m.kind)).toEqual(["income", "band"]);
    expect(complete.every((m) => "hatched" in m && !m.hatched)).toBe(true);
  });

  it("draws a projected month in outline only — nothing there is a bank row", () => {
    const marks = columnMarks(projected("2026-09", 355_642, 200_000, 180_000));
    expect(marks).toHaveLength(3);
    expect(marks.every((m) => m.paint === "outline")).toBe(true);
    expect(marks.some((m) => m.paint === "fill")).toBe(false);
  });

  it("gives 'na opzeggen' its own outline, below the costs outline", () => {
    // The mark only says something when the cancellable subscriptions would
    // actually save money, and it must be readable as a different answer than
    // "verwachte vaste lasten" — not as a smaller version of it.
    const withSavings = columnMarks(projected("2026-09", 355_642, 200_000, 180_000));
    const after = withSavings.find((m) => m.kind === "projected-after-cancel");
    const out = withSavings.find((m) => m.kind === "projected-out");
    expect(after).toBeDefined();
    expect(after).not.toEqual(out);
    expect(after && "cents" in after ? after.cents : null).toBe(180_000);
    expect(out && "cents" in out ? out.cents : null).toBe(200_000);
  });

  it("dims the other bands when a category is focused, and takes their hatch with it", () => {
    const marks = columnMarks(
      actual("2026-07", "partial", 355_642, [["housing", 181_665], ["telecom", 4_500]]),
      "housing"
    );
    const byKind = Object.fromEntries(
      marks.map((m) => [m.kind === "band" ? `band:${m.category}` : m.kind, m])
    );
    expect(byKind["band:housing"]).toMatchObject({ dimmed: false, hatched: true });
    // The dimmed band is painted in the grid ink and no longer carries its own
    // colour, so a coverage hatch on it would warn about the one band the
    // reader has just asked to look past.
    expect(byKind["band:telecom"]).toMatchObject({ dimmed: true, hatched: false });
    // Income is not one of the eight categories: focusing a cost dims it, but
    // it keeps its own colour and therefore its hatch.
    expect(byKind["income"]).toMatchObject({ dimmed: true, hatched: true });
  });

  it("reads a bare ?cat= as no focus at all", () => {
    // `focusCategory` arrives straight from the URL. An empty value is not a
    // category, and greying out all eight bands for a category nobody picked
    // would tell Martin his costs are something he is not looking at.
    const marks = columnMarks(actual("2026-07", "complete", 355_642, [["housing", 181_665]]), "");
    expect(marks.every((m) => "dimmed" in m && !m.dimmed)).toBe(true);
  });
});

describe("accountBoundaries / accountSpans", () => {
  it("puts the boundary between the two accounts' columns", () => {
    // Built through the real composition: `moneyColumns` lays the columns out,
    // and the boundary is where the beheerrekening's months end and the
    // leefgeldrekening's begin. That handover is a boundary, never a line
    // drawn through — the same person's money moving between his own accounts
    // is not a collapse.
    const series: ColumnAccount[] = [
      {
        accountIban: "NL12ABNA0566567741",
        months: [
          { month: "2026-06", coverage: "complete", inCents: 360_636, outCents: 174_009,
            outByCategory: [{ category: "housing", cents: 174_009 }] },
          { month: "2026-07", coverage: "partial", inCents: 355_642, outCents: 181_665,
            outByCategory: [{ category: "housing", cents: 181_665 }] },
        ],
        projected: [],
      },
      {
        accountIban: "NL99LEEF0000000001",
        months: [
          { month: "2026-07", coverage: "partial", inCents: 40_000, outCents: 12_000,
            outByCategory: [{ category: "overig", cents: 12_000 }] },
        ],
        projected: [],
      },
    ];
    const columns = moneyColumns(series);
    expect(columns).toHaveLength(3);
    expect(accountBoundaries(columns)).toEqual([2]);
    expect(accountSpans(columns)).toEqual([
      { account: "NL12ABNA0566567741", from: 0, count: 2 },
      { account: "NL99LEEF0000000001", from: 2, count: 1 },
    ]);
  });

  it("draws no boundary through one account's own months", () => {
    const columns = moneyColumns([
      {
        accountIban: null,
        months: [
          { month: "2026-06", coverage: "complete", inCents: 0, outCents: 0, outByCategory: [] },
          { month: "2026-07", coverage: "none", inCents: 0, outCents: 0, outByCategory: [] },
        ],
        projected: [{ month: "2026-08", inCents: 0, outCents: 0, outAfterCancelCents: 0 }],
      },
    ]);
    expect(accountBoundaries(columns)).toEqual([]);
    expect(accountSpans(columns)).toEqual([{ account: null, from: 0, count: 3 }]);
  });
});

describe("drillHref / legendHref", () => {
  it("round-trips ?cat= : the focused category links back out of the focus", () => {
    expect(legendHref("housing")).toBe("/money?cat=housing");
    expect(legendHref("housing", "telecom")).toBe("/money?cat=housing");
    expect(legendHref("housing", "housing")).toBe("/money");
  });

  it("only drills into a real month, and never from the dashboard", () => {
    // The panel below the chart lists bank rows. For a month that has not
    // happened yet it would answer "geen uitgaven in deze maand" — a statement
    // about the future dressed up as a fact about the ledger. And the compact
    // chart is already inside one link to /money, where a second <a> is
    // invalid HTML that React will not render.
    expect(drillHref(projected("2026-09", 1, 1))).toBeNull();
    expect(drillHref(actual("2026-07", "complete", 1), { compact: true })).toBeNull();
    expect(drillHref(actual("2026-07", "complete", 1))).toBe(
      "/money?month=2026-07&account=NL01"
    );
    expect(drillHref(actual("2026-07", "complete", 1), { focusCategory: "housing" })).toBe(
      "/money?month=2026-07&account=NL01&cat=housing"
    );
    expect(
      drillHref({ ...actual("2026-07", "complete", 1), account: null })
    ).toBe("/money?month=2026-07");
  });
});
