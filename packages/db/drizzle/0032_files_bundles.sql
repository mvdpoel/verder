-- Files (sub-project 10): a document gets a sender, and bundles get a home.
--
-- All additive. Nothing is dropped, no grant is weakened, no ledger event is
-- appended by anything in this file.

-- THE GRANT TRAP. verder_app and verder_worker hold SELECT, INSERT on
-- `documents` and no UPDATE (0001, 0004) — the append-only law. So party_id is
-- writable at INGEST and never again, and every correction rides
-- document_status_changes, which is the table title and doc_type already
-- travel on. effectiveDocument resolves the pair.
ALTER TABLE "documents" ADD COLUMN "party_id" uuid REFERENCES "parties"("id");
--> statement-breakpoint
ALTER TABLE "document_status_changes" ADD COLUMN "party_id" uuid REFERENCES "parties"("id");
--> statement-breakpoint

-- The backfill lives HERE, as the `verder` admin role, because no app role may
-- UPDATE this table. Only mail attachments can resolve: an upload or a scan
-- carries no sender anywhere, and stays NULL until Martin sets one by hand.
-- Case-insensitive on BOTH sides — addresses arrive in whatever case the
-- sender's client felt like.
UPDATE "documents" d SET "party_id" = p."id"
FROM "raw_emails" r
JOIN "parties" p ON lower(p."email") = lower(r."from_addr")
WHERE d."source" = 'email-attachment'
  AND d."source_ref" = r."gmail_message_id"
  AND d."party_id" IS NULL;
--> statement-breakpoint

-- A bundle is NOT evidence: creating, renaming or deleting one appends no
-- ledger event, the same law tracks/stops and debts follow. A bundle is a VIEW
-- onto evidence, never a claim about the case.
CREATE TABLE "bundles" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"       text NOT NULL,
  "note"       text,
  "kind"       text NOT NULL,
  "rule"       jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bundles_kind_ck" CHECK ("kind" IN ('manual','rule')),
  -- A manual bundle has no rule and a rule bundle has nothing else. The
  -- complement — that a rule bundle holds no bundle_documents rows — is a
  -- cross-table fact and is guarded in the router: a trigger is a worse thing
  -- to own than a guard with a test.
  CONSTRAINT "bundles_rule_ck" CHECK (("kind" = 'rule') = ("rule" IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE "bundle_documents" (
  "bundle_id"   uuid NOT NULL REFERENCES "bundles"("id"),
  "document_id" uuid NOT NULL REFERENCES "documents"("id"),
  "added_at"    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bundle_document_uq" UNIQUE ("bundle_id", "document_id")
);
--> statement-breakpoint

-- DELETE is granted here and NOWHERE ELSE, for the reason 0027 granted it on
-- the debt link tables: these carry no ledger event and are not evidence, and
-- a bundle whose mistakes are permanent is worse than the rule it would uphold.
GRANT SELECT, INSERT, UPDATE, DELETE ON "bundles", "bundle_documents"
  TO verder_app, verder_worker;
