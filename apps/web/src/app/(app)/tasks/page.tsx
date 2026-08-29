import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TaskList } from "@/components/task-list";
import { buttonClass, PageTitle, Panel, Tabs } from "@/components/ui";

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-[10px]">
          <PageTitle>Tasks</PageTitle>
          <p className="max-w-lg text-[13.5px] font-light leading-relaxed text-ink-mute">
            One step at a time — every task here has a tamper-proof status trail.
          </p>
        </div>
        {/* The one thing to press on this screen, so the one glowing button. */}
        <Link href="/tasks/new" className={buttonClass("primary")}>+ Add</Link>
      </div>
      <Tabs
        items={TABS.map(([key, label]) => ({ key, label, href: `/tasks?tab=${key}` }))}
        active={tab}
      />
      <Panel lit className="p-[26px]">
        <TaskList tasks={tasks} />
      </Panel>
    </div>
  );
}
