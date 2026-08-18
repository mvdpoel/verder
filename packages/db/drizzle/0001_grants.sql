DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verder_app') THEN
    CREATE ROLE verder_app LOGIN PASSWORD 'verder_app';
  END IF;
END $$;

GRANT CONNECT ON DATABASE verder TO verder_app;
GRANT USAGE ON SCHEMA public TO verder_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verder_app;

-- evidence tables: INSERT + SELECT only
GRANT SELECT, INSERT ON ledger_events, log_entries, parties, entry_participants,
  documents, entry_documents, action_items, document_status_changes,
  action_item_status_changes, raw_emails TO verder_app;

-- operational tables: no DELETE
GRANT SELECT, INSERT, UPDATE ON suggestions, worker_runs, users TO verder_app;
