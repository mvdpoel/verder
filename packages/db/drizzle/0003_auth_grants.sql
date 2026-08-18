-- better-auth managed tables: the app role needs read/write on user + account,
-- and full CRUD on sessions and verifications (better-auth deletes them on
-- sign-out / expiry cleanup). These are operational auth tables, not evidence
-- tables — the insert-only rule does not apply here.
GRANT SELECT, INSERT, UPDATE ON "user", "account" TO verder_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "session", "verification" TO verder_app;
