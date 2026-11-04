-- Vraag Grip, the follow-through the final Figma frames decided (2026-11-04):
-- what Martin does AFTER an answer arrives. Additive and nullable; no grant
-- changes (the app already holds UPDATE on `requests`, 0044).
--
--   title         the answer's short subject ("Boedelbeschrijving Noordkust"),
--                 written by requests-store from the model's answer. NULL until
--                 answered; the phone falls back to the attached item's label,
--                 then to Martin's own words.
--   headline      the outcome in one line ("Er ontbreken twee dingen"), the
--                 answer screen's title. NULL until answered.
--   steps_done    Martin's ticks on "Wat jij nog moet doen": {"<index>": iso}.
--                 An index into martin_steps, which the worker writes once and
--                 never again, so an index is stable. Untick removes the key.
--   dismissed_at  "Laat maar": the request leaves Voor jou (and stops counting)
--                 and stands under Eerdere vragen; a pending proposal it carried
--                 is RELEASED as a standalone Voor jou row. Cleared by the undo.
--
-- NOT EVIDENCE, as 0044: no ledger event for any of these. A ticked step is
-- Martin's own note about work he did outside Grip; nothing in the dossier
-- changes because of it.
--
-- ORDERING TRAP (the same one 0020–0044 carry): rsync, migrate from the
-- homelab HOST, THEN rebuild web+worker. loadWaiting selects these columns, so
-- a web image with this code 500s every Voor jou load (and zeroes the badge
-- sync) until the migration has run.
ALTER TABLE "requests" ADD COLUMN "title" text CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 120);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "headline" text CHECK ("headline" IS NULL OR char_length("headline") BETWEEN 1 AND 160);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "steps_done" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "dismissed_at" timestamp with time zone;
