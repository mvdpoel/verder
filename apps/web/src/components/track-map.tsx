"use client";

import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@verder/api";
import {
  TRACK_STATUS_LABEL, stopHref, stopMark, stopWhenLabel, trackTerminus,
} from "@/lib/track-marks";
import { cx, Panel, TOKEN } from "@/components/ui";

/**
 * The case as a vertical metro map, newest at the top. Inline SVG, no chart
 * library — the web app has no runtime dependency beyond Next and React and
 * `money-chart.tsx` already holds that line.
 *
 * This file DRAWS; it does not decide. Which stop gets which mark is
 * `@/lib/track-marks`, and which row, lane and band every stop sits in is
 * `buildTrackMap` in the api package — both unit-tested without React.
 *
 * WHY VERTICAL. The horizontal drawing put every stop in its own column, so a
 * title had to fit under a dot and was cut to sixteen characters; at 34 stops
 * it was twelve columns of stubs. Down the page a row is as wide as the screen,
 * so there is one label column at a fixed x and the full title fits in it. The
 * page scrolls down anyway, which is the direction a browser is good at.
 *
 * POSITION IS TIME here — rows descend into the past and the month bands are
 * the scale. That reverses the rule this drawing was built on ("a layering,
 * never a time axis"), which existed because an expected stop had no date to
 * place. Migration 0026 removed every expected stop, so the axis is honest.
 * Within a band the stops are evenly spaced and NOT to scale: each one prints
 * its own date, and the legend says so.
 *
 * MONOCHROME on purpose. A stop's lane and the muted track name after its title
 * already say which spoor it belongs to; six new hues would only leave the
 * palette behind. So the rails and the stops live in the steel/ink ramp, a
 * junction ring is cyan (the system's own voice: "another line meets here"),
 * and AMBER IS SPENT ON ONE STOP — the one waiting on Martin. That is also the
 * only thing on this drawing that glows or moves.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MapPayload = RouterOutputs["tracks"]["map"]["map"];

// Pixels, not facts.
const DATE_W = 64;        // right-aligned date gutter
const LANE_X0 = 84;       // x of lane 0, the spine
const LANE_W = 20;
const ROW_H = 34;
const BAND_H = 30;        // what a band header costs
const EMPTY_BAND_H = 22;
const LABEL_GAP = 18;
const LABEL_W = 380;      // the label column's FLOOR, not its width
const LABEL_MAX = 900;    // ...and its CEILING, so the date gutter stays reachable
const LABEL_PAD = 8;
const SPOOR_DX = 8;       // gap between a title and the spoor name trailing it
const PAD_TOP = 12;
const PAD_BOTTOM = 16;
const R_STOP = 6;
const BAND_FS = 10;
const BAND_TRACKING = 0.08;

/**
 * How wide a run of text is, estimated from what is in it.
 *
 * The whole point of this drawing is that a title is never cut, and a root
 * `<svg>` clips whatever runs past its width — so the label column cannot be a
 * fixed 380 and hope. It cannot be measured either: there is no layout engine
 * on the server, and measuring after mount would move the page under Martin
 * while he reads it.
 *
 * So it is estimated, PER CHARACTER AND BY CASE, because one average per string
 * is not safe here. MEASURED in Chrome at 12px/10px system-ui: across all 34
 * rows of the real case the widest averaged 0.522 em per character, but those
 * rows are ordinary Dutch sentences — an uppercase run is around 0.66 em, so a
 * caps-heavy title of about sixty characters overflows a flat 0.565 estimate by
 * roughly 68px and is silently cut off, which is the one failure this drawing
 * exists to remove. Charging capitals at their own rate costs nothing on a
 * normal row and cannot be defeated by a shouty one.
 *
 * Both rates keep headroom over what was measured. Over-estimating buys
 * whitespace inside a container that already scrolls; under-estimating costs
 * the end of a sentence.
 */
const CHAR_EM = 0.565;    // measured worst case 0.522
const CAPS_EM = 0.72;     // measured around 0.66

/** Uppercase in any language, not just A–Z: É and Ë are wide too. */
const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

function runWidth(text: string, px: number): number {
  let caps = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    if (isUpper(ch)) caps++;
  }
  return px * (caps * CAPS_EM + (total - caps) * CHAR_EM);
}

const labelWidth = (title: string, spoor: string | null) =>
  runWidth(title, 12)
  + (spoor === null ? 0 : SPOOR_DX + runWidth(spoor, 10));

/*
 * The palette, as literal values. An SVG `fill`/`stroke` cannot take a Tailwind
 * class here — the marks are chosen per stop in JS — so the token values are
 * written out. Every one of them is copied from globals.css; nothing is mixed
 * by eye and nothing new is invented.
 *
 * PLATE is the exception and the one approximation: it hides the rails behind a
 * band label, so it has to be the colour of the panel this drawing sits ON, not
 * of the page. The panel is a translucent gradient over --color-void, running
 * from about #0d141d at the top to #060a11 at the bottom; a band label is 13px
 * tall and the difference across that gradient is a couple of RGB steps, so one
 * value from the middle of it disappears at every height.
 */
const PLATE = TOKEN.plate;
const INK = TOKEN.ink;              // a halte's own title
const INK_BRIGHT = TOKEN.inkBright; // the selected one
const STEEL = TOKEN.steel;          // it happened
const STEEL_DIM = TOKEN.steelDim;   // it happened, second plane
const SIGNAL = TOKEN.signal;        // a junction, and a halte still running
const ATTN = TOKEN.attn;            // WAITING ON MARTIN, and nothing else
const DIM = TOKEN.inkDim;           // the date gutter
const FAINT = TOKEN.inkFaint;       // the month bands
const HAIRLINE = TOKEN.hairlineHue; // the alpha is set per use

const dateLabel = (at: Date | string) =>
  new Date(at).toLocaleDateString("nl-NL");

export function TrackMap({
  map, selected,
}: {
  map: MapPayload;
  selected: string | null;
}) {
  if (map.stops.length === 0 && map.tracks.length === 0) return null;

  // Rows are slots; bands are headers between them. One pass turns both into y.
  const rowY = new Array<number>(map.rowCount);
  const bandY: number[] = [];
  let cursor = PAD_TOP;
  for (const band of map.bands) {
    bandY.push(cursor + 12);
    cursor += band.empty ? EMPTY_BAND_H : BAND_H;
    for (let r = band.fromRow; r < band.toRow; r++) {
      rowY[r] = cursor + ROW_H / 2;
      cursor += ROW_H;
    }
  }
  const height = cursor + PAD_BOTTOM;
  const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
  const labelX = laneX(map.laneCount) + LABEL_GAP;

  const trackById = new Map(map.tracks.map((t) => [t.id, t]));
  const spoorOf = (trackId: string) => {
    const t = trackById.get(trackId);
    return t && t.parentTrackId !== null ? t.title : null;
  };

  // The column is as wide as its widest row, between a floor and a CEILING. A
  // title that ran past the svg's width would be silently cut off, which is
  // exactly the failure the 16-character stubs were — but an unbounded column
  // is its own failure: past a certain width the card scrolls the date gutter
  // off the left edge and the reader loses the axis the whole page is built on.
  // LABEL_MAX fits about 150 characters, so it binds on pathology only.
  //
  // reduce, not Math.max(...spread): the spread is one argument per stop, and
  // there is no cap on how many stops a case can grow to.
  const labelW = Math.min(LABEL_MAX, Math.ceil(map.stops.reduce(
    (w, s) => Math.max(w, labelWidth(s.title, spoorOf(s.trackId)) + LABEL_PAD),
    LABEL_W)));
  const width = labelX + labelW;

  return (
    <Panel>
      {/* The scroll lives on this inner box, not on the Panel: a Panel is
          `overflow-hidden` and the two would fight over the same axis. */}
      <div className="overflow-x-auto p-4">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="De zaak van boven naar beneden: de nieuwste halte bovenaan, per maand, met de hoofdlijn links en de zijsporen ernaast"
        >
          {/* A month in which nothing happened is a fact about the case, so its
              band is drawn and named rather than closed up. It is shorter than a
              month with stops in it, which is what makes a quiet stretch read as
              quiet instead of as missing. */}
          {map.bands.map((band, i) => (
            <line
              key={band.key}
              x1={0} x2={width} y1={bandY[i] - 12} y2={bandY[i] - 12}
              stroke={HAIRLINE} strokeWidth="1" opacity="0.1"
            />
          ))}

          {/* One rail per track, running down its own lane between its newest and
              its oldest stop. The hoofdlijn is lane 0 and drawn heavier. */}
          {map.tracks.map((t) => {
            const top = rowY[t.firstRow];
            const bottom = rowY[t.lastRow];
            // A track with no stops has no rows to hang a rail on. buildTrackMap
            // still gives it a lane, and the Sporen list on /timeline still names
            // it — there is simply nothing here to draw.
            if (top === undefined || bottom === undefined) return null;
            const x = laneX(t.lane);
            const end = Math.max(bottom, top + 8);
            const terminus = trackTerminus(t);
            return (
              <g key={t.id}>
                {/* NO NAME IN THE GUTTER, for any track. The hoofdlijn never had
                    one — its name beside a stop reads as that stop's caption —
                    and on the vertical map that argument covers the zijsporen
                    too, because EVERY ROW ALREADY NAMES ITS OWN SPOOR after the
                    title. A gutter name repeated the same string 14px lower and
                    to the left, in the only whitespace the 34px cadence has, so
                    it read as a caption for the row BELOW it. The rail is named
                    on hover instead: free, and no ink. */}
                <title>{t.title}</title>
                {/* The hoofdlijn is the brighter, heavier steel; a zijspoor sits
                    a plane back. Both are "it happened" — neither is a signal. */}
                <line
                  x1={x} x2={x} y1={top} y2={end}
                  stroke={t.lane === 0 ? STEEL : STEEL_DIM}
                  strokeWidth={t.lane === 0 ? 3 : 2}
                  opacity={t.lane === 0 ? 0.55 : 0.32}
                />
                {/* The cap sits at the TOP of the rail, the newest end: that is
                    where the spoor stopped. AFGEROND and GEËINDIGD are different
                    facts and the spoor editor makes Martin choose between them,
                    so they get different caps: afgerond a solid double bar in the
                    ink of the line, geëindigd a single muted bar. The <title>
                    names it, and the Sporen list spells it out in words for
                    anyone not using a mouse. */}
                {terminus === "done" && (
                  <g>
                    <line x1={x - 8} x2={x + 8} y1={top - 11} y2={top - 11}
                      stroke={STEEL} strokeWidth="2" opacity="0.75" />
                    <line x1={x - 8} x2={x + 8} y1={top - 16} y2={top - 16}
                      stroke={STEEL} strokeWidth="2" opacity="0.75" />
                    <title>{`${t.title} — ${TRACK_STATUS_LABEL.done}`}</title>
                  </g>
                )}
                {terminus === "ended" && (
                  <g>
                    <line x1={x - 7} x2={x + 7} y1={top - 12} y2={top - 12}
                      stroke={STEEL_DIM} strokeWidth="2" opacity="0.5" />
                    <title>{`${t.title} — ${TRACK_STATUS_LABEL.ended}`}</title>
                  </g>
                )}
              </g>
            );
          })}

          {/* Branches and merges: a curve between two lanes at two rows.
              `from` is the MOVING line and `to` is the one it meets, so the ends
              swap roles with the kind — a branch runs parent → zijspoor, a merge
              runs zijspoor → parent. buildTrackMap already resolved both into
              lane/row pairs, so there is nothing to look up here. */}
          {map.edges.map((e) => {
            const y1 = rowY[e.fromRow];
            const y2 = rowY[e.toRow];
            if (y1 === undefined || y2 === undefined) return null;
            const x1 = laneX(e.fromLane);
            const x2 = laneX(e.toLane);
            const mid = (y1 + y2) / 2;
            return (
              <path
                key={`${e.kind}-${e.trackId}`}
                d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                fill="none" stroke={STEEL_DIM} strokeWidth="2" opacity="0.32"
              />
            );
          })}

          {map.stops.map((s) => {
            const cy = rowY[s.row];
            if (cy === undefined) return null;
            const mark = stopMark(s);
            const cx = laneX(s.lane);
            const isCurrent = s.id === map.currentStopId;
            const isSelected = s.id === selected;
            const spoor = spoorOf(s.trackId);
            // From the STATE, never from whether there is a date: an open stop
            // with no date is "loopt nog". Reading it out as "verwacht" made the
            // screen-reader label of the current stop contradict the card that
            // sits right next to it.
            const when = stopWhenLabel(s);
            // Everything the row shows, in one string. It is the tooltip and it
            // is the link's name, so what the eye gets and what a screen reader
            // gets cannot drift apart — including the red "!", which is a
            // painted glyph and would otherwise be announced to nobody.
            const label = [s.title, spoor, when].filter(Boolean).join(" — ")
              + (mark.flagged ? " — let op: deze datum ligt vóór de vorige halte" : "");
            // The same three marks the Dot vocabulary uses everywhere else in the
            // app: filled steel is "it happened", a cyan ring is "still running",
            // filled amber is "waiting on you". Amber outranks the state, because
            // there is only ever one of it and it is the answer to the question
            // this page is opened with.
            const stroke = isCurrent ? ATTN : mark.fill === "solid" ? STEEL : SIGNAL;
            const fill = isCurrent ? ATTN : mark.fill === "solid" ? STEEL : PLATE;
            return (
              // The <title> is the mouse tooltip; the label on the link is what a
              // screen reader gets, because everything inside a role="img" is
              // presentational and a focusable link in there would otherwise be
              // announced with no name at all.
              <Link key={s.id} href={stopHref(s.id, selected)} aria-label={label}>
                <g>
                  {/* A cyan wash, not a grey one: on this ground a dark tint is
                      invisible, and cyan is already what the app says "here" in. */}
                  {isSelected && (
                    <rect
                      x={0} y={cy - ROW_H / 2} width={width} height={ROW_H}
                      fill={SIGNAL} opacity="0.07"
                    />
                  )}
                  {/* What is waiting on Martin right now, marked on the edge of
                      the page so he does not have to hunt for it. */}
                  {isCurrent && (
                    <rect
                      x={0} y={cy - ROW_H / 2} width={3} height={ROW_H}
                      fill={ATTN}
                    />
                  )}
                  {s.happenedAt && (
                    <text
                      x={DATE_W - 8} y={cy + 3} textAnchor="end" fontSize="10"
                      className="font-mono"
                      fill={mark.flagged ? ATTN : DIM}
                    >
                      {dateLabel(s.happenedAt)}
                    </text>
                  )}
                  {/* Its date contradicts the stop before it. Shown, never
                      corrected — the panel under the map explains it. Amber
                      because it is Martin's to fix and the drawing stays wrong
                      until he does; there is no red in this palette and there
                      should not be one for a typo. */}
                  {mark.flagged && (
                    <text x={DATE_W - 4} y={cy + 3} fontSize="10" className="font-mono" fill={ATTN}>!</text>
                  )}
                  {mark.ring && (
                    <circle cx={cx} cy={cy} r={R_STOP + 3} fill="none"
                      stroke={SIGNAL} strokeWidth="1" opacity="0.55" />
                  )}
                  {/* The halo, and the ONLY thing on this drawing that moves. It
                      is the glow the design system spends on "asking for
                      attention", so it may exist exactly once per page — which is
                      guaranteed here, because there is one current stop. */}
                  {isCurrent && (
                    <circle
                      cx={cx} cy={cy} r={R_STOP + 3} fill="none"
                      stroke={ATTN} strokeWidth="1" opacity="0.55"
                      className="animate-halo"
                    />
                  )}
                  <circle
                    cx={cx} cy={cy} r={R_STOP}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth="2"
                    strokeDasharray={mark.fill === "dashed" ? "3 2" : undefined}
                  />
                  {/* One label column at a fixed x, and the WHOLE title in it.
                      The spoor's name trails it in the muted 10px, which is what
                      lets the lanes stay narrow enough to fit on a phone. */}
                  <text
                    x={labelX} y={cy + 4} fontSize="12"
                    fill={isSelected || isCurrent ? INK_BRIGHT : INK}
                  >
                    {s.title}
                    {spoor && (
                      <tspan dx={SPOOR_DX} fontSize="10" fill={DIM}>{spoor}</tspan>
                    )}
                  </text>
                  <title>{label}</title>
                </g>
              </Link>
            );
          })}

          {/* The band LABELS are painted last, over the rails.
              The rails run continuously through the band strip, so a label wide
              enough to reach lane 0 lands on them: `MEI 2026 · GEEN
              GEBEURTENISSEN` is about 180px and crossed four of them, and even a
              full month is borderline — `SEPTEMBER 2026` just touches the spine.
              The plate is the card's own background, so the label reads without
              leaving the gutter it belongs in. Its RULE stays underneath
              everything, where a divider belongs. */}
          {map.bands.map((band, i) => {
            const text = (band.empty
              ? `${band.label} · geen gebeurtenissen`
              : band.label).toUpperCase();
            const plate = runWidth(text, BAND_FS) + text.length * BAND_TRACKING * BAND_FS;
            return (
              <g key={band.key}>
                <rect
                  x={-2} y={bandY[i] - 9} width={plate + 8} height={13}
                  fill={PLATE}
                />
                <text
                  x={0} y={bandY[i]} fontSize={BAND_FS} fill={FAINT}
                  className="font-mono"
                  letterSpacing={`${BAND_TRACKING}em`}
                >
                  {text}
                </text>
              </g>
            );
          })}

          {/* Tracks but no stops: a real state — a spoor opens the moment
              something arrives, before anyone has written down what happened. */}
          {map.rowCount === 0 && (
            <text x={0} y={PAD_TOP + 12} fontSize="12" fill={DIM}>
              Nog geen haltes op de kaart.
            </text>
          )}
        </svg>
      </div>

      {/* The legend sits OUTSIDE the scroller: it explains the drawing, so it
          must not slide away with it. */}
      <p className="px-4 pb-4 text-xs font-light leading-relaxed text-ink-label">
        Nieuwste bovenaan. Gevuld = gebeurd · open = loopt nog · omcirkeld =
        vertrek- of aankomstpunt van een zijspoor ·{" "}
        <span className="text-attn">amberen rand</span> = waar het nu op wacht ·
        dubbele streep = spoor afgerond · enkele streep = spoor geëindigd.
        Binnen een maand staan de haltes op volgorde, niet op schaal.
      </p>
    </Panel>
  );
}
