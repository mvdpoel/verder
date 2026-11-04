/**
 * verder files a document on its own (spec §6.6, §12.4) — the ONE thing the
 * suggestion-only law lets it do unasked, and only when the measured gate says
 * it can (Plan 3 Task 13 decides whether DOCMETA_AUTO_APPLY is switched on).
 *
 * WHAT IT WRITES: status `filed` and the SOORT, nothing else. The gate the eval
 * measures scores exactly that (docmeta-score.ts: `gate = docTypeExact`), so
 * nothing outside it may be applied on its authority:
 *
 * - NEVER THE TITLE. The row carries the CURRENT effective title, not
 *   `proposed.title`. Auto-name ran earlier in the same job and wrote a name
 *   that passed looksLikeProse, validateName/retainsIdentifiers and a collision
 *   check against every effective title; docmeta's free-form "short,
 *   descriptive" title passed none of them, and applying it would overwrite a
 *   guarded name with an unguarded one that can collide or drop an identifier
 *   (the Rabobank year incident recorded in auto-name.ts). The proposed title
 *   stays on the suggestion, visible in "Door verder gedaan" as information.
 * - NEVER THE SENDER. The docmeta prompt proposes none, and an OCR sender is an
 *   unconfirmed guess (spec §12.5); the effective party is carried forward so
 *   this row cannot revert one.
 * - NEVER A LINK. An `entry_documents` row has no DELETE grant and would sit in
 *   an entry's citation set and the signed export forever, so it could never
 *   be undone; `stops.document_id`/`tasks.document_id` would overwrite Martin's
 *   link with no history. No producer of automatic links exists.
 *
 * WHEN IT REFUSES, it writes nothing to the dossier and the suggestion stays
 * pending in Voor jou exactly as before: anything Martin has touched (a change
 * row with actor NULL), anything not in the inbox, anything purged, and every
 * suggestion that is not a confident, pending docmeta-v2 answer with a soort.
 *
 * The change is a `document_status_changes` row with `actor = 'verder'` and the
 * suggestion's id, ledgered in the verder payload shape — the ledger itself
 * says verder did this, and `/verify` matches the row through that shape only.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { APP_ACTOR, schema, type Db } from "@grip/db";
import { appendLedgerEvent } from "@grip/api/src/ledger";
import { effectiveDocument } from "@grip/api/src/routers/documents";
import { documentStatusChangePayloadByGrip } from "@grip/api/src/verification";
import { AUTO_FILE_WORKER_NAME } from "@grip/api/src/worker-names";
import { recordRun } from "./heartbeat";

/**
 * The prompt version the gate was MEASURED on, spelled as a literal on purpose
 * rather than read from DOCMETA_PROMPT_VERSION: bumping the prompt must switch
 * auto-apply OFF until the new prompt has been measured too, never carry the
 * old measurement over to answers it never scored.
 */
export const AUTO_APPLY_PROMPT_VERSION = "docmeta-v2";

export type AutoApplyOutcome = { applied: boolean; reason: string };

export async function autoApplyDocMeta(
  db: Db, suggestionId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<AutoApplyOutcome> {
  // Exactly "on". Unset is the shipped default, and anything else — "1",
  // "true", "ON" — is a typo that must not quietly switch on an unattended
  // writer to the ledger. Returns BEFORE any write, the run row included.
  if (env.DOCMETA_AUTO_APPLY !== "on") return { applied: false, reason: "disabled" };

  const outcome = await db.transaction(async (tx): Promise<AutoApplyOutcome> => {
    const refuse = (reason: string): AutoApplyOutcome => ({ applied: false, reason });
    // FOR UPDATE: a concurrent auto-apply (a pg-boss retry) or Martin's own
    // approve waits here and then sees the decided status.
    const [s] = await tx.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, suggestionId)).for("update");
    if (!s) return refuse("not-found");
    if (s.kind !== "document-meta" || !s.documentId) return refuse("not-document-meta");
    // Never needs-manual: that row holds no model answer at all.
    if (s.status !== "pending") return refuse("not-pending");
    if (s.promptVersion !== AUTO_APPLY_PROMPT_VERSION) return refuse("prompt-version");
    const proposed = (s.proposed ?? {}) as { docType?: unknown; confident?: unknown };
    // An explicit boolean true only; llmDocSchema already defaults a missing
    // `confident` to false, and a string "true" is not a claim of certainty.
    if (proposed.confident !== true) return refuse("not-confident");
    // Filing with no soort would claim the soort the gate scored is "none".
    const docType = typeof proposed.docType === "string" ? proposed.docType.trim() : "";
    if (docType === "") return refuse("no-soort");

    const documentId = s.documentId;
    // The per-document lock every writer of change rows takes (documents.update,
    // approveDocumentMeta, auto-name), so a discard or a purge landing now
    // cannot both read the old state and both append.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 0))`);
    const current = await effectiveDocument(tx, documentId);
    if (current.purge !== null) return refuse("purged");
    // If Martin has touched it, verder does not: any row of his since ingest —
    // a rename, a retype, a discard and its undo — is a judgement this must not
    // overrule. auto-name's own rows carry actor 'verder' and do not count.
    const [touched] = await tx.select({ id: schema.documentStatusChanges.id })
      .from(schema.documentStatusChanges)
      .where(and(eq(schema.documentStatusChanges.documentId, documentId),
        isNull(schema.documentStatusChanges.actor)))
      .limit(1);
    if (touched) return refuse("touched-by-martin");
    if (current.effectiveStatus !== "inbox") return refuse("not-inbox");

    const before = { status: current.effectiveStatus, title: current.effectiveTitle,
      docType: current.effectiveDocType ?? null };
    const [row] = await tx.insert(schema.documentStatusChanges).values({
      documentId, status: "filed", title: current.effectiveTitle, docType,
      partyId: current.effectivePartyId ?? undefined,
      actor: APP_ACTOR, suggestionId: s.id }).returning();
    await appendLedgerEvent(tx, {
      eventType: "document.updated", entityType: "document", entityId: documentId,
      payload: documentStatusChangePayloadByGrip(row) });
    await tx.update(schema.suggestions).set({
      status: "auto-applied", verdictAt: new Date(),
      finalPayload: { title: current.effectiveTitle, docType, before, changeId: row.id },
    }).where(eq(schema.suggestions.id, s.id));
    return { applied: true, reason: "applied" };
  });

  // After the commit: a run row is not evidence and must never hold the
  // transaction open or roll the filing back.
  await recordRun(db, AUTO_FILE_WORKER_NAME, "ok", { suggestionId, ...outcome });
  return outcome;
}
