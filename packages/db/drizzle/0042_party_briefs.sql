-- Grip for iPhone (Added 2026-11-03, Martin): talking points during a call.
-- The phone shows what to TELL and what to ASK a party, derived on read from
-- the dossier, plus ONE AI line — "what they last asked / where it stands" —
-- drafted on the homelab HOST by `claude -p` (ops/proposal-drafter.sh), never
-- in a web request and never by Ollama. This table holds that line.
--
-- NOT EVIDENCE. A brief appends no ledger event, here or anywhere: it is a
-- display aid that is rebuilt whenever the party writes again. The golden rule
-- is kept on the row instead — the context the worker assembled, the exact
-- prompt, the raw model output, the model and the prompt version — and the
-- store step refuses any answer citing an id that is not in that context.
--
-- Grants: the web app only READS (the route shows status = 'ready' only); the
-- worker marks a party pending on ingest (INSERT … ON CONFLICT DO UPDATE) and
-- stores the drafter's answer (UPDATE). NO DELETE for either role: a brief is
-- overwritten by the next draft and never removed.
--
-- One row per party — `party_id` IS the key, so a second mail from the same
-- party re-marks the existing row rather than queueing a second draft.
--
-- ORDERING TRAP (the same one 0020–0041 carry): migrate from the homelab HOST
-- BEFORE rebuilding web+worker. A worker image with this code ingests a mail
-- from a known party and fails the WHOLE ingest transaction on `relation
-- "party_briefs" does not exist` — the mail is then retried every poll and
-- never lands — and the web's talking-points route 500s.
CREATE TYPE "public"."party_brief_status" AS ENUM('pending', 'drafting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "party_briefs" (
  "party_id"       uuid PRIMARY KEY NOT NULL REFERENCES "parties"("id"),
  "status"         "party_brief_status" DEFAULT 'pending' NOT NULL,
  "summary"        text,
  "context"        jsonb,
  "prompt"         text,
  "model"          text,
  "prompt_version" text,
  "model_output"   text,
  "source_refs"    jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error"          text,
  "requested_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "generated_at"   timestamp with time zone,
  "updated_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "party_briefs_ready_ck" CHECK ("status" <> 'ready' OR ("summary" IS NOT NULL AND "generated_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "party_briefs_status_idx" ON "party_briefs" ("status");--> statement-breakpoint
GRANT SELECT ON "party_briefs" TO grip_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "party_briefs" TO grip_worker;
