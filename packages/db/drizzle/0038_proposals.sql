-- verder for iPhone, slice 5 (spec §6.5, §12.3): proposals — something verder
-- wants Martin to approve — and a log-entry source for the mail verder sends.
--
-- Additive. Nothing is dropped, and no grant on an evidence table is weakened.
--
-- ORDERING TRAP (the same one 0020–0037 carry, with a worse failure): migrate
-- from the homelab HOST BEFORE rebuilding web+worker. An image that writes
-- `source = 'proposal'` before this migration runs fails EVERY send with
-- `invalid input value for enum entry_source` — and it fails AFTER Gmail has
-- already accepted the message, because the outbound entry is written only
-- once the send is known to have gone. Recovery would then find the message in
-- Sent and fail the same way, leaving a mail that went out with no logbook
-- entry. Nothing below USES the new value, and nothing may: drizzle applies
-- pending migrations in one transaction, and Postgres refuses a value added by
-- ALTER TYPE … ADD VALUE until that transaction has committed.
ALTER TYPE "public"."entry_source" ADD VALUE 'proposal';
--> statement-breakpoint

-- A PROPOSAL IS NOT EVIDENCE (spec §6.5) and appends NO ledger event. What is
-- evidence is what happens on approval: a sent mail becomes an outbound log
-- entry through insertEntry, with its `entry.created` event and
-- source_ref = 'proposal:<id>'. The row keeps the golden-rule record — model
-- output, verdict, diff — which is why `verdict` is separate from `status`:
-- the lifecycle says where the proposal is, the verdict says what Martin
-- thought of the draft.
CREATE TABLE "proposals" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind"                 text NOT NULL CHECK ("kind" IN ('reply', 'question', 'follow-up')),
  -- §12.3: approved → sending → sent | failed. `sending` is entered in the
  -- same transaction that stores message_id, so a crash after Gmail accepted
  -- the message is recovered by asking Gmail for it — never by re-sending.
  "status"               text NOT NULL CHECK ("status" IN (
                           'drafting', 'draft-failed', 'pending', 'approved',
                           'sending', 'sent', 'failed', 'rejected', 'superseded')),
  "verdict"              text CHECK ("verdict" IN ('approved', 'edited', 'rejected')),
  "priority"             text NOT NULL CHECK ("priority" IN ('verder', 'creditor', 'other')),
  "trigger_raw_email_id" uuid REFERENCES "raw_emails"("id"),
  "trigger_document_id"  uuid REFERENCES "documents"("id"),
  "trigger_task_id"      uuid REFERENCES "tasks"("id"),
  -- The mail agent's non-dossier message: {gmailId, threadId, messageId, from,
  -- to, subject, date, body}. Watchlist mail stays out of the dossier unless
  -- Martin files it, so it has no raw_emails row to point at.
  "trigger_external"     jsonb,
  -- A follow-up's trigger when the last outbound in the thread is a sent proposal.
  "parent_proposal_id"   uuid REFERENCES "proposals"("id"),
  -- `gmail:<gmail_thread_id>` for source='gmail' rows, NULL otherwise. JMAP
  -- thread ids are a different namespace, so archive threads never get a clock.
  "thread_key"           text,
  -- NULL is legal (a letter, an external mail with no party); the outbound
  -- entry then has no participant.
  "party_id"             uuid REFERENCES "parties"("id"),
  -- For a letter trigger: {kind:'verder'} or {kind:'creditor', partyId}, an
  -- OCR guess shown as unconfirmed (§12.5). NULL for mail.
  "sender_guess"         jsonb,
  "created_task_id"      uuid REFERENCES "tasks"("id"),
  -- finishSent failures AFTER Gmail accepted the message: the poison guard that
  -- stops recovery calling Gmail forever on a row it cannot commit.
  "finish_failures"      integer DEFAULT 0 NOT NULL,
  -- The assembled context, including every id the drafter may cite. Validation
  -- checks recipients, documents, tasks and debts against THIS, never against
  -- what the model claims.
  "context"              jsonb NOT NULL,
  "prompt"               text,
  "model"                text,
  "prompt_version"       text,
  "model_output"         text,
  "payload"              jsonb,
  "final_payload"        jsonb,
  "diff"                 jsonb,
  -- Approve carries the revision it saw, so an approval of text that changed
  -- underneath it is refused.
  "revision"             integer DEFAULT 1 NOT NULL,
  "decided_at"           timestamp with time zone,
  "decided_by"           uuid REFERENCES "users"("id"),
  "reject_reason"        text,
  -- The RFC 5322 Message-ID, generated BEFORE the send. UNIQUE: it is how
  -- recovery recognises the message in Sent, and two proposals must never
  -- claim one message.
  "message_id"           text UNIQUE,
  "gmail_message_id"     text,
  "gmail_thread_id"      text,
  "sending_at"           timestamp with time zone,
  "sent_at"              timestamp with time zone,
  "error"                text,
  "reminded_at"          timestamp with time zone,
  "result_entry_id"      uuid REFERENCES "log_entries"("id"),
  "created_at"           timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"           timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "proposals_has_trigger_ck" CHECK (num_nonnulls(
    "trigger_raw_email_id", "trigger_document_id", "trigger_task_id",
    "trigger_external", "parent_proposal_id") >= 1)
);
--> statement-breakpoint

-- ONE proposal per raw-email trigger, keyed on the trigger ALONE and not on
-- (trigger, kind): a row created as `reply` may become `question` when the
-- drafter answers with one, and a (trigger, kind) key would then let an
-- at-least-once suggest.entry retry insert a second `reply` beside it.
-- Follow-ups are exempt: a thread can be chased more than once.
CREATE UNIQUE INDEX "proposals_trigger_uq" ON "proposals" ("trigger_raw_email_id")
  WHERE "trigger_raw_email_id" IS NOT NULL AND "kind" <> 'follow-up';
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_doc_trigger_uq" ON "proposals" ("trigger_document_id")
  WHERE "trigger_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" ("status");
--> statement-breakpoint
CREATE INDEX "proposals_thread_key_idx" ON "proposals" ("thread_key");
--> statement-breakpoint

-- FULL CRUD for both roles, deliberately: proposals are not evidence (spec
-- §6.5). The golden-rule record lives here, and the evidence of a send is the
-- ledgered outbound entry, whose table keeps SELECT, INSERT only.
-- NOTE the FKs to raw_emails, documents, tasks and log_entries mean
-- verify.test.ts's `TRUNCATE … CASCADE` wipes proposals too. That is harmless:
-- nothing seeds it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "proposals" TO verder_app, verder_worker;
