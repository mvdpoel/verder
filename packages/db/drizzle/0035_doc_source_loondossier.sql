-- Payslips fetched from the Mijn LoonDossier portal get their own document
-- source. Additive only: ADD VALUE never rewrites or invalidates an existing
-- row, so the append-only evidence guarantee is untouched.
ALTER TYPE "public"."doc_source" ADD VALUE 'loondossier';
