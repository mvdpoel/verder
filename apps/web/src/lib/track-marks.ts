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
 * The three stop marks are visually distinct on purpose:
 *   solid   → it happened
 *   hollow  → it is open, and it is what is waiting on someone
 *   ringed  → a junction: another track leaves from or lands on this stop
 *
 * There used to be a fourth, `dashed`, for a stop that was expected. Migration
 * 0026 removed every expected stop, the editor no longer offers the state, and
 * `buildTrackMap` filters it out a second time — the page's axis is time, and
 * an expected stop has no date to put on it. The arm is kept because `stopMark`
 * is TOTAL over the state: a row that somehow reaches it must still draw as
 * something, and the one thing it may not draw as is a fact. It is unreachable
 * by design, not by accident.
 *
 * There is no `size` either. It carried the old map's "station" — a stop the
 * horizontal drawing gave a bigger dot — and the vertical page has one dot
 * size, because a row is already a row.
 */

export interface StopMark {
  fill: "solid" | "hollow" | "dashed";
  ring: boolean;
  /** Its date contradicts the stop before it — shown, never corrected. */
  flagged: boolean;
}

export function stopMark(stop: {
  state: "done" | "open" | "expected";
  isJunction: boolean;
  datesOutOfOrder: boolean;
}): StopMark {
  return {
    fill: stop.state === "done" ? "solid" : stop.state === "open" ? "hollow" : "dashed",
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
 * The date is `happenedAt` and ONLY `happenedAt` — the one date the vertical
 * map files a row by. It used to fall back to `expectedAt`, and that made the
 * label disagree with the axis: a `done` stop carrying only an expected date
 * announced itself as "gebeurd · 12-09-2026" on a row `buildTrackMap` had
 * filed under "Zonder datum", because an expected date is not evidence that
 * anything happened. The column still exists; nothing reads it here.
 */
export function stopWhenLabel(stop: {
  state: string;
  happenedAt: Date | string | null;
}): string {
  const label = STOP_STATE_LABEL[stop.state] ?? stop.state;
  return stop.happenedAt
    ? `${label} · ${new Date(stop.happenedAt).toLocaleDateString("nl-NL")}`
    : label;
}

/**
 * The top of the timeline, for the dashboard's case block.
 *
 * The `nu` band's rows first — what is running right now, which is not history
 * and may not read as if it were — and then the newest few dated rows. It is
 * deliberately SHORTER than /timeline: no map, no evidence, no problems, no
 * undated tail. The dashboard says where the case stands and points at the page
 * that shows how it got there.
 *
 * "onbekend" rows are left out on purpose. A stop lands there when its date is
 * one the axis cannot carry (a mistyped year), so printing it would put a wrong
 * date on the landing page — and a stop with no date at all has nothing to show
 * in a list whose whole shape is date · wat · spoor.
 *
 * Rows come in the map's own order, which is already newest-first: `row` 0 is
 * the top of the page. Nothing is re-sorted here, so the dashboard can never
 * disagree with the map about what is newest.
 */
export interface CaseTopRow {
  id: string;
  title: string;
  /** The zijspoor it sits on, or "hoofdlijn". */
  spoor: string;
  /** "loopt nu" for a running row, otherwise the date in nl-NL. */
  when: string;
  /** A `nu` row: it is happening, not something that happened. */
  running: boolean;
}

/** The band key `buildTrackMap` files a running, undated stop under. */
const NU_BAND = "nu";

export function caseTopRows(input: {
  stops: {
    id: string; trackId: string; title: string; row: number;
    bandKey: string; happenedAt: Date | string | null;
  }[];
  tracks: { id: string; title: string; parentTrackId: string | null }[];
  /** How many dated rows to show under the running ones. Three or four. */
  datedLimit?: number;
}): CaseTopRow[] {
  const spoorOf = new Map(input.tracks.map((t) =>
    [t.id, t.parentTrackId === null ? "hoofdlijn" : t.title]));
  const byRow = [...input.stops].sort((a, b) => a.row - b.row);
  const running = byRow.filter((s) => s.bandKey === NU_BAND).map((s) => ({
    id: s.id, title: s.title, spoor: spoorOf.get(s.trackId) ?? "hoofdlijn",
    when: "loopt nu", running: true,
  }));
  // A date it has AND a band that can carry it. Both, because the two can
  // disagree: a stop dated 1926 keeps its happenedAt and still lands in
  // "onbekend".
  const dated = byRow
    .filter((s) => s.happenedAt !== null && s.bandKey !== NU_BAND
      && /^\d{4}-\d{2}$/.test(s.bandKey))
    .slice(0, input.datedLimit ?? 3)
    .map((s) => ({
      id: s.id, title: s.title, spoor: spoorOf.get(s.trackId) ?? "hoofdlijn",
      when: new Date(s.happenedAt!).toLocaleDateString("nl-NL"), running: false,
    }));
  return [...running, ...dated];
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
