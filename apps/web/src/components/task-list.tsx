import Link from "next/link";
import { Chip, Dot, Empty, Row, type ChipTone, type DotState } from "@/components/ui";

// Presentational (server-safe) pieces for the task screens. Statuses are
// process steps, never judgements — an overdue task is a nudge, not a failure.

export const TASK_STATUS_ORDER = [
  "open", "in-progress", "waiting", "done", "dropped",
] as const;

/**
 * The dot answers "who is this on?"; the chip answers "where is it?" — so the
 * two never say the same thing twice.
 *
 * The BASE mark for an open or in-progress task is the cyan ring, not amber:
 * it is running and it is Martin's, but it is not shouting. Amber is added on
 * top by `taskDot` below, and only once a due date has actually run out.
 *
 * This follows the approved mockup, whose task list gives the amber dot to the
 * overdue row alone and the cyan ring to the merely-open ones. The stricter
 * reading — every open task is by definition waiting on Martin, so every open
 * task is amber — is true and unusable: the Open tab is nothing BUT open tasks,
 * so it renders as a column of glowing amber dots, and a mark that is on every
 * row marks nothing. Amber earns its meaning by being rare.
 *
 * `waiting` means it sits with someone else. A dropped task takes the dim mark
 * rather than the steel one, because steel means "it happened" and dropped is
 * precisely the case where nothing did.
 */
const TASK_STATUS_DOT: Record<string, DotState> = {
  open: "open",
  "in-progress": "open",
  waiting: "waiting",
  done: "done",
  dropped: "waiting",
};

/** Tones for the status word itself — never amber, the dot already carries that. */
const TASK_STATUS_CHIP: Record<string, ChipTone> = {
  open: "mute",
  "in-progress": "signal",
  waiting: "faint",
  done: "okay",
  dropped: "faint",
};

const OPEN_SET: readonly string[] = ["open", "in-progress", "waiting"];

export function TaskStatusBadge({ status }: { status: string }) {
  return (
    <Chip
      tone={TASK_STATUS_CHIP[status] ?? "mute"}
      className={status === "dropped" ? "line-through" : undefined}>
      {status}
    </Chip>
  );
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

/**
 * Compact links to the evidence a task references. A chip that is also a link,
 * which the system has no primitive for yet — hence the classes spelled out.
 */
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
        <Link
          key={label}
          href={href}
          className="inline-flex items-center rounded-chip border border-edge px-[9px] py-[4px] font-mono text-[9.5px] tracking-[0.14em] uppercase text-ink-dim transition-colors hover:border-signal/35 hover:text-signal">
          {label}
        </Link>
      ))}
    </span>
  );
}

/**
 * The due date as the row's measured meta. Amber ONLY when it has actually run
 * out — a date that is merely coming up is a fact, not a summons.
 */
function dueMeta(task: TaskRow): { text: string; tone: "dim" | "attn" } | null {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  const overdue = OPEN_SET.includes(task.effectiveStatus) && due.getTime() < Date.now();
  const date = due.toLocaleDateString("nl-NL");
  return overdue
    ? { text: `was due ${date}`, tone: "attn" }
    : { text: `due ${date}`, tone: "dim" };
}

/**
 * The mark for one row: its status mark, promoted to amber when the date has
 * passed. `dueMeta` has already made exactly that judgement for the meta text
 * on the right, so the dot and the words can never disagree.
 */
function taskDot(task: TaskRow, due: ReturnType<typeof dueMeta>): DotState {
  if (due?.tone === "attn") return "you";
  return TASK_STATUS_DOT[task.effectiveStatus] ?? "open";
}

export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) {
    return <Empty title={"No tasks here — that's a good thing."} />;
  }
  return (
    // `Row as="li"` so the rows are real siblings inside a real list: a screen
    // reader announces how many tasks there are, and `Row`'s own `last:border-0`
    // still finds the last one.
    <ul>
      {tasks.map((task) => {
        const due = dueMeta(task);
        return (
            <Row
              as="li"
              key={task.id}
              state={taskDot(task, due)}
              title={
                <div className="flex flex-wrap items-center gap-[10px]">
                  <Link
                    href={`/tasks/${task.id}`}
                    className="truncate text-ink-soft transition-colors hover:text-signal">
                    {task.title}
                  </Link>
                  <TaskStatusBadge status={task.effectiveStatus} />
                  {task.assigneeName && <Chip tone="faint">{task.assigneeName}</Chip>}
                  <TaskLinkIcons task={task} />
                </div>
              }
              meta={due?.text}
              metaTone={due?.tone}
            />
        );
      })}
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
    return (
      <Empty
        title={'No status changes yet — it starts as "open", and that\'s exactly where it is.'}
      />
    );
  }
  return (
    <ol className="flex flex-col">
      {changes.map((c) => (
        <li key={c.id} className="border-b border-hairline py-[13px] last:border-0">
          <div className="flex flex-wrap items-center gap-[10px]">
            {/*
              Steel, always: every line here is a change that was recorded and
              can never be taken back. The chip beside it says which one.
            */}
            <Dot state="done" />
            <TaskStatusBadge status={c.status} />
            <span className="ml-auto font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim">
              {new Date(c.createdAt).toLocaleString("nl-NL")}
            </span>
          </div>
          {c.note && (
            <p className="mt-[7px] pl-[19px] text-[13.5px] font-light leading-relaxed whitespace-pre-wrap text-ink-soft">
              {c.note}
            </p>
          )}
          {c.overrideReason && (
            <p className="mt-[6px] pl-[19px] text-xs font-light text-ink-label">
              Off the usual path — {c.overrideReason}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
