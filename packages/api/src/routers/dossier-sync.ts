import { z } from "zod";
import { and, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { protectedProcedure, router } from "../trpc";
import { notDiscardedSql, notPurgedSql } from "../effective-status";
import { effectiveDocument } from "./documents";

/**
 * The pocket dossier's sync (spec §7.4, Plan 3 Task 20).
 *
 * ONE monotonic cursor: `ledger_events.seq`. Every document mutation — ingest,
 * rename, retype, file, discard, undo, purge, link — appends an event for that
 * document in the same transaction, and `appendLedgerEvent` holds advisory
 * lock 42 until commit, so seq order IS commit order: a page can never step
 * past an event that commits later with a smaller seq.
 *
 * The delta carries no history, only what each touched document IS now:
 * every id is resolved through `effectiveDocument`, the same resolution the
 * web's /files surfaces read. Text extraction appends no event, so a document
 * that synced before its text existed is fetched again through `texts`.
 */

export const DOSSIER_PAGE_MAX = 50;
export const DOSSIER_TEXTS_MAX = 20;

export type DossierDoc = {
  id: string;
  title: string;
  docType: string | null;
  status: "inbox" | "filed";
  /** ISO instant. */
  receivedAt: string;
  /** As stored: the file route serves the bytes with the sniffed type. */
  mime: string;
  sizeBytes: number;
  sha256: string;
  hasText: boolean;
};

export type DossierTombstone = { id: string; reason: "discarded" | "purged" };

export type DossierDelta = {
  cursor: number;
  more: boolean;
  upserts: DossierDoc[];
  tombstones: DossierTombstone[];
};

export type DossierText = { id: string; text: string; truncated: boolean };

export async function dossierDelta(db: Db, cursor: number, limit: number): Promise<DossierDelta> {
  // max(seq) per document: a document touched five times since the cursor is
  // ONE row, placed at its newest event. Ordering by that seq is what makes
  // the cursor safe — every document not on this page has a newest seq above
  // the page's last one, so the next page (seq > cursor) still finds it.
  // One row more than the page tells `more` without a second query.
  const rows = (await db.execute(sql`
    SELECT entity_id::text AS id, max(seq)::text AS seq
    FROM ledger_events
    WHERE entity_type = 'document' AND seq > ${cursor}
    GROUP BY entity_id
    ORDER BY max(seq)
    LIMIT ${limit + 1}`)).rows as { id: string; seq: string }[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (page.length === 0) return { cursor, more: false, upserts: [], tombstones: [] };

  const ids = page.map((r) => r.id);
  const withText = new Set((await db.execute(sql`
    SELECT document_id::text AS id FROM document_texts
    WHERE document_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      AND char_length(text) > 0`)).rows.map((r) => (r as { id: string }).id));

  const upserts: DossierDoc[] = [];
  const tombstones: DossierTombstone[] = [];
  for (const { id } of page) {
    const d = await effectiveDocument(db, id);
    // Purged is the presence of a document_purges ROW — the display
    // definition /files and effectiveDocument share. (/verify's is the
    // event, and stays /verify's.) It wins over discarded: the stronger fact.
    if (d.purge) { tombstones.push({ id, reason: "purged" }); continue; }
    if (d.effectiveStatus === "discarded") { tombstones.push({ id, reason: "discarded" }); continue; }
    upserts.push({
      id, title: d.effectiveTitle, docType: d.effectiveDocType ?? null,
      status: d.effectiveStatus === "filed" ? "filed" : "inbox",
      receivedAt: d.receivedAt.toISOString(), mime: d.mime,
      sizeBytes: d.sizeBytes, sha256: d.sha256, hasText: withText.has(id),
    });
  }
  return { cursor: Number(page[page.length - 1].seq), more, upserts, tombstones };
}

/** Extracted text for documents the phone keeps; never a discarded or purged one's. */
export async function dossierTexts(db: Db, ids: string[]): Promise<DossierText[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({
    id: schema.documentTexts.documentId, text: schema.documentTexts.text,
    truncated: schema.documentTexts.truncated,
  }).from(schema.documentTexts)
    .innerJoin(schema.documents, sql`${schema.documents.id} = ${schema.documentTexts.documentId}`)
    .where(and(inArray(schema.documentTexts.documentId, ids),
      sql`char_length(${schema.documentTexts.text}) > 0`, notDiscardedSql, notPurgedSql));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export const dossierSyncRouter = router({
  delta: protectedProcedure.input(z.object({
    cursor: z.number().int().min(0),
    limit: z.number().int().min(1).max(DOSSIER_PAGE_MAX).default(DOSSIER_PAGE_MAX),
  })).query(({ ctx, input }) => dossierDelta(ctx.db, input.cursor, input.limit)),

  texts: protectedProcedure.input(z.object({
    ids: z.array(z.string().uuid()).min(1).max(DOSSIER_TEXTS_MAX),
  })).query(({ ctx, input }) => dossierTexts(ctx.db, [...new Set(input.ids)])),
});
