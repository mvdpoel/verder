/**
 * Palette, labels and money formatting for /money.
 *
 * This file has NO "use client" on purpose: the server page and the client
 * chart both need these, and a function exported from a client module cannot be
 * called on the server — only rendered. Same reason `timeline-kinds.ts` and
 * `search-kinds.ts` exist.
 *
 * ---------------------------------------------------------------------------
 * Palette — from the `dataviz` skill's reference categorical palette.
 *
 * The eight hues are assigned in the skill's FIXED slot order to the categories
 * in the order they are stacked (alphabetical with `overig` last — see
 * `outSeries` in packages/api/src/money-series.ts), so stack-adjacency is
 * exactly the adjacent pairlist the palette was validated on:
 *
 *   node scripts/validate_palette.js \
 *     "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" \
 *     --mode light --surface "#ffffff"
 *   → lightness band PASS · chroma floor PASS
 *     worst adjacent CVD ΔE 9.1 PASS · worst adjacent normal-vision ΔE 19.6 PASS
 *     contrast WARN on aqua/yellow/magenta (2.8 / 2.2 / 2.7 against white)
 *
 * That contrast WARN obliges "relief": visible labels or a table view. Both are
 * present — the legend names every band with its total, and the drill panel
 * lists the categories and the bank rows behind them as a table.
 *
 * The app is committed to a single light surface (`bg-slate-50` on <body>,
 * `bg-white` cards; there is no theme toggle and no `dark:` variant anywhere in
 * apps/web), so these are the skill's LIGHT steps. Its dark steps for the same
 * eight hues are recorded beside each one, so adding a theme later is a
 * per-token swap rather than a re-design.
 * ---------------------------------------------------------------------------
 */

/** Stack order, bottom to top. `overig` last, matching `outSeries`. */
export const CATEGORY_ORDER = [
  "energy", "housing", "insurance", "other",
  "software", "streaming", "telecom", "overig",
] as const;

/** Slot n of the reference palette → the nth category in stack order. */
export const CATEGORY_COLOR: Record<string, string> = {
  energy: "#2a78d6",    // slot 1 blue     (dark step #3987e5)
  housing: "#eb6834",   // slot 2 orange   (dark step #d95926)
  insurance: "#1baf7a", // slot 3 aqua     (dark step #199e70)
  other: "#eda100",     // slot 4 yellow   (dark step #c98500)
  software: "#e87ba4",  // slot 5 magenta  (dark step #d55181)
  streaming: "#008300", // slot 6 green    (dark step #008300)
  telecom: "#4a3aa7",   // slot 7 violet   (dark step #9085e9)
  overig: "#e34948",    // slot 8 red      (dark step #e66767)
};

export const CATEGORY_LABEL: Record<string, string> = {
  energy: "energie", housing: "wonen", insurance: "verzekering",
  other: "overige vaste lasten", software: "software", streaming: "streaming",
  telecom: "telecom", overig: "niet gekoppeld",
};

/**
 * How often an income line pays, in Dutch. It sits beside CATEGORY_LABEL
 * because it is the same kind of thing: the vocabulary the page reads a machine
 * value out in. Same shape too — `Record<string, string>`, so a cadence added
 * to `detectRecurring` later falls back to its own key at the call site instead
 * of rendering "undefined" beside an amount.
 */
export const CADENCE_LABEL: Record<string, string> = {
  weekly: "wekelijks", monthly: "maandelijks",
  quarterly: "per kwartaal", yearly: "jaarlijks",
};

/**
 * Income is not a ninth category — it is the other side of the chart — so it
 * does not take a categorical slot (the skill's rule: a 9th series is never a
 * generated hue). It gets the palette's secondary ink: achromatic, and
 * therefore safe against all eight hues under every kind of colour vision.
 */
export const INCOME_INK = "#52514e";
/** Status "good" from the skill's reserved palette; never reused for a series. */
export const AFTER_CANCEL_INK = "#0ca30c";

export const GRID_INK = "#e1e0d9";
export const BASELINE_INK = "#c3c2b7";
export const MUTED_INK = "#898781";

/** Integer-cents euro formatting. No float ever touches the amount. */
export function euro(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const rest = abs % 100;
  return `${sign}€ ${whole.toLocaleString("nl-NL")},${String(rest).padStart(2, "0")}`;
}

/** Axis ticks drop the cents — they are a scale, not a figure. */
export function euroShort(cents: number): string {
  return `€ ${Math.trunc(cents / 100).toLocaleString("nl-NL")}`;
}

const NL_MONTHS = [
  "jan", "feb", "mrt", "apr", "mei", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

/** "2026-07" → "jul ’26". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${NL_MONTHS[Number(m) - 1]} ’${y.slice(2)}`;
}
