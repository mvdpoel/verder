-- Tasks + milestones grants (both app and worker roles).
-- task_status_changes is an EVIDENCE table: INSERT + SELECT only, never UPDATE/DELETE.
GRANT SELECT, INSERT ON "task_status_changes" TO verder_app, verder_worker;
--> statement-breakpoint
-- Fact tables are editable (a typo is a typo) but nothing is ever deleted.
GRANT SELECT, INSERT, UPDATE ON "tasks", "milestones" TO verder_app, verder_worker;
