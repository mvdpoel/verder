-- verder for iPhone (Added 2026-11-03, Martin): talking points during a call —
-- the HISTORY of the AI line. `party_briefs` (0042) holds one row per party and
-- every redraft overwrites its context, prompt, prompt version, model and model
-- output; `markBriefPending` re-marks that row on every new mail from the
-- party, so the next mail destroyed every earlier model output, a forged-id
-- refusal included. The golden rule says the model suggestion and its verdict
-- are ALWAYS recorded, so each attempt is also APPENDED here, one row per
-- answer (or per drafter failure), with the context and exact prompt it
-- answered. `party_briefs` stays the current pointer and status.
--
-- Verdicts: `ready` (passed validateBrief and became the current brief),
-- `refused` (validateBrief said no — e.g. a cited id not in the context),
-- `failed` (the host drafter got no answer: claude exited non-zero, timed out),
-- `late` (an answer that arrived after a newer mail re-marked the brief; kept
-- as said, with NO context or prompt, because the row's may already belong to
-- a newer claim).
--
-- NOT EVIDENCE: no ledger event. But APPEND-ONLY: the worker — the only
-- writer — holds SELECT and INSERT and nothing else; the web app holds nothing
-- (it shows the current brief from party_briefs only).
--
-- ORDERING TRAP (the same one 0020–0042 carry): migrate from the homelab HOST
-- BEFORE rebuilding the worker. A worker image with this code fails EVERY
-- `briefs-store` call on `relation "party_brief_drafts" does not exist` inside
-- the store transaction, so no brief ever turns ready and the drafter's answers
-- are lost (only the `party-brief` run row records the error).
CREATE TYPE "public"."party_brief_verdict" AS ENUM('ready', 'refused', 'failed', 'late');--> statement-breakpoint
CREATE TABLE "party_brief_drafts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "party_id"       uuid NOT NULL REFERENCES "parties"("id"),
  "verdict"        "party_brief_verdict" NOT NULL,
  "summary"        text,
  "context"        jsonb,
  "prompt"         text,
  "prompt_version" text,
  "model"          text,
  "model_output"   text,
  "source_refs"    jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error"          text,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "party_brief_drafts_ready_ck" CHECK ("verdict" <> 'ready' OR ("summary" IS NOT NULL AND "model_output" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "party_brief_drafts_party_idx" ON "party_brief_drafts" ("party_id", "created_at");--> statement-breakpoint
GRANT SELECT, INSERT ON "party_brief_drafts" TO verder_worker;
