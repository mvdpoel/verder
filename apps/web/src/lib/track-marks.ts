/**
 * What the /timeline map draws, as plain decisions.
 *
 * Pure and structural (no api or component imports, no React) so the rules can
 * be unit-tested without a database and without rendering — the same habit as
 * `money-marks.ts` and `money-columns.ts`. `track-map.tsx` renders what comes
 * out of here one to one and decides nothing else.
 *
 * The input shapes are declared here and matched structurally against
 * `MapStop` / `MapTrack`, so this module imports nothing from `@verder/api`.
 *
 * The four stop marks are visually distinct on purpose:
 *   solid   → it happened
 *   hollow  → it is open, and it is what is waiting on someone
 *   dashed  → it is expected: on the map before it is a fact, and it must
 *             never look like one
 *   ringed  → a junction: another track leaves from or lands on this stop
 */

export interface StopMark {
  fill: "solid" | "hollow" | "dashed";
  size: "station" | "stop";
  ring: boolean;
  /** Its date contradicts the stop before it — shown, never corrected. */
  flagged: boolean;
}

export function stopMark(stop: {
  state: "done" | "open" | "expected";
  isStation: boolean;
  isJunction: boolean;
  datesOutOfOrder: boolean;
}): StopMark {
  return {
    fill: stop.state === "done" ? "solid" : stop.state === "open" ? "hollow" : "dashed",
    size: stop.isStation ? "station" : "stop",
    ring: stop.isJunction,
    flagged: stop.datesOutOfOrder,
  };
}

export type Terminus = "merge" | "done" | "ended" | "open";

/**
 * How a track finishes.
 *
 * `done` (afgerond) and `ended` (geëindigd) are DIFFERENT facts and get
 * DIFFERENT caps: afgerond means the thing it was about was completed,
 * geëindigd means it was handled and simply never rejoined the hoofdlijn. The
 * editor asks Martin to choose between them, so the map may not collapse them
 * back into one drawing. Both are clean outcomes; neither is a loose end.
 *
 * A merge the map refused (because it pointed backwards) is NOT an outcome —
 * the spoor is still running, it just does not rejoin. It therefore keeps the
 * open terminus rather than being stamped afgerond or geëindigd, and the
 * contradiction is reported through the map's `problems` instead. What matters
 * here is only that it never draws as a merge the map did not draw.
 */
export function trackTerminus(track: {
  mergesBack: boolean; status: string; droppedMerge: boolean;
}): Terminus {
  if (track.mergesBack && !track.droppedMerge) return "merge";
  if (track.status === "done") return "done";
  if (track.status === "ended") return "ended";
  return "open";
}

export const STOP_STATE_LABEL: Record<string, string> = {
  done: "gebeurd", open: "loopt nog", expected: "verwacht",
};

export const TRACK_STATUS_LABEL: Record<string, string> = {
  open: "loopt nog", done: "afgerond", ended: "geëindigd",
};

/**
 * What a stop's mark says when it is read out or hovered.
 *
 * It comes from the STATE, never from whether there happens to be a date. A
 * stop that is `open` with no date is "loopt nog", not "verwacht" — calling it
 * verwacht made the screen-reader label of the current stop contradict the card
 * printed right next to it.
 *
 * The date is added when there is one, because it is a label on the stop. It is
 * never what decides the wording.
 */
export function stopWhenLabel(stop: {
  state: string;
  happenedAt: Date | string | null;
  expectedAt?: Date | string | null;
}): string {
  const label = STOP_STATE_LABEL[stop.state] ?? stop.state;
  const when = stop.happenedAt ?? stop.expectedAt ?? null;
  return when ? `${label} · ${new Date(when).toLocaleDateString("nl-NL")}` : label;
}

/**
 * The dashboard's line when no spoor is open.
 *
 * It names the outcomes that actually occurred. Saying "alles is afgerond" over
 * a spoor whose status is `ended` asserts the one thing the rest of this work
 * is careful to keep apart — and reports something Martin did not record.
 */
export function noOpenTracksLine(closedStatuses: string[]): string {
  const done = closedStatuses.includes("done");
  const ended = closedStatuses.includes("ended");
  if (!done && !ended) {
    return "Er loopt nog geen zijspoor. Zodra er iets binnenkomt, staat het hier.";
  }
  const outcome = done && ended ? "afgerond of geëindigd" : done ? "afgerond" : "geëindigd";
  return `Geen lopende sporen — alles wat begonnen is, is ${outcome}.`;
}

/**
 * Selection lives in the URL so a view is linkable and survives a reload — the
 * same rule `?cat=` follows on /money. Clicking the selected stop clears it,
 * so the way out is the control that got you in.
 */
export function stopHref(stopId: string, currentSelection: string | null): string {
  return currentSelection === stopId
    ? "/timeline"
    : `/timeline?stop=${encodeURIComponent(stopId)}`;
}
