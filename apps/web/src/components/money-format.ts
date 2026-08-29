/**
 * Palette, labels and money formatting for /money.
 *
 * This file has NO "use client" on purpose: the server page and the client
 * chart both need these, and a function exported from a client module cannot be
 * called on the server — only rendered. Same reason `search-kinds.ts` and
 * `track-marks.ts` exist.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE THAT USED TO LIVE HERE IS GONE, and it is worth saying why.
 *
 * `CATEGORY_COLOR` held eight categorical hues validated by the `dataviz`
 * skill against a WHITE surface:
 *
 *   node scripts/validate_palette.js \
 *     "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" \
 *     --mode light --surface "#ffffff"
 *   → lightness band PASS · chroma floor PASS
 *     worst adjacent CVD ΔE 9.1 PASS · worst adjacent normal-vision ΔE 19.6 PASS
 *     contrast WARN on aqua/yellow/magenta (2.8 / 2.2 / 2.7 against white)
 *
 * The app is no longer on a white surface, and two of that palette's dark steps
 * (#d95926 orange, #c98500 yellow) land on top of `--color-attn` — which would
 * spend the one colour this app reserves for "waiting on Martin" on a cost bar.
 * So `money-chart.tsx` draws the bands in a single-hue steel ramp of its own and
 * no longer imports a colour from here; the six exports that fed it
 * (`CATEGORY_COLOR`, `INCOME_INK`, `AFTER_CANCEL_INK`, `GRID_INK`,
 * `BASELINE_INK`, `MUTED_INK`) had no callers left and are removed rather than
 * kept as a light-surface palette nothing renders.
 *
 * OPEN QUESTION FOR A HUMAN, not a leftover to clean up: the steel ramp is a
 * SEQUENTIAL scale carrying a CATEGORICAL variable, which is normally wrong. It
 * holds here only because the stack order is fixed by `CATEGORY_ORDER` and the
 * legend and the drill table name every band — the same relief the original
 * palette's contrast WARN already obliged. Re-measuring eight dark hues that
 * dodge amber, against `--surface "#04070d"`, is the proper fix.
 * ---------------------------------------------------------------------------
 */

/** Stack order, bottom to top. `overig` last, matching `outSeries`. */
export const CATEGORY_ORDER = [
  "energy", "housing", "insurance", "other",
  "software", "streaming", "telecom", "overig",
] as const;

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
