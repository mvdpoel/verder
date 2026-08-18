CREATE TYPE "public"."action_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('call', 'meeting', 'email', 'whatsapp', 'voicemail', 'letter', 'other');--> statement-breakpoint
CREATE TYPE "public"."clarity" AS ENUM('clear', 'ambiguous', 'already-provided');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."doc_source" AS ENUM('upload', 'nas-scan', 'email-attachment');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('inbox', 'filed');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('manual', 'gmail-watch', 'nas-watch');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('person', 'organization');--> statement-breakpoint
CREATE TYPE "public"."suggestion_kind" AS ENUM('log-entry', 'document-meta');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'approved', 'edited', 'rejected', 'needs-manual');--> statement-breakpoint
CREATE TABLE "action_item_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_item_id" uuid NOT NULL,
	"status" "action_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"owner_party_id" uuid,
	"description" text NOT NULL,
	"due_at" timestamp with time zone,
	"clarity" "clarity" DEFAULT 'clear' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"status" "doc_status" NOT NULL,
	"title" text,
	"doc_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"title" text NOT NULL,
	"doc_type" text,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"source" "doc_source" NOT NULL,
	"source_ref" text,
	"status" "doc_status" DEFAULT 'inbox' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "entry_documents" (
	"entry_id" uuid NOT NULL,
	"document_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_participants" (
	"entry_id" uuid NOT NULL,
	"party_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"event_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_event_hash_unique" UNIQUE("event_hash")
);
--> statement-breakpoint
CREATE TABLE "log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" "channel" NOT NULL,
	"direction" "direction" NOT NULL,
	"summary" text NOT NULL,
	"details" text,
	"source" "entry_source" NOT NULL,
	"source_ref" text,
	"supersedes_id" uuid,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "party_kind" NOT NULL,
	"name" text NOT NULL,
	"organization" text,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"subject" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"raw_rfc822_sha256" text NOT NULL,
	"body_text" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_emails_gmail_message_id_unique" UNIQUE("gmail_message_id")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "suggestion_kind" NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"raw_email_id" uuid,
	"document_id" uuid,
	"model" text,
	"prompt_version" text,
	"proposed" jsonb,
	"final_payload" jsonb,
	"result_entry_id" uuid,
	"verdict_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_item_status_changes" ADD CONSTRAINT "action_item_status_changes_action_item_id_action_items_id_fk" FOREIGN KEY ("action_item_id") REFERENCES "public"."action_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_entry_id_log_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_owner_party_id_parties_id_fk" FOREIGN KEY ("owner_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_status_changes" ADD CONSTRAINT "document_status_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_documents" ADD CONSTRAINT "entry_documents_entry_id_log_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_documents" ADD CONSTRAINT "entry_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_participants" ADD CONSTRAINT "entry_participants_entry_id_log_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_participants" ADD CONSTRAINT "entry_participants_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_raw_email_id_raw_emails_id_fk" FOREIGN KEY ("raw_email_id") REFERENCES "public"."raw_emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entry_doc_uq" ON "entry_documents" USING btree ("entry_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_party_uq" ON "entry_participants" USING btree ("entry_id","party_id");--> statement-breakpoint
CREATE INDEX "ledger_entity_idx" ON "ledger_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entries_occurred_idx" ON "log_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "worker_runs_idx" ON "worker_runs" USING btree ("worker","ran_at");