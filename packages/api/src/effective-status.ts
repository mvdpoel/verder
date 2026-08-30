import { sql, type SQL } from "drizzle-orm";

/**
 * A document's status as it actually stands.
 *
 * A discard is APPENDED to document_status_changes and never written back, so
 * `documents.status` reads "inbox" forever. Every surface that filters or
 * counts documents must resolve it through here.
 *
 * This expression was written out by hand in six places — routers/documents.ts
 * twice, routers/dashboard.ts, track-evidence.ts, ops/seed-documents.ts and
 * docmeta-sweep.ts — which is how a definition starts drifting. It assumes the
 * query selects FROM documents (unaliased), which all six do.
 */
export const effectiveDocStatusSql: SQL<string> = sql`COALESCE((
  SELECT c.status FROM document_status_changes c
  WHERE c.document_id = documents.id
  ORDER BY c.created_at DESC LIMIT 1), documents.status)::text`;

/**
 * IS DISTINCT FROM, never `<>`. `NULL <> 'discarded'` evaluates to NULL, which
 * a WHERE clause treats as false — so the "simplification" silently drops every
 * row whose status cannot be resolved.
 */
export const notDiscardedSql: SQL = sql`${effectiveDocStatusSql} IS DISTINCT FROM 'discarded'`;
