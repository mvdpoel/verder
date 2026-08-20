import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    // The EFFECTIVE document status, resolved exactly as inboxDocs below does
    // it. suggestions.list drops a suggestion whose document is discarded, and
    // a tile that disagrees renders "1 to review" over a queue that says it is
    // empty — a count that can never drain, because nothing is left to decide
    // it on. Discard lives in document_status_changes; documents.status keeps
    // reading "inbox" forever, so the column alone would never catch it.
    const [{ pending }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS pending FROM suggestions s
      WHERE s.status IN ('pending','needs-manual')
        AND (s.document_id IS NULL OR COALESCE(
          (SELECT c.status FROM document_status_changes c
            WHERE c.document_id = s.document_id ORDER BY c.created_at DESC LIMIT 1),
          (SELECT d.status FROM documents d WHERE d.id = s.document_id))
          IS DISTINCT FROM 'discarded')`)).rows as [{ pending: number }];
    const [{ inbox }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS inbox FROM documents d
      WHERE COALESCE((SELECT c.status FROM document_status_changes c
        WHERE c.document_id = d.id ORDER BY c.created_at DESC LIMIT 1), d.status) = 'inbox'`)).rows as [{ inbox: number }];
    const [{ open }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS open FROM action_items a
      WHERE COALESCE((SELECT c.status FROM action_item_status_changes c
        WHERE c.action_item_id = a.id ORDER BY c.created_at DESC LIMIT 1), 'open') = 'open'`)).rows as [{ open: number }];
    const workers = (await ctx.db.execute(sql`
      SELECT DISTINCT ON (worker) worker, status, ran_at FROM worker_runs
      ORDER BY worker, ran_at DESC`)).rows as { worker: string; status: string; ran_at: string }[];
    return { pendingSuggestions: pending, inboxDocs: inbox, openActionItems: open,
      lastWorkerRuns: workers.map((w) => ({ worker: w.worker, status: w.status, ranAt: new Date(w.ran_at) })) };
  }),
});
