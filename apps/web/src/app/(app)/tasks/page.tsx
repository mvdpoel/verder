import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TaskList } from "@/components/task-list";

const TABS = [
  ["open", "Open"],
  ["waiting", "Waiting on others"],
  ["done", "Done"],
] as const;

export default async function TasksPage({ searchParams }: {
  searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab: "open" | "waiting" | "done" =
    tabParam === "waiting" ? "waiting" : tabParam === "done" ? "done" : "open";
  const caller = await serverCaller();
  const tasks = await caller.tasks.list({ filter: tab });

  const tabClass = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <Link href="/tasks/new" className="rounded bg-slate-900 text-white px-4 py-2">+ Add</Link>
      </div>
      <p className="text-slate-600">
        One step at a time — every task here has a tamper-proof status trail.
      </p>
      <nav className="flex gap-2 border-b pb-2">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/tasks?tab=${key}`} className={tabClass(tab === key)}>
            {label}
          </Link>
        ))}
      </nav>
      <TaskList tasks={tasks} />
    </div>
  );
}
