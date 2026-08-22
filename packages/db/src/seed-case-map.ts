import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

/**
 * The seed of Martin's case map, as an IDEMPOTENT function.
 *
 * TWO SPELLINGS OF ONE SEED. `drizzle/0023_timeline_tracks.sql` is the other,
 * and the two must agree on every title, order_index and state here. The
 * difference in scope is deliberate: the migration ALSO copies the existing
 * `timeline_events` and `milestones` rows onto the map, which is a one-time
 * data migration and must never be repeated — running it twice would duplicate
 * every key event. This function only puts back the SKELETON: the root track,
 * its two anchors, the WSNP track, and one stop per WSNP stage that has none.
 *
 * Why it has to exist at all: `stops.entry_id` and `stops.document_id`
 * reference `log_entries` and `documents`, so the
 * `TRUNCATE ledger_events, log_entries, documents, parties CASCADE` in
 * packages/api/src/routers/verify.test.ts takes `stops` with it, and then
 * `tracks` (which references `stops`). Measured: 6 tracks and 12 stops to zero
 * in one run. A seed that lives only inside a one-shot migration cannot come
 * back from that — the dev app is simply left with no map and no way to get one.
 *
 * Every write below is guarded by a lookup, so this is safe to run a hundred
 * times: the second run creates nothing and reports nothing created.
 */

/** The root track: the main line, and the only track with no parent. */
const ROOT_TITLE = "Einde bewindvoering";
const ROOT_NOTE =
  "De hoofdlijn. Alles hier is een stap richting het einde van de bewindvoering.";
/** The two anchors on the root. The goal anchor shares the root's title. */
const START_TITLE = "Start";
const GOAL_TITLE = ROOT_TITLE;
/** Room for every stop between the anchors, so nothing ever needs a renumber. */
const GOAL_ORDER = 1_000_000;

const WSNP_TITLE = "WSNP";
const WSNP_NOTE = "De zes fases van de wettelijke schuldsanering.";

/**
 * The six stages in enum order, with the title each synthetic stop carries.
 * order_index is `position * 100` — the ROUND slot. The migration gives a stop
 * copied from a real milestone `position * 100 + n` with n >= 1, so a round
 * order_index is what marks a stop as the synthetic filler for its stage.
 */
const WSNP_STAGE_SEED = [
  { stage: "application", title: "Aanvraag" },
  { stage: "accepted", title: "Toegelaten" },
  { stage: "onboarding", title: "Intake" },
  { stage: "wsnp-start", title: "Start WSNP" },
  { stage: "settlement", title: "Regeling" },
  { stage: "clean-slate", title: "Schone lei" },
] as const satisfies readonly { stage: (typeof schema.wsnpStageEnum.enumValues)[number];
  title: string }[];

export type EnsureCaseMapResult = {
  rootTrack: boolean;
  startStop: boolean;
  goalStop: boolean;
  wsnpTrack: boolean;
  /** The stages that had no stop at all and got their synthetic one back. */
  stageStops: string[];
};

export async function ensureCaseMap(db: Db): Promise<EnsureCaseMapResult> {
  const created: EnsureCaseMapResult = {
    rootTrack: false, startStop: false, goalStop: false,
    wsnpTrack: false, stageStops: [],
  };

  // The root is the track with no parent, and a unique index allows exactly
  // one — so "find by parent IS NULL" is the same question as "is there a map".
  let [root] = await db.select().from(schema.tracks)
    .where(isNull(schema.tracks.parentTrackId));
  if (!root) {
    [root] = await db.insert(schema.tracks)
      .values({ title: ROOT_TITLE, status: "open", note: ROOT_NOTE }).returning();
    created.rootTrack = true;
  }

  const stopOnRoot = async (title: string) => {
    const [s] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, root.id), eq(schema.stops.title, title)))
      .orderBy(asc(schema.stops.createdAt), asc(schema.stops.id)).limit(1);
    return s;
  };

  // DONE, and deliberately WITHOUT a date. A now() here would render as
  // "Start · <today>", a claim about when Martin's case began that nobody
  // measured — the one kind of assertion this app refuses to make.
  let start = await stopOnRoot(START_TITLE);
  if (!start) {
    [start] = await db.insert(schema.stops).values({
      trackId: root.id, orderIndex: 0, title: START_TITLE,
      kind: "process", state: "done",
    }).returning();
    created.startStop = true;
  }

  // The goal has not happened yet, and the map says so rather than implying it.
  let goal = await stopOnRoot(GOAL_TITLE);
  if (!goal) {
    [goal] = await db.insert(schema.stops).values({
      trackId: root.id, orderIndex: GOAL_ORDER, title: GOAL_TITLE,
      kind: "process", state: "expected",
    }).returning();
    created.goalStop = true;
  }

  // WSNP is a procedure INSIDE the goal of ending bewindvoering, not the same
  // road: its own track, branching at the start anchor and merging back at the
  // goal. Oldest wins, the same rule the milestones router resolves it with.
  let [wsnp] = await db.select().from(schema.tracks)
    .where(and(eq(schema.tracks.title, WSNP_TITLE),
      eq(schema.tracks.parentTrackId, root.id)))
    .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
  if (!wsnp) {
    [wsnp] = await db.insert(schema.tracks).values({
      title: WSNP_TITLE, status: "open", parentTrackId: root.id,
      branchesAtStopId: start.id, mergesAtStopId: goal.id, note: WSNP_NOTE,
    }).returning();
    created.wsnpTrack = true;
  }

  // One synthetic stop per stage that has NO stop at all — never per stage that
  // has no SYNTHETIC stop. A stage Martin has already written down is complete,
  // and adding a filler beside it would duplicate a station on the strip. Same
  // rule as the migration's FOREACH loop.
  const wsnpStops = await db.select().from(schema.stops)
    .where(eq(schema.stops.trackId, wsnp.id));
  for (const [i, { stage, title }] of WSNP_STAGE_SEED.entries()) {
    if (wsnpStops.some((s) => s.stage === stage)) continue;
    await db.insert(schema.stops).values({
      trackId: wsnp.id, orderIndex: (i + 1) * 100, title,
      kind: "process", state: "expected", stage,
    });
    created.stageStops.push(stage);
  }

  return created;
}

// `pnpm --filter @verder/db seed-map` — puts the skeleton back after a suite
// (or a hand) has truncated it away. Idempotent, so running it on a healthy
// database is a no-op that prints zeros.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL
    ?? "postgres://verder:verder@localhost:5432/verder";
  const { db, pool } = createDb(url);
  try {
    const created = await ensureCaseMap(db);
    console.log("ensureCaseMap:", JSON.stringify(created));
  } finally {
    await pool.end();
  }
}
