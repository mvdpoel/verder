/**
 * Give every scanned document a filename that says what it is.
 *
 * The NAS share is a twenty-year personal archive, and 54 of its 133 PDFs are
 * called scan0063.pdf. This reads the text the extractor already stored, asks
 * an LLM for a name in Martin's own convention (Soort.Partij.Persoon.Jaar.pdf),
 * renames the file on the NAS and records the same name in the dossier.
 *
 * TWO WRITES, ONE DECISION. `documents` has no UPDATE grant, so the dossier
 * side is an append to document_status_changes with its ledger event — the
 * same path documents.update takes. The NAS side is a plain rename. They must
 * agree: a file renamed on disk but not in the dossier reads as scan0063.pdf
 * forever, because documents.title is the ingest-time name and never changes.
 *
 * EVERY RENAME IS JOURNALLED to a JSONL file before it happens, so the whole
 * run is reversible with --undo. This is not a review gate — the run applies
 * as it goes — it is the difference between a bulk edit and a one-way door.
 */
import { readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { schema, createDb } from "@verder/db";
import { effectiveTitleSql } from "@verder/api/src/effective-status";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument } from "@verder/api/src/routers/documents";

/** Filenames the archive already answers for itself. */
const OPAQUE = /^(scan|img|image|doc|document|untitled|foto|photo|dsc|pdf)[-_ ]?\d*\.[a-z0-9]+$/i;

/**
 * What a proposed name may contain. Deliberately narrow: this string becomes a
 * path on a NAS shared over SMB and NFS, so no separators, no leading dot, no
 * control characters, and nothing Windows refuses (: * ? " < > |). A name that
 * fails this is skipped, never sanitised into something the model did not say.
 */
const SAFE_NAME = /^[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F.,()' _-]{2,150}$/;

export interface RenamePlan {
  documentId: string;
  oldName: string;
  newName: string;
}

export function buildNamePrompt(currentName: string, text: string): string {
  return [
    "Je krijgt de tekst van een gescand document uit een Nederlands persoonlijk archief.",
    "Bedenk een bestandsnaam die beschrijft WAT het document is.",
    "",
    "Conventie, punten als scheidingsteken, in deze volgorde:",
    "  Soort.Organisatie.Persoon.Jaar",
    "Voorbeelden uit dit archief:",
    "  Arbeidsovereenkomst.Airteq.MP.van.der.Poel.pdf",
    "  Jaaropgave.mp.2022.UWV.pdf",
    "  Loonstrook.mp.2026-02.TrueFullstaq.pdf",
    "  Beschikking.Rechtbank.Midden-Nederland.2026.pdf",
    "",
    "Regels:",
    "- Laat de extensie weg; die wordt toegevoegd.",
    "- Gebruik alleen letters, cijfers, punten en koppeltekens.",
    "- Geen spaties, geen slashes, geen dubbele punten.",
    "- Noem het jaar alleen als het in de tekst staat.",
    "- Verzin niets. Weet je de organisatie niet, laat dat deel weg.",
    "- Maximaal 90 tekens.",
    "",
    `Huidige bestandsnaam: ${currentName}`,
    "",
    "Tekst van het document:",
    text.slice(0, 6000),
    "",
    'Antwoord met JSON: {"filename": "...", "confident": true|false}',
  ].join("\n");
}

/**
 * Accepts the model's name or refuses it. Refusing costs a file that keeps an
 * ugly name; accepting something wrong renames a document in a legal archive.
 */
export function validateName(
  proposed: unknown, oldName: string, taken: Set<string>,
): string | null {
  if (typeof proposed !== "string") return null;
  const ext = extname(oldName).toLowerCase();
  // NFC, because the model emits composed characters while macOS hands back
  // decomposed ones over SMB. Both spell an e-diaeresis; only one of them
  // equals the title stored in the dossier, and the sweep's stat pre-check
  // compares that title to the filename.
  let stem = proposed.normalize("NFC").trim();
  if (stem.toLowerCase().endsWith(ext)) stem = stem.slice(0, -ext.length);
  // basename() defeats "../../etc/passwd" and "a/b" alike.
  stem = basename(stem).replace(/\s+/g, ".").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  if (!stem) return null;
  const candidate = stem + ext;
  if (!SAFE_NAME.test(candidate)) return null;
  if (candidate.length > 160) return null;
  if (candidate.toLowerCase() === oldName.toLowerCase()) return null;
  if (taken.has(candidate.toLowerCase())) return null;
  return candidate;
}

interface Deps {
  db: ReturnType<typeof createDb>["db"];
  scanDir: string;
  llm: (prompt: string) => Promise<unknown>;
  journalPath: string;
  all: boolean;
  limit: number;
  commit: boolean;
  log?: (s: string) => void;
}

export async function normalizeFilenames(deps: Deps): Promise<{
  renamed: number; skipped: number; refused: number; plans: RenamePlan[];
}> {
  const log = deps.log ?? (() => {});
  const rows = await deps.db.select({
    id: schema.documents.id,
    sourceRef: schema.documents.sourceRef,
    effectiveTitle: effectiveTitleSql,
    text: schema.documentTexts.text,
  }).from(schema.documents)
    .innerJoin(schema.documentTexts, eq(schema.documentTexts.documentId, schema.documents.id))
    .where(and(eq(schema.documents.source, "nas-scan"), isNotNull(schema.documents.sourceRef)));

  // Every name currently on the share, so a proposal cannot collide with a
  // file this run has not touched.
  const taken = new Set<string>();
  for (const r of rows) if (r.sourceRef) taken.add(r.sourceRef.toLowerCase());

  const plans: RenamePlan[] = [];
  let renamed = 0, skipped = 0, refused = 0;

  for (const row of rows) {
    if (plans.length >= deps.limit) break;
    const oldName = row.sourceRef!;
    // Already renamed — by an earlier run of this script, or by hand in the
    // app. documents.title is frozen at ingest, so a title that has drifted
    // from source_ref is the only evidence a rename happened, and without
    // this a second --all pass would rename every file a second time.
    if (row.effectiveTitle !== oldName) { skipped++; continue; }
    if (!deps.all && !OPAQUE.test(oldName)) { skipped++; continue; }
    const abs = join(deps.scanDir, oldName);
    if (!existsSync(abs)) { skipped++; continue; }
    if (!row.text || row.text.trim().length < 40) { skipped++; continue; }

    let answer: unknown;
    try { answer = await deps.llm(buildNamePrompt(oldName, row.text)); }
    catch (err) { log(`  ! ${oldName}: ${String(err)}`); refused++; continue; }

    const obj = answer as { filename?: unknown; confident?: unknown };
    if (obj?.confident === false) { log(`  ? ${oldName}: model not confident`); refused++; continue; }
    const newName = validateName(obj?.filename, oldName, taken);
    if (!newName) { log(`  ? ${oldName}: refused ${JSON.stringify(obj?.filename)}`); refused++; continue; }

    plans.push({ documentId: row.id, oldName, newName });
    taken.add(newName.toLowerCase());
    log(`  ${oldName}  ->  ${newName}`);
    if (!deps.commit) continue;

    // Journal BEFORE the move, so a crash mid-rename still leaves a record of
    // what was attempted. An undo reads this file, not the database.
    await appendFile(deps.journalPath,
      JSON.stringify({ at: new Date().toISOString(), ...{ documentId: row.id, oldName, newName } }) + "\n");
    await rename(abs, join(deps.scanDir, newName));
    await deps.db.transaction(async (tx) => {
      // Same serialization documents.update takes: effectiveDocument below is
      // a read the insert depends on, so a concurrent writer on this document
      // would make it a TOCTOU.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${row.id}::text, 0))`);
      const current = await effectiveDocument(tx, row.id);
      await tx.insert(schema.documentStatusChanges).values({
        documentId: row.id, status: current.effectiveStatus, title: newName });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: row.id,
        payload: { id: row.id, status: current.effectiveStatus,
          title: newName, docType: null, partyId: null } });
    });
    renamed++;
  }
  return { renamed, skipped, refused, plans };
}
