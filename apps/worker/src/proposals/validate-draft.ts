import { isValidTaskTransition, TASK_STATUSES } from "@verder/api/src/task-status";
import type { ReplyPayload } from "@verder/api/src/proposal-state";
import type { ContextItem, ProposalContext } from "./context";

/**
 * NOTHING THE CONTEXT DID NOT OFFER IS EVER SHOWN AS A DRAFT (spec §6.5,
 * Review Focus 6).
 *
 * The drafter's answer is untrusted twice over: it is a model's output, and the
 * model read third-party mail that may have been written to steer it. So the
 * answer is parsed strictly and every reference in it is checked against the
 * context the worker assembled (`gatherContext`), which is the WHOLE of what a
 * draft may use:
 *
 *   - every recipient (to AND cc) must be in `ctx.addresses`;
 *   - every attachment must be in `ctx.attachable` (effectively not discarded,
 *     not purged when gathered — a thread attachment that was discarded is in
 *     the thread but NOT attachable, and is refused);
 *   - every `reliedOn` id must be an item of the context;
 *   - a reply's subject is the one the context SET (`ctx.reply.subject`), never
 *     one the model invented — threading and the 7-day clock depend on it;
 *   - a question's option may only act on a task in `ctx.tasks` (with a move
 *     `isValidTaskTransition` allows from that task's status when gathered), a
 *     debt in `ctx.debts`, or a document in `ctx.attachable`.
 *
 * Any failure refuses the WHOLE draft: the proposal becomes `draft-failed`
 * with the reason, and the raw output is kept for the golden rule. A partly
 * valid draft is never trimmed into a valid one, because the part that failed
 * is exactly the part an attacker wrote.
 *
 * The server re-checks attachments and option targets on approve/answer
 * (Task 15), because the world moves between drafting and Martin's tap.
 *
 * Pure: no DB, no I/O.
 */

export const ASK_MAX = 120;
export const ENTRY_SUMMARY_MAX = 100;
const SUBJECT_MAX = 300;
const BODY_MAX = 20_000;
const LABEL_MAX = 120;
const LIST_MAX = 20;

export type QuestionOption =
  | { action: "set-task-status"; taskId: string; status: string; label: string }
  | { action: "link-document-to-debt"; documentId: string; debtId: string; label: string }
  | { action: "create-task"; title: string; dueAt: string | null; label: string }
  | { action: "none"; label: string };

export interface ReplyDraft {
  to: string[]; cc: string[]; subject: string; body: string; attachmentDocumentIds: string[];
}

export interface ReliedOn { type: ContextItem["type"]; id: string; why: string }

/** What `proposals.payload` holds: everything the model returned, validated. */
export interface DraftPayload {
  ask: string;
  dueAt: string | null;
  missing: string[];
  entrySummary: string;
  reply: ReplyDraft | null;
  task: { title: string; dueAt: string | null } | null;
  question: { prompt: string; options: QuestionOption[] } | null;
  reliedOn: ReliedOn[];
}

export type DraftResult =
  | { ok: true; payload: DraftPayload; reliedOn: ReliedOn[] }
  | { ok: false; reason: string };

/** The editable reply as `verdictFor`/`proposalDiff` and the phone see it. */
export function replyPayloadOf(p: DraftPayload): ReplyPayload | null {
  return p.reply ? { ...p.reply, entrySummary: p.entrySummary } : null;
}

class Refusal extends Error {}
const refuse = (reason: string): never => { throw new Refusal(reason); };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, opts: { min?: number; max: number }): string {
  if (typeof v !== "string") return refuse(`${field} is not a string`);
  const t = v.trim();
  if (t.length < (opts.min ?? 1)) return refuse(`${field} is empty`);
  if (t.length > opts.max) return refuse(`${field} is longer than ${opts.max} characters`);
  return t;
}

/** null, or a calendar date / ISO timestamp that parses. */
function date(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())
    || Number.isNaN(Date.parse(v.trim()))) {
    return refuse(`${field} is not a date`);
  }
  return v.trim();
}

function strList(v: unknown, field: string, max = LIST_MAX): string[] {
  if (!Array.isArray(v)) return refuse(`${field} is not a list`);
  if (v.length > max) return refuse(`${field} has more than ${max} entries`);
  return v.map((x, i) => str(x, `${field}[${i}]`, { max: 500 }));
}

/** The model's answer as one JSON object; one surrounding code fence is tolerated. */
function parse(raw: string): Obj {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  let v: unknown;
  try { v = JSON.parse(text); } catch { return refuse("the answer is not JSON"); }
  if (!isObj(v)) return refuse("the answer is not JSON object");
  return v;
}

function reply(v: Obj, ctx: ProposalContext): ReplyDraft {
  const allowed = new Set(ctx.addresses.map((a) => a.toLowerCase()));
  const recipients = (list: unknown, field: string): string[] => {
    const out: string[] = [];
    for (const a of strList(list, field)) {
      const lower = a.toLowerCase();
      if (!allowed.has(lower)) refuse(`${field} recipient ${a.slice(0, 80)} is not in the context`);
      if (!out.includes(lower)) out.push(lower);
    }
    return out;
  };
  const to = recipients(v.to, "reply.to");
  if (to.length === 0) refuse("reply.to names no recipient");
  const cc = recipients(v.cc ?? [], "reply.cc").filter((a) => !to.includes(a));

  const subject = str(v.subject, "reply.subject", { max: SUBJECT_MAX });
  if (ctx.reply && subject !== ctx.reply.subject.trim()) {
    refuse(`reply.subject is not the thread's subject ${JSON.stringify(ctx.reply.subject)}`);
  }
  if (typeof v.body !== "string" || v.body.trim() === "") refuse("reply.body is empty");
  const body = (v.body as string).replace(/\s+$/, "");
  if (body.length > BODY_MAX) refuse(`reply.body is longer than ${BODY_MAX} characters`);

  const attachable = new Set(ctx.attachable.map((d) => d.id));
  const attachmentDocumentIds: string[] = [];
  for (const id of strList(v.attachmentDocumentIds ?? [], "reply.attachmentDocumentIds")) {
    if (!attachable.has(id)) refuse(`attachment ${id.slice(0, 40)} is not attachable in this context`);
    if (!attachmentDocumentIds.includes(id)) attachmentDocumentIds.push(id);
  }
  return { to, cc, subject, body, attachmentDocumentIds };
}

function option(v: unknown, i: number, ctx: ProposalContext): QuestionOption {
  const f = `question.options[${i}]`;
  if (!isObj(v)) return refuse(`${f} is not an object`);
  const label = str(v.label, `${f}.label`, { max: LABEL_MAX });
  switch (v.action) {
    case "set-task-status": {
      const taskId = str(v.taskId, `${f}.taskId`, { max: 64 });
      const task = ctx.tasks.find((t) => t.id === taskId);
      if (!task) return refuse(`${f} targets task ${taskId.slice(0, 40)}, which is not in the context`);
      const status = str(v.status, `${f}.status`, { max: 20 });
      if (!(TASK_STATUSES as readonly string[]).includes(status)) return refuse(`${f}.status ${status} is unknown`);
      if (!task.status) return refuse(`${f}: the context does not know the task's status`);
      if (!isValidTaskTransition(task.status, status)) {
        return refuse(`${f}: task status cannot move ${task.status} → ${status}`);
      }
      return { action: "set-task-status", taskId, status, label };
    }
    case "link-document-to-debt": {
      const documentId = str(v.documentId, `${f}.documentId`, { max: 64 });
      const debtId = str(v.debtId, `${f}.debtId`, { max: 64 });
      if (!ctx.attachable.some((d) => d.id === documentId)) {
        return refuse(`${f} links document ${documentId.slice(0, 40)}, which is not in the context`);
      }
      if (!ctx.debts.some((d) => d.id === debtId)) {
        return refuse(`${f} links debt ${debtId.slice(0, 40)}, which is not in the context`);
      }
      return { action: "link-document-to-debt", documentId, debtId, label };
    }
    case "create-task":
      return {
        action: "create-task", title: str(v.title, `${f}.title`, { max: 200 }),
        dueAt: date(v.dueAt, `${f}.dueAt`), label,
      };
    case "none":
      return { action: "none", label };
    default:
      return refuse(`${f}.action ${JSON.stringify(v.action)?.slice(0, 40)} is not allowed`);
  }
}

function question(v: Obj, ctx: ProposalContext): DraftPayload["question"] {
  const prompt = str(v.prompt, "question.prompt", { max: 500 });
  if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 4) {
    return refuse("a question needs 2 to 4 options");
  }
  return { prompt, options: v.options.map((o, i) => option(o, i, ctx)) };
}

/** Every item of the context, by id (first occurrence's type wins). */
function contextIndex(ctx: ProposalContext): Map<string, ContextItem["type"]> {
  const out = new Map<string, ContextItem["type"]>();
  const add = (i: ContextItem | null) => {
    if (!i) return;
    if (!out.has(i.id)) out.set(i.id, i.type);
    for (const a of i.attachments ?? []) add(a);
  };
  for (const i of [ctx.trigger, ...ctx.thread, ctx.party, ctx.parentParty, ...ctx.entries, ...ctx.debts,
    ...ctx.tasks, ...ctx.stops, ...ctx.kb, ...ctx.sentDocuments, ...ctx.attachable]) add(i);
  return out;
}

export function validateDraft(raw: string, ctx: ProposalContext): DraftResult {
  try {
    const v = parse(raw);
    const hasReply = v.reply !== null && v.reply !== undefined;
    const hasQuestion = v.question !== null && v.question !== undefined;
    if (hasReply === hasQuestion) refuse("exactly one of reply and question must be set");

    const ask = str(v.ask, "ask", { max: ASK_MAX });
    const entrySummary = str(v.entrySummary, "entrySummary", { max: ENTRY_SUMMARY_MAX });
    const dueAt = date(v.dueAt, "dueAt");
    const missing = strList(v.missing ?? [], "missing");

    let task: DraftPayload["task"] = null;
    if (v.task !== null && v.task !== undefined) {
      if (!isObj(v.task)) refuse("task is not an object");
      const t = v.task as Obj;
      task = { title: str(t.title, "task.title", { max: 200 }), dueAt: date(t.dueAt, "task.dueAt") };
    }

    let replyDraft: ReplyDraft | null = null;
    let q: DraftPayload["question"] = null;
    if (hasReply) {
      if (!isObj(v.reply)) refuse("reply is not an object");
      replyDraft = reply(v.reply as Obj, ctx);
    } else {
      if (!isObj(v.question)) refuse("question is not an object");
      q = question(v.question as Obj, ctx);
    }

    const index = contextIndex(ctx);
    if (!Array.isArray(v.reliedOn)) refuse("reliedOn is not a list");
    const reliedList = v.reliedOn as unknown[];
    if (reliedList.length > 50) refuse("reliedOn has more than 50 entries");
    const reliedOn: ReliedOn[] = reliedList.map((r, i) => {
      if (!isObj(r)) return refuse(`reliedOn[${i}] is not an object`);
      const id = str(r.id, `reliedOn[${i}].id`, { max: 64 });
      const type = index.get(id);
      if (!type) return refuse(`reliedOn[${i}] cites ${id.slice(0, 40)}, which is not in the context`);
      const why = typeof r.why === "string" ? r.why.trim().slice(0, 300) : "";
      return { type, id, why };
    });

    const payload: DraftPayload = {
      ask, dueAt, missing, entrySummary, reply: replyDraft, task, question: q, reliedOn,
    };
    return { ok: true, payload, reliedOn };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}
