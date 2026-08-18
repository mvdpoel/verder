CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'quarterly', 'yearly', 'irregular');--> statement-breakpoint
CREATE TYPE "public"."debt_status" AS ENUM('identified', 'acknowledged', 'disputed', 'in-settlement', 'settled');--> statement-breakpoint
CREATE TYPE "public"."discovery_source" AS ENUM('manual', 'bank', 'paypal', 'apple', 'email');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('energy', 'insurance', 'telecom', 'streaming', 'software', 'housing', 'other');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('identified', 'mandatory', 'allowed', 'requested', 'to-cancel', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."payment_channel" AS ENUM('direct-debit', 'paypal', 'apple', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."tx_source" AS ENUM('abn-camt053', 'abn-tsv', 'paypal-csv');--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creditor_party_id" uuid,
	"creditor_name" text NOT NULL,
	"principal_cents" integer,
	"claimed_cents" integer NOT NULL,
	"references" text,
	"origin" text,
	"origin_story" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "item_category" NOT NULL,
	"provider_party_id" uuid,
	"amount_cents" integer NOT NULL,
	"billing_cycle" "billing_cycle" NOT NULL,
	"payment_channel" "payment_channel" NOT NULL,
	"contract_start" date,
	"contract_end" date,
	"notice_period" text,
	"cancellation_method" text,
	"cancellation_details" text,
	"account_number" text,
	"discovered_via" "discovery_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"financial_item_id" uuid,
	"debt_id" uuid,
	"status" text NOT NULL,
	"explanation" text NOT NULL,
	"document_id" uuid,
	"blocker_note" text,
	"override_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_decision_target_ck" CHECK (num_nonnulls("registry_decisions"."financial_item_id", "registry_decisions"."debt_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "tx_source" NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" text,
	"description" text,
	"mandate_id" text,
	"statement_sha256" text NOT NULL,
	"row_index" integer NOT NULL,
	"parse_error" boolean DEFAULT false NOT NULL,
	"raw_row" text,
	"financial_item_id" uuid
);
--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_creditor_party_id_parties_id_fk" FOREIGN KEY ("creditor_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_items" ADD CONSTRAINT "financial_items_provider_party_id_parties_id_fk" FOREIGN KEY ("provider_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_decisions" ADD CONSTRAINT "registry_decisions_financial_item_id_financial_items_id_fk" FOREIGN KEY ("financial_item_id") REFERENCES "public"."financial_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_decisions" ADD CONSTRAINT "registry_decisions_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_decisions" ADD CONSTRAINT "registry_decisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_decisions" ADD CONSTRAINT "registry_decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_financial_item_id_financial_items_id_fk" FOREIGN KEY ("financial_item_id") REFERENCES "public"."financial_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tx_stmt_row_uq" ON "transactions" USING btree ("statement_sha256","row_index");