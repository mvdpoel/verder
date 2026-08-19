import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { EnablePush } from "@/components/enable-push";
import { formatEuro } from "@/components/registry-list";
import { WsnpTimeline } from "@/components/wsnp-timeline";

export default async function DashboardPage() {
  const caller = await serverCaller();
  const stats = await caller.dashboard.stats();
  const registry = await caller.registry.stats();
  const taskStats = await caller.tasks.stats();
  const timeline = await caller.milestones.timeline();
  const recent = await caller.entries.list({ limit: 5 });
  const staleMs = 15 * 60 * 1000;
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Hi Martin 👋 — here's where things stand</h1>
        <EnablePush />
      </div>
      <WsnpTimeline stages={timeline.stages} countdown={timeline.countdown} />
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
        <h2 className="font-semibold mb-2">Recently logged</h2>
        <ul className="space-y-1">{recent.map((e) => (
          <li key={e.id}><Link className="hover:underline" href={`/logbook/${e.id}`}>{e.summary}</Link>
            <span className="text-xs text-slate-500"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")}</span></li>))}</ul>
      </section>
    </div>
  );
}
