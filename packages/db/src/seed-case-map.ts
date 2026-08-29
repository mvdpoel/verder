import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

/** Amsterdam wall-clock → instant, pinned to noon — the same convention
 *  `SPINE_SEED` in apps/worker/src/ops/case-history.ts uses, so the two agree
 *  on the instant and not just the calendar day. */
const at = (iso: string) => new Date(`${iso}T12:00:00+02:00`);

/**
 * The seed of Martin's case map, as an IDEMPOTENT function.
 *
 * TWO SPELLINGS OF ONE SEED. `drizzle/0023_timeline_tracks.sql`, amended by
 * 0024 and reshaped by `drizzle/0026_vertical_case_timeline.sql`, is the other,
 * and the two must agree on every title, order_index and happened_at here.
 * The difference in scope is deliberate: the migrations ALSO move and delete
 * the rows the map already had, which is a one-time data migration and must
 * never be repeated.
 * This function only puts back the SKELETON: the root track and its spine.
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
const ROOT_TITLE = "Bewindvoering";
const ROOT_NOTE = "De hoofdlijn: hoe de bewindvoering zelf is gelopen.";

/**
 * The spine: the bewindvoering itself, plus every moment something new landed.
 *
 * Migration 0026 deleted the goal stop, so the root is no longer a destination
 * — it is the story so far. And a spoor is ONE EPISODE: something arrives (the
 * trigger, which belongs HERE, on the hoofdlijn) and everything done in
 * response hangs off it until the matter closes, however many parties are
 * involved. So these seven are the aanmelding, the beschikking that answered
 * it, the handover, and the four moments something arrived — Team Opstart's
 * request, the deurwaarder at the door, the bank account taken over, and Regio
 * 3's request. The answering of each lives on the spoor that answers it.
 *
 * That is Martin's own reading of his case; the long version, with what it
 * corrects, is on `SPINE_SEED` in apps/worker/src/ops/case-history.ts.
 *
 * DATED, not undated: every stop on the trunk has happened, and `writeStop`
 * never touches `happened_at` on a stop that already exists, so writing it
 * here only ever fills in a gap left by a truncation — it can never overwrite
 * a date typed by hand. Undated used to be the rule ("this function only puts
 * the SKELETON back"), but that reasoning stopped applying the moment the spine
 * stopped being a skeleton and became the story so far (see above): a
 * truncate-and-reseed with no dates here rendered the whole hoofdlijn under
 * "Zonder datum" until `case-history` next ran. The dates below are read from
 * `SPINE_SEED` in apps/worker/src/ops/case-history.ts — never retyped — using
 * the same noon-Amsterdam convention (`at`, above) so the two agree on the
 * instant, not just the calendar day.
 *
 * EXPORTED so it can be diffed against `SPINE_SEED` in
 * apps/worker/src/ops/case-history.ts, which is the third spelling of this one
 * seed. The two must name the same stops in the same order with the same
 * dates: `writeStop` never changes `state` or `title` on a stop that already
 * exists, so a title only one of them knows is a stop only one of them
 * creates, and 0026's deletes come undone the next time the other one runs.
 * case-history.test.ts asserts it.
 */
export const SPINE_SEED = [
  { title: "Aanmelding bij Verder", orderIndex: 100, happenedAt: at("2026-04-16") },
  { title: "Beschikking: onder bewind gesteld", orderIndex: 200, happenedAt: at("2026-07-14") },
  { title: "Dossier naar Team Opstart", orderIndex: 300, happenedAt: at("2026-07-20") },
  { title: "Team Opstart vraagt de opstartstukken", orderIndex: 400, happenedAt: at("2026-07-27") },
  { title: "Deurwaarder zegt de ontruiming aan", orderIndex: 500, happenedAt: at("2026-07-29") },
  { title: "Rekening overgenomen zonder aankondiging", orderIndex: 600, happenedAt: at("2026-08-05") },
  { title: "Stukken opgevraagd door Regio 3", orderIndex: 700, happenedAt: at("2026-08-12") },
] as const satisfies readonly { title: string; orderIndex: number; happenedAt: Date }[];

export type EnsureCaseMapResult = {
  rootTrack: boolean;
  /** The main-line stations that were missing and got put back. */
  spineStops: string[];
};

export async function ensureCaseMap(db: Db): Promise<EnsureCaseMapResult> {
  const created: EnsureCaseMapResult = { rootTrack: false, spineStops: [] };

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

  // The main line's own stations. Guarded on title, like everything else here,
  // so a database that already has them is left alone.
  for (const station of SPINE_SEED) {
    if (await stopOnRoot(station.title)) continue;
    await db.insert(schema.stops).values({
      trackId: root.id, orderIndex: station.orderIndex, title: station.title,
      kind: "process", state: "done", happenedAt: station.happenedAt,
    });
    created.spineStops.push(station.title);
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
