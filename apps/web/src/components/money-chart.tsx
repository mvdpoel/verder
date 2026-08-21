"use client";

import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@verder/api";
import {
  AFTER_CANCEL_INK, BASELINE_INK, CATEGORY_COLOR, CATEGORY_LABEL, CATEGORY_ORDER,
  GRID_INK, INCOME_INK, MUTED_INK, euro, euroShort, monthLabel,
} from "./money-format";
import { moneyColumns } from "@/lib/money-columns";

/**
 * The /money chart. Inline SVG, no chart library — the web app has no runtime
 * dependencies beyond Next/React and this keeps it that way.
 *
 * Reading order of the marks, all four of which are visually distinct:
 *   solid fill   → a real month, statements cover all of it
 *   hatched fill → a real month whose statements do not provably cover it
 *   dashed outline → a projection from the registry, not a bank row
 *   a gap reading "geen data" → no rows at all. NEVER a zero-height bar:
 *                              "we don't know" and "nothing happened" are
 *                              different facts and must not look the same.
 *
 * Money is integer cents everywhere. The only division here is pixel geometry
 * (cents → bar height) and display formatting, neither of which is money.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type MoneySeriesOutput = RouterOutputs["money"]["series"];
export type AccountSeries = MoneySeriesOutput["series"][number];

const GRID = GRID_INK;
const BASELINE = BASELINE_INK;
const MUTED = MUTED_INK;

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

/**
 * Which columns to draw is a rule, not a rendering detail, so it lives in
 * `@/lib/money-columns` where it is unit-tested without React — most of all
 * the part that keeps a partial newest month from being drawn twice.
 *
 * The key is kind-qualified as well as account- and month-qualified. Month and
 * account alone were the key, and an actual and a projected column for the
 * same month collided: a React warning, an unreliable reconciliation, and one
 * `selected` highlight lighting up two columns.
 */
const columnKey = (col: { kind: string; account: string | null; month: string }) =>
  `${col.kind}-${col.account}-${col.month}`;

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

  // Where one account's columns end and the next account's begin.
  const boundaries: number[] = [];
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].account !== columns[i - 1].account) boundaries.push(i);
  }
  // Account name spans, for the header strip above the plot.
  const spans: { account: string | null; from: number; count: number }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const last = spans[spans.length - 1];
    if (last && last.account === columns[i].account) last.count += 1;
    else spans.push({ account: columns[i].account, from: i, count: 1 });
  }

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

  return (
    <div className={compact ? "" : "rounded border bg-white p-4"}>
      <div className="overflow-x-auto">
        <div style={{ width }}>
          {/* Account strip. The bewind handover is a boundary, never a line
              drawn through: the same person's money moving from a
              beheerrekening to a leefgeldrekening is not a collapse.
              A compact chart of a single account already gets its name from
              the block around it, so the strip only appears there when there
              is actually a boundary to explain. */}
          {(!compact || spans.length > 1) && (
          <div className="flex text-xs" style={{ paddingLeft: AXIS_W }}>
            {spans.map((s) => (
              <div
                key={`${s.account}-${s.from}`}
                style={{ width: s.count * COL_W }}
                className={`truncate px-1 pb-1 font-medium text-slate-600 ${
                  s.from > 0 ? "border-l border-slate-300" : ""
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
                <line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" strokeWidth="2.5" />
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
                  fontSize="10"
                  fill={MUTED}
                  style={{ fontVariantNumeric: "tabular-nums" }}
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
                stroke={MUTED}
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

              if (col.kind === "actual" && col.coverage === "none") {
                // A gap, not a zero. There is nothing to draw here on purpose.
                return (
                  <g key={columnKey(col)}>
                    <line
                      x1={left + COL_W / 2}
                      x2={left + COL_W / 2}
                      y1={TOP_PAD}
                      y2={BASE_Y}
                      stroke={GRID}
                      strokeWidth="1"
                      strokeDasharray="2 4"
                    />
                    <text
                      x={left + COL_W / 2}
                      y={BASE_Y - 8}
                      fontSize="10"
                      fill={MUTED}
                      textAnchor="start"
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
                    fill="#0b0b0b"
                    opacity="0.05"
                  />
                );
              }

              if (col.kind === "actual") {
                const hatched = col.coverage === "partial";
                const inH = h(col.inCents);
                if (inH > 0) {
                  nodes.push(
                    <g key="in">
                      <rect
                        x={left + IN_X}
                        y={BASE_Y - inH}
                        width={BAR_W}
                        height={inH}
                        rx="4"
                        fill={INCOME_INK}
                        opacity={focusCategory ? 0.35 : 1}
                      />
                      {hatched && (
                        <rect
                          x={left + IN_X}
                          y={BASE_Y - inH}
                          width={BAR_W}
                          height={inH}
                          rx="4"
                          fill={`url(#${hatchId})`}
                        />
                      )}
                      <title>
                        {`${monthLabel(col.month)} — vast inkomen ${euro(col.inCents)}`}
                      </title>
                    </g>
                  );
                }

                let cursor = 0;
                for (const band of col.outByCategory) {
                  const bandH = h(band.cents);
                  if (bandH <= 0) continue;
                  const y = BASE_Y - cursor - bandH;
                  const dimmed = focusCategory != null && focusCategory !== band.category;
                  nodes.push(
                    <g key={`out-${band.category}`}>
                      <rect
                        x={left + OUT_X}
                        y={y}
                        width={BAR_W}
                        height={Math.max(1, bandH - SEG_GAP)}
                        rx="2"
                        fill={dimmed ? GRID : (CATEGORY_COLOR[band.category] ?? MUTED)}
                      />
                      {hatched && !dimmed && (
                        <rect
                          x={left + OUT_X}
                          y={y}
                          width={BAR_W}
                          height={Math.max(1, bandH - SEG_GAP)}
                          rx="2"
                          fill={`url(#${hatchId})`}
                        />
                      )}
                      <title>
                        {`${monthLabel(col.month)} — ${CATEGORY_LABEL[band.category] ?? band.category} ${euro(band.cents)}`}
                      </title>
                    </g>
                  );
                  cursor += bandH;
                }
              } else {
                // Projected: outline only. Nothing here is a bank row.
                const inH = h(col.inCents);
                const outH = h(col.outCents);
                const afterH = h(col.outAfterCancelCents);
                if (inH > 0) {
                  nodes.push(
                    <g key="pin">
                      <rect
                        x={left + IN_X + 0.5}
                        y={BASE_Y - inH}
                        width={BAR_W - 1}
                        height={inH}
                        rx="4"
                        fill="none"
                        stroke={INCOME_INK}
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                      />
                      <title>
                        {`${monthLabel(col.month)} — verwacht vast inkomen ${euro(col.inCents)}`}
                      </title>
                    </g>
                  );
                }
                if (outH > 0) {
                  nodes.push(
                    <g key="pout">
                      <rect
                        x={left + OUT_X + 0.5}
                        y={BASE_Y - outH}
                        width={BAR_W - 1}
                        height={outH}
                        rx="4"
                        fill="none"
                        stroke={MUTED}
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                      />
                      <title>
                        {`${monthLabel(col.month)} — verwachte vaste lasten ${euro(col.outCents)}`}
                      </title>
                    </g>
                  );
                }
                if (afterH > 0) {
                  nodes.push(
                    <g key="pafter">
                      <rect
                        x={left + OUT_X + 3.5}
                        y={BASE_Y - afterH}
                        width={BAR_W - 7}
                        height={afterH}
                        rx="3"
                        fill="none"
                        stroke={AFTER_CANCEL_INK}
                        strokeWidth="1.5"
                        strokeDasharray="2 2"
                      />
                      <title>
                        {`${monthLabel(col.month)} — na opzeggen ${euro(col.outAfterCancelCents)}`}
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
              Compact has no drill, so there the same labels are plain text —
              and neither has a projected month: the panel lists bank rows, and
              for a month that has not happened yet it would answer "geen
              uitgaven in deze maand", which is a statement about the future
              dressed up as a fact about the ledger. */}
          <div className="flex" style={{ paddingLeft: AXIS_W }}>
            {columns.map((col, i) => {
              const isSelected =
                selected != null &&
                col.kind === "actual" &&
                selected.month === col.month &&
                (selected.account ?? null) === (col.account ?? null);
              const drillable = !compact && col.kind === "actual";
              const href =
                `/money?month=${col.month}` +
                (col.account ? `&account=${encodeURIComponent(col.account)}` : "") +
                (focusCategory ? `&cat=${encodeURIComponent(focusCategory)}` : "");
              const className =
                `block truncate px-1 py-1 text-center text-[10px] ${
                  drillable ? "hover:bg-slate-100" : ""
                } ${boundaries.includes(i) ? "border-l border-slate-300" : ""} ${
                  isSelected ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-500"
                } ${col.kind === "projected" ? "italic" : ""}`;
              return !drillable ? (
                <span
                  key={columnKey(col)}
                  style={{ width: COL_W }}
                  className={className}
                >
                  {monthLabel(col.month)}
                </span>
              ) : (
                <Link
                  key={columnKey(col)}
                  href={href}
                  style={{ width: COL_W }}
                  className={className}
                >
                  {monthLabel(col.month)}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend. Identity is never colour alone: every band is named, and its
          total over the shown months is spelled out — which is also the relief
          the palette's contrast warning asks for.

          The compact block leaves it out on purpose: it is a pointer to
          /money, and colour without a name is not identity, so the dashboard
          block names the account and nothing else, and /money — one click
          away — is where a band gets a name and a number. */}
      {!compact && (
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="flex items-center gap-1.5 text-slate-600">
          <span
            className="inline-block h-3 w-3 rounded-sm"
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
              href={active ? "/money" : `/money?cat=${category}`}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-slate-100 ${
                active ? "font-semibold text-slate-900 ring-1 ring-slate-300" : "text-slate-600"
              }`}
              title={active ? "Toon weer alle categorieën" : `Alleen ${CATEGORY_LABEL[category] ?? category}`}
            >
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: CATEGORY_COLOR[category] }}
                aria-hidden
              />
              {CATEGORY_LABEL[category] ?? category}
              <span className="text-slate-400" style={{ fontVariantNumeric: "tabular-nums" }}>
                {euro(categoryTotal(category))}
              </span>
            </Link>
          );
        })}
      </div>
      )}

      {!compact && (
      <p className="mt-3 text-xs text-slate-500">
        Gevuld = echte bankregels · gearceerd = mogelijk incompleet · gestippeld =
        verwacht uit de registratie · <span className="italic">geen data</span> = geen
        afschrift voor die maand.{" "}
        <span style={{ color: AFTER_CANCEL_INK }}>Groen gestippeld</span> is{" "}
        <em>na opzeggen</em>: wat de nog op te zeggen abonnementen zouden schelen.
      </p>
      )}
    </div>
  );
}
