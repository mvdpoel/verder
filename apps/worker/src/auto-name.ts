/**
 * Name a document at ingest, the moment its text exists.
 *
 * Same three guards as the bulk pass, because they are what make an unattended
 * rename safe: looksLikeProse refuses garbled OCR (a model shown mirrored text
 * named an ASML nondisclosure agreement "Beschikking.UWV"), retainsIdentifiers
 * refuses a name that drops a distinguishing detail, and a model that says it
 * is not confident is believed.
 *
 * BEST EFFORT, ALWAYS. Every failure path leaves the document exactly as it
 * arrived: an unnamed scan is a cosmetic problem, an ingest job that fails
 * because the LLM was down is a document that never reaches the dossier.
 *
 * The rename appends to document_status_changes with its ledger event, the
 * same lawful path documents.update takes, and is written to the same journal
 * the bulk pass uses — so `normalize-names --undo` reverses an automatic
 * rename identically.
 */
import { appendFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { effectiveTitleSql } from "@verder/api/src/effective-status";
import { buildNamePrompt, validateName } from "./ops/normalize-filenames";
import { looksLikeProse } from "./text-quality";
import { recordRun } from "./heartbeat";

export interface AutoNameDeps {
  db: Db;
  /** Returns parsed JSON from the naming model. */
  nameLlm: (prompt: string) => Promise<unknown>;
  scanDir: string;
  journalPath: string;
  log?: (s: string) => void;
}

export type AutoNameOutcome =
  | { renamed: true; from: string; to: string }
  | { renamed: false; reason: string };

export async function autoNameDocument(
  deps: AutoNameDeps, documentId: string, text: string,
): Promise<AutoNameOutcome> {
  const log = deps.log ?? (() => {});
  if (!looksLikeProse(text)) return { renamed: false, reason: "text-not-readable" };

  const current = await effectiveDocument(deps.db, documentId);
  const from = current.effectiveTitle;
  if (!from) return { renamed: false, reason: "no-title" };

  // ALREADY NAMED — by an earlier run, by the bulk pass, or by hand. The batch
  // script has always had this guard and this one did not, so a document that
  // suggest.docmeta revisited got renamed a second time: of the first four
  // automatic renames three were of already-named documents, one of which
  // dropped a year (Geheimhoudingsverklaring.Rabobank.MP.2026 became
  // .Rabobank.M with no year at all). documents.title is frozen at ingest, so
  // a title that has drifted from it is the evidence that naming happened.
  const [raw] = await deps.db.select({ title: schema.documents.title })
    .from(schema.documents).where(eq(schema.documents.id, documentId));
  if (raw && raw.title !== from) return { renamed: false, reason: "already-named" };

  // Every name already in use, so an automatic rename can never collide with a
  // document someone is looking at. Effective titles, not documents.title:
  // the raw column is the ingest-time name and is stale for anything renamed.
  const taken = new Set<string>();
  const rows = await deps.db.select({ t: effectiveTitleSql }).from(schema.documents)
    .where(and(isNotNull(schema.documents.title),
      sql`${schema.documents.id} <> ${documentId}::uuid`));
  for (const r of rows) if (r.t) taken.add(r.t.toLowerCase());

  let answer: unknown;
  try { answer = await deps.nameLlm(buildNamePrompt(from, text)); }
  catch (err) { return { renamed: false, reason: `llm-failed: ${String(err)}` }; }

  const obj = answer as { filename?: unknown; confident?: unknown };
  if (obj?.confident === false) return { renamed: false, reason: "model-not-confident" };
  const to = validateName(obj?.filename, from, taken);
  if (!to) return { renamed: false, reason: `refused: ${JSON.stringify(obj?.filename)}` };

  // Journal BEFORE the move, so a crash still leaves a record of what was
  // attempted and `normalize-names --undo` can reverse it.
  await appendFile(deps.journalPath,
    JSON.stringify({ at: new Date().toISOString(), documentId, oldName: from, newName: to }) + "\n");

  // The file on the share, when there is one. A mail attachment lives only in
  // the vault under its content hash and has nothing to rename here.
  const onDisk = join(deps.scanDir, from);
  if (existsSync(onDisk)) {
    try { await rename(onDisk, join(deps.scanDir, to)); }
    catch (err) { log(`  ! ${from}: rename failed ${String(err)}`); }
  }

  await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 0))`);
    const fresh = await effectiveDocument(tx, documentId);
    if (fresh.effectiveTitle === to) return;
    await tx.insert(schema.documentStatusChanges).values({
      documentId, status: fresh.effectiveStatus, title: to,
      docType: fresh.effectiveDocType ?? undefined,
      partyId: fresh.effectivePartyId ?? undefined });
    await appendLedgerEvent(tx, {
      eventType: "document.updated", entityType: "document", entityId: documentId,
      payload: { id: documentId, status: fresh.effectiveStatus, title: to,
        docType: fresh.effectiveDocType ?? null, partyId: fresh.effectivePartyId ?? null } });
  });
  log(`  ${from}  ->  ${to}`);
  return { renamed: true, from, to };
}

/** Wraps autoNameDocument so nothing it does can fail the job that called it. */
export async function autoNameSafely(
  deps: AutoNameDeps, documentId: string, text: string,
): Promise<void> {
  try {
    const out = await autoNameDocument(deps, documentId, text);
    await recordRun(deps.db, "auto-name", "ok", { documentId, ...out });
  } catch (err) {
    await recordRun(deps.db, "auto-name", "error", { documentId, message: String(err) });
  }
}
