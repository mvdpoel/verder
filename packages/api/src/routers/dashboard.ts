import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    const [{ pending }] = (await ctx.db.execute(
      sql`SELECT count(*)::int AS pending FROM suggestions WHERE status IN ('pending','needs-manual')`)).rows as [{ pending: number }];
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
