/**
 * THE PROPOSAL LIFECYCLE, AND THE GOLDEN-RULE VERDICT (spec §6.5, §12.3).
 *
 * Pure: no DB, no I/O. The worker (create, store, send, recover) and the web
 * router (approve, reject, answer) both decide every move through
 * `canTransition`, so the one table below is the whole law.
 *
 * NEVER BACKWARDS. `sent`, `failed`, `rejected` and `superseded` are final, and
 * `sending` can only end. A failed send is not reset to `approved`: a new
 * attempt is a NEW proposal, so the record of what happened stays. The one
 * edge that looks backwards, `draft-failed → drafting`, is a retry of the
 * drafter, before anything was ever shown to Martin.
 *
 * `pending → sent` is legal ONLY for a `question`: answering one resolves to an
 * existing ledgered action inside the house and nothing leaves it, so there is
 * no `approved`/`sending` leg to walk. A reply or follow-up taking that edge
 * would mean a mail was recorded as sent without the send job ever claiming it.
 *
 * The verdict is separate from the lifecycle: the status says where the
 * proposal is, the verdict says what Martin thought of the draft.
 */

export const PROPOSAL_STATUSES = [
  "drafting", "draft-failed", "pending", "approved", "sending", "sent", "failed", "rejected", "superseded",
] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

export const PROPOSAL_KINDS = ["reply", "question", "follow-up"] as const;
export type ProposalKind = typeof PROPOSAL_KINDS[number];

export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  drafting: ["pending", "draft-failed", "superseded"],
  "draft-failed": ["drafting"],
  pending: ["approved", "rejected", "superseded", "sent"],
  approved: ["sending"],
  sending: ["sent", "failed"],
  sent: [],
  failed: [],
  rejected: [],
  superseded: [],
};

/** Statuses a newer message in the thread (or Martin's own reply) makes stale.
 *  Anything Martin already approved is his decision and is never taken back. */
export const SUPERSEDABLE_STATUSES = ["drafting", "pending"] as const satisfies readonly ProposalStatus[];

export function canTransition(from: ProposalStatus, to: ProposalStatus, kind: ProposalKind): boolean {
  if (!PROPOSAL_TRANSITIONS[from].includes(to)) return false;
  if (from === "pending" && to === "sent") return kind === "question";
  return true;
}

/** The editable part of a reply: what the phone shows and Martin may change. */
export interface ReplyPayload {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachmentDocumentIds: string[];
  /** The outbound log entry's summary (Task 14), shown and editable. */
  entrySummary?: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** Changed fields in a fixed order. Recipients and attachments are SETS: a
 *  reordering is not an edit. Text is compared exactly — a whitespace change is
 *  still something Martin did to the model's words, and the golden rule records
 *  it. */
function changedFields(model: ReplyPayload, final: ReplyPayload): string[] {
  const fields: string[] = [];
  if (!sameSet(model.to, final.to)) fields.push("to");
  if (!sameSet(model.cc, final.cc)) fields.push("cc");
  if (model.subject !== final.subject) fields.push("subject");
  if (model.body !== final.body) fields.push("body");
  if (!sameSet(model.attachmentDocumentIds, final.attachmentDocumentIds)) fields.push("attachmentDocumentIds");
  if ((model.entrySummary ?? "") !== (final.entrySummary ?? "")) fields.push("entrySummary");
  return fields;
}

export function verdictFor(modelPayload: ReplyPayload, finalPayload: ReplyPayload): "approved" | "edited" {
  return changedFields(modelPayload, finalPayload).length === 0 ? "approved" : "edited";
}

export function proposalDiff(
  modelPayload: ReplyPayload, finalPayload: ReplyPayload,
): { fields: string[]; body: string | null } {
  const fields = changedFields(modelPayload, finalPayload);
  return {
    fields,
    body: fields.includes("body") ? unifiedDiff(modelPayload.body, finalPayload.body) : null,
  };
}

const CONTEXT_LINES = 3;
/** Above this many LCS cells the diff degrades to delete-all/insert-all rather
 *  than spend the memory: a mail body is never this long in practice. */
const MAX_LCS_CELLS = 4_000_000;

type Op = { t: " " | "-" | "+"; line: string };

function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: "-", line: a[i] }); i++; }
    else { ops.push({ t: "+", line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

/** A line-based unified diff, in-house and dependency-free. Hunks carry
 *  CONTEXT_LINES of context and merge when their contexts touch. */
export function unifiedDiff(model: string, final: string): string | null {
  if (model === final) return null;
  const ops = lineOps(model.split("\n"), final.split("\n"));
  // Old/new line counts BEFORE each op, so a hunk can name where it starts.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nw = 0;
  for (const op of ops) {
    oldBefore.push(o); newBefore.push(nw);
    if (op.t !== "+") o++;
    if (op.t !== "-") nw++;
  }
  const changes = ops.flatMap((op, k) => (op.t === " " ? [] : [k]));
  const groups: Array<[number, number]> = [];
  for (const k of changes) {
    const from = Math.max(0, k - CONTEXT_LINES);
    const to = Math.min(ops.length, k + CONTEXT_LINES + 1);
    const last = groups[groups.length - 1];
    if (last && from <= last[1]) last[1] = to; else groups.push([from, to]);
  }
  const range = (start: number, count: number) =>
    count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;
  let out = "--- model\n+++ final\n";
  for (const [from, to] of groups) {
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    out += `@@ -${range(oldBefore[from] + 1, oldCount)} +${range(newBefore[from] + 1, newCount)} @@\n`;
    for (const op of slice) out += `${op.t}${op.line}\n`;
  }
  return out;
}
