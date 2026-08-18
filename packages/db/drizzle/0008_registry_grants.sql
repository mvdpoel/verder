-- Financial registry grants (both app and worker roles).
-- registry_decisions is an EVIDENCE table: INSERT + SELECT only, never UPDATE/DELETE.
GRANT SELECT, INSERT ON "registry_decisions" TO verder_app, verder_worker;
--> statement-breakpoint
-- Fact tables are editable (a typo is a typo) but nothing is ever deleted.
GRANT SELECT, INSERT, UPDATE ON "financial_items", "debts", "transactions" TO verder_app, verder_worker;
