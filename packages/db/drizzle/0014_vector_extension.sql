-- pgvector. Must land BEFORE the table migration: search_chunks.embedding is
-- vector(768) and CREATE TABLE fails if the type does not exist yet.
-- drizzle-kit cannot express this (its extensionsFilters only knows postgis),
-- so it is hand-written, in the style of the DO $$ role blocks in 0001/0004.
-- Migrations run as the bootstrap superuser `verder`, which may CREATE
-- EXTENSION; verder_app and verder_worker need no grant, because types created
-- in schema public are usable by PUBLIC.
CREATE EXTENSION IF NOT EXISTS vector;
