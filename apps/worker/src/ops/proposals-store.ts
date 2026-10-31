// The drafter's answer, back into the dossier (spec §6.5):
//
//   … | pnpm --silent --filter worker proposals-store --id <uuid> --model <text>
//   pnpm --silent --filter worker proposals-store --id <uuid> --model <text> --failed <reason>
//   pnpm --silent --filter worker proposals-store --heartbeat
//   … | pnpm --silent --filter worker proposals-store --external
//
// Called ONLY by ops/proposal-drafter.sh on the host, which ran `claude -p` on
// the prompt `proposals-pending` printed. The model answer arrives on stdin and
// is untrusted: `validateDraft` checks every recipient, attachment, cited id
// and option target against the context stored on the row, and only a draft
// that passes is ever `pending` — i.e. ever shown to Martin.
//
// Either way the raw answer is KEPT (golden rule: a failure is recorded too),
// and every call writes exactly one `proposal-draft` run row.
//
// `--external` (Task 20) is the mail agent's door: ONE JSON line from
// `mail-agent-watch` on stdin becomes a `drafting` proposal (priority `other`,
// party = the party whose email is the sender, else none), and the Gmail ids it
// covers are printed as `seen <id>` lines for ops/mail-agent.sh to append to
// seen.txt. Idempotent on the trigger's gmailId.
//
// NOT EVIDENCE: a proposal appends no ledger event, here or anywhere.
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema, type Db } from "@verder/db";
import { canTransition, type ProposalKind, type ProposalStatus } from "@verder/api/src/proposal-state";
import { PROPOSAL_CREATE_WORKER_NAME, PROPOSAL_DRAFT_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { closeNotify, notifier, type NotifyFn, type NotifyInput } from "../notify/notify";
import type { ExternalMail, ProposalContext } from "../proposals/context";
import { createProposal, type CreateDeps } from "../proposals/create";
import { buildProposalPrompt, promptVersionFor } from "../proposals/draft-prompt";
import { realRetrieveRefs } from "../retrieval-refs";
import { validateDraft, type DraftPayload } from "../proposals/validate-draft";

export interface StoreDeps { db: Db; notify: NotifyFn }

export type StoreOutcome = "pending" | "draft-failed" | "not-drafting" | "not-found";
export interface StoreResult { outcome: StoreOutcome; reason?: string }

/** An answer larger than this is not a draft; it is kept truncated and refused. */
export const MAX_ANSWER_CHARS = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_TEXT = /^[\x20-\x7e]{1,120}$/;
const FAILURE_REASON = /^[a-z0-9-]{1,40}$/;

type Row = typeof schema.proposals.$inferSelect;

interface Stored {
  result: StoreResult;
  row?: Row;
  payload?: DraftPayload;
}

async function lockRow(tx: Db, id: string): Promise<Row | undefined> {
  const [row] = await tx.select().from(schema.proposals)
    .where(eq(schema.proposals.id, id)).for("update");
  return row;
}

/** What the push names the other side as. */
function partyLabel(row: Row, ctx: ProposalContext): string {
  if (ctx.party?.label) return ctx.party.label;
  const guess = row.senderGuess as { kind?: string } | null;
  if (guess?.kind === "verder") return "Verder";
  return "de afzender";
}

function proposalPush(row: Row, ctx: ProposalContext, payload: DraftPayload): NotifyInput {
  const who = partyLabel(row, ctx);
  // The key of the push that announced the trigger (Task 10's mail push,
  // Task 18's letter push), so this one replaces it.
  const triggerKey = row.triggerRawEmailId ? `mail:${row.triggerRawEmailId}`
    : row.triggerDocumentId ? `letter:${row.triggerDocumentId}` : undefined;
  return {
    kind: "proposal",
    level: row.priority === "verder" ? "time-sensitive" : "active",
    title: `Voorstel: ${payload.ask}`,
    // A question never leaves the house, so "verstuur" would be a lie there.
    body: payload.question
      ? `Een vraag over ${who}. Kies een antwoord.`
      : `Antwoord klaar voor ${who}. Bekijk en verstuur.`,
    link: `verder://proposal/${row.id}`,
    dedupKey: `proposal:${row.id}`,
    // Same thread and collapse id as the mail or letter push, so this one
    // REPLACES it on the lock screen instead of stacking a second alert.
    ...(triggerKey ? { threadId: triggerKey, collapseId: triggerKey } : {}),
  };
}

export async function storeDraft(
  deps: StoreDeps, input: { id: string; model: string; answer: string },
): Promise<StoreResult> {
  const { db } = deps;
  const answer = input.answer.length > MAX_ANSWER_CHARS ? input.answer.slice(0, MAX_ANSWER_CHARS) : input.answer;
  const stored: Stored = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await lockRow(tx, input.id);
    if (!row) return { result: { outcome: "not-found" } };
    // A late answer (superseded meanwhile, a second drafter run, a retry) never
    // overwrites what is already there.
    if (row.status !== "drafting") return { result: { outcome: "not-drafting", reason: row.status }, row };

    const ctx = row.context as ProposalContext;
    const v = input.answer.length > MAX_ANSWER_CHARS
      ? { ok: false as const, reason: `the answer is longer than ${MAX_ANSWER_CHARS} characters` }
      : validateDraft(answer, ctx);
    const kind = row.kind as ProposalKind;
    const now = new Date();

    if (!v.ok) {
      if (!canTransition("drafting", "draft-failed", kind)) throw new Error("drafting → draft-failed refused");
      await tx.update(schema.proposals).set({
        status: "draft-failed", error: v.reason, modelOutput: answer, model: input.model,
        promptVersion: promptVersionFor(kind, false), updatedAt: now,
      }).where(eq(schema.proposals.id, row.id));
      return { result: { outcome: "draft-failed", reason: v.reason }, row };
    }

    const isQuestion = v.payload.question !== null;
    // A reply row may come back as a question (Task 13); a follow-up stays a
    // follow-up whatever it carries, so its version and clock are untouched.
    const nextKind: ProposalKind = isQuestion && kind === "reply" ? "question" : kind;
    if (!canTransition("drafting", "pending", nextKind)) throw new Error("drafting → pending refused");
    await tx.update(schema.proposals).set({
      status: "pending", kind: nextKind, modelOutput: answer, payload: v.payload,
      model: input.model, promptVersion: promptVersionFor(kind, isQuestion), error: null, updatedAt: now,
    }).where(eq(schema.proposals.id, row.id));
    return { result: { outcome: "pending" }, row, payload: v.payload };
  });

  const { result, row, payload } = stored;
  const failed = result.outcome === "draft-failed" || result.outcome === "not-found";
  await recordRun(db, PROPOSAL_DRAFT_WORKER_NAME, failed ? "error" : "ok", {
    proposalId: input.id, outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}),
  });

  // After the commit: the draft is stored whatever happens to the push.
  // notify() never throws, but an injected one may.
  if (result.outcome === "pending" && row && payload) {
    try { await deps.notify(proposalPush(row, row.context as ProposalContext, payload)); }
    catch (err) { console.error(`proposals-store: notify failed: ${String(err)}`); }
  }
  return result;
}

/** The host could not get an answer at all (claude exited non-zero, timed out,
 *  or answered nothing). `draft-failed` with the reason; nothing to keep. */
export async function storeDrafterFailure(
  db: Db, input: { id: string; model?: string; reason: string },
): Promise<StoreResult> {
  const result: StoreResult = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await lockRow(tx, input.id);
    if (!row) return { outcome: "not-found" };
    if (row.status !== "drafting") return { outcome: "not-drafting", reason: row.status };
    if (!canTransition(row.status as ProposalStatus, "draft-failed", row.kind as ProposalKind)) {
      throw new Error("drafting → draft-failed refused");
    }
    await tx.update(schema.proposals).set({
      status: "draft-failed", error: `drafter: ${input.reason}`, model: input.model ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.proposals.id, row.id));
    return { outcome: "draft-failed", reason: `drafter: ${input.reason}` };
  });
  await recordRun(db, PROPOSAL_DRAFT_WORKER_NAME, "error", {
    proposalId: input.id, outcome: result.outcome, reason: result.reason ?? input.reason,
  });
  return result;
}

/** A drafter run with nothing pending: proof the cron is alive. */
export async function recordDrafterHeartbeat(db: Db): Promise<void> {
  await recordRun(db, PROPOSAL_DRAFT_WORKER_NAME, "ok", { drafted: 0 });
}

// ---- the mail agent's external message (Task 20) ---------------------------

const GMAIL_ID = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const ISO = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "not a date");
/** What `mail-agent-watch` prints, and nothing more: an unknown key is refused. */
export const externalMailSchema = z.object({
  gmailId: GMAIL_ID,
  threadId: GMAIL_ID,
  messageId: z.string().max(998).nullable(),
  from: z.string().min(1).max(2000),
  to: z.string().max(4000),
  subject: z.string().max(1000),
  date: ISO,
  body: z.string().max(6001),
  attachments: z.array(z.object({
    filename: z.string().max(500), mime: z.string().max(200), size: z.number().int().nonnegative(),
  }).strict()).max(50).default([]),
  thread: z.array(z.object({
    gmailId: GMAIL_ID, from: z.string().max(2000), subject: z.string().max(1000), date: ISO,
    body: z.string().max(2001),
  }).strict()).max(20).default([]),
}).strict();

export interface ExternalResult {
  outcome: "created" | "exists" | "invalid";
  proposalId?: string;
  /** The Gmail ids this line covers: mark them seen on the host. Empty when invalid. */
  seen: string[];
  reason?: string;
}

/** The proposal already made for this gmailId, if any. */
async function externalProposalFor(db: Db, gmailId: string): Promise<string | null> {
  const [p] = await db.select({ id: schema.proposals.id }).from(schema.proposals)
    .where(sql`${schema.proposals.triggerExternal}->>'gmailId' = ${gmailId}`).limit(1);
  return p?.id ?? null;
}

export async function storeExternal(deps: CreateDeps, line: string): Promise<ExternalResult> {
  let mail: ExternalMail;
  try {
    mail = externalMailSchema.parse(JSON.parse(line));
  } catch (err) {
    const reason = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)
      : "not json";
    await recordRun(deps.db, PROPOSAL_CREATE_WORKER_NAME, "error", { trigger: "external", reason });
    return { outcome: "invalid", seen: [], reason };
  }
  const seen = [...new Set([mail.gmailId, ...(mail.thread ?? []).map((t) => t.gmailId)])];
  const existing = await externalProposalFor(deps.db, mail.gmailId);
  if (existing) return { outcome: "exists", proposalId: existing, seen };
  try {
    // Priority `other`: the watchlist is never Verder or a creditor (those are
    // ingested, and mail-agent-watch skips them). The party is resolved from the
    // sender by gatherContext; with none, the sent reply's entry has no
    // participant (finishSent).
    const { id, created } = await createProposal(deps, { external: mail }, "other");
    await recordRun(deps.db, PROPOSAL_CREATE_WORKER_NAME, "ok",
      { trigger: "external", gmailId: mail.gmailId, proposalId: id, created });
    return { outcome: created ? "created" : "exists", proposalId: id, seen };
  } catch (err) {
    await recordRun(deps.db, PROPOSAL_CREATE_WORKER_NAME, "error",
      { trigger: "external", gmailId: mail.gmailId, message: String(err).slice(0, 500) });
    throw err;
  }
}

// ---- CLI ---------------------------------------------------------------------

export type StoreArgs =
  | { mode: "heartbeat" }
  | { mode: "external" }
  | { mode: "store"; id: string; model: string }
  | { mode: "failed"; id: string; model: string; reason: string };

export function parseStoreArgs(args: string[]): StoreArgs {
  if (args.length === 1 && args[0] === "--heartbeat") return { mode: "heartbeat" };
  if (args.length === 1 && args[0] === "--external") return { mode: "external" };
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!["--id", "--model", "--failed"].includes(k)) throw new Error(`unknown flag "${k.slice(0, 40)}"`);
    if (args[i + 1] === undefined) throw new Error(`${k} needs a value`);
    flags.set(k, args[i + 1]);
  }
  const id = flags.get("--id") ?? "";
  if (!UUID.test(id)) throw new Error("--id must be a uuid");
  const model = flags.get("--model") ?? "";
  if (!MODEL_TEXT.test(model)) throw new Error("--model must be 1-120 printable ASCII characters");
  const failed = flags.get("--failed");
  if (failed !== undefined) {
    if (!FAILURE_REASON.test(failed)) throw new Error("--failed must be a short [a-z0-9-] reason");
    return { mode: "failed", id, model, reason: failed };
  }
  return { mode: "store", id, model };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    const b = c as Buffer;
    size += b.length;
    // Keep reading past the cap (so the writer is never blocked) but stop storing.
    if (size <= MAX_ANSWER_CHARS * 4 + 4) chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  let args: StoreArgs;
  try { args = parseStoreArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(`proposals-store: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { db, pool } = createDb(url);
  try {
    if (args.mode === "heartbeat") await recordDrafterHeartbeat(db);
    else if (args.mode === "external") {
      const r = await storeExternal({
        db, retrieveRefs: realRetrieveRefs(db), vaultDir: process.env.VAULT_DIR ?? "./vault-files",
        buildPrompt: buildProposalPrompt,
      }, await readStdin());
      // `seen <id>` lines are what ops/mail-agent.sh appends to seen.txt.
      for (const id of r.seen) console.log(`seen ${id}`);
      console.log(`proposals-store: external ${r.outcome}${r.proposalId ? ` ${r.proposalId}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
      if (r.outcome === "invalid") process.exitCode = 1;
    }
    else if (args.mode === "failed") {
      const r = await storeDrafterFailure(db, args);
      console.log(`proposals-store: ${args.id} ${r.outcome}`);
    } else {
      const r = await storeDraft({ db, notify: notifier(db) },
        { id: args.id, model: args.model, answer: await readStdin() });
      // The outcome and the validator's reason only: never the answer itself.
      console.log(`proposals-store: ${args.id} ${r.outcome}${r.reason ? ` (${r.reason.slice(0, 200)})` : ""}`);
    }
  } catch (err) {
    console.error(`proposals-store: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    // One-shot: an open APNs HTTP/2 session would keep the process alive.
    await closeNotify();
    await pool.end();
  }
}
