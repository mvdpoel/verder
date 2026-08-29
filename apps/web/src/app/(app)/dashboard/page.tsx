import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { EnablePush } from "@/components/enable-push";
import { DashboardMoney } from "@/components/dashboard-money";
import { formatEuro } from "@/components/registry-list";
import { caseTopRows, noOpenTracksLine } from "@/lib/track-marks";

export default async function DashboardPage() {
  const caller = await serverCaller();
  const stats = await caller.dashboard.stats();
  const registry = await caller.registry.stats();
  const taskStats = await caller.tasks.stats();
  const clearedBlockers = await caller.registry.clearedBlockers();
  const recent = await caller.entries.list({ limit: 5 });
  const staleMs = 15 * 60 * 1000;
  const { map } = await caller.tracks.map();
  // One line per open spoor: its newest stop that is not done yet, or its
  // newest stop if everything on it is done. `own[0]` can be undefined, because
  // a spoor with no haltes yet is a real state and the type should say so
  // instead of promising a stop that isn't there.
  const openTracks = map.tracks
    .filter((t) => t.status === "open" && t.parentTrackId !== null)
    .map((t) => {
      const own = map.stops.filter((s) => s.trackId === t.id)
        .sort((a, b) => a.row - b.row);
      // The newest stop that is not done yet, or the newest stop there is. Row 0
      // is the top of the page, so ascending row is newest first.
      return { track: t, stop: own.find((s) => s.state !== "done") ?? own[0] };
    });
  // The top of the timeline: what is running now, then the newest few dated
  // haltes. Same `tracks.map()` call as the list below it — the dashboard makes
  // one query for this whole block, never two.
  const topRows = caseTopRows({ stops: map.stops, tracks: map.tracks, datedLimit: 3 });
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Hi Martin 👋 — here's where things stand</h1>
        <EnablePush />
      </div>
      {/* Where the case stands: the top of the timeline, then one line per open
          spoor. The dashboard shows LESS than /timeline on purpose: no map, no
          evidence, no problems, and only the newest handful of rows — it points
          at the page that has them. */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-semibold">Waar de zaak staat</h2>
          <Link className="text-sm text-slate-500 hover:underline" href="/timeline">
            de hele kaart →
          </Link>
        </div>
        {topRows.length > 0 && (
          <ul className="mb-3 space-y-1 rounded border bg-white p-3 text-sm">
            {topRows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                {/* The date column, fixed width so the rows line up and the
                    page reads as a timeline and not as a paragraph. A running
                    halte says "loopt nu" here instead of a date: it has none,
                    and printing one would be the dashboard inventing it. */}
                <span
                  className={`w-24 shrink-0 text-xs ${
                    r.running ? "font-medium text-green-700" : "text-slate-500"
                  }`}
                >
                  {r.when}
                </span>
                <span className={r.running ? "font-medium" : undefined}>{r.title}</span>
                <span className="text-slate-500">· {r.spoor}</span>
              </li>
            ))}
          </ul>
        )}
        {openTracks.length === 0 ? (
          // Names the outcomes that actually happened. "alles is afgerond"
          // asserted afgerond over a spoor whose status is `ended` — a
          // different, equally clean outcome that the rest of this work keeps
          // carefully apart.
          <p className="text-sm text-slate-500">
            {noOpenTracksLine(map.tracks
              .filter((t) => t.parentTrackId !== null)
              .map((t) => t.status))}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {openTracks.map(({ track, stop }) => (
              <li key={track.id} className="flex flex-wrap gap-x-2 rounded border bg-white p-3">
                <span className="font-medium">{track.title}</span>
                <span className="text-slate-600">
                  {stop ? stop.title : "nog geen halte"}
                </span>
                {stop?.id === map.currentStopId && (
                  <span className="ml-auto text-xs font-medium text-green-700">
                    wacht op jou
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {clearedBlockers.length > 0 && (
        <section className="space-y-2">
          {clearedBlockers.map((b) => (
            <Link key={b.id} href={`/registry/${b.id}`}
              className="block rounded border border-green-300 bg-green-50 p-3 text-sm">
              <span className="font-medium">{b.name}</span> — blocker cleared, ready to decide?{" "}
              <span className="text-slate-500">(The note was: {b.blockerNote})</span>
            </Link>
          ))}
        </section>
      )}
      <div className="grid grid-cols-5 gap-4">
        <Link href="/queue" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.pendingSuggestions}</p><p>to review</p></Link>
        <Link href="/vault" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.inboxDocs}</p><p>documents to sort</p></Link>
        <div className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.openActionItems}</p><p>open actions</p></div>
        <Link href="/registry" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{registry.itemCount}</p>
          <p>registry items · {formatEuro(registry.monthlyTotalCents)}/mo · {registry.pendingDecisions} pending</p></Link>
        <Link href="/tasks" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{taskStats.openCount}</p>
          <p>tasks open · {taskStats.overdueCount} overdue · {taskStats.waitingOnOthersCount} waiting on others</p></Link>
      </div>
      {/* Next to the registry tile, which counts the contracts: this shows what
          they actually cost against what comes in. A chart, not a stat, so it
          sits under the tile row rather than inside it. */}
      <DashboardMoney />
      <section>
        <h2 className="font-semibold mb-2">System health</h2>
        <ul className="text-sm space-y-1">
          {stats.lastWorkerRuns.map((w) => {
            const stale = Date.now() - w.ranAt.getTime() > staleMs;
            return <li key={w.worker}>{stale || w.status !== "ok" ? "🔴" : "🟢"} {w.worker} — last ran {w.ranAt.toLocaleTimeString("nl-NL")} ({w.status})</li>;
          })}
          {stats.lastWorkerRuns.length === 0 && <li>🟡 Watchers haven't reported yet.</li>}
        </ul>
      </section>
      {/* "Recent key events" used to live here, reading the flat timeline that
          this sub-project replaced. It is gone rather than re-pointed at stops:
          the block at the top already says where every open spoor stands, and a
          second, date-ordered list of stops would be the dashboard telling the
          same story twice — once without the map that gives it its meaning. */}
      <section>
        <h2 className="font-semibold mb-2">Recently logged</h2>
        <ul className="space-y-1">{recent.map((e) => (
          <li key={e.id}><Link className="hover:underline" href={`/logbook/${e.id}`}>{e.summary}</Link>
            <span className="text-xs text-slate-500"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")}</span></li>))}</ul>
      </section>
    </div>
  );
}
