-- Additive and defaulted: every existing row is Gmail-sourced, and its
-- gmail_message_id stays exactly as it is. That column is also
-- documents.source_ref and the case map's third level derives from it, so it
-- is never rewritten — only labelled.
ALTER TABLE "raw_emails" ADD COLUMN "source" text DEFAULT 'gmail' NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_emails" ADD CONSTRAINT "raw_emails_source_check" CHECK ("raw_emails"."source" IN ('gmail', 'jmap'));