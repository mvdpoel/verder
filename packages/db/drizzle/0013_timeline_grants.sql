-- Curated key events grants (both app and worker roles).
-- timeline_events is an editable display aid (a typo is a typo) — the linked
-- logbook entries and documents stay the evidence — but nothing is ever deleted.
GRANT SELECT, INSERT, UPDATE ON "timeline_events" TO verder_app, verder_worker;
