import { readFile } from "node:fs/promises";
import { and, eq, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "@grip/api/src/effective-status";
import { readFilePath } from "@grip/api/src/storage";
import { REQUEST_RUNNER_WORKER_NAME } from "@grip/api/src/worker-names";
import { rateLimitedUntil, resolveSenderPartyId } from "../gmail";
import { recordRun } from "../heartbeat";
import { matchesList } from "../mail/priority";
import { operatorAddresses, ownMailboxAddresses } from "../mail/relevance";
import { replyHeaders, replySubject, threadAncestry, threadingHeaders } from "../mail/threading";
import type { NotifyFn } from "../notify/notify";
import { REQUEST_PROMPT_VERSION } from "./prompt";

/**
 * THE RESEARCHER'S ANSWER, BACK INTO THE DOSSIER (Vraag Grip spec, "The answer
 * schema"). Called only by ops/request-runner.sh with `claude -p`'s output on
 * stdin; the answer is untrusted twice over (a model's output, after reading
 * third-party mail), so it is parsed strictly and every reference in it is
 * checked against the request's TOOL LOG — the record of what the read-only
 * tools actually showed — never against what the model claims.
 *
 * REFUSED (request `failed`, reason recorded, the raw output kept, NOTHING
 * created) when:
 *   - the answer does not parse as one JSON object of the schema;
 *   - a source's (type, id) never appeared in a tool result;
 *   - an attachment id never appeared as a document in a tool result, or is
 *     discarded or purged by now;
 *   - a recipient address never appeared in a tool result's `addresses`, or is
 *     Martin's own;
 *   - `inReplyTo` names a message that was not READ through a tool (get_mail /
 *     gmail_read), or a reply's subject is not that message's reply subject;
 *   - a compose names a message to reply to, or a reply names none.
 * A partly valid answer is never trimmed into a valid one: the part that failed
 * is exactly the part an injected instruction would have written.
 *
 * A follow-up may cite what its ANCESTORS' tools showed: those are tool results
 * of the same conversation, and "Vraag door" builds on them.
 *
 * NOT EVIDENCE. A request appends no ledger event. A proposal it carries is a
 * `pending` proposal like any other: it goes through the existing approval
 * screen and `proposal-send`, and only a SENT one writes `entry.created`.
 */

export const MAX_ANSWER_CHARS = 256 * 1024;
const ANSWER_MAX = 8000;
const WHY_MAX = 300;
const STEP_MAX = 300;
const SOURCES_MAX = 40;
const STEPS_MAX = 12;
const RECIPIENTS_MAX = 10;
const ATTACHMENTS_MAX = 10;
const SUBJECT_MAX = 300;
const BODY_MAX = 20_000;
const ASK_MAX = 120;
const ENTRY_SUMMARY_MAX = 100;
/** A `working` request older than this was abandoned by a dead runner. */
export const STUCK_AFTER_MS = 15 * 60_000;
const SOURCE_TYPES = new Set(schema.REQUEST_SOURCE_TYPES as readonly string[]);

type ToolCall = schema.RequestToolCall;
type Source = schema.RequestSource;
type RequestRow = typeof schema.requests.$inferSelect;

export interface ProposalDraft {
  kind: "reply" | "compose";
  to: string[]; cc: string[]; subject: string; body: string; attachments: string[];
  inReplyTo: { rawEmailId: string } | { gmailId: string } | null;
}
export interface ValidAnswer { answer: string; sources: Source[]; martinSteps: string[]; proposal: ProposalDraft | null }
export type Validation = { ok: true; value: ValidAnswer } | { ok: false; reason: string };

class Refusal extends Error {}
const refuse = (reason: string): never => { throw new Refusal(reason); };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") return refuse(`${field} is not a string`);
  const t = v.trim();
  if (t === "") return refuse(`${field} is empty`);
  if (t.length > max) return refuse(`${field} is longer than ${max} characters`);
  return t;
}
function list(v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return refuse(`${field} is not a list`);
  if (v.length > max) return refuse(`${field} has more than ${max} entries`);
  return v;
}
function parse(raw: string): Obj {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  let v: unknown;
  try { v = JSON.parse(text); } catch { return refuse("the answer is not JSON"); }
  if (!isObj(v)) return refuse("the answer is not a JSON object");
  return v;
}

/** What the tool log says the tools showed: refs by `type:id`, addresses, and
 *  the messages that were READ (not merely listed). */
export function seenIn(logs: readonly ToolCall[]) {
  const refs = new Map<string, string | undefined>();
  const addresses = new Set<string>();
  const readMail = new Set<string>();
  const readGmail = new Map<string, NonNullable<ToolCall["mail"]>>();
  for (const c of logs) {
    if (c.error) continue;
    for (const r of c.ids ?? []) {
      if (r.type === "address") addresses.add(r.id.toLowerCase());
      else if (!refs.has(`${r.type}:${r.id}`)) refs.set(`${r.type}:${r.id}`, r.label);
      if (c.tool === "get_mail" && r.type === "mail") readMail.add(r.id);
    }
    if (c.tool === "gmail_read" && c.mail) readGmail.set(c.mail.gmailId, c.mail);
  }
  return { refs, addresses, readMail, readGmail };
}

/** Pure: the answer against the tool log. The database checks follow in storeAnswer. */
export function validateAnswer(raw: string, logs: readonly ToolCall[], own: readonly string[]): Validation {
  try {
    const v = parse(raw);
    const seen = seenIn(logs);
    const answer = str(v.answer, "answer", ANSWER_MAX);

    const sources: Source[] = list(v.sources, "sources", SOURCES_MAX).map((s, i) => {
      if (!isObj(s)) return refuse(`sources[${i}] is not an object`);
      const type = str(s.type, `sources[${i}].type`, 20);
      if (!SOURCE_TYPES.has(type)) return refuse(`sources[${i}].type ${type} is not a source type`);
      const id = str(s.id, `sources[${i}].id`, 80);
      if (!seen.refs.has(`${type}:${id}`)) return refuse(`sources[${i}] cites ${type} ${id.slice(0, 40)}, which no tool showed`);
      const why = typeof s.why === "string" ? s.why.trim().slice(0, WHY_MAX) : "";
      const label = seen.refs.get(`${type}:${id}`);
      return { type: type as Source["type"], id, why, ...(label ? { label } : {}) };
    });
    const martinSteps = list(v.martinSteps, "martinSteps", STEPS_MAX)
      .map((s, i) => str(s, `martinSteps[${i}]`, STEP_MAX));

    let proposal: ProposalDraft | null = null;
    if (v.proposal !== null && v.proposal !== undefined) {
      if (!isObj(v.proposal)) refuse("proposal is not an object");
      const p = v.proposal as Obj;
      const kind = p.kind;
      if (kind !== "reply" && kind !== "compose") refuse(`proposal.kind ${JSON.stringify(kind)?.slice(0, 20)} is not reply or compose`);
      const ownSet = new Set(own.map((a) => a.toLowerCase()));
      const recipients = (l: unknown, field: string, min: number): string[] => {
        const out: string[] = [];
        for (const [i, a] of list(l, field, RECIPIENTS_MAX).entries()) {
          const addr = str(a, `${field}[${i}]`, 320).toLowerCase();
          if (ownSet.has(addr)) refuse(`${field} recipient ${addr.slice(0, 80)} is Martin's own address`);
          if (!seen.addresses.has(addr)) refuse(`${field} recipient ${addr.slice(0, 80)} never appeared in a tool result`);
          if (!out.includes(addr)) out.push(addr);
        }
        if (out.length < min) refuse(`${field} names no recipient`);
        return out;
      };
      const to = recipients(p.to, "proposal.to", 1);
      const cc = recipients(p.cc, "proposal.cc", 0).filter((a) => !to.includes(a));
      const subject = str(p.subject, "proposal.subject", SUBJECT_MAX);
      if (typeof p.body !== "string" || p.body.trim() === "") refuse("proposal.body is empty");
      const body = (p.body as string).replace(/\s+$/, "");
      if (body.length > BODY_MAX) refuse(`proposal.body is longer than ${BODY_MAX} characters`);
      const attachments: string[] = [];
      for (const [i, a] of list(p.attachments, "proposal.attachments", ATTACHMENTS_MAX).entries()) {
        const id = str(a, `proposal.attachments[${i}]`, 80);
        if (!seen.refs.has(`document:${id}`)) refuse(`attachment ${id.slice(0, 40)} never appeared as a document in a tool result`);
        if (!attachments.includes(id)) attachments.push(id);
      }
      let inReplyTo: ProposalDraft["inReplyTo"] = null;
      if (p.inReplyTo !== null && p.inReplyTo !== undefined) {
        if (!isObj(p.inReplyTo)) refuse("proposal.inReplyTo is not an object");
        const r = p.inReplyTo as Obj;
        if (typeof r.rawEmailId === "string" && r.gmailId === undefined) {
          if (!seen.readMail.has(r.rawEmailId)) refuse(`inReplyTo mail ${r.rawEmailId.slice(0, 40)} was not read through get_mail`);
          inReplyTo = { rawEmailId: r.rawEmailId };
        } else if (typeof r.gmailId === "string" && r.rawEmailId === undefined) {
          const m = seen.readGmail.get(r.gmailId);
          if (!m) refuse(`inReplyTo Gmail message ${r.gmailId.slice(0, 40)} was not read through gmail_read`);
          if (subject !== replySubject(m!.subject).trim()) refuse(`proposal.subject is not the reply subject ${JSON.stringify(replySubject(m!.subject))}`);
          inReplyTo = { gmailId: r.gmailId };
        } else refuse("proposal.inReplyTo names neither one rawEmailId nor one gmailId");
      }
      if (kind === "reply" && !inReplyTo) refuse("a reply names no message in inReplyTo");
      if (kind === "compose" && inReplyTo) refuse("a compose replies to nothing; inReplyTo must be null");
      proposal = { kind: kind as ProposalDraft["kind"], to, cc, subject, body, attachments, inReplyTo };
    }
    return { ok: true, value: { answer, sources, martinSteps, proposal } };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}

/** The tool logs this request may cite: its own and its ancestors'. */
async function citableLogs(db: Db, row: RequestRow): Promise<ToolCall[]> {
  const logs: ToolCall[] = [...(row.toolLog ?? [])];
  const seen = new Set([row.id]);
  let parentId = row.parentRequestId;
  while (parentId && !seen.has(parentId) && seen.size < 12) {
    seen.add(parentId);
    const [p] = await db.select({ log: schema.requests.toolLog, parent: schema.requests.parentRequestId })
      .from(schema.requests).where(eq(schema.requests.id, parentId));
    if (!p) break;
    logs.push(...(p.log ?? []));
    parentId = p.parent;
  }
  return logs;
}

export interface StoreDeps { db: Db; notify: NotifyFn; vaultDir: string; now?: () => Date }
export type StoreOutcome = "answered" | "failed" | "not-working" | "not-found";
export interface StoreResult { outcome: StoreOutcome; reason?: string; proposalId?: string }

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The proposal row a valid draft becomes, after the database checks. Throws a
 *  Refusal when the world disagrees with the tool log. */
async function proposalFor(tx: Db, deps: StoreDeps, row: RequestRow, v: ValidAnswer, logs: ToolCall[], model: string,
  answerRaw: string): Promise<typeof schema.proposals.$inferInsert> {
  const p = v.proposal!;
  const seen = seenIn(logs);
  const own = new Set(ownMailboxAddresses());

  // Attachments re-resolved NOW: a discard is never written back to
  // documents.status, and a purge is a row of its own.
  if (p.attachments.length) {
    const live = await tx.select({ id: schema.documents.id }).from(schema.documents)
      .where(and(inArray(schema.documents.id, p.attachments), notDiscardedSql, notPurgedSql));
    const ok = new Set(live.map((d) => d.id));
    for (const id of p.attachments) if (!ok.has(id)) refuse(`attachment ${id.slice(0, 40)} is discarded or purged`);
  }
  // What Martin may still add on the approval screen: every live document the
  // tools showed — never one they did not.
  const shownDocs = [...seen.refs.keys()].filter((k) => k.startsWith("document:")).map((k) => k.slice(9));
  const attachable = shownDocs.length === 0 ? [] : await tx
    .select({ id: schema.documents.id, title: effectiveTitleSql }).from(schema.documents)
    .where(and(inArray(schema.documents.id, shownDocs), notDiscardedSql, notPurgedSql));

  let trigger: { type: string; id: string; label: string };
  let reply: { inReplyTo?: string; references?: string; subject: string } | null = null;
  let threadKey: string | null = null;
  let gmailThreadId: string | null = null;
  let triggerExternal: unknown = null;
  if (p.inReplyTo && "rawEmailId" in p.inReplyTo) {
    const [m] = await tx.select().from(schema.rawEmails).where(eq(schema.rawEmails.id, p.inReplyTo.rawEmailId));
    if (!m) refuse("inReplyTo names a mail that no longer exists");
    if (p.subject !== replySubject(m!.subject).trim()) refuse(`proposal.subject is not the reply subject ${JSON.stringify(replySubject(m!.subject))}`);
    let raw: Buffer | null = null;
    try { raw = await readFile(readFilePath(deps.vaultDir, m!.rawRfc822Sha256)); } catch { raw = null; }
    const h = raw ? threadingHeaders(raw) : { messageId: null, inReplyTo: null, references: [] };
    reply = { ...replyHeaders({ messageId: h.messageId ?? m!.messageId, references: threadAncestry(h) }), subject: p.subject };
    const isGmail = m!.source === "gmail";
    threadKey = isGmail ? `gmail:${m!.gmailThreadId}` : null;
    gmailThreadId = isGmail ? m!.gmailThreadId : null;
    trigger = { type: "email", id: m!.id, label: `${m!.fromAddr} — ${m!.subject}` };
  } else if (p.inReplyTo && "gmailId" in p.inReplyTo) {
    const g = seen.readGmail.get(p.inReplyTo.gmailId)!;
    reply = { ...replyHeaders({ messageId: g.messageId, references: g.references }), subject: p.subject };
    // The mail agent's shape: a Gmail message outside the dossier rides as
    // trigger_external, and the send relies on the threading headers alone.
    triggerExternal = { gmailId: g.gmailId, threadId: g.threadId, messageId: g.messageId, from: g.from,
      to: g.to, subject: g.subject, date: g.date, body: g.body };
    threadKey = `gmail:${g.threadId}`;
    gmailThreadId = g.threadId;
    trigger = { type: "email", id: g.gmailId, label: `${g.from} — ${g.subject}` };
  } else {
    trigger = { type: "request", id: row.id, label: clipTo(row.text, 200) };
  }

  const addresses = [...seen.addresses].filter((a) => !own.has(a));
  const partyId = (await resolveSenderPartyId(tx, p.to[0])) ?? null;
  const [party] = partyId ? await tx.select({ id: schema.parties.id, name: schema.parties.name })
    .from(schema.parties).where(eq(schema.parties.id, partyId)) : [];
  const operator = operatorAddresses().addrs;
  const priority = [...p.to, ...p.cc].some((a) => matchesList(operator, a)) ? "verder" : "other";
  const entrySummary = clipTo(`Mail aan ${party?.name ?? p.to[0]}: ${p.subject}`, ENTRY_SUMMARY_MAX);

  return {
    kind: p.kind, status: "pending", priority, partyId,
    triggerRequestId: row.id, triggerExternal,
    threadKey,
    context: {
      trigger, thread: [], party: party ? { type: "party", id: party.id, label: party.name } : null,
      parentParty: null, entries: [], debts: [], tasks: [], stops: [],
      kb: v.sources.map((s) => ({ type: s.type, id: s.id, label: s.label ?? s.id })),
      sentDocuments: [],
      attachable: attachable.map((d) => ({ type: "document", id: d.id, label: d.title })),
      addresses, threadKey, gmailThreadId, reply, request: { id: row.id },
    },
    prompt: row.prompt, model, promptVersion: REQUEST_PROMPT_VERSION, modelOutput: answerRaw,
    payload: {
      ask: clipTo(p.subject, ASK_MAX), dueAt: null, missing: [], entrySummary,
      reply: { to: p.to, cc: p.cc, subject: p.subject, body: p.body, attachmentDocumentIds: p.attachments },
      task: null, question: null,
      reliedOn: v.sources.map((s) => ({ type: s.type, id: s.id, why: s.why })),
    },
  };
}

/** The account-wide Gmail deadline, carried forward on every run row so a
 *  routine heartbeat never erases a 429 a tool hit (`rateLimitedUntil` reads
 *  the newest row of each name). */
async function carry(db: Db, now: Date): Promise<{ retryAfter?: string }> {
  const until = await rateLimitedUntil(db, now);
  return until ? { retryAfter: until.toISOString() } : {};
}

export async function storeAnswer(deps: StoreDeps, input: { id: string; model: string; answer: string }): Promise<StoreResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const tooLong = input.answer.length > MAX_ANSWER_CHARS;
  const answerRaw = tooLong ? input.answer.slice(0, MAX_ANSWER_CHARS) : input.answer;

  const result: StoreResult = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [row] = await tx.select().from(schema.requests).where(eq(schema.requests.id, input.id)).for("update");
    if (!row) return { outcome: "not-found" };
    if (row.status !== "working") {
      // Cancelled (or reset) meanwhile: the answer is DISCARDED, never shown.
      // The raw output is still kept on the row, for the record.
      await tx.update(schema.requests).set({ modelOutput: answerRaw, model: input.model, updatedAt: now })
        .where(eq(schema.requests.id, row.id));
      return { outcome: "not-working", reason: row.status };
    }
    const logs = await citableLogs(tx, row);
    const fail = async (reason: string): Promise<StoreResult> => {
      await tx.update(schema.requests).set({ status: "failed", error: reason, modelOutput: answerRaw,
        model: input.model, updatedAt: now }).where(eq(schema.requests.id, row.id));
      return { outcome: "failed", reason };
    };
    if (tooLong) return fail(`the answer is longer than ${MAX_ANSWER_CHARS} characters`);
    const v = validateAnswer(answerRaw, logs, ownMailboxAddresses());
    if (!v.ok) return fail(v.reason);

    let proposalId: string | null = null;
    if (v.value.proposal) {
      let values: typeof schema.proposals.$inferInsert;
      try { values = await proposalFor(tx, deps, row, v.value, logs, input.model, answerRaw); }
      catch (err) { if (err instanceof Refusal) return fail(err.message); throw err; }
      const [p] = await tx.insert(schema.proposals).values(values).returning({ id: schema.proposals.id });
      proposalId = p.id;
    }
    await tx.update(schema.requests).set({
      status: "answered", answer: v.value.answer, sources: v.value.sources, martinSteps: v.value.martinSteps,
      proposalId, model: input.model, modelOutput: answerRaw, error: null, answeredAt: now, updatedAt: now,
    }).where(eq(schema.requests.id, row.id));
    return { outcome: "answered", ...(proposalId ? { proposalId } : {}) };
  });

  await recordRun(db, REQUEST_RUNNER_WORKER_NAME, result.outcome === "answered" || result.outcome === "not-working" ? "ok" : "error", {
    requestId: input.id, outcome: result.outcome, ...(result.reason ? { reason: result.reason.slice(0, 300) } : {}),
    ...(result.proposalId ? { proposalId: result.proposalId } : {}), ...(await carry(db, now)),
  });

  // After the commit: the answer is stored whatever happens to the push. No
  // case content on the lock screen — the question itself can name a creditor.
  // The link is Voor jou, where the answered request is listed at the top:
  // the phone's DeepLink does not parse a request link yet (LinkDestinationTests
  // pins that every link the worker sends lands somewhere), and `grip://inbox`
  // lands on every installed build. The phone half switches it to its own
  // `grip://request/<id>` once DeepLink knows it.
  //
  // KIND `proposal` (category PROPOSAL, "Bekijken" behind Face ID) rather than
  // a kind of its own, for the same reason: NotificationCategoriesTests on the
  // phone pins the worker's CATEGORY map to the categories the installed app
  // registers, and a category the app never registered shows without its
  // hidden-preview text. An answer is something Grip prepared for Martin to
  // read, which is what PROPOSAL already means on the lock screen. A `REQUEST`
  // category arrives with the phone half, in both places at once.
  if (result.outcome === "answered") {
    try {
      await deps.notify({ kind: "proposal", level: "active", title: "Grip heeft je vraag uitgezocht",
        body: "Tik om het antwoord te lezen.", link: "grip://inbox", dedupKey: `request:${input.id}`,
        threadId: `request:${input.id}`, collapseId: `request:${input.id}` });
    } catch (err) { console.error(`requests-store: notify failed: ${String(err)}`); }
  }
  return result;
}

/** The runner got no answer at all (claude exited non-zero, timed out, said nothing). */
export async function storeRunnerFailure(db: Db, input: { id: string; model?: string; reason: string }, now = new Date()): Promise<StoreResult> {
  const reason = `runner: ${input.reason}`;
  const rows = await db.update(schema.requests).set({ status: "failed", error: reason, model: input.model ?? null, updatedAt: now })
    .where(and(eq(schema.requests.id, input.id), eq(schema.requests.status, "working")))
    .returning({ id: schema.requests.id });
  const result: StoreResult = rows.length ? { outcome: "failed", reason } : { outcome: "not-working" };
  await recordRun(db, REQUEST_RUNNER_WORKER_NAME, "error", {
    requestId: input.id, outcome: result.outcome, reason, ...(await carry(db, now)),
  });
  return result;
}

/** A runner tick with nothing to do (`busy`: the previous run still holds the lock). */
export async function recordRunnerHeartbeat(db: Db, busy = false, now = new Date()): Promise<void> {
  await recordRun(db, REQUEST_RUNNER_WORKER_NAME, "ok", { ran: 0, ...(busy ? { busy: true } : {}), ...(await carry(db, now)) });
}

/** A `working` request older than STUCK_AFTER_MS was left by a dead runner (a
 *  killed cron, a reboot): it becomes `failed` "Duurde te lang". */
export async function resetStuck(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db.update(schema.requests)
    .set({ status: "failed", error: "stuck: working for more than 15 minutes", updatedAt: now })
    .where(and(eq(schema.requests.status, "working"), lt(schema.requests.claimedAt, new Date(now.getTime() - STUCK_AFTER_MS))))
    .returning({ id: schema.requests.id });
  return rows.map((r) => r.id);
}
