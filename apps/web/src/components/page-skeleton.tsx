/**
 * What the shell shows while a page's data is on its way.
 *
 * Every page here is a server component that awaits its own queries, so without
 * a `loading.tsx` a navigation does nothing visible until ALL of them resolve —
 * the rail stays lit, the old page stays put, and the only feedback is the
 * browser's own spinner. On the heavier screens that is long enough to read as
 * a dead click.
 *
 * IT DRAWS NO NUMBERS AND NO WORDS. A skeleton that guesses at a layout is a
 * drawing pretending to be a measurement — the thing this system refuses
 * everywhere else — so this is empty plates and nothing that could be mistaken
 * for a fact that has arrived.
 *
 * `aria-busy` with a live region carries the same news to a screen reader,
 * which cannot see a pulse. The pulse itself is neutralised by the global
 * `prefers-reduced-motion` rule in globals.css.
 *
 * WHY THIS IS NOT ONE `loading.tsx` ON THE (app) GROUP, which is where it
 * started: a `loading.tsx` is a Suspense boundary, and a Suspense boundary makes
 * the response STREAM. Once the shell has been sent the status line is already
 * committed, so a `notFound()` resolved afterwards renders the right page under
 * a 200. Measured: with a group-level loading.tsx `/vault/<unknown-uuid>`
 * answered 200, and without it 404.
 *
 * So the boundary is mounted per route, and only on routes with NO nested
 * detail page under them: /dashboard, /timeline, /money, /search, /queue and
 * /verify. A `loading.tsx` cascades over the WHOLE subtree below it, so one on
 * /vault streams /vault/[id] too and takes that page's 404 with it — measured,
 * after the first attempt put a skeleton on all ten list screens and every
 * detail route was still answering 200.
 *
 * /vault, /logbook, /registry and /tasks therefore have none, which is the
 * cheaper half of the trade: each is a single list query, while the six that
 * keep a skeleton are the screens that assemble a whole map or a whole chart.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Bezig met laden…</span>
      <div className="h-[26px] w-[210px] animate-pulse rounded-panel bg-hairline-lit" />
      <div className="h-[188px] animate-pulse rounded-panel border border-edge bg-plate/50" />
      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        <div className="h-[236px] animate-pulse rounded-panel border border-edge bg-plate/50" />
        <div className="h-[236px] animate-pulse rounded-panel border border-edge bg-plate/50" />
      </div>
    </div>
  );
}
