import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TaskForm } from "@/components/task-form";
import { TaskStatusForm } from "@/components/task-status-form";
import { TaskStatusBadge, TaskStatusTimeline } from "@/components/task-list";
import { taskFormOptions } from "../form-options";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const task = await caller.tasks.get({ id });
  const options = await taskFormOptions();
  const { linked } = task;
  const evidence: { label: string; text: string; href: string }[] = [];
  if (linked.entry) evidence.push({
    label: "Logbook entry", text: linked.entry.summary, href: `/logbook/${linked.entry.id}` });
  if (linked.financialItem) evidence.push({
    label: "Registry item", text: linked.financialItem.name, href: `/registry/${linked.financialItem.id}` });
  if (linked.debt) evidence.push({
    label: "Debt", text: linked.debt.creditorName, href: `/registry/debts/${linked.debt.id}` });
  if (linked.document) evidence.push({
    label: "Document", text: linked.document.title, href: `/vault/${linked.document.id}` });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <TaskStatusBadge status={task.effectiveStatus} />
        {task.assigneeName && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {task.assigneeName}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-8 items-start">
        <div className="space-y-6">
          <TaskForm task={{
            id: task.id, title: task.title, details: task.details,
            assigneePartyId: task.assigneePartyId, dueAt: task.dueAt,
            entryId: task.entryId, financialItemId: task.financialItemId,
            debtId: task.debtId, documentId: task.documentId,
          }} options={options} />
          <section>
            <h2 className="font-semibold mb-2">Linked evidence</h2>
            {evidence.length === 0
              ? <p className="text-sm text-slate-600">Not linked to anything yet — that&apos;s fine.</p>
              : (
                <ul className="space-y-1">
                  {evidence.map((e) => (
                    <li key={e.href} className="text-sm">
                      <span className="text-slate-500">{e.label}: </span>
                      <Link href={e.href} className="underline">{e.text}</Link>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
        <div className="space-y-6">
          <TaskStatusForm taskId={task.id} currentStatus={task.effectiveStatus} />
          <section>
            <h2 className="font-semibold mb-2">Status trail — every step on record</h2>
            <TaskStatusTimeline changes={task.statusTimeline} />
          </section>
        </div>
      </div>
    </div>
  );
}
