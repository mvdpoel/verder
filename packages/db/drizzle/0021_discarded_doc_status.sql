-- Signature logos from email footers arrive as real documents. Discarding one
-- must not delete it: documents is append-only and already carries a
-- document.ingested ledger event, so removal would break the hash chain.
-- Discard is therefore a third status, appended through
-- document_status_changes exactly as "filed" is.
--
-- Additive only: ALTER TYPE ... ADD VALUE never rewrites or invalidates an
-- existing row, so the append-only evidence guarantee is untouched.
ALTER TYPE "public"."doc_status" ADD VALUE 'discarded';
