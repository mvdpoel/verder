import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { EnablePush } from "@/components/enable-push";
import { DashboardMoney } from "@/components/dashboard-money";
import { formatEuro } from "@/components/registry-list";
import { WsnpTimeline } from "@/components/wsnp-timeline";
import { KIND_BADGE, KIND_LABEL } from "@/components/timeline-kinds";

export default async function DashboardPage() {
  const caller = await serverCaller();
  const stats = await caller.dashboard.stats();
  const registry = await caller.registry.stats();
  const taskStats = await caller.tasks.stats();
  const timeline = await caller.milestones.timeline();
  const clearedBlockers = await caller.registry.clearedBlockers();
  const keyEvents = await caller.timeline.recent({ limit: 5 });
  const recent = await caller.entries.list({ limit: 5 });
  const staleMs = 15 * 60 * 1000;
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Hi Martin 👋 — here's where things stand</h1>
        <EnablePush />
      </div>
      <WsnpTimeline stages={timeline.stages} countdown={timeline.countdown} />
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
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-semibold">Recent key events</h2>
          <Link className="text-sm text-slate-500 hover:underline" href="/timeline">full timeline →</Link>
        </div>
        {keyEvents.length === 0 ? (
          <p className="text-sm text-slate-500">
            No key events yet — <Link className="hover:underline" href="/timeline">add the moments that matter</Link>.
          </p>
        ) : (
          <ul className="space-y-1">{keyEvents.map((e) => (
            <li key={e.id} className="text-sm">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_BADGE[e.kind] ?? KIND_BADGE.other}`}>
                {KIND_LABEL[e.kind] ?? e.kind}
              </span>{" "}
              <Link className="hover:underline" href="/timeline">{e.title}</Link>
              <span className="text-xs text-slate-500"> · {new Date(e.happenedAt).toLocaleDateString("nl-NL")}</span>
            </li>))}</ul>
        )}
      </section>
      <section>
        <h2 className="font-semibold mb-2">Recently logged</h2>
        <ul className="space-y-1">{recent.map((e) => (
          <li key={e.id}><Link className="hover:underline" href={`/logbook/${e.id}`}>{e.summary}</Link>
            <span className="text-xs text-slate-500"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")}</span></li>))}</ul>
      </section>
    </div>
  );
}
