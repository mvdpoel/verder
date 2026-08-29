-- The case map goes vertical: newest at the top, oldest at the bottom, history
-- and the current situation only.
--
-- This is the ONLY migration in this project that deletes a row from `stops` or
-- `tracks`. It runs as the `verder` admin role. The app and worker grants are
-- unchanged: they keep SELECT, INSERT, UPDATE and no DELETE, and restructuring
-- through those roles stays rename-and-move forever.
--
-- Nothing here is evidence. No ledger event is appended, and `nightly-verify`
-- must report the chain head UNCHANGED after this runs.

-- 0. The check 0023 installed says a child track MUST name a branch point:
--    CHECK ((parent_track_id IS NULL) = (branches_at_stop_id IS NULL)).
--    Step 1 below nulls exactly those pointers, so the check has to go first or
--    the UPDATE is refused. It is no longer a truth about the model either:
--    branch geometry is date-driven from here on, the pointer is semantic only,
--    and NULL is the honest value for a spoor whose origin nobody recorded.
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS track_branch_root_ck;
--> statement-breakpoint

-- 1. Pointers first: these are FKs into `stops`, and the deletes below fail
--    while any of them still points at a row that is about to go.
UPDATE tracks SET branches_at_stop_id = NULL, merges_at_stop_id = NULL
 WHERE parent_track_id IS NOT NULL;
--> statement-breakpoint

-- Deliberately NOT rewired to a nearest preceding spine stop. Branch geometry
-- is date-driven now, so the pointer is semantic only: it means "this spoor
-- came out of THAT event". Guessing one would be the app inventing a fact about
-- Martin's case. NULL says "no recorded origin", which is true, and the editor
-- lets him set one when he knows.

-- 2. The spine absorbs the bewindvoering story. Both tracks' stops move onto
--    the root and are renumbered in date order, gaps of 100 so the editor can
--    insert without a renumber.
DO $$
DECLARE
  root_id uuid;
  s record;
  ix int := 100;
BEGIN
  SELECT id INTO root_id FROM tracks WHERE parent_track_id IS NULL;
  IF root_id IS NULL THEN
    RAISE NOTICE '0026: no root track, skipping — run pnpm --filter @verder/db seed-map';
    RETURN;
  END IF;

  FOR s IN
    SELECT st.id FROM stops st JOIN tracks t ON t.id = st.track_id
     WHERE t.title IN ('Aanvraag bewindvoering', 'Opstart en stukken')
       AND st.state <> 'expected'
     ORDER BY st.happened_at NULLS LAST, st.order_index
  LOOP
    UPDATE stops SET track_id = root_id, order_index = ix WHERE id = s.id;
    ix := ix + 100;
  END LOOP;
END $$;
--> statement-breakpoint

-- 3. Remember what is about to go, so the search index can be cleaned by id.
CREATE TEMP TABLE gone_stops AS
  SELECT id FROM stops
   WHERE state = 'expected'
      OR (title IN ('Start', 'Aanvraag bewindvoering', 'bewindvoering')
          AND track_id = (SELECT id FROM tracks WHERE parent_track_id IS NULL));
--> statement-breakpoint

CREATE TEMP TABLE gone_tracks AS
  SELECT id FROM tracks
   WHERE title IN ('Aanvraag bewindvoering', 'Opstart en stukken', 'WSNP')
     AND parent_track_id IS NOT NULL;
--> statement-breakpoint

-- 4. The deletes.
--
--  * every `state = 'expected'` stop: WSNP x6, Schuldregeling 300-600 x4,
--    Opstart's "Aanvragen ingediend bij de gemeente", and the root's goal
--    "Einde bewindvoering";
--  * "Start", undated pre-history — the map now begins at the aanmelding;
--  * the root's "Aanvraag bewindvoering" (24-04) and "bewindvoering" (14-07),
--    which are the same two events as the spine's "Verzoek onderbewindstelling
--    ingediend" and "Beschikking: onder bewind gesteld".
DELETE FROM stops WHERE id IN (SELECT id FROM gone_stops);
--> statement-breakpoint
DELETE FROM tracks WHERE id IN (SELECT id FROM gone_tracks);
--> statement-breakpoint

-- 5. The root has no goal to run to any more, so its old name describes nothing.
UPDATE tracks SET title = 'Bewindvoering',
       note = 'De hoofdlijn: hoe de bewindvoering zelf is gelopen.'
 WHERE parent_track_id IS NULL;
--> statement-breakpoint

-- 6. Orphaned index rows. `reindex --prune` CANNOT do this: it walks the live
--    entities of each type in SEARCH_ENTITY_TYPES and never visits an id that
--    no longer exists. Same shape of trap 0023 documented for the retired
--    `milestone` and `timeline_event` kinds, one level down.
DELETE FROM search_chunks
 WHERE (entity_type = 'stop'  AND entity_id IN (SELECT id FROM gone_stops))
    OR (entity_type = 'track' AND entity_id IN (SELECT id FROM gone_tracks));
--> statement-breakpoint
DELETE FROM search_outbox
 WHERE (entity_type = 'stop'  AND entity_id IN (SELECT id FROM gone_stops))
    OR (entity_type = 'track' AND entity_id IN (SELECT id FROM gone_tracks));
--> statement-breakpoint

DROP TABLE gone_stops;
--> statement-breakpoint
DROP TABLE gone_tracks;
--> statement-breakpoint

-- 7. The milestones table held 0 rows in production. Its router, its page and
--    its editor went in the previous commit.
--
--    `timeline_events.milestone_id` is the reason this is three statements and
--    not one: it is a foreign key INTO milestones, so a bare DROP TABLE is
--    refused, and drizzle's own generated `DROP TABLE ... CASCADE` followed by
--    an unguarded `DROP CONSTRAINT` fails on the second statement because the
--    cascade already removed it. Drop the reference first, explicitly.
ALTER TABLE timeline_events
  DROP CONSTRAINT IF EXISTS timeline_events_milestone_id_milestones_id_fk;
--> statement-breakpoint
ALTER TABLE timeline_events DROP COLUMN IF EXISTS milestone_id;
--> statement-breakpoint
DROP TABLE IF EXISTS milestones;
