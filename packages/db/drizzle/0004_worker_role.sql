-- Worker role: same evidence grants as grip_app, plus UPDATE on operational
-- tables and CREATE on the database so pg-boss can own its own schema.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grip_worker') THEN
    CREATE ROLE grip_worker LOGIN PASSWORD 'grip_worker';
  END IF;
END $$;

GRANT CONNECT ON DATABASE grip TO grip_worker;
GRANT USAGE ON SCHEMA public TO grip_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO grip_worker;

-- evidence tables: INSERT + SELECT only
GRANT SELECT, INSERT ON ledger_events, log_entries, parties, entry_participants,
  documents, entry_documents, action_items, document_status_changes,
  action_item_status_changes, raw_emails TO grip_worker;

-- operational tables: no DELETE
GRANT SELECT, INSERT, UPDATE ON suggestions, worker_runs, users TO grip_worker;

GRANT CREATE ON DATABASE grip TO grip_worker; -- pg-boss creates its own schema
