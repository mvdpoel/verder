import { sql } from "drizzle-orm";
import type { Db } from "@verder/db";

// The ⌘K palette's empty state. Parties and e-mails are deliberately absent
// from this list: neither has a screen of its own, and a row you cannot open is
// worse than no row at all.
export const LINKABLE_ENTITY_TYPES = [
  "document", "entry", "financial_item", "debt", "task", "track", "stop",
] as const;
export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];

/** The list above as a Postgres text[] literal — identifiers this repo owns, never
 *  anything a user typed. */
const LINKABLE = `{${LINKABLE_ENTITY_TYPES.join(",")}}`;

export type RecentRecord = {
  entityType: LinkableEntityType;
  entityId: string;
  title: string;
  occurredAt: string | null;
  href: string;
};

/** Detail route for a record. Every path here is a real route under apps/web/src/app/(app). */
export function entityHref(entityType: LinkableEntityType, entityId: string): string {
  switch (entityType) {
    case "document": return `/files/${entityId}`;
    case "entry": return `/logbook/${entityId}`;
    case "financial_item": return `/registry/${entityId}`;
    case "debt": return `/registry/debts/${entityId}`;
    case "task": return `/tasks/${entityId}`;
    case "track": return "/timeline";
    // The map has no per-stop page; it reads the selection off the query string,
    // so the palette can still open a halte instead of the whole map.
    case "stop": return `/timeline?stop=${encodeURIComponent(entityId)}`;
  }
}

/**
 * The records that changed most recently, read straight off the index so the
 * palette's empty state costs one query instead of nine per-table ones.
 * Ordered by indexed_at, not occurred_at: "recent" here means "recently touched
 * in the dossier", which is what someone reaching for ⌘K is usually after, and
 * it does not let a record dated in the future pin itself to the top forever.
 */
export async function recentEntities(db: Db, limit: number): Promise<RecentRecord[]> {
  const rows = (await db.execute(sql`
    SELECT entity_type, entity_id, title, occurred_at
    FROM search_chunks
    WHERE chunk_index = 0
      -- An allow-list, not "NOT IN ('party','email')": entity_type is a TEXT
      -- column and still holds chunks for the kinds sub-project 6 retired
      -- (milestone, timeline_event), which reindex --prune does not visit. One
      -- of those would leave entityHref with no case and hand the palette a row
      -- with an undefined href.
      AND entity_type = ANY(${LINKABLE}::text[])
      -- Discarding enqueues a reindex, so without this a signature logo Martin just
      -- discarded would arrive at the very top of this indexed_at-ordered list.
      -- IS DISTINCT FROM, not <>: most entity types have no status, and
      -- NULL <> 'discarded' is NULL, which would empty the palette entirely.
      AND status IS DISTINCT FROM 'discarded'
    ORDER BY indexed_at DESC
    LIMIT ${limit}`)).rows as {
      entity_type: string; entity_id: string; title: string;
      occurred_at: string | Date | null;
    }[];
  return rows.map((r) => {
    const entityType = r.entity_type as LinkableEntityType;
    return {
      entityType,
      entityId: r.entity_id,
      title: r.title,
      occurredAt: r.occurred_at === null ? null : new Date(r.occurred_at).toISOString(),
      href: entityHref(entityType, r.entity_id),
    };
  });
}
