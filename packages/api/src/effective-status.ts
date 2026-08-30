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

/**
 * A document's soort as it actually stands.
 *
 * Unlike status, a docType correction on document_status_changes can be
 * absent (a change row that only touches status/title says nothing about the
 * soort) — so this resolves to the NEWEST row that HAS an opinion, not simply
 * the newest row, mirroring the `??` in effectiveDocument. That is also why a
 * soort can be overwritten but never cleared: a documented, tested property
 * that must not change here.
 */
export const effectiveDocTypeSql: SQL<string | null> = sql`COALESCE((
  SELECT c.doc_type FROM document_status_changes c
  WHERE c.document_id = documents.id AND c.doc_type IS NOT NULL
  ORDER BY c.created_at DESC LIMIT 1), documents.doc_type)`;

/**
 * A document's sender as it actually stands. Same COALESCE-of-newest-opinion
 * shape as effectiveDocTypeSql, and for the same reason: a party correction
 * can be absent from a given change row, and when it is, that row must not
 * be read as "cleared the sender" — only the newest row that actually named
 * one wins.
 */
export const effectivePartyIdSql: SQL<string | null> = sql`COALESCE((
  SELECT c.party_id FROM document_status_changes c
  WHERE c.document_id = documents.id AND c.party_id IS NOT NULL
  ORDER BY c.created_at DESC LIMIT 1), documents.party_id)`;

/**
 * A document's title as it actually stands. Same COALESCE-of-newest-opinion
 * shape as effectiveDocTypeSql and effectivePartyIdSql — unlike status, a
 * change row can say nothing about the title (it may only correct status or
 * docType), and that silence must not be read as clearing it. documents.title
 * is NOT NULL, so the fallback always resolves to a string.
 */
export const effectiveTitleSql: SQL<string> = sql`COALESCE((
  SELECT c.title FROM document_status_changes c
  WHERE c.document_id = documents.id AND c.title IS NOT NULL
  ORDER BY c.created_at DESC LIMIT 1), documents.title)`;

/**
 * THE TWO BRANCH KEYS BELOW live here, one import level under both routers,
 * rather than in routers/documents.ts where they were written: bundles.ts
 * needs docTypeKeySql for a rule, and documents.ts needs bundles.ts to resolve
 * a bundel branch. Keeping them up there made that pair a cycle.
 */

/**
 * The folded soort key `tree` groups on and `browse`'s `soort` branch filters
 * on — the SAME constant, not two hand-typed copies. Folds inner whitespace
 * runs too: without regexp_replace, "bank  afschrift" (double space) and
 * "bank afschrift" would land in two different SQL branches while this key
 * treats them as one.
 *
 * `'\\s+'`, not `'\s+'`: inside a JS template literal `'\s+'` silently drops
 * the backslash and Postgres then matches a literal "s" — measured.
 */
export const docTypeKeySql = sql<string>`regexp_replace(
  lower(btrim(coalesce(${effectiveDocTypeSql},''))), '\\s+', ' ', 'g')`;

/**
 * The month key `tree` groups on and `browse`'s `periode` branch filters on —
 * Amsterdam, not UTC: month membership is an Amsterdam question, and a UTC
 * bucket files 31 August 23:00Z under August while every date the app prints
 * says 1 September.
 */
export const receivedMonthSql = sql<string>`to_char(
  (documents.received_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM')`;
