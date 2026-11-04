-- Vraag Grip (spec docs/superpowers/specs/2026-11-04-vraag-grip-design.md):
-- a request in Martin's own words, researched on the homelab HOST by `claude -p`
-- with a read-only tool server, answered in the app, and — when it needs a
-- mail — turned into an ordinary proposal that he approves behind Face ID.
--
-- Additive. Nothing is dropped except two CHECK constraints on `proposals`,
-- each re-added WIDER in the same migration (a new kind, a new trigger).
--
-- NOT EVIDENCE. A request appends no ledger event, here or anywhere. The golden
-- rule is kept on the row instead: the request, the prompt and its version, the
-- model, every tool call with a hash of its result (`tool_log`), the raw model
-- output and the stored answer. A proposal it creates is a `pending` proposal
-- like any other, and a SENT one still writes its `entry.created` as today.
--
-- Grants: the web app creates a request, cancels it and marks it opened
-- (SELECT, INSERT, UPDATE); the worker claims, logs tool calls and stores the
-- answer (SELECT, INSERT, UPDATE). NO DELETE for either role: a request is a
-- record of what Martin asked and what Grip answered.
--
-- ORDERING TRAP (the same one 0020–0043 carry): rsync, migrate from the
-- homelab HOST, THEN rebuild web+worker. A web image with this code 500s every
-- Voor jou load on `relation "requests" does not exist` (loadWaiting reads it),
-- which also zeroes the badge sync — so the migration must land first.
CREATE TABLE "requests" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The phone's idempotency key: a retry after a lost response finds the row.
  "client_id"         uuid NOT NULL UNIQUE,
  -- "Vraag door": a follow-up in the same thread.
  "parent_request_id" uuid REFERENCES "requests"("id"),
  "text"              text NOT NULL CHECK (char_length("text") BETWEEN 1 AND 4000),
  -- What it is about, at most one of {rawEmailId|documentId|partyId|stopId|taskId}.
  "about"             jsonb,
  "status"            text DEFAULT 'queued' NOT NULL CHECK ("status" IN (
                        'queued', 'working', 'answered', 'failed', 'cancelled')),
  "answer"            text,
  "sources"           jsonb DEFAULT '[]'::jsonb NOT NULL,
  "martin_steps"      jsonb DEFAULT '[]'::jsonb NOT NULL,
  "proposal_id"       uuid REFERENCES "proposals"("id"),
  "prompt"            text,
  "prompt_version"    text,
  "model"             text,
  "model_output"      text,
  -- [{tool, args, resultSha256, ids, ms, at}], appended by grip-tools per call.
  "tool_log"          jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error"             text,
  "opened_at"         timestamp with time zone,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at"        timestamp with time zone,
  "answered_at"       timestamp with time zone,
  "updated_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "requests_answered_ck" CHECK ("status" <> 'answered' OR ("answer" IS NOT NULL AND "answered_at" IS NOT NULL)),
  CONSTRAINT "requests_working_ck" CHECK ("status" <> 'working' OR "claimed_at" IS NOT NULL),
  CONSTRAINT "requests_no_self_parent_ck" CHECK ("parent_request_id" IS DISTINCT FROM "id")
);
--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "requests_parent_idx" ON "requests" ("parent_request_id");
--> statement-breakpoint

-- The proposal a request creates names it as its trigger. One per request.
ALTER TABLE "proposals" ADD COLUMN "trigger_request_id" uuid REFERENCES "requests"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_request_trigger_uq" ON "proposals" ("trigger_request_id")
  WHERE "trigger_request_id" IS NOT NULL;
--> statement-breakpoint
-- `compose`: a new mail, not a reply. It goes through the SAME approval and
-- `proposal-send` path; with no thread it simply carries no In-Reply-To.
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_kind_check";
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_kind_check"
  CHECK ("kind" IN ('reply', 'question', 'follow-up', 'compose'));
--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_has_trigger_ck";
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_has_trigger_ck" CHECK (num_nonnulls(
  "trigger_raw_email_id", "trigger_document_id", "trigger_task_id",
  "trigger_external", "parent_proposal_id", "trigger_request_id") >= 1);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "requests" TO grip_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "requests" TO grip_worker;
