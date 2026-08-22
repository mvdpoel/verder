-- Timeline tracks (sub-project 6): the case as a metro map.
--
-- tracks + stops REPLACE timeline_events and the milestone model. The main line
-- is the track with no parent; a side track either merges back into its parent
-- (it was a prerequisite for Einde bewindvoering) or it simply ends.
--
-- NEITHER TABLE IS EVIDENCE. Both are editable display aids and append no
-- ledger_events, exactly as timeline_events and milestones already did — the
-- facts stay in log_entries, documents and tasks. /verify is untouched.
--
-- timeline_events and milestones are READ FROM here and then left in place,
-- unread, forever after. Nothing in this project stops reading a table and
-- drops it in the same change; the drop is a later migration, if ever.
CREATE TYPE "public"."track_status" AS ENUM('open', 'done', 'ended');
--> statement-breakpoint
CREATE TYPE "public"."stop_state" AS ENUM('done', 'open', 'expected');
--> statement-breakpoint
CREATE TABLE "tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "status" "public"."track_status" DEFAULT 'open' NOT NULL,
  "parent_track_id" uuid,
  "branches_at_stop_id" uuid,
  "merges_at_stop_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A branch with no parent, or a parent with no branch point, cannot be drawn.
  CONSTRAINT "track_branch_root_ck"
    CHECK (("parent_track_id" IS NULL) = ("branches_at_stop_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stops" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "track_id" uuid NOT NULL,
  "order_index" integer NOT NULL,
  "title" text NOT NULL,
  "kind" "public"."timeline_event_kind" DEFAULT 'other' NOT NULL,
  "state" "public"."stop_state" DEFAULT 'done' NOT NULL,
  "happened_at" timestamp with time zone,
  "expected_at" timestamp with time zone,
  "stage" "public"."wsnp_stage",
  "entry_id" uuid,
  "task_id" uuid,
  "document_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- These four are declared in the drizzle schema, so they carry the names
-- drizzle-kit generated: the snapshot next to this file names them, and a
-- future generated migration that touches one would DROP it by that name.
ALTER TABLE "stops" ADD CONSTRAINT "stops_track_id_tracks_id_fk"
  FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_entry_id_log_entries_id_fk"
  FOREIGN KEY ("entry_id") REFERENCES "public"."log_entries"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id");
--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_document_id_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id");
--> statement-breakpoint
-- tracks and stops reference each other. Both directions are nullable on one
-- side, so the cycle resolves as long as these are added after both tables
-- exist. Verified on PG17 before this migration was written.
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_parent_track_id_fk"
  FOREIGN KEY ("parent_track_id") REFERENCES "public"."tracks"("id");
--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_branches_at_stop_id_fk"
  FOREIGN KEY ("branches_at_stop_id") REFERENCES "public"."stops"("id");
--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_merges_at_stop_id_fk"
  FOREIGN KEY ("merges_at_stop_id") REFERENCES "public"."stops"("id");
--> statement-breakpoint
-- EXACTLY ONE root track, ever. Indexing a constant expression means only one
-- row can satisfy the predicate: a second root is a corrupt map, not a second
-- opinion. Verified on PG17 — the second insert fails on this index.
CREATE UNIQUE INDEX "tracks_single_root_uq" ON "tracks" ((true))
  WHERE "parent_track_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "stops_track_order_idx" ON "stops" ("track_id", "order_index");
--> statement-breakpoint
-- Editable display aids (a typo is a typo), but nothing is ever deleted — the
-- same grant shape milestones and timeline_events carry.
GRANT SELECT, INSERT, UPDATE ON "tracks", "stops" TO verder_app, verder_worker;
--> statement-breakpoint
-- Search outbox triggers, using the function migration 0017 installed.
CREATE OR REPLACE TRIGGER "tracks_search_outbox_trg" AFTER INSERT OR UPDATE ON "tracks"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('track', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "stops_search_outbox_trg" AFTER INSERT OR UPDATE ON "stops"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('stop', 'id');
--> statement-breakpoint
-- A stop's chunk body carries its TRACK's title ("Spoor: WSNP"), read live at
-- index time and never stored on the stop — but the chunk itself is a copy, so
-- renaming a spoor leaves every halte on it indexed under the old name until
-- something touches the stop row. Nothing ever does: stops_search_outbox_trg
-- only fires on stops. This is the same denormalisation trap search_chunks.
-- status already sprang in 0021, and the fix is the same shape: the parent
-- enqueues its children.
--
-- Fires on EVERY update rather than only on a title change. Tracks are
-- hand-authored and rare, search.drain dedupes the outbox, and a WHEN clause
-- naming `title` would silently stop working the day renderStop learns to
-- include another track field.
CREATE OR REPLACE FUNCTION public.search_enqueue_track_stops() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO search_outbox (entity_type, entity_id)
    SELECT 'stop', s.id FROM stops s WHERE s.track_id = NEW.id;
  RETURN NULL; -- AFTER trigger: the return value is ignored
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "tracks_stops_search_outbox_trg" AFTER UPDATE ON "tracks"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue_track_stops();
--> statement-breakpoint
-- The two triggers 0017 installed for the models this sub-project replaces must
-- go, or they poison the index queue forever: 'milestone' and 'timeline_event'
-- are no longer in SEARCH_ENTITY_TYPES, loadAndRender THROWS on an unknown
-- type, and search.drain therefore retries those rows every 60 s and records
-- itself as `error` each time. milestones and timeline_events stay as tables —
-- they are simply no longer indexed.
DROP TRIGGER IF EXISTS "milestones_search_outbox_trg" ON "milestones";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "timeline_events_search_outbox_trg" ON "timeline_events";
--> statement-breakpoint
-- And the rows already queued and already indexed. search_outbox and
-- search_chunks are DERIVED and rebuildable — they hold no facts, only a
-- lookup for facts that live in the evidence tables — so DELETE is allowed
-- here where it would be unthinkable one table over.
--
-- This is the ONLY thing that removes the retired chunks: `reindex --prune`
-- walks SEARCH_ENTITY_TYPES, and a type that is no longer in that tuple is
-- never visited, so prune cannot see them to drop them.
DELETE FROM search_outbox WHERE entity_type IN ('milestone', 'timeline_event');
--> statement-breakpoint
DELETE FROM search_chunks WHERE entity_type IN ('milestone', 'timeline_event');
--> statement-breakpoint
-- Data migration. Order matters: a track cannot branch from or merge into a
-- stop that does not exist yet, so the root's two anchors are written before
-- any child track is.
--
-- order_index leaves room on purpose: the goal anchor sits at 1000000 so every
-- key event copied below slots between the two anchors without a renumber.
--
-- TWO SPELLINGS OF ONE SEED. `ensureCaseMap` in packages/db/src/seed-case-map.ts
-- is the other, and the two must agree on every title, order_index and state
-- below. This one runs once and also COPIES timeline_events and milestones
-- across; that copy is a one-time migration and ensureCaseMap deliberately does
-- not redo it. ensureCaseMap exists because a CASCADE truncate of the evidence
-- tables (packages/api/src/routers/verify.test.ts) takes stops and then tracks
-- with it, and a seed that lives only inside a one-shot migration cannot come
-- back after that.
DO $$
DECLARE
  root_id uuid;
  start_stop_id uuid;
  goal_stop_id uuid;
  wsnp_id uuid;
  next_order integer := 1;
  r record;
  stage_name text;
  stage_title text;
BEGIN
  INSERT INTO tracks (title, status, note)
  VALUES ('Einde bewindvoering', 'open',
          'De hoofdlijn. Alles hier is een stap richting het einde van de bewindvoering.')
  RETURNING id INTO root_id;

  -- The start anchor is DONE — the case is under way — but it carries NO date.
  -- now() here would render "Start · 22-08-2026" as a statement about when
  -- Martin's case began, and the spec forbids exactly that: "Inventing when
  -- things happened in his case would be exactly the kind of assertion this app
  -- refuses to make." It would also be wrong in a second way: every key event
  -- copied below is dated in the past, so a start stamped today makes the
  -- out-of-order detector flag every single migrated stop.
  INSERT INTO stops (track_id, order_index, title, kind, state)
  VALUES (root_id, 0, 'Start', 'process', 'done')
  RETURNING id INTO start_stop_id;

  -- The goal has not happened yet, and the map says so rather than implying it.
  INSERT INTO stops (track_id, order_index, title, kind, state)
  VALUES (root_id, 1000000, 'Einde bewindvoering', 'process', 'expected')
  RETURNING id INTO goal_stop_id;

  -- WSNP is a procedure INSIDE the goal of ending bewindvoering, not the same
  -- road: it runs as its own track and merges back at the end.
  INSERT INTO tracks (title, status, parent_track_id, branches_at_stop_id,
                      merges_at_stop_id, note)
  VALUES ('WSNP', 'open', root_id, start_stop_id, goal_stop_id,
          'De zes fases van de wettelijke schuldsanering.')
  RETURNING id INTO wsnp_id;

  -- Every milestone becomes a stop, in WSNP stage order.
  FOR r IN
    SELECT m.*,
           array_position(enum_range(NULL::wsnp_stage)::text[], m.stage::text) AS pos,
           row_number() OVER (PARTITION BY m.stage ORDER BY m.created_at, m.id) AS n
    FROM milestones m
    ORDER BY array_position(enum_range(NULL::wsnp_stage)::text[], m.stage::text),
             m.created_at, m.id
  LOOP
    INSERT INTO stops (track_id, order_index, title, kind, state, happened_at,
                       expected_at, stage, entry_id, document_id, note)
    VALUES (wsnp_id, r.pos * 100 + r.n::integer, r.title, 'process',
            CASE WHEN r.done THEN 'done'::stop_state ELSE 'open'::stop_state END,
            r.happened_at, r.expected_at, r.stage, r.entry_id, r.document_id, r.note);
  END LOOP;

  -- Any stage Martin has not recorded gets one synthetic expected stop, so the
  -- strip is complete WITHOUT duplicating a stage he already wrote down.
  FOREACH stage_name IN ARRAY enum_range(NULL::wsnp_stage)::text[] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM stops
      WHERE track_id = wsnp_id AND stage::text = stage_name
    ) THEN
      stage_title := CASE stage_name
        WHEN 'application' THEN 'Aanvraag'
        WHEN 'accepted'    THEN 'Toegelaten'
        WHEN 'onboarding'  THEN 'Intake'
        WHEN 'wsnp-start'  THEN 'Start WSNP'
        WHEN 'settlement'  THEN 'Regeling'
        WHEN 'clean-slate' THEN 'Schone lei'
      END;
      INSERT INTO stops (track_id, order_index, title, kind, state, stage)
      VALUES (wsnp_id,
              array_position(enum_range(NULL::wsnp_stage)::text[], stage_name) * 100,
              stage_title, 'process', 'expected', stage_name::wsnp_stage);
    END IF;
  END LOOP;

  -- Every curated key event becomes a stop on the main line, between the anchors.
  FOR r IN SELECT * FROM timeline_events ORDER BY happened_at, id LOOP
    INSERT INTO stops (track_id, order_index, title, kind, state, happened_at,
                       entry_id, document_id, note)
    VALUES (root_id, next_order, r.title, r.kind,
            CASE WHEN r.happened_at <= now() THEN 'done'::stop_state
                 ELSE 'expected'::stop_state END,
            r.happened_at, r.entry_id, r.document_id, r.note);
    next_order := next_order + 1;
  END LOOP;
END $$;
