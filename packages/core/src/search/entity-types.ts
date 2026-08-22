// The nine record types the knowledge base indexes. One tuple, one spelling:
// the schema's entity_type column, the trigger arguments, the router's input
// schema and the /search filter rail all read this list.
//
// `track` and `stop` replaced `milestone` and `timeline_event` in sub-project 6:
// the curated narrative became a map. entity_type is a text column, so this
// needed no schema change — but the old chunks had to be DELETEd by hand in
// migration 0023. `reindex --prune` cannot do it: prune walks this very tuple,
// so a kind that has left it is never visited and never dropped. Retiring the
// next kind means deleting its chunks and its outbox trigger in the same
// migration that removes it from this list.
export const SEARCH_ENTITY_TYPES = ["document", "entry", "email", "financial_item",
  "debt", "task", "track", "stop", "party"] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/**
 * Every status a search result can OFFER as a filter, deduped across the four
 * vocabularies that exist in the app: doc_status, TASK_STATUSES, item_status,
 * debt_status. search_chunks.status is denormalized, so a status filter is one
 * WHERE clause against one column instead of a per-entity-type subquery — which
 * is what makes "the filter rail offers a status the router rejects" impossible.
 *
 * ONE deliberate omission: doc_status also has `discarded` (migration 0021).
 * retrieve.ts excludes discarded chunks unconditionally — that is the whole
 * point of discarding one — so offering it here would be a filter guaranteed to
 * return nothing. Adding it needs a browse-discarded surface first.
 */
export const SEARCH_STATUSES = [
  "inbox", "filed",                                            // documents
  "open", "in-progress", "waiting", "done", "dropped",         // tasks
  "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled", // financial items
  "acknowledged", "disputed", "in-settlement", "settled",      // debts ("identified" shared)
] as const;

export type SearchStatus = (typeof SEARCH_STATUSES)[number];
