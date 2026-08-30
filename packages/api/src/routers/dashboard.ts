import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { effectiveDocStatusSql } from "../effective-status";

/**
 * `worker_runs` names that are INCIDENT MARKERS, not watchers — excluded from
 * the system-health list because that list means the opposite of what they do.
 *
 * Every other name in it is something that SHOULD be running, so the dashboard
 * reads silence as failure: `down = stale || status !== "ok"` with a 15-minute
 * staleness bound. That is right for a cron job and exactly inverted for a row
 * written only when something went wrong on an on-demand path, where silence is
 * the healthy state and the newest row is not "current health" but "the last
 * time this ever broke".
 *
 * MEASURED, and it is why this exists: `search-rerank` is written ONLY by
 * search/retrieve.ts, ONLY with status "error", when a DEEP search's LLM rerank
 * times out (the search still succeeds — it falls back to the fused order). No
 * code path anywhere writes it "ok". Nothing in apps/web ever requests
 * `mode: "deep"` — the router defaults to "fast" and deep is documented as agent
 * surfaces only. So one transient Ollama timeout on 2026-08-23 painted this tile
 * red and NOTHING COULD EVER CLEAR IT: going green needs a success row that no
 * code writes, from a mode no surface requests. It sat red for a week over an
 * optional feature CLAUDE.md already records as unproven ("Deep did NOT beat
 * fast"), which is precisely the permanent-red that trains a reader to stop
 * looking — the same argument poll.ts makes when it records a rate-limit skip as
 * `ok` rather than burying the failure that needs a human under noise.
 *
 * The rows are still WRITTEN and still queryable: this is a display decision,
 * not a decision to stop recording. When a surface actually uses deep search,
 * the degradation belongs in that search's own result, where the person who ran
 * it will see it — not as a dot on a page they may not open for days.
 *
 * A name missing from this set costs one spurious red dot; a watcher wrongly IN
 * it goes dark unnoticed. So it is a denylist of known markers and never an
 * allowlist of known watchers — the failure direction has to be the loud one.
 */
const INCIDENT_MARKERS = ["search-rerank"];

// Joined into individual bound parameters rather than passed as one array:
// drizzle sends a JS array to pg as a plain string, and Postgres rejects it
// with 22P02 `Array value must start with "{"`. Measured — it failed every
// dashboard test, not just this one.

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
    const workers = (await ctx.db.execute(sql`
      SELECT DISTINCT ON (worker) worker, status, ran_at FROM worker_runs
      WHERE worker NOT IN (${sql.join(INCIDENT_MARKERS.map((m) => sql`${m}`), sql`, `)})
      ORDER BY worker, ran_at DESC`)).rows as { worker: string; status: string; ran_at: string }[];
    return { pendingSuggestions: pending, inboxDocs: inbox, openActionItems: open,
      lastWorkerRuns: workers.map((w) => ({ worker: w.worker, status: w.status, ranAt: new Date(w.ran_at) })) };
  }),
});
