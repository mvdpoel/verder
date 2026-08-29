/**
 * The palette as literal values, for drawings.
 *
 * An SVG `fill` or `stroke` that is chosen in JS — the mark for a stop, the ink
 * for a band — cannot be a Tailwind class, and a `.tsx` file cannot read the
 * `@theme` custom properties out of globals.css. So the values are written out
 * ONCE, here, instead of once per chart: `track-map.tsx` and `money-chart.tsx`
 * each carried their own copy of this list, and two copies of a palette is how a
 * palette starts drifting.
 *
 * Every value is a straight copy of a `--color-*` token in
 * `apps/web/src/app/globals.css`. Nothing here is mixed by eye, and nothing new
 * is invented: if a token changes there it must change here, and the comment on
 * each line is what makes that check possible.
 */
export const TOKEN = {
  /* ── ground ──────────────────────────────────────────────────────────── */
  void: "#04070d", // --color-void: the page itself
  plate: "#0a0f18", // --color-plate: the panel's gradient, flattened
  edge: "#8cc3f01a", // --color-edge: panel border
  edgeStrong: "#8cc3f033", // --color-edge-strong: input border, ghost button
  /** --color-hairline's HUE only. The alpha is chosen per use. */
  hairlineHue: "#8cc3f0",

  /* ── text ────────────────────────────────────────────────────────────── */
  inkBright: "#f0f7fc", // --color-ink-bright: headings, the selected mark
  ink: "#dbe6f2", // --color-ink: ordinary text
  inkSoft: "#cfe0ee", // --color-ink-soft: rows, second plane
  inkMute: "#93a8bd", // --color-ink-mute: paragraphs
  inkLabel: "#6d8298", // --color-ink-label: small caps labels
  inkDim: "#63788e", // --color-ink-dim: mono micro, dates, the date gutter
  inkFaint: "#4f6478", // --color-ink-faint: axis names, month bands

  /* ── signal ──────────────────────────────────────────────────────────── */
  signal: "#63d3ea", // --color-signal: the system's own voice
  attn: "#e8a557", // --color-attn: WAITING ON MARTIN, and nothing else
  okay: "#7fd8c0", // --color-okay: system healthy
  steel: "#b6cfe4", // --color-steel: it happened
  steelDim: "#8fb3cc", // --color-steel-dim: it happened, second plane
} as const;
