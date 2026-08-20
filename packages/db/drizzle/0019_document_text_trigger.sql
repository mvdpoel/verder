-- A FIFTEENTH search-outbox trigger, on document_texts.
--
-- Extraction is asynchronous: a document is ingested and indexed on its title
-- and metadata straight away, and its OCR/PDF text lands later, whenever the
-- docmeta job or the extract-texts backfill gets to it. Nothing re-enqueued the
-- document at that moment, so the very text this sub-project exists to make
-- searchable sat in document_texts unreferenced by any chunk, until some
-- unrelated write to the document or its status happened to reindex it.
--
-- Found on the production backfill: 18 documents indexed, 0 document_texts
-- rows, so every scanned letter was findable by filename only.
--
-- Reuses the same SECURITY DEFINER search_enqueue(entity_type, id_column) as
-- migration 0017 — document_texts.document_id is the parent document.
CREATE TRIGGER document_texts_search_outbox_trg
AFTER INSERT OR UPDATE ON document_texts
FOR EACH ROW EXECUTE FUNCTION public.search_enqueue('document', 'document_id');
