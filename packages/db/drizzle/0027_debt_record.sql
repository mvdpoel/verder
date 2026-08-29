-- A debt gets a real record: who is demanding, who is collecting for them,
-- who to talk to there, what paperwork came with it, and whether Verder knows.
--
-- All additive. Nothing is dropped, no grant is weakened. `debts` stays a
-- non-evidence table (SELECT, INSERT, UPDATE, no ledger event);
-- `registry_decisions` stays evidence and is untouched.
CREATE TYPE "debt_party_role" AS ENUM ('eiser', 'incasso', 'deurwaarder', 'gemachtigde');
--> statement-breakpoint

CREATE TABLE "debt_parties" (
  "debt_id"    uuid NOT NULL REFERENCES "debts"("id"),
  "party_id"   uuid NOT NULL REFERENCES "parties"("id"),
  "role"       "debt_party_role" NOT NULL,
  "note"       text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "debt_party_uq" UNIQUE ("debt_id", "party_id", "role")
);
--> statement-breakpoint

CREATE TABLE "debt_documents" (
  "debt_id"     uuid NOT NULL REFERENCES "debts"("id"),
  "document_id" uuid NOT NULL REFERENCES "documents"("id"),
  CONSTRAINT "debt_document_uq" UNIQUE ("debt_id", "document_id")
);
--> statement-breakpoint

-- One level is the intent: organisation → person. The CHECK refuses a
-- self-reference; a deeper cycle is not enforced here, and the editor offers
-- only organisations as parents.
ALTER TABLE "parties" ADD COLUMN "parent_party_id" uuid REFERENCES "parties"("id");
--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_no_self_parent_ck"
  CHECK ("parent_party_id" IS NULL OR "parent_party_id" <> "id");
--> statement-breakpoint

ALTER TABLE "debts" ADD COLUMN "reported_to_verder_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN "reported_via_entry_id" uuid REFERENCES "log_entries"("id");
--> statement-breakpoint

-- Required by the data: the KvK aanmaning names an invoice number and no total.
-- `0` would assert that they claim nothing, which is false.
ALTER TABLE "debts" ALTER COLUMN "claimed_cents" DROP NOT NULL;
--> statement-breakpoint

-- DELETE is granted on these two link tables and NOWHERE ELSE, deliberately.
-- They carry no ledger event and are not evidence; they are links on an
-- editable fact table. A party linked to the wrong debt has to be removable,
-- and a registry whose mistakes are permanent is worse than the rule it would
-- uphold. registry_decisions keeps SELECT, INSERT and nothing more.
GRANT SELECT, INSERT, UPDATE, DELETE ON "debt_parties", "debt_documents"
  TO verder_app, verder_worker;
