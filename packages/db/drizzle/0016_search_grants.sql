-- Searchable knowledge base grants (both app and worker roles).
--
-- READ THIS BEFORE CONCLUDING THE APPEND-ONLY LAW WAS WEAKENED.
-- document_texts, search_chunks and search_outbox are DERIVED tables, NOT
-- evidence. They hold no facts: only a rebuildable lookup FOR the facts that
-- live in the evidence tables. `pnpm --filter worker reindex` recreates every
-- row of all three from the source records, and they append no ledger_events.
--
-- They are therefore the first tables in this project to grant DELETE to an
-- application role, and that is deliberate: the drain replaces chunks whose
-- source text changed, drops chunks a shorter re-render no longer produces, and
-- clears outbox rows it has processed. An index that cannot forget is an index
-- that goes stale and lies. A tampered index cannot corrupt the record — it can
-- only fail to find it — and index health (chunk count, outbox depth, embedding
-- failures, last drain) is surfaced on /verify so that failure is visible.
--
-- Every append-only grant on every evidence table is untouched by this file.

-- The web app SEARCHES the index and never maintains it: SELECT only, on all
-- three tables. (search_outbox too — /verify reports outbox depth.)
GRANT SELECT ON "document_texts", "search_chunks", "search_outbox" TO verder_app;
--> statement-breakpoint
-- The worker OWNS the index: extraction writes document_texts, the drain
-- upserts and prunes search_chunks.
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_texts", "search_chunks" TO verder_worker;
--> statement-breakpoint
-- The worker CLAIMS from the outbox and deletes what it has processed — but it
-- may not enqueue. Nothing may: rows arrive only through the SECURITY DEFINER
-- function search_enqueue(), owned by `verder`, which the AFTER INSERT OR UPDATE
-- triggers call. That is why there is no INSERT here for either role, and why
-- search_outbox_id_seq needs no USAGE grant either — the only inserter is the
-- owner, who already has it.
GRANT SELECT, DELETE ON "search_outbox" TO verder_worker;
