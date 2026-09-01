import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { effectiveDocStatusSql } from "../effective-status";
import { declFor, workerState } from "../worker-health";

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
      SELECT count(*)::int AS inbox FROM documents
      WHERE ${effectiveDocStatusSql} = 'inbox'`)).rows as [{ inbox: number }];
    const [{ open }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS open FROM action_items a
      WHERE COALESCE((SELECT c.status FROM action_item_status_changes c
        WHERE c.action_item_id = a.id ORDER BY c.created_at DESC LIMIT 1), 'open') = 'open'`)).rows as [{ open: number }];
    // The WHERE clause that used to exclude incident markers here is gone, and
    // the exclusion now happens in JS below. Two reasons. First, one concept in
    // one place: the taxonomy in worker-health.ts already knows what a marker
    // is, and spelling a second copy of the list into SQL is how the two come
    // to disagree — the list is a denylist, and a marker missing from the SQL
    // half only shows up as a permanently red dot nobody can clear. Second,
    // this query returns exactly one row per worker with no LIMIT, so filtering
    // after the fact drops the same rows and can never eat a page budget the
    // way an unfiltered documents.list would.
    //
    // It also retires the sql.join dance that clause needed: a JS array passed
    // straight into a `sql` template goes to pg as a plain string and dies with
    // 22P02 `Array value must start with "{"` — measured, and it failed every
    // dashboard test, not just the one about markers.
    const workers = (await ctx.db.execute(sql`
      SELECT DISTINCT ON (worker) worker, status, ran_at FROM worker_runs
      ORDER BY worker, ran_at DESC`)).rows as { worker: string; status: string; ran_at: string }[];
    // One instant for every row, so two workers with the same ran_at can never
    // be judged differently by a clock that ticked mid-loop.
    const now = Date.now();
    return { pendingSuggestions: pending, inboxDocs: inbox, openActionItems: open,
      // The judgement is served AS DATA — kind and state, decided here where
      // they are unit-tested. The web app must never recompute staleness: a
      // second copy of the rule in a React component is how the two drift, and
      // the drift stays invisible until a dead watcher renders green.
      lastWorkerRuns: workers
        .map((w) => ({ ...w, decl: declFor(w.worker) }))
        .filter((w) => w.decl.kind !== "incident")
        .map((w) => {
          const ranAt = new Date(w.ran_at);
          return { worker: w.worker, status: w.status, ranAt, kind: w.decl.kind,
            state: workerState(w.decl, w.status, ranAt, now) };
        }) };
  }),
});
