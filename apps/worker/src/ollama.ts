import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { AUTO_FILE_WORKER_NAME } from "@verder/api/src/worker-names";
import { autoApplyDocMeta } from "./auto-file";
import { recordRun } from "./heartbeat";
import { proposalForOwnSentMail } from "./proposals/own-sent";
import { buildDocMetaPrompt, buildEntryPrompt, DOCMETA_PROMPT_VERSION, PROMPT_VERSION } from "./prompts";
import type { RetrievedRef, RetrieveRefsFn } from "./retrieval-refs";

export interface LlmPort { chatJson(prompt: string): Promise<unknown> }

// NO PUSH FROM HERE. A suggestion used to raise a generic "Something new to
// review" push for every mail and every document, which is exactly the
// "nieuwe mail" push spec §6.4 forbids: it interrupts for everything and so
// tells nothing. Mail from the Verder organisation gets its own push with a
// one-line summary (Plan 2 Task 10); everything else waits in /queue.

export function realLlmPort(): LlmPort {
  return {
    async chatJson(prompt) {
      const res = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
          messages: [{ role: "user", content: prompt }], format: "json", stream: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message: { content: string } };
      return JSON.parse(data.message.content) as unknown;
    },
  };
}

const llmEntrySchema = z.object({
  summary: z.string().min(1).max(200),
  details: z.string().default(""),
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })).default([]),
});

export async function suggestEntry(
  deps: { db: Db; llm: LlmPort; retrieveRefs?: RetrieveRefsFn },
  rawEmailId: string,
): Promise<void> {
  const [email] = await deps.db.select().from(schema.rawEmails)
    .where(eq(schema.rawEmails.id, rawEmailId));
  if (!email) return;
  // A mail verder itself sent for a proposal, coming back through the poll.
  // Its outbound entry is written by finishSent (proposals/send.ts) from the
  // text Martin approved, so a log-entry suggestion here would be a second
  // entry for one mail. `sending` counts too: the re-ingest can overtake a slow
  // or crashed finishSent.
  const sentBy = await proposalForOwnSentMail(deps.db, email);
  if (sentBy) {
    await recordRun(deps.db, "ollama", "ok", { rawEmailId, skipped: "sent-by-verder", proposalId: sentBy });
    return;
  }
  const attachmentDocs = await deps.db.select().from(schema.documents)
    .where(eq(schema.documents.sourceRef, email.gmailMessageId));
  const base = { occurredAt: email.sentAt.toISOString(), channel: "email" as const,
    participantNames: [email.fromAddr],
    attachmentDocumentIds: attachmentDocs.map((d) => d.id) };
  // What the index already knows about this email's subject matter. Computed
  // BEFORE the LLM call so both the parsed suggestion and the needs-manual
  // fallback carry the same provenance. realRetrieveRefs never throws; this
  // guard covers injected test doubles that might.
  let retrievedRefs: RetrievedRef[] = [];
  if (deps.retrieveRefs) {
    try {
      retrievedRefs = await deps.retrieveRefs(
        `${email.subject}\n${email.bodyText.slice(0, 2000)}`);
    } catch { retrievedRefs = []; }
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  try {
    const parsed = llmEntrySchema.parse(await deps.llm.chatJson(buildEntryPrompt({
      from: email.fromAddr, subject: email.subject, sentAt: email.sentAt, bodyText: email.bodyText })));
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      retrievedRefs,
      proposed: { ...base, direction: parsed.direction, summary: parsed.summary,
        details: parsed.details, actionItems: parsed.actionItems } });
    await recordRun(deps.db, "ollama", "ok", { rawEmailId, refs: retrievedRefs.length });
  } catch (err) {
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      status: "needs-manual", retrievedRefs,
      proposed: { ...base, direction: "inbound", summary: email.subject,
        details: email.bodyText.slice(0, 2000), actionItems: [] } });
    await recordRun(deps.db, "ollama", "error", { rawEmailId, message: String(err) });
  }
}

/**
 * What docmeta-v2 answers. `confident` defaults to FALSE: a model that leaves it
 * out has not claimed certainty, and auto-apply (Task 14) only ever acts on an
 * explicit `true`. Exported so the docmeta eval parses exactly what production
 * parses.
 */
export const llmDocSchema = z.object({
  title: z.string().min(1),
  docType: z.string().nullable().default(null),
  confident: z.boolean().default(false),
});

export async function suggestDocMeta(
  deps: { db: Db; llm: LlmPort; extractText: (mime: string, buf: Buffer) => Promise<string>;
    /** Read for DOCMETA_AUTO_APPLY only; tests inject it, production passes nothing. */
    env?: NodeJS.ProcessEnv },
  documentId: string, fileBuf: Buffer,
): Promise<void> {
  const [doc] = await deps.db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  // The EFFECTIVE title, not documents.title: auto-name runs earlier in the
  // same job (index.ts, suggest.docmeta) and appends its rename as a change
  // row, so the raw column holds a name like scan0042.pdf that the document
  // no longer has — and that /queue no longer shows next to the suggestion.
  const { effectiveTitle } = await effectiveDocument(deps.db, documentId);
  let pendingId: string | null = null;
  try {
    const text = await deps.extractText(doc.mime, fileBuf);
    const parsed = llmDocSchema.parse(
      await deps.llm.chatJson(buildDocMetaPrompt(effectiveTitle, text)));
    const [s] = await deps.db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model, promptVersion: DOCMETA_PROMPT_VERSION,
      proposed: parsed }).returning({ id: schema.suggestions.id });
    pendingId = s.id;
    await recordRun(deps.db, "ollama", "ok", { documentId });
  } catch (err) {
    await deps.db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model, promptVersion: DOCMETA_PROMPT_VERSION,
      // The RAW title on purpose: export-docmeta-samples.ts recognises a
      // needs-manual-origin row by `proposed.title = documents.title` with a
      // null docType, and an approved one must never be scored as a model
      // answer. Never confident: there was no answer to be confident about.
      status: "needs-manual", proposed: { title: doc.title, docType: null, confident: false } });
    await recordRun(deps.db, "ollama", "error", { documentId, message: String(err) });
  }
  // OUTSIDE the try above, on purpose: a failure to auto-file must never be
  // mistaken for a failed model call and insert a second, needs-manual
  // suggestion beside the pending one. Best effort, like auto-name: the
  // suggestion simply stays pending in Voor jou, and the run row says why.
  if (pendingId) {
    try { await autoApplyDocMeta(deps.db, pendingId, deps.env ?? process.env); }
    catch (err) {
      await recordRun(deps.db, AUTO_FILE_WORKER_NAME, "error",
        { suggestionId: pendingId, message: String(err) });
    }
  }
}
