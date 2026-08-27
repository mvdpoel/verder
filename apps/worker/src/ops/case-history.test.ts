// Structural checks on the case-history seed. No database: these are questions
// about the seed itself, and every one of them is a failure that would
// otherwise surface as a thrown script halfway through a production run — or,
// worse, as a map that renders but points the wrong way.
import { describe, expect, it } from "vitest";
import {
  PARTY_SEED, SPINE_DATES, SPINE_SEED, STOP_RENAMES, TASK_SEED, TRACK_RENAMES,
  TRACK_SEED,
} from "./case-history";

/** The stops the root track already has from migrations 0023/0024. */
const EXISTING_ROOT_STOPS = [
  "Start", "Aanvraag bewindvoering", "bewindvoering", "Einde bewindvoering",
];

const rootStopTitles = () =>
  new Set([...EXISTING_ROOT_STOPS, ...SPINE_SEED.map((s) => s.title)]);

const allStops = () => [...SPINE_SEED, ...TRACK_SEED.flatMap((t) => t.stops)];

describe("case-history seed", () => {
  it("branches and merges every track at a stop that is actually on the root", () => {
    const root = rootStopTitles();
    for (const t of TRACK_SEED) {
      expect(root, `${t.title} branches at "${t.branchesAt}"`).toContain(t.branchesAt);
      if (t.mergesAt) {
        expect(root, `${t.title} merges at "${t.mergesAt}"`).toContain(t.mergesAt);
      }
    }
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
    // A side-track stop that shares a title with a root stop is not a conflict
    // (the guard is per track), but a stop that collides with one of 0023/0024's
    // anchors on the ROOT would be adopted instead of created.
    for (const s of SPINE_SEED) expect(EXISTING_ROOT_STOPS).not.toContain(s.title);
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
      "Stukken aanleveren",
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

  it("dates only the two anchors 0024 deliberately left undated", () => {
    expect(SPINE_DATES.map((s) => s.title))
      .toEqual(["Aanvraag bewindvoering", "bewindvoering"]);
    for (const s of SPINE_DATES) expect(EXISTING_ROOT_STOPS).toContain(s.title);
  });

  it("keeps the main line bare — four anchors, no stations of its own", () => {
    // Martin's correction after seeing the first render: the trunk shows where
    // the line goes, not every errand run along it. Everything else is work,
    // and work lives on a spoor.
    expect(SPINE_SEED).toEqual([]);
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
      expect(onSideTracks, `${t.title} branches at "${t.branchesAt}"`)
        .not.toContain(t.branchesAt);
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
    for (const t of titles) expect(EXISTING_ROOT_STOPS).not.toContain(t);
  });
});
