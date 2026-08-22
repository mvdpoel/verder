/**
 * The /timeline map. PURE: no database, no I/O, no imports from @verder/db.
 * Rows in, a drawable map out — the same discipline as money-series.ts, and
 * for the same reason: every rule below is unit-testable without a database.
 *
 * TOTAL: any input renders. A corrupt map is reported through `problems` and
 * still draws what it can, because a page that throws tells Martin nothing
 * about his case.
 *
 * POSITION IS A LAYERING, NOT A TIME AXIS. A metro map is deliberately not to
 * scale, and here that is honesty rather than style: an expected stop has no
 * date, and putting it on a time axis would mean inventing one. Dates are
 * labels on a stop; they are never geometry.
 */

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
  column: number;
  lane: number;
  /** Carries a WSNP stage: draws as a large named station. */
  isStation: boolean;
  /** Another track branches from or merges into it. */
  isJunction: boolean;
  /** Its date precedes the previous dated stop on the same track. */
  datesOutOfOrder: boolean;
}

export interface MapTrack extends TrackRow {
  lane: number;
  firstColumn: number;
  lastColumn: number;
  mergesBack: boolean;
  /** Its merge pointed backwards and was refused; it renders as ending. */
  droppedMerge: boolean;
}

export interface MapEdge {
  kind: "track" | "branch" | "merge";
  fromStopId: string;
  toStopId: string;
}

export interface MapProblem {
  kind:
    | "no-root"
    | "backwards-merge"
    | "branch-into-own-subtree"
    | "ancestry-cycle"
    | "orphan-stop";
  trackId?: string;
  stopId?: string;
  detail: string;
}

export interface TrackMap {
  tracks: MapTrack[];
  stops: MapStop[];
  edges: MapEdge[];
  laneCount: number;
  columnCount: number;
  /** What is waiting on Martin right now — the page's actual answer. */
  currentStopId: string | null;
  problems: MapProblem[];
}

/** order_index, then date, then id: total and stable, so the map never reshuffles. */
function compareStops(a: StopRow, b: StopRow): number {
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  const at = a.happenedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.happenedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

/**
 * Longest path from any source, over a DAG. Every edge strictly increases the
 * column, which is what makes the result a valid drawing: a branch can never
 * point left and a merge can never land on top of what it waited for.
 */
function longestPathColumns(
  nodeIds: string[], edges: MapEdge[]
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const e of edges) {
    if (!indegree.has(e.fromStopId) || !indegree.has(e.toStopId)) continue;
    const list = outgoing.get(e.fromStopId);
    if (list) list.push(e.toStopId);
    else outgoing.set(e.fromStopId, [e.toStopId]);
    indegree.set(e.toStopId, (indegree.get(e.toStopId) ?? 0) + 1);
  }
  const column = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  // Sorted queue, so two independent sources never depend on insertion order.
  const queue = nodeIds.filter((id) => indegree.get(id) === 0).sort();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of outgoing.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return column;
}

export function buildTrackMap(input: {
  tracks: TrackRow[]; stops: StopRow[];
}): TrackMap {
  const problems: MapProblem[] = [];
  const byId = new Map(input.tracks.map((t) => [t.id, t]));

  const root = input.tracks.find((t) => t.parentTrackId === null);
  if (!root) {
    problems.push({ kind: "no-root", detail: "geen hoofdlijn gevonden" });
    return { tracks: [], stops: [], edges: [], laneCount: 0, columnCount: 0,
      currentStopId: null, problems };
  }

  // Only tracks whose ancestry actually reaches the root are drawable. A cycle
  // among parents is refused at write time; if one is ever in the data it is
  // reported here and the tracks in it are left out rather than looped over.
  const reachable: TrackRow[] = [];
  // id → itself plus every track above it. Kept, because phase A below needs it
  // to tell a branch off the parent line apart from a branch off its own line.
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
  const drawable = new Set(reachable.map((t) => t.id));

  const byTrack = new Map<string, StopRow[]>();
  for (const s of input.stops) {
    if (!drawable.has(s.trackId)) {
      if (!byId.has(s.trackId)) {
        problems.push({ kind: "orphan-stop", stopId: s.id,
          detail: `halte "${s.title}" hoort bij geen enkel spoor` });
      }
      continue;
    }
    const bucket = byTrack.get(s.trackId);
    if (bucket) bucket.push(s);
    else byTrack.set(s.trackId, [s]);
  }
  for (const list of byTrack.values()) list.sort(compareStops);

  const drawnStops = [...byTrack.values()].flat();
  const stopIds = drawnStops.map((s) => s.id);
  const known = new Set(stopIds);

  // Phase A: track and branch edges only.
  //
  // Track edges alone are a forest of chains. Branch edges are NOT acyclic by
  // construction, and believing they were is how this collapsed: nothing in the
  // schema forces branches_at_stop_id onto a stop of the PARENT track. Point it
  // at one of the track's OWN stops — or at a stop on a track below it — and
  // phase A closes a loop. The layering is Kahn-based, so it does not throw or
  // report: every node in the loop and everything downstream of it simply keeps
  // column 0, and the whole map draws stacked at one x with an empty problems
  // panel. A silently flat map is the worst possible failure here, because it
  // still looks like an answer.
  //
  // So a branch whose stop belongs to the track itself or to one of its
  // descendants is skipped and reported. `ancestry` holds each track's own id
  // plus everything above it, so one lookup answers both cases at once.
  const stopOwner = new Map(drawnStops.map((s) => [s.id, s.trackId]));
  const structural: MapEdge[] = [];
  const droppedBranch = new Set<string>();
  for (const list of byTrack.values()) {
    for (let i = 1; i < list.length; i++) {
      structural.push({ kind: "track", fromStopId: list[i - 1].id, toStopId: list[i].id });
    }
  }
  for (const t of reachable) {
    const own = byTrack.get(t.id);
    if (!t.branchesAtStopId || !known.has(t.branchesAtStopId)) continue;
    const owner = stopOwner.get(t.branchesAtStopId);
    if (owner && ancestry.get(owner)?.has(t.id)) {
      droppedBranch.add(t.id);
      problems.push({ kind: "branch-into-own-subtree", trackId: t.id,
        stopId: t.branchesAtStopId,
        detail: `spoor "${t.title}" vertrekt vanaf een halte op zichzelf of op een eigen zijspoor — dat vertrek is niet getekend` });
      continue;
    }
    if (own?.length) {
      structural.push({ kind: "branch", fromStopId: t.branchesAtStopId, toStopId: own[0].id });
    }
  }
  // Phase B: a merge is refused when it would close a loop — when the stop it
  // rejoins can ALREADY reach the stop it leaves from. That is precisely what a
  // track claiming to rejoin before it left describes, and refusing exactly
  // those keeps the whole graph a DAG, so the layering below terminates.
  //
  // NOT a column comparison. Asking whether the merge target sits right of the
  // track's last stop in the branch-only layering throws away the ordinary
  // case: the whole point of a merge is that the target moves right to make
  // room for the child. In the three-stop child of the tests, the target m3 is
  // at column 3 and the child's last stop a3 at 4, and that honest merge — the
  // main line waiting for the side track — was silently dropped.
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const e of structural) link(e.fromStopId, e.toStopId);

  const canReach = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      for (const next of adjacency.get(stack.pop()!) ?? []) {
        if (next === to) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return false;
  };

  const merges: MapEdge[] = [];
  const droppedMerge = new Set<string>();
  // By id, so that when two merges conflict with each other the one that is
  // refused never depends on the order the rows came out of the database.
  const merging = [...reachable].sort((a, b) => a.id.localeCompare(b.id));
  for (const t of merging) {
    const own = byTrack.get(t.id);
    if (!t.mergesAtStopId || !known.has(t.mergesAtStopId) || !own?.length) continue;
    const from = own[own.length - 1].id;
    if (t.mergesAtStopId !== from && !canReach(t.mergesAtStopId, from)) {
      merges.push({ kind: "merge", fromStopId: from, toStopId: t.mergesAtStopId });
      link(from, t.mergesAtStopId);
    } else {
      droppedMerge.add(t.id);
      problems.push({ kind: "backwards-merge", trackId: t.id,
        detail: `spoor "${t.title}" komt terug vóór het vertrok — die verbinding is niet getekend` });
    }
  }

  const edges = [...structural, ...merges];
  const column = longestPathColumns(stopIds, edges);

  return finishMap({
    root, reachable, byTrack, edges, column, droppedBranch, droppedMerge, problems,
  });
}


/**
 * Lanes, stations, the current stop and the date flag.
 *
 * The root is lane 0. Every other track takes the LOWEST lane whose occupants
 * do not overlap its column span, so two tracks that never ran at the same time
 * share a row and the map stays readable instead of growing one row per track
 * forever.
 */
function finishMap(x: {
  root: TrackRow; reachable: TrackRow[]; byTrack: Map<string, StopRow[]>;
  edges: MapEdge[]; column: Map<string, number>; droppedBranch: Set<string>;
  droppedMerge: Set<string>; problems: MapProblem[];
}): TrackMap {
  const col = (id: string | null) => (id ? x.column.get(id) ?? 0 : 0);
  // A refused branch point is not geometry: no edge was drawn from it, so it
  // must not pull the track's span or its lane ordering towards a stop the map
  // never connected it to.
  const branchOf = (t: TrackRow) =>
    (x.droppedBranch.has(t.id) ? null : t.branchesAtStopId);

  // Junctions: every stop another track leaves from or lands on. A branch or a
  // merge that was refused leaves no junction behind — a junction dot with no
  // line out of it would be the map claiming a connection it did not draw.
  const junctions = new Set<string>();
  for (const t of x.reachable) {
    const branch = branchOf(t);
    if (branch) junctions.add(branch);
    if (t.mergesAtStopId && !x.droppedMerge.has(t.id)) junctions.add(t.mergesAtStopId);
  }

  const spanOf = (t: TrackRow) => {
    const own = x.byTrack.get(t.id) ?? [];
    if (own.length === 0) {
      // A track with no stops is a real state — it opens the moment something
      // arrives, before anyone has written down what happens next. It gets a
      // stub one column right of where it branched.
      const at = col(branchOf(t)) + 1;
      return { firstColumn: at, lastColumn: at };
    }
    const cols = own.map((s) => col(s.id));
    return {
      firstColumn: Math.min(...cols, col(branchOf(t)) + 1),
      lastColumn: Math.max(...cols, x.droppedMerge.has(t.id) ? 0 : col(t.mergesAtStopId)),
    };
  };

  // Depth-first from the root, children ordered by where they branch, so the
  // lane assignment never depends on the order rows came out of the database.
  const childrenOf = new Map<string, TrackRow[]>();
  for (const t of x.reachable) {
    if (t.parentTrackId === null) continue;
    const list = childrenOf.get(t.parentTrackId);
    if (list) list.push(t);
    else childrenOf.set(t.parentTrackId, [t]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) =>
      col(branchOf(a)) - col(branchOf(b)) ||
      a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  const ordered: TrackRow[] = [];
  const walk = (t: TrackRow) => {
    ordered.push(t);
    for (const child of childrenOf.get(t.id) ?? []) walk(child);
  };
  walk(x.root);

  const laneSpans = new Map<number, { from: number; to: number }[]>();
  const laneOf = new Map<string, number>();
  const spans = new Map<string, { firstColumn: number; lastColumn: number }>();
  for (const t of ordered) {
    const span = spanOf(t);
    spans.set(t.id, span);
    if (t.parentTrackId === null) {
      laneOf.set(t.id, 0);
      laneSpans.set(0, [{ from: span.firstColumn, to: span.lastColumn }]);
      continue;
    }
    let lane = 1;
    for (;; lane++) {
      const taken = laneSpans.get(lane) ?? [];
      const clash = taken.some((s) =>
        span.firstColumn <= s.to && s.from <= span.lastColumn);
      if (!clash) {
        laneSpans.set(lane, [...taken, { from: span.firstColumn, to: span.lastColumn }]);
        break;
      }
    }
    laneOf.set(t.id, lane);
  }

  const stops: MapStop[] = [];
  for (const [trackId, list] of x.byTrack) {
    // Within a track, a dated stop earlier than the PREVIOUS dated one is
    // REPORTED, never reordered. It usually means the stop is on the wrong
    // track, and silently sorting it away would destroy the signal.
    //
    // lastDated moves on unconditionally, including past a flagged stop. Not
    // moving it turns lastDated into the running MAXIMUM, which inverts the
    // whole signal: one typo — 2036 for 2026 — then leaves the typo itself
    // clean and flags every correct stop behind it, pointing Martin at four
    // healthy stops instead of the one that is wrong.
    let lastDated: number | null = null;
    for (const s of list) {
      const at = s.happenedAt?.getTime() ?? null;
      const out = at !== null && lastDated !== null && at < lastDated;
      if (at !== null) lastDated = at;
      stops.push({
        ...s,
        column: col(s.id),
        lane: laneOf.get(trackId) ?? 0,
        isStation: s.stage !== null,
        isJunction: junctions.has(s.id),
        datesOutOfOrder: out,
      });
    }
  }

  const tracks: MapTrack[] = ordered.map((t) => ({
    ...t,
    lane: laneOf.get(t.id) ?? 0,
    firstColumn: spans.get(t.id)!.firstColumn,
    lastColumn: spans.get(t.id)!.lastColumn,
    mergesBack: t.mergesAtStopId !== null && !x.droppedMerge.has(t.id),
    droppedMerge: x.droppedMerge.has(t.id),
  }));

  // "What is waiting on me" — the furthest open stop. This is the question the
  // page is opened to answer, so the map hands over the answer rather than
  // making Martin find it.
  const current = stops
    .filter((s) => s.state === "open")
    .sort((a, b) => b.column - a.column || a.lane - b.lane || a.id.localeCompare(b.id))[0];

  return {
    tracks, stops, edges: x.edges,
    laneCount: Math.max(1, ...[...laneOf.values()].map((l) => l + 1)),
    // Track spans count too, not just stops: a track with no stops has no stop
    // to measure and its stub sits one column RIGHT of its branch point, so a
    // stops-only count leaves it outside the viewBox, clipped against the edge.
    // A stopless track is a real state, and the map must have room to say so.
    columnCount: Math.max(
      stops.reduce((m, s) => Math.max(m, s.column), 0),
      tracks.reduce((m, t) => Math.max(m, t.lastColumn), 0),
    ) + 1,
    currentStopId: current?.id ?? null,
    problems: x.problems,
  };
}
