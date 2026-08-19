import Link from "next/link";

// Presentational (server-safe) pieces for the task screens. Statuses are
// process steps, never judgements — an overdue task is a nudge, not a failure.

export const TASK_STATUS_ORDER = [
  "open", "in-progress", "waiting", "done", "dropped",
] as const;

const TASK_STATUS_BADGE: Record<string, string> = {
  open: "bg-slate-100 text-slate-700",
  "in-progress": "bg-blue-100 text-blue-700",
  waiting: "bg-amber-100 text-amber-700",
  done: "bg-green-100 text-green-700",
  dropped: "bg-gray-100 text-gray-500 line-through",
};

const OPEN_SET: readonly string[] = ["open", "in-progress", "waiting"];

export function TaskStatusBadge({ status }: { status: string }) {
  const cls = TASK_STATUS_BADGE[status] ?? "bg-slate-100 text-slate-700";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

export type TaskRow = {
  id: string;
  title: string;
  effectiveStatus: string;
  assigneeName: string | null;
  dueAt: Date | null;
  entryId: string | null;
  financialItemId: string | null;
  debtId: string | null;
  documentId: string | null;
};

/** Compact links to the evidence a task references. */
function TaskLinkIcons({ task }: { task: TaskRow }) {
  const links: [string, string][] = [];
  if (task.entryId) links.push(["entry", `/logbook/${task.entryId}`]);
  if (task.financialItemId) links.push(["item", `/registry/${task.financialItemId}`]);
  if (task.debtId) links.push(["debt", `/registry/debts/${task.debtId}`]);
  if (task.documentId) links.push(["doc", `/vault/${task.documentId}`]);
  if (links.length === 0) return null;
  return (
    <span className="flex gap-1">
      {links.map(([label, href]) => (
        <Link key={label} href={href}
          className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100">
          {label}
        </Link>
      ))}
    </span>
  );
}

function DueDate({ task }: { task: TaskRow }) {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  const overdue = OPEN_SET.includes(task.effectiveStatus) && due.getTime() < Date.now();
  return overdue
    ? <span className="shrink-0 text-sm text-red-600">was due {due.toLocaleDateString("nl-NL")}</span>
    : <span className="shrink-0 text-sm text-slate-500">due {due.toLocaleDateString("nl-NL")}</span>;
}

export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) {
    return <p className="text-slate-600">No tasks here — that&apos;s a good thing.</p>;
  }
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <li key={task.id} className="rounded border bg-white p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <TaskStatusBadge status={task.effectiveStatus} />
            <Link href={`/tasks/${task.id}`} className="font-medium hover:underline truncate">
              {task.title}
            </Link>
            {task.assigneeName && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {task.assigneeName}
              </span>
            )}
            <TaskLinkIcons task={task} />
          </div>
          <DueDate task={task} />
        </li>
      ))}
    </ul>
  );
}

export type TaskStatusChangeRow = {
  id: string;
  status: string;
  note: string | null;
  overrideReason: string | null;
  createdAt: Date;
};

/** Read-only ledger-backed status timeline, newest first. */
export function TaskStatusTimeline({ changes }: { changes: TaskStatusChangeRow[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-slate-600">No status changes yet — it starts as &quot;open&quot;, and that&apos;s exactly where it is.</p>;
  }
  return (
    <ol className="space-y-3">
      {changes.map((c) => (
        <li key={c.id} className="rounded border bg-white p-3">
          <div className="flex items-center gap-2">
            <TaskStatusBadge status={c.status} />
            <span className="text-xs text-slate-500">
              {new Date(c.createdAt).toLocaleString("nl-NL")}
            </span>
          </div>
          {c.note && <p className="mt-1 text-sm whitespace-pre-wrap">{c.note}</p>}
          {c.overrideReason && (
            <p className="mt-1 text-xs text-slate-500">Off the usual path — {c.overrideReason}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
