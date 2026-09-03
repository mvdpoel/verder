-- Definitief verwijderen (sub-project 11): a document's CONTENT can be
-- destroyed; its RECORD cannot.
--
-- Additive. Nothing is dropped, and no grant on an evidence table is weakened.
--
-- WHY THE `documents` ROW SURVIVES. /verify re-derives every document.ingested
-- event from the live row and the live vault bytes (verification.ts), and that
-- event can never leave the hash chain. Deleting the row leaves one
-- permanently failing seq, reported by nightly-verify every night forever.
-- Worse, a document cited by a logbook entry appears in that entry's ledgered
-- payload via entryEventPayload.documentIds, so removing the link rewrites the
-- ENTRY's recomputed hash and reads as tampering with the logbook. Keeping the
-- row and destroying the content leaves every ledgered citation intact.

-- EVIDENCE: SELECT, INSERT and nothing else. A purge that can be edited is not
-- a record, and a purge that can be deleted is a way to make bytes vanish
-- untraceably.
CREATE TABLE "document_purges" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- UNIQUE: a document is purged once. A second purge is a no-op in the
  -- router, not an error — the same law documents.update follows for a
  -- repeated discard, and for the same reason: one decision must not appear
  -- in the record twice.
  "document_id" uuid NOT NULL UNIQUE REFERENCES "documents"("id"),
  -- Copied, not read back off `documents`. This is the record of WHAT WAS
  -- DESTROYED, and it must not depend on another table still agreeing.
  "sha256"      text NOT NULL,
  "size_bytes"  bigint NOT NULL,
  -- Nullable: the button offers the field and does not demand it.
  "reason"      text,
  "created_by"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

GRANT SELECT, INSERT ON "document_purges" TO verder_app, verder_worker;
--> statement-breakpoint

-- THE ONE GRANT WIDENING, and the reason it is lawful. verder_app holds SELECT
-- only on these two (0016, deliberately: "the web app searches the index and
-- never maintains it"). Without DELETE, a purge leaves the document's full
-- OCR'd text in the database and in search, and the button is a lie. Both
-- tables are DERIVED and documented as non-evidence — "they hold no facts:
-- only a rebuildable lookup" — and verder_worker already holds DELETE on them.
-- Widening the app's grant on two rebuildable tables is not the same act as
-- widening it on `documents`.
GRANT DELETE ON "document_texts", "search_chunks" TO verder_app;
