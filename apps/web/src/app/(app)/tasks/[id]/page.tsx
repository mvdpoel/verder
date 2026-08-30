import { serverCaller } from "@/lib/trpc-server";
import { orNotFound } from "@/lib/not-found";
import { TaskForm } from "@/components/task-form";
import { TaskStatusForm } from "@/components/task-status-form";
import { TaskStatusBadge, TaskStatusTimeline } from "@/components/task-list";
import { taskFormOptions } from "../form-options";
import { Chip, Empty, PageTitle, Panel, PanelHead, Row, TextLink } from "@/components/ui";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const [task, options] = await Promise.all([
    orNotFound(caller.tasks.get({ id })),
    taskFormOptions(),
  ]);
  const { linked } = task;
  const evidence: { label: string; text: string; href: string }[] = [];
  if (linked.entry) evidence.push({
    label: "Logboekregel", text: linked.entry.summary, href: `/logbook/${linked.entry.id}` });
  if (linked.financialItem) evidence.push({
    label: "Post in het register", text: linked.financialItem.name, href: `/registry/${linked.financialItem.id}` });
  if (linked.debt) evidence.push({
    label: "Vordering", text: linked.debt.creditorName, href: `/registry/debts/${linked.debt.id}` });
  if (linked.document) evidence.push({
    label: "Document", text: linked.document.title, href: `/vault/${linked.document.id}` });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-[14px]">
        <PageTitle>
          {task.title}
        </PageTitle>
        <TaskStatusBadge status={task.effectiveStatus} />
        {task.assigneeName && <Chip tone="faint">{task.assigneeName}</Chip>}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <TaskForm task={{
            id: task.id, title: task.title, details: task.details,
            assigneePartyId: task.assigneePartyId, dueAt: task.dueAt,
            entryId: task.entryId, financialItemId: task.financialItemId,
            debtId: task.debtId, documentId: task.documentId,
          }} options={options} />
          <Panel className="p-[26px]">
            <div className="flex flex-col gap-[14px]">
              <PanelHead labelAs="h2" label="Gekoppeld bewijs" />
              {evidence.length === 0
                ? <Empty title="Nog nergens aan gekoppeld — dat mag." />
                : (
                  /*
                    A junction mark, not a done one: each of these is a record
                    that lives elsewhere and can be walked to from here.
                  */
                  <div>
                    {evidence.map((e) => (
                      <Row
                        key={e.href}
                        state="junction"
                        kicker={e.label}
                        title={
                          <TextLink href={e.href}>
                            {e.text}
                          </TextLink>
                        }
                      />
                    ))}
                  </div>
                )}
            </div>
          </Panel>
        </div>
        <div className="flex flex-col gap-6">
          <TaskStatusForm taskId={task.id} currentStatus={task.effectiveStatus} />
          <Panel className="p-[26px]">
            <div className="flex flex-col gap-[14px]">
              <PanelHead labelAs="h2" label="Statusspoor — elke stap blijft staan" />
              <TaskStatusTimeline changes={task.statusTimeline} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
