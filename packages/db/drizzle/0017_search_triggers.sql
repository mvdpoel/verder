-- Search outbox triggers (sub-project 4 — DERIVED index, no ledger events).
--
-- FOURTEEN AFTER INSERT OR UPDATE row triggers write (entity_type, entity_id)
-- into search_outbox; the search.drain worker job dedupes and re-indexes.
-- Chosen over calling an enqueue helper at each mutation site: there are dozens
-- of those across four routers and the worker, and one forgotten call is an
-- invisible bug (a record that silently never becomes findable). A trigger
-- catches every path, manual psql included.
--
-- SECURITY DEFINER: the function runs as its owner (the `verder` admin role
-- that runs migrations), so verder_app and verder_worker need no INSERT grant
-- on search_outbox and no grant on its sequence — they can never write junk
-- into the outbox directly, only by touching a real record. search_path is
-- pinned so the function can never be tricked into resolving `search_outbox`
-- in an attacker-controlled schema.
--
-- TG_ARGV[0] is the entity_type; TG_ARGV[1] is the column on NEW that holds the
-- entity id. That second argument is what lets ONE function serve both the nine
-- entity tables ('id') and the four single-parent child tables
-- ('document_id', 'task_id', 'entry_id'). Status and relations live in those
-- child tables: an approved doc-meta suggestion writes document_status_changes
-- and never touches documents, so without the child triggers the most common
-- queue action would never reindex.
CREATE OR REPLACE FUNCTION public.search_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
BEGIN
  target := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  IF target IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id) VALUES (TG_ARGV[0], target);
  END IF;
  RETURN NULL; -- AFTER trigger: the return value is ignored
END $$;
--> statement-breakpoint
-- registry_decisions is the one child table with TWO possible parents. Its
-- check constraint registry_decision_target_ck guarantees exactly one of the
-- two FKs is non-null, so the routing below is total.
CREATE OR REPLACE FUNCTION public.search_enqueue_registry_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.financial_item_id IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id)
      VALUES ('financial_item', NEW.financial_item_id);
  ELSIF NEW.debt_id IS NOT NULL THEN
    INSERT INTO search_outbox (entity_type, entity_id)
      VALUES ('debt', NEW.debt_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- The nine entity tables: the row IS the indexed entity.
CREATE OR REPLACE TRIGGER "documents_search_outbox_trg" AFTER INSERT OR UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "log_entries_search_outbox_trg" AFTER INSERT OR UPDATE ON "log_entries"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "raw_emails_search_outbox_trg" AFTER INSERT OR UPDATE ON "raw_emails"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('email', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "financial_items_search_outbox_trg" AFTER INSERT OR UPDATE ON "financial_items"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('financial_item', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "debts_search_outbox_trg" AFTER INSERT OR UPDATE ON "debts"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('debt', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "tasks_search_outbox_trg" AFTER INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('task', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "milestones_search_outbox_trg" AFTER INSERT OR UPDATE ON "milestones"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('milestone', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "timeline_events_search_outbox_trg" AFTER INSERT OR UPDATE ON "timeline_events"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('timeline_event', 'id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "parties_search_outbox_trg" AFTER INSERT OR UPDATE ON "parties"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('party', 'id');
--> statement-breakpoint
-- The five parent-refresh tables: the row is a CHILD whose content the parent's
-- rendered text contains (effective status, participants, attached documents).
CREATE OR REPLACE TRIGGER "document_status_changes_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "document_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'document_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "task_status_changes_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "task_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('task', 'task_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entry_participants_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "entry_participants"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'entry_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entry_documents_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "entry_documents"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('entry', 'entry_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "registry_decisions_search_outbox_trg"
  AFTER INSERT OR UPDATE ON "registry_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.search_enqueue_registry_decision();
