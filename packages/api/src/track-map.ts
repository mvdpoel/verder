/**
 * The /timeline map. PURE: no database, no I/O, no imports from @verder/db.
 * Rows in, a drawable map out — the same discipline as money-series.ts.
 *
 * TOTAL: any input renders. A corrupt map is reported through `problems` and
 * still draws what it can, because a page that throws tells Martin nothing.
 *
 * POSITION IS TIME, newest at the top. This REVERSES the rule this module was
 * built on ("position is a layering, never a time axis"). That rule existed for
 * one reason: an expected stop has no date, so a time axis would have to invent
 * one. Migration 0026 removes every expected stop and the editor no longer
 * offers the state, so the objection is gone and the axis is honest. IF
 * EXPECTED STOPS EVER COME BACK, THIS DECISION COMES BACK WITH THEM.
 *
 * Within a month, stops are evenly spaced and NOT to scale: 22 of Martin's 34
 * stops fall in five weeks, and a true time scale piles them on top of each
 * other. The month band carries the sense of time; even spacing carries the
 * readability; each stop prints its own date.
 */

import { monthIndex, monthKey, monthLabel, monthsBetween } from "./amsterdam";

export interface TrackRow {
  id: string;
  title: string;
  status: "open" | "done" | "ended";
  parentTrackId: string | null;
  branchesAtStopId: string | null;
  mergesAtStopId: string | null;
  note: string | null;
}

export interface StopRow {
  id: string;
  trackId: string;
  orderIndex: number;
  title: string;
  kind: string;
  state: "done" | "open" | "expected";
  happenedAt: Date | null;
  expectedAt: Date | null;
  stage: string | null;
  entryId: string | null;
  taskId: string | null;
  documentId: string | null;
  note: string | null;
}

export interface MapStop extends StopRow {
  /** 0 is the topmost row on the page — the newest thing that happened. */
  row: number;
  /** 0 is the spine. */
  lane: number;
  /** Which band it fell in: "nu", a month key, or "onbekend". */
  bandKey: string;
  /** Another track branches from or merges into it. */
  isJunction: boolean;
  /** Its date precedes the previous dated stop on the same track. */
  datesOutOfOrder: boolean;
}

export interface MapTrack extends TrackRow {
  lane: number;
  /** The NEWEST row it touches — the smallest number, because 0 is the top. */
  firstRow: number;
  /** The OLDEST row it touches. */
  lastRow: number;
  mergesBack: boolean;
  /** Its merge pointed backwards and was refused; it renders as ending. */
  droppedMerge: boolean;
}

/** A horizontal stripe of the page: one month, plus "nu" and "onbekend". */
export interface MapBand {
  key: string;
  label: string;
  /** Inclusive. */
  fromRow: number;
  /** Exclusive; equal to `fromRow` when the band holds nothing. */
  toRow: number;
  empty: boolean;
}

/**
 * A departure or a return, as two points to draw a curve between.
 *
 * `from` is the MOVING line and `to` is the line it meets, which means the two
 * ends swap roles with the kind: a `branch` runs from the parent to the child,
 * a `merge` runs from the child back to the parent. Reading `from` as "always
 * the parent" draws every merge backwards.
 */
export interface MapEdge {
  kind: "branch" | "merge";
  trackId: string;
  /** Where the line leaves: the parent on a branch, the zijspoor on a merge. */
  fromLane: number;
  fromRow: number;
  /** Where it arrives: the zijspoor on a branch, the parent on a merge. */
  toLane: number;
  toRow: number;
  /** The anchor stop, when one is recorded and drawn. */
  atStopId: string | null;
}

export interface MapProblem {
  kind:
    | "no-root"
    | "extra-root"
    | "date-out-of-range"
    | "backwards-merge"
    | "branch-into-own-subtree"
    | "ancestry-cycle"
    | "orphan-stop";
  trackId?: string;
  stopId?: string;
  detail: string;
}

export interface CaseMap {
  bands: MapBand[];
  stops: MapStop[];
  tracks: MapTrack[];
  edges: MapEdge[];
  rowCount: number;
  laneCount: number;
  /** What is waiting on Martin right now — the page's actual answer. */
  currentStopId: string | null;
  problems: MapProblem[];
}

/** The band a stop with no month of its own falls into. */
const NU = "nu";
const ONBEKEND = "onbekend";

const BAND_LABEL: Record<string, string> = {
  [NU]: "Nu",
  [ONBEKEND]: "Zonder datum",
};

/** Newest first: "nu" at the top, then the months, then everything undatable. */
function bandLabel(key: string): string {
  return BAND_LABEL[key] ?? monthLabel(key);
}

/**
 * How far the month bands reach either side of the middle of the case, in
 * months. Five years each way: a bewindvoering runs three years and a WSNP
 * three more, so a real case fits with room to spare, while the mistyped year
 * that "1926" is falls outside by a century and is reported instead of drawn.
 * It also bounds what the renderer is ever asked to paint at 121 stripes.
 */
const MAX_BAND_REACH = 60;

/**
 * The instant a Date carries, or null when there is nothing usable there.
 *
 * `new Date("onzin")` is a Date whose time is NaN, and handing that to
 * Intl.format throws RangeError. Nothing in this module may throw, and NaN
 * would poison every comparison it reached anyway.
 */
function instantOf(s: StopRow): number | null {
  if (s.happenedAt === null) return null;
  const at = s.happenedAt.getTime();
  return Number.isNaN(at) ? null : at;
}

export function buildTrackMap(input: {
  tracks: TrackRow[]; stops: StopRow[];
}): CaseMap {
  const problems: MapProblem[] = [];
  const byId = new Map(input.tracks.map((t) => [t.id, t]));

  const root = input.tracks.find((t) => t.parentTrackId === null);
  if (!root) {
    problems.push({ kind: "no-root", detail: "geen hoofdlijn gevonden" });
    return { bands: [], stops: [], tracks: [], edges: [], rowCount: 0,
      laneCount: 0, currentStopId: null, problems };
  }

  // Only tracks whose ancestry actually reaches the root are drawable. A cycle
  // among parents is refused at write time; if one is ever in the data it is
  // reported here and the tracks in it are left out rather than looped over.
  const reachable: TrackRow[] = [];
  // id → itself plus every track above it. Kept, because the branch check below
  // needs it to tell a branch off the parent line apart from a branch off its
  // own line or one of its own zijsporen.
  const ancestry = new Map<string, Set<string>>();
  for (const t of input.tracks) {
    const seen = new Set<string>();
    let cur: TrackRow | undefined = t;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentTrackId === null) break;
      cur = byId.get(cur.parentTrackId);
    }
    if (cur && cur.parentTrackId === null) {
      reachable.push(t);
      ancestry.set(t.id, seen);
    }
    else problems.push({ kind: "ancestry-cycle", trackId: t.id,
      detail: `spoor "${t.title}" hangt niet aan de hoofdlijn` });
  }

  // 1. TRACK ORDER. Depth-first from the root, children by title then id.
  //
  // This is the comparator's tie-break, and it exists so that lanes can be
  // DERIVED from rows instead of the other way round. Using the lane there
  // would be circular: a lane needs the track's row span, and a row span needs
  // the rows. Track order needs nothing but the tracks themselves.
  const childrenOf = new Map<string, TrackRow[]>();
  for (const t of reachable) {
    if (t.parentTrackId === null) continue;
    const list = childrenOf.get(t.parentTrackId);
    if (list) list.push(t);
    else childrenOf.set(t.parentTrackId, [t]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  const ordered: TrackRow[] = [];
  const walk = (t: TrackRow) => {
    ordered.push(t);
    for (const child of childrenOf.get(t.id) ?? []) walk(child);
  };
  walk(root);
  const trackOrder = new Map(ordered.map((t, i) => [t.id, i]));

  // `tracks_single_root_uq` makes a second hoofdlijn unreachable from the
  // database, but the header of this module promises that ANY input renders,
  // and "unreachable from today's schema" is not that promise. A track that
  // terminates at some OTHER root is not on this map — the map draws one case —
  // so it is left out, and every one of them is NAMED. Silently dropping a
  // whole line, stops and all, is the one failure mode a problems panel exists
  // to prevent.
  const drawable = new Set(ordered.map((t) => t.id));
  for (const t of reachable) {
    if (drawable.has(t.id)) continue;
    problems.push({ kind: "extra-root", trackId: t.id,
      detail: `spoor "${t.title}" hangt aan een tweede hoofdlijn — de kaart tekent er één` });
  }

  // 2. STOPS PER TRACK. An orphan is reported BEFORE the expected filter: an
  // expected orphan is still a data error, and dropping it silently would hide
  // one problem behind another.
  const byTrack = new Map<string, StopRow[]>();
  for (const t of ordered) byTrack.set(t.id, []);
  for (const s of input.stops) {
    if (!byId.has(s.trackId)) {
      problems.push({ kind: "orphan-stop", stopId: s.id,
        detail: `halte "${s.title}" hoort bij geen enkel spoor` });
      continue;
    }
    if (!drawable.has(s.trackId)) continue;
    // Migration 0026 removed every expected stop and the editor no longer
    // offers the state. This is the second line of defence: the axis is time,
    // and an expected stop has no date to put on it.
    if (s.state === "expected") continue;
    byTrack.get(s.trackId)?.push(s);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));
  }

  // 3. DATES OUT OF ORDER, per track, in order_index order. A dated stop
  // earlier than the PREVIOUS dated one is REPORTED, never reordered.
  //
  // lastDated moves on UNCONDITIONALLY, including past a flagged stop. Not
  // moving it turns lastDated into the running MAXIMUM, which inverts the whole
  // signal: one typo — 2036 for 2026 — then leaves the typo itself clean and
  // flags every correct stop behind it, pointing Martin at four healthy stops
  // instead of the one that is wrong.
  const outOfOrder = new Set<string>();
  for (const list of byTrack.values()) {
    let lastDated: number | null = null;
    for (const s of list) {
      const at = instantOf(s);
      if (at !== null && lastDated !== null && at < lastDated) outOfOrder.add(s.id);
      if (at !== null) lastDated = at;
    }
  }

  // 4. WHICH DATES THE AXIS CAN HONESTLY CARRY.
  //
  // A date is geometry here, so a wrong one is not a wrong label any more — it
  // is a wrong page. `<input type="date">` on the stop editor has no min and no
  // max, so 1926 for 2026 is one keystroke away, and it would hand the renderer
  // 1200 month stripes with 34 stops among them. Past a few centuries the band
  // list is truncated by monthsBetween's own guard and stops start landing in
  // bands that do not exist at all.
  //
  // So the axis covers a window around the MIDDLE of the case, and a stop
  // outside it is filed under "zonder datum" and REPORTED — its date is kept
  // and printed on the stop, it just stops deciding where the stop sits.
  //
  // The anchor is the MEDIAN month, never the newest or the oldest: a single
  // typo would become whichever of those it was nearest and push the whole real
  // case out of the window instead of itself. With one bad date among many good
  // ones the median is always a good one. (With exactly two stops one month
  // apart in centuries there is no majority to appeal to and either answer is a
  // guess — the problems entry is what makes it visible.)
  const datedMonths: string[] = [];
  for (const list of byTrack.values()) {
    for (const s of list) {
      const at = instantOf(s);
      if (at !== null) datedMonths.push(monthKey(s.happenedAt!));
    }
  }
  datedMonths.sort();
  const anchor = datedMonths.length > 0
    ? datedMonths[datedMonths.length >> 1] : null;
  const anchorIndex = anchor === null ? 0 : monthIndex(anchor);

  /** The instant a stop can be placed at, or null when it cannot be placed. */
  const placeableOf = new Map<string, number | null>();
  for (const list of byTrack.values()) {
    for (const s of list) {
      const at = instantOf(s);
      if (at === null) {
        // No date at all is the ordinary case and no problem. A date the
        // runtime cannot read is unreachable through drizzle, but this module
        // promises never to throw, so it is caught rather than trusted.
        if (s.happenedAt !== null) {
          problems.push({ kind: "date-out-of-range", stopId: s.id,
            detail: `halte "${s.title}" heeft een onleesbare datum — hij staat onder "zonder datum"` });
          placeableOf.set(s.id, null);
        }
        continue;
      }
      const month = monthKey(s.happenedAt!);
      if (Math.abs(monthIndex(month) - anchorIndex) > MAX_BAND_REACH) {
        problems.push({ kind: "date-out-of-range", stopId: s.id,
          detail: `halte "${s.title}" is gedateerd op ${month} en valt buiten de zaak — hij staat onder "zonder datum"` });
        placeableOf.set(s.id, null);
        continue;
      }
      placeableOf.set(s.id, at);
    }
  }
  /** Had a date, but not one the axis can carry: "zonder datum", never "nu". */
  const unplaceable = (s: StopRow) =>
    s.happenedAt !== null && placeableOf.get(s.id) == null;

  // 4b. EFFECTIVE BAND AND EFFECTIVE TIME per stop.
  //
  // A dated stop speaks for itself. An OPEN undated stop is what is running
  // right now, so it goes in "nu", above all history. A DONE undated stop
  // happened, we just do not know when — it borrows its place from the stop
  // before it on its own track (else the one after it), which is the only
  // honest guess there is, and lands in "onbekend" when its whole track is
  // undated. It borrows the INSTANT and not just the band, which is what puts
  // it directly above the stop it borrowed from.
  //
  // The borrowing reads `placeableOf`, so a neighbour's unusable date is never
  // handed on: one typo must not drag a healthy stop off the axis with it.
  const bandOf = new Map<string, string>();
  const timeOf = new Map<string, number | null>();
  for (const list of byTrack.values()) {
    const times = list.map((s) => placeableOf.get(s.id) ?? null);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (times[i] !== null) {
        bandOf.set(s.id, monthKey(s.happenedAt!));
        timeOf.set(s.id, times[i]);
        continue;
      }
      if (unplaceable(s)) {
        // It has a date; it is just not one the axis can carry. It never
        // borrows and it is never "nu" — that would file a stop dated 1926
        // under what is running today.
        bandOf.set(s.id, ONBEKEND);
        timeOf.set(s.id, null);
        continue;
      }
      if (s.state === "open") {
        bandOf.set(s.id, NU);
        timeOf.set(s.id, null);
        continue;
      }
      let borrowed: number | null = null;
      for (let j = i - 1; j >= 0 && borrowed === null; j--) borrowed = times[j];
      for (let j = i + 1; j < times.length && borrowed === null; j++) borrowed = times[j];
      bandOf.set(s.id, borrowed === null ? ONBEKEND : monthKey(new Date(borrowed)));
      timeOf.set(s.id, borrowed);
    }
  }

  // The bands, top to bottom. Every month between the oldest and the newest,
  // including the quiet ones — a stretch where nothing happened is a fact about
  // the case, and a map that closes the gap hides it.
  const months = [...new Set([...bandOf.values()]
    .filter((b) => b !== NU && b !== ONBEKEND))].sort();
  const bandKeys: string[] = [];
  if ([...bandOf.values()].includes(NU)) bandKeys.push(NU);
  if (months.length > 0) bandKeys.push(...monthsBetween(months[0], months[months.length - 1]));
  if ([...bandOf.values()].includes(ONBEKEND)) bandKeys.push(ONBEKEND);
  const bandRank = new Map(bandKeys.map((k, i) => [k, i]));

  // 5. THE COMPARATOR. Band, then time descending, then track order, then
  // order_index descending, then id. TOTAL and STABLE: every step is a
  // comparison of values already on the row, so two reads of the same data
  // always draw the same map.
  //
  // order_index DESCENDING because the page runs newest-first: a stop later on
  // its track is nearer the top. It only ever decides between two stops on the
  // same track at the same instant, which is exactly the undated-done case.
  const drawn = [...byTrack.values()].flat();
  drawn.sort((a, b) => {
    const ra = bandRank.get(bandOf.get(a.id)!) ?? 0;
    const rb = bandRank.get(bandOf.get(b.id)!) ?? 0;
    if (ra !== rb) return ra - rb;
    const ta = timeOf.get(a.id) ?? null;
    const tb = timeOf.get(b.id) ?? null;
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    const oa = trackOrder.get(a.trackId) ?? 0;
    const ob = trackOrder.get(b.trackId) ?? 0;
    if (oa !== ob) return oa - ob;
    if (a.orderIndex !== b.orderIndex) return b.orderIndex - a.orderIndex;
    return a.id.localeCompare(b.id);
  });

  // 6. ROWS, and the bands measured against them.
  const rowOf = new Map(drawn.map((s, i) => [s.id, i]));
  const rowCount = drawn.length;
  const bands: MapBand[] = [];
  let cursor = 0;
  for (const key of bandKeys) {
    const count = drawn.filter((s) => bandOf.get(s.id) === key).length;
    bands.push({ key, label: bandLabel(key), fromRow: cursor,
      toRow: cursor + count, empty: count === 0 });
    cursor += count;
  }

  // 7. LANES. The root is lane 0; every other track takes the LOWEST lane
  // whose occupants do not overlap its row span, so two zijsporen that never
  // ran at the same time share a lane and the map stays narrow.
  //
  // Oldest-first (largest lastRow first) so the lane numbering reads bottom-up
  // and does not depend on the order rows came out of the database.
  const branchRow = (t: TrackRow) =>
    (t.branchesAtStopId && rowOf.has(t.branchesAtStopId)
      ? rowOf.get(t.branchesAtStopId)! : null);
  const spanOf = (t: TrackRow) => {
    const rows = (byTrack.get(t.id) ?? []).map((s) => rowOf.get(s.id)!);
    if (rows.length === 0) {
      // A track with no stops is a real state — it opens the moment something
      // arrives, before anyone has written down what happened. It gets a
      // zero-height span where it branched, so it still has a lane to sit on.
      const at = branchRow(t) ?? 0;
      return { firstRow: at, lastRow: at };
    }
    return { firstRow: Math.min(...rows), lastRow: Math.max(...rows) };
  };
  const spans = new Map(ordered.map((t) => [t.id, spanOf(t)]));

  const laneOf = new Map<string, number>([[root.id, 0]]);
  const laneSpans = new Map<number, { from: number; to: number }[]>();
  const packing = ordered.filter((t) => t.id !== root.id).sort((a, b) =>
    spans.get(b.id)!.lastRow - spans.get(a.id)!.lastRow ||
    (trackOrder.get(a.id) ?? 0) - (trackOrder.get(b.id) ?? 0));
  for (const t of packing) {
    const span = spans.get(t.id)!;
    let lane = 1;
    for (;; lane++) {
      const taken = laneSpans.get(lane) ?? [];
      const clash = taken.some((s) => span.firstRow <= s.to && s.from <= span.lastRow);
      if (!clash) {
        laneSpans.set(lane, [...taken, { from: span.firstRow, to: span.lastRow }]);
        break;
      }
    }
    laneOf.set(t.id, lane);
  }

  // 8. EDGES. One branch per zijspoor, plus a merge for each that comes back.
  //
  // A branch whose anchor stop belongs to the track itself or to one of its own
  // zijsporen is not a departure from anywhere — it is a data error, and it is
  // reported rather than drawn. `ancestry` holds each track's own id plus
  // everything above it, so one lookup answers both cases at once.
  const stopOwner = new Map(drawn.map((s) => [s.id, s.trackId]));
  const edges: MapEdge[] = [];
  const droppedMerge = new Set<string>();
  const junctions = new Set<string>();

  for (const t of ordered) {
    if (t.id === root.id) continue;
    const span = spans.get(t.id)!;
    const lane = laneOf.get(t.id) ?? 1;
    const parentLane = t.parentTrackId ? laneOf.get(t.parentTrackId) ?? 0 : 0;
    let atStopId: string | null = null;
    if (t.branchesAtStopId && rowOf.has(t.branchesAtStopId)) {
      const owner = stopOwner.get(t.branchesAtStopId);
      if (owner && ancestry.get(owner)?.has(t.id)) {
        problems.push({ kind: "branch-into-own-subtree", trackId: t.id,
          stopId: t.branchesAtStopId,
          detail: `spoor "${t.title}" vertrekt vanaf een halte op zichzelf of op een eigen zijspoor — dat vertrek is niet getekend` });
      } else {
        atStopId = t.branchesAtStopId;
      }
    }
    // No anchor recorded: the departure is drawn level with the zijspoor's own
    // OLDEST stop, which is the moment it demonstrably existed.
    const fromRow = atStopId !== null ? rowOf.get(atStopId)! : span.lastRow;
    edges.push({ kind: "branch", trackId: t.id, fromLane: parentLane, fromRow,
      toLane: lane, toRow: span.lastRow, atStopId });
    if (atStopId !== null) junctions.add(atStopId);
  }

  // A merge into a stop at or below the zijspoor's newest row is a spoor
  // claiming to rejoin the line before it left it. Refused, reported, and the
  // track then draws as ending — which is a clean outcome, not a failure.
  // By id, so two conflicting merges never resolve on database row order.
  for (const t of [...ordered].sort((a, b) => a.id.localeCompare(b.id))) {
    if (t.id === root.id) continue;
    if (!t.mergesAtStopId || !rowOf.has(t.mergesAtStopId)) continue;
    const span = spans.get(t.id)!;
    const target = rowOf.get(t.mergesAtStopId)!;
    if (target >= span.firstRow) {
      droppedMerge.add(t.id);
      problems.push({ kind: "backwards-merge", trackId: t.id,
        detail: `spoor "${t.title}" komt terug vóór het vertrok — die verbinding is niet getekend` });
      continue;
    }
    const owner = stopOwner.get(t.mergesAtStopId);
    edges.push({ kind: "merge", trackId: t.id,
      fromLane: laneOf.get(t.id) ?? 1, fromRow: span.firstRow,
      toLane: (owner ? laneOf.get(owner) : undefined) ?? 0, toRow: target,
      atStopId: t.mergesAtStopId });
    junctions.add(t.mergesAtStopId);
  }

  // 9. JUNCTIONS were collected above, from the edges that were ACTUALLY
  // DRAWN. A refused edge leaves no junction behind — a ring with no line out
  // of it is the map claiming a connection it did not draw.
  const stops: MapStop[] = drawn.map((s) => ({
    ...s,
    row: rowOf.get(s.id)!,
    lane: laneOf.get(s.trackId) ?? 0,
    bandKey: bandOf.get(s.id)!,
    isJunction: junctions.has(s.id),
    datesOutOfOrder: outOfOrder.has(s.id),
  }));

  const tracks: MapTrack[] = ordered.map((t) => ({
    ...t,
    lane: laneOf.get(t.id) ?? 0,
    firstRow: spans.get(t.id)!.firstRow,
    lastRow: spans.get(t.id)!.lastRow,
    mergesBack: t.mergesAtStopId !== null && !droppedMerge.has(t.id),
    droppedMerge: droppedMerge.has(t.id),
  }));

  // 10. "What is waiting on me" — the topmost open stop. The row ordering has
  // already broken every tie, so there is nothing left to decide here: an
  // undated open stop sits in "nu" and therefore wins over a dated one, which
  // is right, because it is the thing that is running now.
  const current = stops.find((s) => s.state === "open");

  return {
    bands, stops, tracks, edges, rowCount,
    laneCount: Math.max(1, ...[...laneOf.values()].map((l) => l + 1)),
    currentStopId: current?.id ?? null,
    problems,
  };
}
