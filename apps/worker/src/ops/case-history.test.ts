// Structural checks on the case-history seed. No database: these are questions
// about the seed itself, and every one of them is a failure that would
// otherwise surface as a thrown script halfway through a production run — or,
// worse, as a map that renders but points the wrong way.
import { describe, expect, it } from "vitest";
import { CASE_MAP_SPINE_SEED } from "@verder/db";
import {
  PARTY_SEED, SPINE_SEED, STOP_RENAMES, TASK_SEED, TRACK_RENAMES, TRACK_SEED,
  trackPointerPatch,
} from "./case-history";

// Migration 0026 emptied the root of everything the seed does not name: Start,
// the two duplicated anchors and the goal are gone, and the spine IS SPINE_SEED.
const rootStopTitles = () => new Set(SPINE_SEED.map((s) => s.title));

const allStops = () => [...SPINE_SEED, ...TRACK_SEED.flatMap((t) => t.stops)];

describe("case-history seed", () => {
  it("branches and merges every track at a stop that is actually on the root", () => {
    const root = rootStopTitles();
    for (const t of TRACK_SEED) {
      // Both pointers are optional now, and every spoor in this seed leaves them
      // unset — a NULL origin is the honest value for one nobody recorded.
      if (t.branchesAt) {
        expect(root, `${t.title} branches at "${t.branchesAt}"`).toContain(t.branchesAt);
      }
      if (t.mergesAt) {
        expect(root, `${t.title} merges at "${t.mergesAt}"`).toContain(t.mergesAt);
      }
    }
  });

  it("leaves a hand-set branch or merge point alone", () => {
    // THE REGRESSION THIS GUARDS. Martin opens the spoor editor and records
    // that Schuldregeling rejoins the hoofdlijn at the beschikking. No
    // TRACK_SEED entry names a merge point, so a seed that read "absent means
    // NULL" would erase what he just typed on the very next run — and report
    // the erasure in `rewired` as if it were a repair.
    const recorded = { branchesAtStopId: "stop-a", mergesAtStopId: "stop-b" };
    expect(trackPointerPatch(recorded, {})).toEqual({});

    // And it holds for the seed as it actually stands: not one entry names a
    // pointer, so a real run may not touch either column on any existing spoor.
    for (const t of TRACK_SEED) {
      expect(trackPointerPatch(recorded, {
        branchesAtStopId: t.branchesAt === undefined ? undefined : "stop-x",
        mergesAtStopId: t.mergesAt === undefined ? undefined : "stop-x",
      }), `spoor "${t.title}"`).toEqual({});
    }
  });

  it("still rewires a pointer the seed does name, null included", () => {
    // "Absent" and "explicitly none" have to stay distinguishable, or the fix
    // for the one-way door just installs a different one: a seed that DOES have
    // an opinion must still be able to move a pointer, and to clear it.
    const recorded = { branchesAtStopId: "stop-a", mergesAtStopId: "stop-b" };
    expect(trackPointerPatch(recorded, { mergesAtStopId: "stop-c" }))
      .toEqual({ mergesAtStopId: "stop-c" });
    expect(trackPointerPatch(recorded, { branchesAtStopId: null }))
      .toEqual({ branchesAtStopId: null });
    expect(trackPointerPatch(recorded, {
      branchesAtStopId: null, mergesAtStopId: null,
    })).toEqual({ branchesAtStopId: null, mergesAtStopId: null });

    // A value equal to what is already there is not a rewire: `rewired` in the
    // run's report must name the spoor that actually moved and no other.
    expect(trackPointerPatch(recorded, { branchesAtStopId: "stop-a" })).toEqual({});
    // And clearing a column that is already NULL is not one either.
    expect(trackPointerPatch(
      { branchesAtStopId: null, mergesAtStopId: null }, { mergesAtStopId: null },
    )).toEqual({});
  });

  it("points every stop's task at a task the seed defines", () => {
    const titles = new Set(TASK_SEED.map((t) => t.title));
    for (const s of allStops()) {
      if (s.task) expect(titles, `stop "${s.title}"`).toContain(s.task);
    }
  });

  it("assigns every task to a party the app has or this seed creates", () => {
    // The four already in production on 2026-08-22. A task assigned to an
    // address that exists nowhere silently lands with a null assignee, which
    // reads on the page as "nobody owns this".
    const known = new Set([
      "abruinsma@verdergroep.nl", "dwillemse@verderbewindmidden.nl",
      "teamopstart@verderbewindmidden.nl", "almere@verdergroep.nl",
      ...PARTY_SEED.map((p) => p.email),
    ]);
    for (const t of TASK_SEED) {
      if (t.assignee) expect(known, `task "${t.title}"`).toContain(t.assignee);
    }
  });

  it("keeps titles unique — every guard in the script keys on the title", () => {
    const dupes = <T>(xs: T[]) =>
      xs.filter((x, i) => xs.indexOf(x) !== i);
    expect(dupes(TASK_SEED.map((t) => t.title))).toEqual([]);
    expect(dupes(TRACK_SEED.map((t) => t.title))).toEqual([]);
    expect(dupes(SPINE_SEED.map((s) => s.title))).toEqual([]);
    for (const t of TRACK_SEED) {
      expect(dupes(t.stops.map((s) => s.title)), t.title).toEqual([]);
    }
  });

  it("orders stops by order_index in the same direction as their dates", () => {
    // The layout is a longest-path layering, not a time axis, so a date that
    // runs backwards against order_index is FLAGGED by the map rather than
    // reordered. Better to never ship one.
    for (const track of [{ title: "hoofdlijn", stops: SPINE_SEED }, ...TRACK_SEED]) {
      const dated = track.stops
        .filter((s) => s.happenedAt)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      for (let i = 1; i < dated.length; i++) {
        expect(
          dated[i].happenedAt!.getTime(),
          `${track.title}: "${dated[i].title}" is dated before "${dated[i - 1].title}"`,
        ).toBeGreaterThanOrEqual(dated[i - 1].happenedAt!.getTime());
      }
    }
  });

  it("gives every done stop a date and no expected stop one", () => {
    for (const s of allStops()) {
      if (s.state === "done") {
        expect(s.happenedAt, `done stop "${s.title}" has no date`).toBeDefined();
      }
      if (s.state === "expected") {
        expect(s.happenedAt, `expected stop "${s.title}" is dated`).toBeUndefined();
      }
    }
  });

  it("leaves exactly one open stop as the furthest-right candidate on its lane", () => {
    // The map's headline is the furthest-right open stop, tie-broken by lowest
    // lane. This does not recompute the layout — it guards the thing that
    // actually went wrong: an open stop on a track whose work waits on someone
    // else. Every open stop must be work that waits on Martin.
    const waitsOnMartin = new Set([
      "Financieel beeld compleet, vaste lasten stabiel",
      "KvK — aanmaning op OpsMate",
      "Trust and Law — PLM Investments, € 2.623,15",
      "Stam — Het CAK, € 1.141,61, er ligt een vonnis",
    ]);
    const open = allStops().filter((s) => s.state === "open").map((s) => s.title);
    expect(new Set(open)).toEqual(waitsOnMartin);
  });

  it("records a terminal status for every task that is not plain open", () => {
    for (const t of TASK_SEED) {
      if (!t.status) continue;
      expect(t.statusNote, `task "${t.title}" has a status but no note`).toBeTruthy();
      expect(["in-progress", "waiting", "done", "dropped"]).toContain(t.status);
    }
  });

  it("agrees with ensureCaseMap's spine, stop for stop and in order", () => {
    // THREE SPELLINGS OF ONE SPINE: migration 0026, ensureCaseMap, and this
    // seed. The migration is one-shot and already measured; these two both run
    // again and again, and `writeStop` changes neither `title` nor `state` on a
    // stop that already exists — so a stop only one of them names is a stop
    // only one of them creates, and whichever ran last decides what the map
    // looks like. That is exactly how 0026's deletes come undone silently.
    // happenedAt is in the comparison too: ensureCaseMap now dates the spine
    // on insert, and a date only one of the two seeds knows is exactly the
    // kind of drift this test exists to catch — `writeStop` never backfills
    // happened_at on a stop that already exists, so whichever seed ran last
    // would decide the date silently, same as it decides title and order.
    expect(SPINE_SEED.map((s) => (
      { title: s.title, orderIndex: s.orderIndex, happenedAt: s.happenedAt?.getTime() }
    ))).toEqual(CASE_MAP_SPINE_SEED.map((s) => (
      { title: s.title, orderIndex: s.orderIndex, happenedAt: s.happenedAt?.getTime() }
    )));
    // ensureCaseMap writes every one of them `done`; this seed must not
    // contradict it, because it is the one that would lose the argument.
    for (const s of SPINE_SEED) expect(s.state, s.title).toBe("done");
  });

  it("seeds no expected stop — the map shows history only", () => {
    // Migration 0026 deleted every expected stop there was. A seed that writes
    // one back would resurrect exactly what the migration removed, on the next
    // run of this script, silently.
    const states = [...SPINE_SEED.map((s) => s.state),
      ...TRACK_SEED.flatMap((t) => t.stops.map((s) => s.state))];
    expect(states).not.toContain("expected");
  });

  it("puts the fifteen spine stops in date order", () => {
    // The trunk is no longer a destination, it is the story so far — so every
    // one of its stops has happened, and the order they are numbered in is the
    // order they happened in.
    const dated = SPINE_SEED.filter((s) => s.happenedAt);
    expect(dated).toHaveLength(15);
    for (let i = 1; i < dated.length; i++) {
      expect(dated[i].happenedAt!.getTime())
        .toBeGreaterThanOrEqual(dated[i - 1].happenedAt!.getTime());
    }
  });

  it("renames onto a title the seed actually uses, and away from one it does not", () => {
    // A rename whose target no title in the seed claims would strand the row
    // under a name nothing adopts; a rename whose SOURCE is still in the seed
    // would rename the row and then re-insert it under the old name.
    const stopTitles = new Set(allStops().map((s) => s.title));
    for (const r of STOP_RENAMES) {
      expect(stopTitles, `rename target "${r.to}"`).toContain(r.to);
      expect(stopTitles, `rename source "${r.from}"`).not.toContain(r.from);
    }
    const trackTitles = new Set(TRACK_SEED.map((t) => t.title));
    for (const r of TRACK_RENAMES) {
      expect(trackTitles, `rename target "${r.to}"`).toContain(r.to);
      expect(trackTitles, `rename source "${r.from}"`).not.toContain(r.from);
    }
  });

  it("never branches a track at a stop that lives on another track", () => {
    // `branchesAt`/`mergesAt` resolve against the ROOT only. The restructure
    // moved "Beschikking: onder bewind gesteld" onto the Aanvraag track, so a
    // side track still branching there would throw mid-run in production.
    const onSideTracks = new Set(TRACK_SEED.flatMap((t) => t.stops.map((s) => s.title)));
    for (const t of TRACK_SEED) {
      if (t.branchesAt) {
        expect(onSideTracks, `${t.title} branches at "${t.branchesAt}"`)
          .not.toContain(t.branchesAt);
      }
      if (t.mergesAt) {
        expect(onSideTracks, `${t.title} merges at "${t.mergesAt}"`)
          .not.toContain(t.mergesAt);
      }
    }
  });

  it("gives every stop a title unique across the WHOLE map", () => {
    // `stopAnywhere` looks a stop up by title with no track scope, so two
    // tracks sharing a stop title would fight over one row and move it back
    // and forth on every run.
    const titles = allStops().map((s) => s.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
