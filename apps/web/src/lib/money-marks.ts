/**
 * What the /money chart draws, as plain descriptors.
 *
 * The chart is inline SVG with no chart library, so every judgement it makes —
 * which mark, filled or outlined, hatched or not, dimmed or not — used to live
 * inside JSX where no test could reach it. The judgements are here instead,
 * pure and structural (no api or component imports, no React), the same habit
 * as `money-columns.ts` and `dashboard-money-slice.ts`. `money-chart.tsx`
 * renders what comes out of here one to one and decides nothing else.
 *
 * Reading order of the marks, all four of which are visually distinct:
 *   solid fill   → a real month, statements cover all of it
 *   hatched fill → a real month whose statements do not provably cover it
 *   dashed outline → a projection from the registry, not a bank row
 *   a gap reading "geen data" → no rows at all. NEVER a zero-height bar:
 *                              "we don't know" and "nothing happened" are
 *                              different facts and must not look the same.
 *
 * Cents in, cents out. Nothing here divides: pixel geometry stays in the
 * component, because pixels are not money.
 */

import type { MoneyColumn } from "@/lib/money-columns";

export type ColumnMark =
  /** No rows at all. The component draws a dashed rule and the words "geen data". */
  | { kind: "gap"; paint: "none" }
  | { kind: "income"; paint: "fill"; cents: number; hatched: boolean; dimmed: boolean }
  | {
      kind: "band";
      paint: "fill";
      category: string;
      cents: number;
      hatched: boolean;
      dimmed: boolean;
    }
  | {
      kind: "projected-income" | "projected-out" | "projected-after-cancel";
      paint: "outline";
      cents: number;
    };

/**
 * The marks for one column, in drawing order.
 *
 * `focusCategory` is a category the reader asked to read on its own. It comes
 * straight from `?cat=` in the URL, where a bare `?cat=` parses as the empty
 * string — which is not a focus, and is read here as none. The drill link and
 * the legend already treat it that way; the bands used to be the one surface
 * that greyed out all eight of them for a category nobody had picked.
 */
export function columnMarks(col: MoneyColumn, focusCategory?: string): ColumnMark[] {
  const focus = focusCategory ? focusCategory : null;
  const marks: ColumnMark[] = [];

  if (col.kind === "projected") {
    // Nothing in a projected column is a bank row, so nothing in it is ever
    // filled: an outline is the chart saying "this has not happened yet".
    if (col.inCents > 0) {
      marks.push({ kind: "projected-income", paint: "outline", cents: col.inCents });
    }
    if (col.outCents > 0) {
      marks.push({ kind: "projected-out", paint: "outline", cents: col.outCents });
    }
    // "na opzeggen" is its own mark and not a smaller version of the costs
    // outline: it answers a different question — what the subscriptions still
    // to be cancelled would save — and it is the one line on this page that
    // points at something Martin can do.
    if (col.outAfterCancelCents > 0) {
      marks.push({
        kind: "projected-after-cancel",
        paint: "outline",
        cents: col.outAfterCancelCents,
      });
    }
    return marks;
  }

  // A gap, not a zero. There is nothing else to draw here on purpose: a bar of
  // height zero would claim the month was quiet, and what we have is no
  // statement covering it.
  if (col.coverage === "none") return [{ kind: "gap", paint: "none" }];

  const hatched = col.coverage === "partial";

  if (col.inCents > 0) {
    // Income is dimmed whenever ANY category is focused: it is not one of the
    // eight, and focusing a cost category is a request to read the costs.
    marks.push({
      kind: "income",
      paint: "fill",
      cents: col.inCents,
      hatched,
      dimmed: focus != null,
    });
  }

  for (const band of col.outByCategory) {
    if (band.cents <= 0) continue;
    const dimmed = focus != null && focus !== band.category;
    marks.push({
      kind: "band",
      paint: "fill",
      category: band.category,
      cents: band.cents,
      // A dimmed band loses its hatch. It is painted in the grid ink and no
      // longer carries its own colour, so a coverage warning on it would be a
      // warning about the one band the reader has just asked to look past. The
      // income bar keeps its hatch while dimmed: it is dimmed by opacity, so it
      // is still its own colour and still the month's real income.
      hatched: hatched && !dimmed,
      dimmed,
    });
  }

  return marks;
}

/** The column identity the chart keys its marks and its month labels on.
 *
 * The key is kind-qualified as well as account- and month-qualified. Month and
 * account alone were the key, and an actual and a projected column for the
 * same month collided: a React warning, an unreliable reconciliation, and one
 * `selected` highlight lighting up two columns.
 */
export const columnKey = (col: { kind: string; account: string | null; month: string }) =>
  `${col.kind}-${col.account}-${col.month}`;

/**
 * Where one account's columns end and the next account's begin.
 *
 * The bewind handover is a boundary, never a line drawn through: the same
 * person's money moving from a beheerrekening to a leefgeldrekening is not a
 * collapse.
 */
export function accountBoundaries(columns: readonly { account: string | null }[]): number[] {
  const boundaries: number[] = [];
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].account !== columns[i - 1].account) boundaries.push(i);
  }
  return boundaries;
}

/** Account name spans, for the header strip above the plot. */
export function accountSpans(
  columns: readonly { account: string | null }[]
): { account: string | null; from: number; count: number }[] {
  const spans: { account: string | null; from: number; count: number }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const last = spans[spans.length - 1];
    if (last && last.account === columns[i].account) last.count += 1;
    else spans.push({ account: columns[i].account, from: i, count: 1 });
  }
  return spans;
}

/**
 * Where a click on this column's month label goes, or null when the column is
 * not a drill target.
 *
 * Only a real month is one. The panel below the chart lists bank rows, and for
 * a month that has not happened yet it would answer "geen uitgaven in deze
 * maand" — a statement about the future dressed up as a fact about the ledger.
 *
 * The compact chart has no links of its own either: the whole dashboard block
 * is wrapped in one link to /money, and an <a> inside an <a> is invalid HTML
 * that React will not render.
 */
export function drillHref(
  col: MoneyColumn,
  { compact = false, focusCategory }: { compact?: boolean; focusCategory?: string } = {}
): string | null {
  if (compact || col.kind !== "actual") return null;
  return (
    `/money?month=${col.month}` +
    (col.account ? `&account=${encodeURIComponent(col.account)}` : "") +
    (focusCategory ? `&cat=${encodeURIComponent(focusCategory)}` : "")
  );
}

/**
 * Where a click on a legend entry goes. It toggles: the focused category links
 * back to /money with no `cat` at all, so the way out of a focus is the same
 * control that got you into it.
 */
export function legendHref(category: string, focusCategory?: string): string {
  return focusCategory === category ? "/money" : `/money?cat=${category}`;
}
