import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

/**
 * The seed of Martin's case map, as an IDEMPOTENT function.
 *
 * TWO SPELLINGS OF ONE SEED. `drizzle/0023_timeline_tracks.sql`, amended by
 * 0024 and reshaped by `drizzle/0026_vertical_case_timeline.sql`, is the other,
 * and the two must agree on every title and order_index here. The difference in
 * scope is deliberate: the migrations ALSO move and delete the rows the map
 * already had, which is a one-time data migration and must never be repeated.
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
 * The spine, as the case actually ran — aanmelding, de gang naar de rechtbank,
 * de beschikking, de opstart.
 *
 * This REVERSES the bare-trunk rule ("a metro map's trunk shows where the line
 * goes, not every errand run along it"). That rule was right for a horizontal
 * map aimed at `Einde bewindvoering`. Migration 0026 deletes that goal, so the
 * root has nothing left to aim at: it is no longer a destination, it is the
 * spine of the story so far, and it has to carry that story.
 *
 * Undated here on purpose — this function only puts the SKELETON back after a
 * truncation. The dates live in the migration and in case-history's seed, and
 * `case-history` only ever dates a stop whose happened_at is still NULL, so a
 * date typed by hand always wins.
 */
const SPINE_SEED = [
  { title: "Aanmelding bij Verder", orderIndex: 100 },
  { title: "Intakegesprek bewindvoering", orderIndex: 200 },
  { title: "Ondernemingen uitgeschreven bij de KvK", orderIndex: 300 },
  { title: "Verzoek onderbewindstelling ingediend", orderIndex: 400 },
  { title: "Poststukken ingeleverd", orderIndex: 500 },
  { title: "Rechtbank vraagt een verklaring", orderIndex: 600 },
  { title: "Verklaring ontstaan schulden aangeleverd", orderIndex: 700 },
  { title: "Beschikking: onder bewind gesteld", orderIndex: 800 },
  { title: "Dossier naar Team Opstart", orderIndex: 900 },
  { title: "Team Opstart vraagt de opstartstukken", orderIndex: 1000 },
  { title: "Heen en weer over de bestandsformaten", orderIndex: 1100 },
  { title: "Opstart van het dossier afgerond", orderIndex: 1200 },
  { title: "Stukken opgevraagd door Regio 3", orderIndex: 1300 },
  { title: "Regio 3 vraagt de laatste drie loonstroken", orderIndex: 1400 },
  { title: "Stukken aanleveren", orderIndex: 1500 },
] as const satisfies readonly { title: string; orderIndex: number }[];

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
      kind: "process", state: "done",
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
