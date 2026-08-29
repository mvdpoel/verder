"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@verder/api";
import {
  CATEGORY_LABEL, CATEGORY_ORDER, euro, euroShort, monthLabel,
} from "./money-format";
import { moneyColumns } from "@/lib/money-columns";
import {
  accountBoundaries, accountSpans, columnKey, columnMarks, drillHref, legendHref,
} from "@/lib/money-marks";
import { Panel, TOKEN } from "@/components/ui";

/**
 * The /money chart. Inline SVG, no chart library — the web app has no runtime
 * dependencies beyond Next/React and this keeps it that way.
 *
 * This file draws; it does not decide. Which columns exist is `moneyColumns`,
 * and which marks a column gets — filled or outlined, hatched or not, dimmed
 * or not, and the gap that is never a zero-height bar — is `columnMarks`, both
 * unit-tested in `@/lib` without React. What is left here is geometry, and
 * geometry is pixels: money is integer cents everywhere, and the only division
 * below is cents → bar height and display formatting, neither of which is money.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type MoneySeriesOutput = RouterOutputs["money"]["series"];
export type AccountSeries = MoneySeriesOutput["series"][number];

/**
 * The chart's palette, out of `TOKEN` — the one place the drawing colours live,
 * shared with the map on /timeline. An SVG `fill` chosen in JS cannot be a
 * Tailwind class, and this file used to carry its own transcription of the token
 * list; so did `track-map.tsx`, and two transcriptions of one palette is how a
 * palette starts drifting.
 *
 * Money coming IN is the system's own cyan; money going OUT is steel, the
 * colour this app uses for "it happened". Spending is deliberately NOT amber:
 * amber says one thing here — something is waiting on Martin — and a cost bar
 * is not that.
 *
 * The eight cost bands used to be eight validated categorical hues on a white
 * surface (the palette and its measurements are still recorded in
 * `money-format.ts`). Two of those hues, the orange and the yellow, land on top
 * of `--color-attn` on this field and would spend the one colour the app
 * reserves — so on the dark ground the bands become a single-hue steel ramp,
 * lightest at the bottom of the stack and darkest at the top. Identity then
 * comes from the legend, which names every band with its total, and from the
 * drill table under the chart. Both were already there: the original palette
 * carried a contrast warning that obliged exactly the same relief.
 */
const BAND_INK: Record<string, string> = {
  energy: TOKEN.inkSoft,
  housing: TOKEN.steel,
  insurance: "#a1c2da", // between steel and steel-dim; the ramp needs a step here
  other: TOKEN.steelDim,
  software: "#7a9fbb", // between steel-dim and ink-faint
  streaming: "#6a8ba7", // idem
  telecom: "#5b7793", // idem
  overig: TOKEN.inkFaint,
};

const INCOME_INK = TOKEN.signal;
const OUT_INK = TOKEN.steelDim;
/** The footnote calls it green; the token calls it okay. Same colour. */
const AFTER_CANCEL_INK = TOKEN.okay;
/** A band the reader has asked to look past: steel, but far enough back to be read past. */
const DIMMED_INK = `${TOKEN.steelDim}30`;
const GRID = TOKEN.edge;
const BASELINE = TOKEN.edgeStrong;
/** Axis names and specifications; the token comment for ink-faint says so literally. */
const AXIS_INK = TOKEN.inkFaint;
const MUTED = TOKEN.inkDim;
/**
 * The hatch is the GROUND, scoring the bar away. On the old white surface it
 * was white for the same reason; inverting the page inverts the hatch, and a
 * light hatch here would read as a band of its own rather than as an absence.
 */
const HATCH_INK = TOKEN.void;
/** The selected column's wash. Cyan, because selection is the system answering. */
const SELECTED_INK = TOKEN.signal;

// Geometry. Pixels, not money. Two sizes of the same chart: the full one on
// /money and a compact one on the dashboard — a second chart implementation
// would be a second set of bugs and a second reading of the same numbers.
const GEOMETRY = {
  full: { COL_W: 52, BAR_W: 18, IN_X: 5, PAIR_GAP: 4, AXIS_W: 68, PLOT_H: 220, TOP_PAD: 14, SEG_GAP: 2 },
  compact: { COL_W: 34, BAR_W: 11, IN_X: 3, PAIR_GAP: 3, AXIS_W: 46, PLOT_H: 96, TOP_PAD: 10, SEG_GAP: 1 },
} as const;

/** A "nice" axis top so the ticks are readable numbers. */
function niceCeil(cents: number): number {
  if (cents <= 0) return 100_00;
  const digits = Math.floor(Math.log10(cents));
  const pow = Math.pow(10, digits);
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = Math.ceil(step * pow);
    if (candidate >= cents) return candidate;
  }
  return Math.ceil(10 * pow);
}

export function MoneyChart({
  series,
  accountLabels,
  focusCategory,
  selected,
  compact = false,
}: {
  series: AccountSeries[];
  accountLabels: Record<string, string>;
  focusCategory?: string;
  selected?: { account: string | null; month: string } | null;
  /**
   * Dashboard size: smaller geometry, and NO links of its own — the whole
   * block is wrapped in one link to /money, and an <a> inside an <a> is
   * invalid HTML that React will not render. The marks are identical.
   */
  compact?: boolean;
}) {
  const { COL_W, BAR_W, IN_X, PAIR_GAP, AXIS_W, PLOT_H, TOP_PAD, SEG_GAP } =
    GEOMETRY[compact ? "compact" : "full"];
  const OUT_X = IN_X + BAR_W + PAIR_GAP; // a surface gap between the pair
  const BASE_Y = TOP_PAD + PLOT_H;
  // SVG ids are document-global, so the two sizes must not share one: a second
  // <pattern id="money-hatch"> on the same page silently wins for both charts.
  const hatchId = compact ? "money-hatch-compact" : "money-hatch";

  // Which columns to draw is a rule, not a rendering detail, so it lives in
  // `@/lib/money-columns` where it is unit-tested without React — most of all
  // the part that keeps a partial newest month from being drawn twice.
  const columns = moneyColumns(series);
  if (columns.length === 0) return null;

  const accountName = (iban: string | null) =>
    iban ? (accountLabels[iban] ?? iban) : "onbekende rekening";

  const peak = columns.reduce(
    (max, c) =>
      Math.max(
        max,
        c.inCents,
        c.outCents,
        c.kind === "projected" ? c.outAfterCancelCents : 0
      ),
    0
  );
  const top = niceCeil(peak);
  /** cents → pixel height. Pixels are not money, so this division is safe. */
  const h = (cents: number) => (cents <= 0 ? 0 : Math.round((cents / top) * PLOT_H));

  const width = AXIS_W + columns.length * COL_W;
  const height = BASE_Y + 10;
  const ticks = (compact ? [0, 2, 4] : [0, 1, 2, 3, 4]).map((n) => Math.round((top / 4) * n));

  const boundaries = accountBoundaries(columns);
  const spans = accountSpans(columns);

  const categoriesPresent = CATEGORY_ORDER.filter((c) =>
    columns.some((col) => col.kind === "actual" && col.outByCategory.some((b) => b.category === c))
  );
  const categoryTotal = (category: string) =>
    columns.reduce(
      (sum, col) =>
        col.kind === "actual"
          ? sum + (col.outByCategory.find((b) => b.category === category)?.cents ?? 0)
          : sum,
      0
    );

  const x = (i: number) => AXIS_W + i * COL_W;

  /*
   * The chart is what /money leads with, so there it is that page's one lit
   * panel. On the dashboard the block around it is already a panel, so the
   * compact form is a bare div — glass inside glass doubles the gradient.
   *
   * The full form goes through `Panel lit` rather than writing `.panel
   * panel-edge` out by hand: a copied class list is a panel that stops tracking
   * the primitive the moment the gradient changes.
   */
  const Frame = compact ? PlainFrame : LitPanelFrame;

  return (
    <Frame>
      <div className="overflow-x-auto">
        <div style={{ width }}>
          {/* Account strip. The bewind handover is a boundary, never a line
              drawn through: the same person's money moving from a
              beheerrekening to a leefgeldrekening is not a collapse.
              A compact chart of a single account already gets its name from
              the block around it, so the strip only appears there when there
              is actually a boundary to explain. */}
          {(!compact || spans.length > 1) && (
          <div className="flex" style={{ paddingLeft: AXIS_W }}>
            {spans.map((s) => (
              <div
                key={`${s.account}-${s.from}`}
                style={{ width: s.count * COL_W }}
                className={`lbl truncate px-1 pb-[6px] ${
                  s.from > 0 ? "border-l border-edge" : ""
                }`}
                title={accountName(s.account)}
              >
                {accountName(s.account)}
              </div>
            ))}
          </div>
          )}

          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Inkomsten en uitgaven per maand, per rekening"
          >
            <defs>
              {/* Hatch for a month the statements do not provably cover.
                  Tone-on-tone: the band keeps its own colour and reads as
                  "mogelijk incompleet" rather than as a different category. */}
              <pattern
                id={hatchId}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="6" stroke={HATCH_INK} strokeWidth="2.5" />
              </pattern>
            </defs>

            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={AXIS_W}
                  x2={width}
                  y1={BASE_Y - h(t)}
                  y2={BASE_Y - h(t)}
                  stroke={t === 0 ? BASELINE : GRID}
                  strokeWidth="1"
                />
                <text
                  x={AXIS_W - 8}
                  y={BASE_Y - h(t) + 4}
                  textAnchor="end"
                  fontSize="9.5"
                  fill={AXIS_INK}
                  className="font-mono"
                  style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "0.06em" }}
                >
                  {euroShort(t)}
                </text>
              </g>
            ))}

            {boundaries.map((i) => (
              <line
                key={`b${i}`}
                x1={x(i)}
                x2={x(i)}
                y1={TOP_PAD - 6}
                y2={BASE_Y}
                stroke={AXIS_INK}
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            ))}

            {columns.map((col, i) => {
              const left = x(i);
              // Only a real month can be selected: the drill panel below the
              // chart shows bank rows, and a projection has none.
              const isSelected =
                selected != null &&
                col.kind === "actual" &&
                selected.month === col.month &&
                (selected.account ?? null) === (col.account ?? null);

              const marks = columnMarks(col, focusCategory);

              // A gap, not a zero. There is nothing to draw here on purpose —
              // see `columnMarks` for why a bar of height zero would be a lie.
              if (marks[0]?.kind === "gap") {
                return (
                  <g key={columnKey(col)}>
                    <line
                      x1={left + COL_W / 2}
                      x2={left + COL_W / 2}
                      y1={TOP_PAD}
                      y2={BASE_Y}
                      stroke={BASELINE}
                      strokeWidth="1"
                      strokeDasharray="2 4"
                    />
                    <text
                      x={left + COL_W / 2}
                      y={BASE_Y - 8}
                      fontSize="9.5"
                      fill={MUTED}
                      textAnchor="start"
                      className="font-mono"
                      style={{ letterSpacing: "0.12em" }}
                      transform={`rotate(-90 ${left + COL_W / 2} ${BASE_Y - 8})`}
                    >
                      geen data
                    </text>
                  </g>
                );
              }

              const nodes: React.ReactNode[] = [];

              if (isSelected) {
                nodes.push(
                  <rect
                    key="sel"
                    x={left + 1}
                    y={TOP_PAD - 6}
                    width={COL_W - 2}
                    height={PLOT_H + 6}
                    fill={SELECTED_INK}
                    opacity="0.07"
                  />
                );
              }

              // The cost bands stack from the baseline up, in the order
              // `columnMarks` hands them over.
              let cursor = 0;

              for (const mark of marks) {
                if (mark.kind === "gap") continue; // returned above; never stacked
                // A mark thinner than one pixel is not drawn. That is geometry
                // and not a judgement: `columnMarks` has already decided there
                // is money here, and the gap above is the only mark that means
                // "no data".
                const markH = h(mark.cents);
                if (markH <= 0) continue;

                if (mark.kind === "income") {
                  nodes.push(
                    <g key="in">
                      <rect
                        x={left + IN_X}
                        y={BASE_Y - markH}
                        width={BAR_W}
                        height={markH}
                        rx="4"
                        fill={INCOME_INK}
                        opacity={mark.dimmed ? 0.35 : 1}
                      />
                      {mark.hatched && (
                        <rect
                          x={left + IN_X}
                          y={BASE_Y - markH}
                          width={BAR_W}
                          height={markH}
                          rx="4"
                          fill={`url(#${hatchId})`}
                          /* The hatch dims with the bar it scores. It is the
                             ground colour now, so at full strength on a dimmed
                             bar it would be the loudest thing in the column. */
                          opacity={mark.dimmed ? 0.35 : 1}
                        />
                      )}
                      <title>
                        {`${monthLabel(col.month)} — vast inkomen ${euro(mark.cents)}`}
                      </title>
                    </g>
                  );
                } else if (mark.kind === "band") {
                  const y = BASE_Y - cursor - markH;
                  nodes.push(
                    <g key={`out-${mark.category}`}>
                      <rect
                        x={left + OUT_X}
                        y={y}
                        width={BAR_W}
                        height={Math.max(1, markH - SEG_GAP)}
                        rx="2"
                        fill={mark.dimmed ? DIMMED_INK : (BAND_INK[mark.category] ?? OUT_INK)}
                      />
                      {mark.hatched && (
                        <rect
                          x={left + OUT_X}
                          y={y}
                          width={BAR_W}
                          height={Math.max(1, markH - SEG_GAP)}
                          rx="2"
                          fill={`url(#${hatchId})`}
                        />
                      )}
                      <title>
                        {`${monthLabel(col.month)} — ${CATEGORY_LABEL[mark.category] ?? mark.category} ${euro(mark.cents)}`}
                      </title>
                    </g>
                  );
                  cursor += markH;
                } else if (mark.kind === "projected-income") {
                  nodes.push(
                    <g key="pin">
                      <rect
                        x={left + IN_X + 0.5}
                        y={BASE_Y - markH}
                        width={BAR_W - 1}
                        height={markH}
                        rx="4"
                        fill="none"
                        stroke={INCOME_INK}
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                        opacity="0.75"
                      />
                      <title>
                        {`${monthLabel(col.month)} — verwacht vast inkomen ${euro(mark.cents)}`}
                      </title>
                    </g>
                  );
                } else if (mark.kind === "projected-out") {
                  nodes.push(
                    <g key="pout">
                      <rect
                        x={left + OUT_X + 0.5}
                        y={BASE_Y - markH}
                        width={BAR_W - 1}
                        height={markH}
                        rx="4"
                        fill="none"
                        stroke={OUT_INK}
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                        opacity="0.75"
                      />
                      <title>
                        {`${monthLabel(col.month)} — verwachte vaste lasten ${euro(mark.cents)}`}
                      </title>
                    </g>
                  );
                } else if (mark.kind === "projected-after-cancel") {
                  nodes.push(
                    <g key="pafter">
                      <rect
                        x={left + OUT_X + 3.5}
                        y={BASE_Y - markH}
                        width={BAR_W - 7}
                        height={markH}
                        rx="3"
                        fill="none"
                        stroke={AFTER_CANCEL_INK}
                        strokeWidth="1.5"
                        strokeDasharray="2 2"
                      />
                      <title>
                        {`${monthLabel(col.month)} — na opzeggen ${euro(mark.cents)}`}
                      </title>
                    </g>
                  );
                }
              }

              return <g key={columnKey(col)}>{nodes}</g>;
            })}
          </svg>

          {/* Month labels double as the drill targets: clicking a month opens
              the panel below the chart. HTML links, so this is real navigation
              with real keyboard focus rather than an SVG click handler.
              `drillHref` decides which columns get one — compact has no drill,
              and neither has a projected month. */}
          <div className="flex" style={{ paddingLeft: AXIS_W }}>
            {columns.map((col, i) => {
              const isSelected =
                selected != null &&
                col.kind === "actual" &&
                selected.month === col.month &&
                (selected.account ?? null) === (col.account ?? null);
              const href = drillHref(col, { compact, focusCategory });
              const className =
                `block truncate px-1 py-[6px] text-center font-mono text-[9.5px] tracking-[0.12em] uppercase transition-colors ${
                  href ? "hover:text-signal" : ""
                } ${boundaries.includes(i) ? "border-l border-edge" : ""} ${
                  isSelected ? "bg-signal/10 text-ink-bright" : "text-ink-dim"
                } ${col.kind === "projected" ? "italic" : ""}`;
              return href == null ? (
                <span
                  key={columnKey(col)}
                  style={{ width: COL_W }}
                  className={className}>
                  {monthLabel(col.month)}
                </span>
              ) : (
                <Link
                  key={columnKey(col)}
                  href={href}
                  style={{ width: COL_W }}
                  className={className}>
                  {monthLabel(col.month)}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend. Identity is never colour alone: every band is named, and its
          total over the shown months is spelled out — which is also the relief
          the palette's contrast warning asks for, and the relief a single-hue
          ramp needs even more.

          The compact block leaves it out on purpose: it is a pointer to
          /money, and colour without a name is not identity, so the dashboard
          block names the account and nothing else, and /money — one click
          away — is where a band gets a name and a number. */}
      {!compact && (
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-4 text-[11.5px] font-light">
        <span className="flex items-center gap-[7px] text-ink-mute">
          <span
            className="inline-block h-[10px] w-[10px] rounded-[1px]"
            style={{ backgroundColor: INCOME_INK }}
            aria-hidden
          />
          vast inkomen
        </span>
        {categoriesPresent.map((category) => {
          const active = focusCategory === category;
          return (
            <Link
              key={category}
              href={legendHref(category, focusCategory)}
              className={`flex items-center gap-[7px] rounded-chip border px-[7px] py-[3px] transition-colors ${
                active
                  ? "border-edge-strong text-ink-bright"
                  : "border-transparent text-ink-mute hover:text-ink-bright"
              }`}
              title={active ? "Toon weer alle categorieën" : `Alleen ${CATEGORY_LABEL[category] ?? category}`}
            >
              <span
                className="inline-block h-[10px] w-[10px] rounded-[1px]"
                style={{ backgroundColor: BAND_INK[category] ?? OUT_INK }}
                aria-hidden
              />
              {CATEGORY_LABEL[category] ?? category}
              <span className="font-mono text-[10px] text-ink-dim" style={{ fontVariantNumeric: "tabular-nums" }}>
                {euro(categoryTotal(category))}
              </span>
            </Link>
          );
        })}
      </div>
      )}

      {!compact && (
      <p className="mt-3 max-w-3xl text-[12px] font-light leading-relaxed text-ink-label">
        Gevuld = echte bankregels · gearceerd = mogelijk incompleet · gestippeld =
        verwacht uit de registratie · <span className="italic">geen data</span> = geen
        afschrift voor die maand.{" "}
        <span className="text-okay">Groen gestippeld</span> is{" "}
        <em>na opzeggen</em>: wat de nog op te zeggen abonnementen zouden schelen.
      </p>
      )}
    </Frame>
  );
}

/** The dashboard's frame: nothing, because the block around it is the panel. */
function PlainFrame({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** /money's frame: the page's one lit panel. */
function LitPanelFrame({ children }: { children: ReactNode }) {
  return <Panel lit className="p-[26px]">{children}</Panel>;
}
