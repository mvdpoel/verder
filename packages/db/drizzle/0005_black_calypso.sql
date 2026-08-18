ALTER TABLE "raw_emails" ADD COLUMN "suggest_queued_at" timestamp with time zone;--> statement-breakpoint
-- Existing rows predate the outbox marker; treat them as already enqueued so
-- the poller does not re-enqueue (and possibly duplicate) old suggestions.
UPDATE "raw_emails" SET "suggest_queued_at" = "fetched_at";--> statement-breakpoint
-- raw_emails stays append-only for the worker except for this bookkeeping column.
GRANT UPDATE ("suggest_queued_at") ON "raw_emails" TO verder_worker;