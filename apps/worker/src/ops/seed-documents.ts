import { asc } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { notDiscardedSql } from "@verder/api/src/effective-status";

/**
 * The vault's documents keyed by the filename they arrived under, for the
 * backfill seeds to resolve their `doc:` references against.
 *
 * ONE function rather than one per seed. `case-history.ts` and `case-debts.ts`
 * both used to build this map inline, identically, and that duplication is
 * exactly how they came to disagree: the discarded-document rule below was
 * added to neither, and fixing one copy would have left the other resolving a
 * title the first refuses. A seed that links evidence must not depend on which
 * file asked.
 *
 * DISCARDED DOCUMENTS ARE NOT CANDIDATES. A discard is APPENDED to
 * `document_status_changes` and never written back, so `documents.status` keeps
 * reading "inbox" forever — the trap the whole app resolves through
 * `effectiveDocument`. Without this filter a seed happily links a document
 * Martin has thrown away: 56% of filed attachments were once the `cid:` images
 * an HTML mail embeds, and one of those is titled `image.png`, not something a
 * seed would ever name — but a real Beschikking discarded by mistake and then
 * re-ingested is, and the seed would bind to the discarded copy.
 *
 * A document with no status change at all is KEPT, and the COALESCE onto
 * `documents.status` is what keeps it: that column is NOT NULL DEFAULT 'inbox',
 * so the expression never evaluates to NULL. Which means — measured, not
 * assumed — `<>` would behave identically here, and the `IS DISTINCT FROM`
 * below is NOT load-bearing the way it is in `search/retrieve.ts`, where the
 * status column itself is NULL for every entity type that has none. It is kept
 * for two smaller reasons: this is the third copy of one expression
 * (`documents.list`, `pendingDocMeta`, here) and three copies should read
 * identically, and it stays correct if the COALESCE fallback ever becomes
 * nullable. Cast to text so the comparison does not depend on the enum's
 * operator set.
 *
 * FILTER FIRST, THEN OLDEST WINS. The order matters and it is not the obvious
 * one: if the oldest copy of a title was discarded and a later copy was kept,
 * the later copy is the answer. Taking the oldest first and rejecting it
 * afterwards would resolve the title to nothing and report it missing, when a
 * perfectly good document is sitting in the vault.
 *
 * The key is the RAW `documents.title` — the filename the mail carried, which
 * ingestion copies verbatim and never changes — not `effectiveDocument`'s
 * `effectiveTitle`. That is deliberate: the seeds name files as they arrived,
 * so a document Martin has since renamed in the meta form must still resolve
 * under the name the seed knows it by.
 */
export async function documentIdsByTitle(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.documents.id, title: schema.documents.title })
    .from(schema.documents)
    .where(notDiscardedSql)
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
  const byTitle = new Map<string, string>();
  for (const d of rows) if (!byTitle.has(d.title)) byTitle.set(d.title, d.id);
  return byTitle;
}
