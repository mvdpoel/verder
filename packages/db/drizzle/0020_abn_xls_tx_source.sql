-- transactions.source is an enum, so a new statement parser is a schema change.
-- ABN AMRO's "Excel" export (BIFF8 or OOXML, both imported as abn-xls) could
-- otherwise be detected and parsed but never stored.
--
-- Additive only: ALTER TYPE ... ADD VALUE never rewrites or invalidates an
-- existing row, so the append-only evidence guarantee is untouched.
ALTER TYPE "public"."tx_source" ADD VALUE 'abn-xls';
