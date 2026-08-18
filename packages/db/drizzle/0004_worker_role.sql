-- Worker role: same evidence grants as verder_app, plus UPDATE on operational
-- tables and CREATE on the database so pg-boss can own its own schema.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verder_worker') THEN
    CREATE ROLE verder_worker LOGIN PASSWORD 'verder_worker';
  END IF;
END $$;

GRANT CONNECT ON DATABASE verder TO verder_worker;
GRANT USAGE ON SCHEMA public TO verder_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verder_worker;

-- evidence tables: INSERT + SELECT only
GRANT SELECT, INSERT ON ledger_events, log_entries, parties, entry_participants,
  documents, entry_documents, action_items, document_status_changes,
  action_item_status_changes, raw_emails TO verder_worker;

-- operational tables: no DELETE
GRANT SELECT, INSERT, UPDATE ON suggestions, worker_runs, users TO verder_worker;

GRANT CREATE ON DATABASE verder TO verder_worker; -- pg-boss creates its own schema
