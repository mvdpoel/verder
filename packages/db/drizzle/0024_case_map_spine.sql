-- The main line's own stations: how the bewindvoering itself runs.
--
-- 0023 seeded the spine with only its two anchors — Start and the goal — plus
-- whatever curated key events it copied in. That leaves the road to Einde
-- bewindvoering with no stations of its own, so the two facts that actually
-- shape the case are missing: that Martin APPLIED for bewindvoering, and that
-- he is IN it. Both belong on the main line, because the main line is the goal.
--
-- Data only. No schema change, no ledger event, nothing here is evidence —
-- stops is an editable display aid exactly as it was in 0023.
--
-- 0023 is already applied in production, which is why this is a new migration
-- and not an edit to that one. The same two stops are created by
-- ensureCaseMap() in packages/db/src/seed-case-map.ts; the two remain two
-- spellings of ONE seed and must be changed together.
--
-- DATES ARE DELIBERATELY EMPTY. Nobody recorded when the bewindvoering was
-- applied for or when it started, and this migration will not invent them —
-- the same rule that keeps the Start anchor undated. The map is laid out
-- structurally, so an undated station costs nothing; Martin fills them in the
-- editor if and when he wants to.
DO $$
DECLARE
  root_id uuid;
BEGIN
  SELECT id INTO root_id FROM tracks WHERE parent_track_id IS NULL;
  -- A database whose map was never seeded (or was truncated away) has nothing
  -- to add stations to. ensureCaseMap is how it comes back; this stays quiet.
  IF root_id IS NULL THEN
    RAISE NOTICE '0024: no root track, skipping — run pnpm --filter @verder/db seed-map';
    RETURN;
  END IF;

  -- Make room between Start (0) and the goal (1000000). 0023 copied the
  -- curated key events in at 1..n, which leaves no integer gap for two
  -- stations in front of them, and those events are chronologically LATER than
  -- both of them anyway: the WSNP ontvangstbevestiging of 16-04-2026 arrived
  -- long after the bewind began.
  UPDATE stops SET order_index = order_index + 300
   WHERE track_id = root_id AND order_index > 0 AND order_index < 1000000;

  -- Guarded on title so re-running against a database that already has them is
  -- a no-op, matching ensureCaseMap's contract.
  INSERT INTO stops (track_id, order_index, title, kind, state)
  SELECT root_id, 100, 'Aanvraag bewindvoering', 'process', 'done'
   WHERE NOT EXISTS (SELECT 1 FROM stops
                      WHERE track_id = root_id AND title = 'Aanvraag bewindvoering');

  -- "loopt nog", not "gebeurd": the bewindvoering is the period Martin is in,
  -- not a thing that finished. It therefore reads as the furthest-right open
  -- stop until a side track carries one further along — at which point that
  -- one takes over "waar het nu op wacht", which is the intent.
  INSERT INTO stops (track_id, order_index, title, kind, state)
  SELECT root_id, 200, 'bewindvoering', 'process', 'open'
   WHERE NOT EXISTS (SELECT 1 FROM stops
                      WHERE track_id = root_id AND title = 'bewindvoering');
END $$;
