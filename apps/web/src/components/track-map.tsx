"use client";

import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@verder/api";
import {
  TRACK_STATUS_LABEL, stopHref, stopMark, stopWhenLabel, trackTerminus,
} from "@/lib/track-marks";

/**
 * The case as a metro map. Inline SVG, no chart library — the web app has no
 * runtime dependency beyond Next and React and `money-chart.tsx` already holds
 * that line.
 *
 * This file DRAWS; it does not decide. Which stop gets which mark is
 * `@/lib/track-marks`, and where every stop sits is `buildTrackMap` in the api
 * package — both unit-tested without React.
 *
 * Position is a layering, never a time axis: an expected stop has no date, and
 * a time axis would mean inventing one. Dates are labels here, not geometry.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MapPayload = RouterOutputs["tracks"]["map"]["map"];

// Pixels, not facts.
const COL_W = 116;
const LANE_H = 64;
const PAD_X = 150;   // room for the track title at the left of its lane
const PAD_Y = 40;
const R_STOP = 7;
const R_STATION = 11;

const INK = "#52514e";
const MUTED = "#898781";
const RAIL = "#c3c2b7";
const CURRENT = "#0ca30c";
const FLAG = "#e34948";

export function TrackMap({
  map, selected,
}: {
  map: MapPayload;
  selected: string | null;
}) {
  if (map.stops.length === 0 && map.tracks.length === 0) return null;

  const x = (column: number) => PAD_X + column * COL_W;
  const y = (lane: number) => PAD_Y + lane * LANE_H;
  const width = PAD_X + Math.max(1, map.columnCount) * COL_W;
  const height = PAD_Y + Math.max(1, map.laneCount) * LANE_H + 30;

  const byId = new Map(map.stops.map((s) => [s.id, s]));

  return (
    <div className="overflow-x-auto rounded border bg-white p-4">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="De zaak als metrokaart: de hoofdlijn naar het einde van de bewindvoering, met zijsporen"
      >
        {/* One rail per track, with its name at the left of its own lane. */}
        {map.tracks.map((t) => {
          const from = x(t.firstColumn);
          const to = x(t.lastColumn);
          const lane = y(t.lane);
          const terminus = trackTerminus(t);
          const end = Math.max(to, from + 8);
          return (
            <g key={t.id}>
              <line
                x1={from} x2={end} y1={lane} y2={lane}
                stroke={t.lane === 0 ? INK : RAIL}
                strokeWidth={t.lane === 0 ? 3 : 2}
              />
              {/* Side tracks get their name in the gutter. The MAIN LINE does
                  not: its rail starts at column 0, so its name would land
                  immediately left of the Start node and read as that stop's
                  label — "Einde bewindvoering · Start" as one phrase, which is
                  the opposite of what the map means. The main line is already
                  named by the heading above it, by its own goal stop at the far
                  right, and by the Sporen list on /timeline. */}
              {t.parentTrackId !== null && (
                <text
                  x={PAD_X - 12} y={lane + 4} textAnchor="end"
                  fontSize="11" fill={MUTED}
                >
                  {t.title}
                </text>
              )}
              {/* A spoor that finished is a CLEAN outcome — handled and closed —
                  so it gets a cap, not a frayed end. AFGEROND and GEËINDIGD are
                  different facts and the editor makes Martin choose between
                  them, so they get different caps: afgerond is a solid double
                  bar in the ink of the line, geëindigd a single muted bar. The
                  <title> names it, and the Sporen list on /timeline spells it
                  out in words for anyone not using a mouse. */}
              {terminus === "done" && (
                <g>
                  <line x1={end + 5} x2={end + 5} y1={lane - 8} y2={lane + 8}
                    stroke={INK} strokeWidth="2" />
                  <line x1={end + 10} x2={end + 10} y1={lane - 8} y2={lane + 8}
                    stroke={INK} strokeWidth="2" />
                  <title>{`${t.title} — ${TRACK_STATUS_LABEL.done}`}</title>
                </g>
              )}
              {terminus === "ended" && (
                <g>
                  <line x1={end + 6} x2={end + 6} y1={lane - 7} y2={lane + 7}
                    stroke={MUTED} strokeWidth="2" />
                  <title>{`${t.title} — ${TRACK_STATUS_LABEL.ended}`}</title>
                </g>
              )}
            </g>
          );
        })}

        {/* Branches and merges: a curve between two lanes. */}
        {map.edges.filter((e) => e.kind !== "track").map((e) => {
          const from = byId.get(e.fromStopId);
          const to = byId.get(e.toStopId);
          if (!from || !to) return null;
          const x1 = x(from.column); const y1 = y(from.lane);
          const x2 = x(to.column); const y2 = y(to.lane);
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${e.kind}-${e.fromStopId}-${e.toStopId}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none" stroke={RAIL} strokeWidth="2"
            />
          );
        })}

        {map.stops.map((s) => {
          const mark = stopMark(s);
          const cx = x(s.column);
          const cy = y(s.lane);
          const r = mark.size === "station" ? R_STATION : R_STOP;
          const isCurrent = s.id === map.currentStopId;
          const isSelected = s.id === selected;
          // From the STATE, never from whether there is a date: an open stop
          // with no date is "loopt nog". Reading it out as "verwacht" made the
          // screen-reader label of the current stop contradict the card that
          // sits right next to it.
          const when = stopWhenLabel(s);
          return (
            // The <title> is the mouse tooltip; the label on the link is what a
            // screen reader gets, because everything inside a role="img" is
            // presentational and a focusable link in there would otherwise be
            // announced with no name at all.
            <Link key={s.id} href={stopHref(s.id, selected)} aria-label={`${s.title} — ${when}`}>
              <g>
                {isSelected && (
                  <circle cx={cx} cy={cy} r={r + 7} fill="#0b0b0b" opacity="0.06" />
                )}
                {/* What is waiting on Martin right now, marked so he does not
                    have to hunt for it. */}
                {isCurrent && (
                  <circle cx={cx} cy={cy} r={r + 4} fill="none"
                    stroke={CURRENT} strokeWidth="2" />
                )}
                {mark.ring && (
                  <circle cx={cx} cy={cy} r={r + 2} fill="none"
                    stroke={MUTED} strokeWidth="1" />
                )}
                <circle
                  cx={cx} cy={cy} r={r}
                  fill={mark.fill === "solid" ? INK : "#ffffff"}
                  stroke={INK}
                  strokeWidth="2"
                  strokeDasharray={mark.fill === "dashed" ? "3 2" : undefined}
                />
                {mark.flagged && (
                  <text x={cx + r + 3} y={cy - r} fontSize="12" fill={FLAG}>!</text>
                )}
                <text
                  x={cx} y={cy + r + 14} textAnchor="middle" fontSize="10"
                  fill={isSelected ? "#0b0b0b" : MUTED}
                >
                  {s.title.length > 16 ? `${s.title.slice(0, 15)}…` : s.title}
                </text>
                <title>{`${s.title} — ${when}`}</title>
              </g>
            </Link>
          );
        })}
      </svg>

      <p className="mt-3 text-xs text-slate-500">
        Gevuld = gebeurd · open = loopt nog · gestippeld = verwacht · omcirkeld =
        vertrek- of aankomstpunt van een zijspoor ·{" "}
        <span style={{ color: CURRENT }}>groene ring</span> = waar het nu op wacht ·
        dubbele streep = spoor afgerond · enkele streep = spoor geëindigd.
        De kaart staat niet op schaal: een verwachte halte heeft nog geen datum.
      </p>
    </div>
  );
}
