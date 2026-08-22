import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { WSNP_STAGES, deriveTimeline } from "../wsnp-timeline";
import { stageRows } from "./milestones";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const DAY_MS = 86_400_000;

// The dev postgres is shared with other suites: milestones is a global table,
// so every assertion below is about rows THIS file created (or shape/ordering
// invariants that hold regardless of foreign rows) — never absolute counts.
//
// The strip now reads the WSNP TRACK's stops, which the migration seeded once.
// Those rows are an editable display aid, not evidence, so the tests below are
// free to set a stop's state and date — but the app role has no DELETE on
// stops, so a stop a test creates stays. Hence: fixed titles, found-or-created,
// so a suite that runs a hundred times does not grow the map a hundred stops.

// stageRows is pure, so the strip's own rule is provable without the shared dev
// database — which cannot answer "which stage is current" reproducibly, because
// every suite may leave a staged stop behind.
describe("stageRows", () => {
  const stop = (over: Partial<{ stage: string | null; state: string; happenedAt: Date | null }>
    & { id: string }) => ({ stage: null, state: "expected", happenedAt: null, ...over });

  it("a stage with only a placeholder reads 'empty' — the strip never claims the case is there", () => {
    // Migration 0023 seeds one synthetic 'expected' stop per stage that has no
    // milestone behind it. With those counted, all six groups are non-empty,
    // 'application' is current forever, and the dashboard puts a case well past
    // Aanvraag back at the beginning.
    const placeholders = WSNP_STAGES.map((stage) => stop({ id: `ph-${stage}`, stage }));
    const real = stop({ id: "real", stage: "settlement", state: "open" });
    const { stages } = deriveTimeline(
      stageRows([...placeholders, real]), new Date("2026-08-22T00:00:00Z"));
    const stateOf = (s: string) => stages.find((x) => x.stage === s)!.state;
    expect(stateOf("application")).toBe("empty");
    expect(stateOf("accepted")).toBe("empty");
    expect(stateOf("onboarding")).toBe("empty");
    expect(stateOf("wsnp-start")).toBe("empty");
    expect(stateOf("settlement")).toBe("current");
    expect(stateOf("clean-slate")).toBe("empty");
    // and no placeholder is handed to the strip to render
    expect(stages.flatMap((s) => s.milestones).map((m) => m.id)).toEqual(["real"]);
  });

  it("keeps done and open stops, and translates state into deriveTimeline's done", () => {
    const rows = stageRows([
      stop({ id: "a", stage: "application", state: "done",
        happenedAt: new Date("2026-05-01T00:00:00Z") }),
      stop({ id: "b", stage: "accepted", state: "open" }),
      stop({ id: "c", stage: "accepted", state: "expected" }),
      stop({ id: "d", stage: null, state: "done" }), // a stop that is no station
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.done)).toEqual([true, false]);
    expect(rows[0]!.happenedAt).toEqual(new Date("2026-05-01T00:00:00Z"));
  });
});

describe("milestones router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `ms${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  /** The seeded WSNP track — the migration's own, oldest wins. */
  const wsnpTrack = async () => {
    const [t] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, "WSNP"))
      .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
    return t;
  };

  /**
   * A side track whose title is deliberately NOT "WSNP", found-or-created. It
   * stands in for Martin's own hand-built WSNP-aanvraag spoor: the strip must
   * find its stations by STAGE, because a track title is free text he is
   * expected to edit.
   */
  const SIDE_TITLE = "WSNP-aanvraag (milestones router)";
  const sideTrack = async () => {
    const [found] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, SIDE_TITLE))
      .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
    if (found) return found;
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    const [anchor] = await db.select({ id: schema.stops.id }).from(schema.stops)
      .where(eq(schema.stops.trackId, root.id)).orderBy(asc(schema.stops.orderIndex));
    const [track] = await db.insert(schema.tracks).values({
      title: SIDE_TITLE, parentTrackId: root.id, branchesAtStopId: anchor.id,
      note: "Fixture van de milestones-router tests.",
    }).returning();
    return track;
  };

  /** Found-or-created by title, then forced to the state this test wants: the
   *  app role has no DELETE on stops, so a suite that ran a hundred times must
   *  not have grown the map a hundred stations. */
  const sideStop = async (values: {
    orderIndex: number; title: string;
    stage: "application" | "accepted" | "onboarding" | "wsnp-start" | "settlement" | "clean-slate";
    state: "done" | "open" | "expected"; happenedAt?: Date;
  }) => {
    const track = await sideTrack();
    const [found] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, track.id), eq(schema.stops.title, values.title)));
    const id = found?.id ?? (await db.insert(schema.stops)
      .values({ trackId: track.id, kind: "process", ...values }).returning())[0]!.id;
    const [stop] = await db.update(schema.stops)
      .set({ state: values.state, stage: values.stage, happenedAt: values.happenedAt ?? null })
      .where(eq(schema.stops.id, id)).returning();
    return stop!;
  };
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("create returns the row with defaults applied", async () => {
    const c = caller();
    const created = await c.milestones.create({
      stage: "application", title: "Aanvraag ingediend",
    });
    expect(created.id).toBeTruthy();
    expect(created.stage).toBe("application");
    expect(created.title).toBe("Aanvraag ingediend");
    expect(created.done).toBe(false);
    expect(created.happenedAt).toBeNull();
    expect(created.expectedAt).toBeNull();
    expect(created.note).toBeNull();
  });

  it("list groups rows under their stage, all six stages in fixed order", async () => {
    const c = caller();
    const app = await c.milestones.create({ stage: "application", title: `L-app ${Date.now()}` });
    const settle = await c.milestones.create({ stage: "settlement", title: `L-settle ${Date.now()}` });
    const groups = await c.milestones.list();
    expect(groups.map((g) => g.stage)).toEqual([...WSNP_STAGES]);
    const appGroup = groups.find((g) => g.stage === "application")!;
    const settleGroup = groups.find((g) => g.stage === "settlement")!;
    expect(appGroup.milestones.some((m) => m.id === app.id)).toBe(true);
    expect(settleGroup.milestones.some((m) => m.id === settle.id)).toBe(true);
    // a row never leaks into another stage's group
    expect(settleGroup.milestones.some((m) => m.id === app.id)).toBe(false);
  });

  it("update edits fact fields and leaves the rest untouched", async () => {
    const c = caller();
    const created = await c.milestones.create({
      stage: "accepted", title: "Toelating", expectedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const updated = await c.milestones.update({
      id: created.id, done: true,
      happenedAt: new Date("2026-08-15T00:00:00Z"), note: "Bevestigd per brief",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.done).toBe(true);
    expect(updated.happenedAt?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(updated.note).toBe("Bevestigd per brief");
    // untouched fields survive
    expect(updated.title).toBe("Toelating");
    expect(updated.stage).toBe("accepted");
    expect(updated.expectedAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("update with only an id returns the row unchanged", async () => {
    const c = caller();
    const created = await c.milestones.create({ stage: "onboarding", title: "Intake" });
    const same = await c.milestones.update({ id: created.id });
    expect(same.id).toBe(created.id);
    expect(same.title).toBe("Intake");
  });

  it("update on a nonexistent id throws NOT_FOUND", async () => {
    const c = caller();
    await expect(c.milestones.update({
      id: "00000000-0000-0000-0000-000000000000", title: "ghost",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("timeline round-trip: a stop with a stage surfaces in that stage, valid state", async () => {
    const track = await wsnpTrack();
    // Found-or-created, because the strip reads stops now and this suite cannot
    // clean up after itself. A stop on a later stage never moves "current".
    const title = "T-clean (milestones router)";
    const existing = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, track.id), eq(schema.stops.title, title)));
    const stop = existing[0] ?? (await db.insert(schema.stops).values({
      trackId: track.id, orderIndex: 699, title, stage: "clean-slate", state: "open",
    }).returning())[0];

    const result = await caller().milestones.timeline();
    expect(result.stages.map((s) => s.stage)).toEqual([...WSNP_STAGES]);
    const clean = result.stages.find((s) => s.stage === "clean-slate")!;
    expect(clean.milestones.some((m) => m.id === stop.id)).toBe(true);
    // and it does not leak into another stage's group
    const settle = result.stages.find((s) => s.stage === "settlement")!;
    expect(settle.milestones.some((m) => m.id === stop.id)).toBe(false);
    for (const s of result.stages)
      expect(["done", "current", "future", "empty"]).toContain(s.state);
  });

  it("milestone rows no longer feed the strip — the WSNP track's stops do", async () => {
    const c = caller();
    // The countdown hangs off wsnp-start. A milestone row with an absurdly early
    // date used to move it; after the re-point it must not, or the two models
    // would both be half-true at once.
    await c.milestones.create({
      stage: "wsnp-start", title: `T-start ${Date.now()}`,
      happenedAt: new Date("2000-01-01T00:00:00Z"), done: true,
    });
    // Every track's wsnp-start stations, minus the placeholders — the strip
    // selects on the stage, not on a track.
    const stops = (await db.select().from(schema.stops)
      .where(eq(schema.stops.stage, "wsnp-start")))
      .filter((s) => s.state !== "expected");
    const result = await caller().milestones.timeline();
    const startGroup = result.stages.find((s) => s.stage === "wsnp-start")!;
    expect(startGroup.milestones.map((m) => m.id).sort())
      .toEqual(stops.map((s) => s.id).sort());
  });

  it("derives the strip and the countdown from the WSNP track's stops", async () => {
    const track = await wsnpTrack();
    // A real start date on the wsnp-start station is what the countdown hangs off.
    const [startStop] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, track.id), eq(schema.stops.stage, "wsnp-start")));
    const startedAt = new Date("2026-08-01T00:00:00Z");
    await db.update(schema.stops)
      .set({ state: "done", happenedAt: startedAt })
      .where(eq(schema.stops.id, startStop.id));

    const { stages, countdown } = await caller().milestones.timeline();
    expect(stages.map((s) => s.stage)).toEqual([
      "application", "accepted", "onboarding", "wsnp-start", "settlement", "clean-slate",
    ]);
    // 547 days, unchanged — the rule did not move, only where it reads from.
    // Earliest-wins across the WHOLE map (a stage-carrying stop counts wherever
    // it stands), so the expected answer is derived from the data rather than
    // hardcoded: 2026-08-01 + 547 days is 2028-01-30 when nothing is earlier.
    const starts = (await db.select().from(schema.stops)
      .where(eq(schema.stops.stage, "wsnp-start")))
      .filter((s) => s.state === "done" && s.happenedAt)
      .map((s) => s.happenedAt!.getTime());
    expect(starts).toContain(startedAt.getTime());
    expect(countdown!.endsAt.getTime()).toBe(Math.min(...starts) + 547 * DAY_MS);
  });

  it("finds a station on ANY track — a spoor's title is free text, not a key", async () => {
    // Task 13 asks Martin to rename his sporen. Before this, the strip resolved
    // its rows with tracks.title = 'WSNP': a rename emptied it silently and the
    // countdown vanished with no error anywhere.
    const track = await sideTrack();
    expect(track.title).not.toBe("WSNP");
    const stop = await sideStop({
      orderIndex: 310, title: "Intake Gemeentehuis Almere",
      stage: "onboarding", state: "open",
    });
    const { stages } = await caller().milestones.timeline();
    const onboarding = stages.find((s) => s.stage === "onboarding")!;
    expect(onboarding.milestones.some((m) => m.id === stop.id)).toBe(true);
    expect(onboarding.state).not.toBe("empty");
  });

  it("the countdown starts on the earliest done wsnp-start stop on ANY track", async () => {
    // "Start WSNP" on Martin's own hand-built spoor must start the clock; while
    // the strip was scoped to the seeded track it never did, and nothing said why.
    const startedAt = new Date("2026-07-01T00:00:00Z");
    await sideStop({
      orderIndex: 410, title: "Toelating WSNP uitgesproken",
      stage: "wsnp-start", state: "done", happenedAt: startedAt,
    });
    const { countdown } = await caller().milestones.timeline();
    const starts = (await db.select().from(schema.stops)
      .where(eq(schema.stops.stage, "wsnp-start")))
      .filter((s) => s.state === "done" && s.happenedAt)
      .map((s) => s.happenedAt!.getTime());
    expect(starts).toContain(startedAt.getTime());
    expect(countdown).not.toBeNull();
    expect(countdown!.endsAt.getTime()).toBe(Math.min(...starts) + 547 * DAY_MS);
    expect(Math.min(...starts)).toBeLessThanOrEqual(startedAt.getTime());
  });

  it("a placeholder station never reaches the strip", async () => {
    // A synthetic 'expected' stop (migration 0023 seeds one per stage with no
    // milestone behind it) is not evidence that a stage has begun.
    const placeholder = await sideStop({
      orderIndex: 610, title: "Schone lei (nog niets achter deze halte)",
      stage: "clean-slate", state: "expected",
    });
    const { stages } = await caller().milestones.timeline();
    const shown = stages.flatMap((s) => s.milestones);
    expect(shown.some((m) => m.id === placeholder.id)).toBe(false);
    expect(shown.every((m) => m.state !== "expected")).toBe(true);
  });
});
