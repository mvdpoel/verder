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


/**
 * Words frequent enough in Dutch and English that prose cannot avoid them.
 * Counting them is a cheap, language-agnostic-enough test for "is this text
 * at all", which is the only question being asked.
 */
const STOPWORDS = [
  "de", "het", "een", "van", "en", "in", "op", "te", "dat", "die", "voor",
  "met", "zijn", "wordt", "aan", "bij", "the", "of", "and", "to", "in", "for",
  "is", "that", "this", "shall", "will", "any",
];

/**
 * Minimum share of words that are stopwords. MEASURED across all 138 texts on
 * this share, not guessed: garbled OCR runs 0.7%-3.3% and every readable
 * document is 4.7% or above, so the threshold sits in a real gap. It is
 * deliberately far below the 21.8% median, because the sparse end of "real" is
 * a payslip (4.9%) or a passport MRZ (5.3%) -- documents that are tables, not
 * prose, and must not be refused.
 */
const MIN_STOPWORD_SHARE = 0.04;

/**
 * Whether extracted text is worth showing a model.
 *
 * asml.pdf was scanned UPSIDE DOWN, so OCR returned 3082 characters of
 * mirrored gibberish ("uorpoIpsin[ SAISN[9Xe BABY [IM LNOD YIJNG" is "Dutch
 * COURT will have exclusive jurisdiction" reversed). Asked to name it, the
 * model invented "Beschikking.UWV" -- a plausible Dutch document type with no
 * basis in the document at all. 25 documents on this share are in that state,
 * and for an opaque scan0063.pdf there is no original filename for
 * retainsIdentifiers to defend, so the invented name would stand.
 *
 * The share is measured per WORD, not per character: a per-character ratio
 * rewards garbled text for being dense in short junk tokens, which is exactly
 * backwards.
 *
 * Refusing costs an ugly filename. Accepting files a hallucination in a legal
 * archive under a name that reads as authoritative.
 */
export function looksLikeProse(text: string): boolean {
  const t = text.toLowerCase();
  const words = t.split(/[^a-z\u00C0-\u024F]+/).filter(Boolean);
  // Too little to judge. A real document this short is named by hand.
  if (words.length < 40) return false;
  const hits = words.filter((w) => STOPWORDS.includes(w)).length;
  return hits / words.length >= MIN_STOPWORD_SHARE;
}

export function buildNamePrompt(currentName: string, text: string): string {
  const keep = identifierTokens(currentName);
  return [
    "Je krijgt de tekst van een gescand document uit een Nederlands persoonlijk archief.",
    "Bedenk een bestandsnaam die het document ondubbelzinnig beschrijft.",
    "",
    "De naam beantwoordt drie vragen, in deze volgorde, gescheiden door punten:",
    "  1. WAT is het?        (soort document)",
    "  2. WAARVOOR / WAARVAN? (organisatie, instantie, zaak, adres)",
    "  3. VOOR of VAN WIE?   (persoon)",
    "En als laatste het jaar, als dat in de tekst staat.",
    "",
    "Voorbeelden:",
    "  Machtiging.LBIO.Carolien.pdf",
    "  Arbeidsovereenkomst.Airteq.MP.van.der.Poel.2026.pdf",
    "  Verhuurdersverklaring.Slauerhoffstraat.203.2023.pdf",
    "  Jaaropgave.UWV.MP.van.der.Poel.2024.pdf",
    "",
    "Regels:",
    "- LANGE NAMEN ZIJN PRIMA. Volledig en onderscheidend is belangrijker dan kort.",
    "- Laat NOOIT een naam, plaats, organisatie, huisnummer of zaaknummer weg.",
    "- Laat de extensie weg; die wordt toegevoegd.",
    "- Alleen letters, cijfers, punten en koppeltekens. Geen spaties of slashes.",
    "- Verzin niets. Staat de organisatie niet in de tekst, gebruik dan wat de",
    "  huidige bestandsnaam al zegt.",
    "- Nederlandse spelling moet correct zijn.",
    "",
    `Huidige bestandsnaam: ${currentName}`,
    keep.length > 0
      ? `Deze woorden staan al in de naam en MOETEN terugkomen: ${keep.join(", ")}`
      : "De huidige naam zegt niets over de inhoud.",
    "",
    "Tekst van het document:",
    text.slice(0, 6000),
    "",
    'Antwoord met JSON: {"filename": "...", "confident": true|false}',
  ].join("\n");
}


/**
 * Words that name a DOCUMENT TYPE rather than identify a document. These may
 * be replaced by a better one (vaststellingovereenkomst -> beeindigings-
 * overeenkomst is an improvement, not a loss); everything else in a filename
 * is an identifier and must survive.
 */
const SOORT_SUFFIXES = [
  "overeenkomst", "verklaring", "formulier", "contract", "brief", "bewijs",
  "opgave", "strook", "beschikking", "machtiging", "convenant", "uittreksel",
  "aanmaning", "factuur", "polis", "akte", "volmacht", "rapport", "besluit",
  "vonnis", "registratie", "toestemming", "aanvraag", "offerte", "nota",
  "specificatie", "afschrift", "loonheffing", "oprichting", "aanbod",
  // English, and one misspelling that is in the archive as written.
  "settlement", "agreement", "statement", "license", "overeenkomt",
  // Type words that are not suffixes of a longer compound here.
  "melding", "overzicht", "verzoek", "opgaaf", "convenant",
];

/** Filename fragments that identify nothing. */
const NOISE = /^(scan|img|image|doc|document|documenten|screen|untitled|foto|photo|dsc|pdf|file|form|ok|def|final|kopie|copy|nieuw|new|stuk|stukken|bijlage)\d*$/i;

/**
 * Martin's own name. It appears in most of these files and therefore
 * distinguishes NONE of them from each other, so it is not an identifier for
 * this purpose — and insisting on it would refuse the legitimate abbreviation
 * Martin -> MP that half the archive already uses.
 */
const PERSON = /^(martin|poel|vanderpoel|mvanderpoel|mpvanderpoel|mp)$/i;

/** 1900-2099. The one number a document's text may legitimately correct. */
const YEAR = /^(19|20)\d\d$/;

/**
 * The parts of a filename that DISTINGUISH this document from another one:
 * organisations, places, house numbers, case numbers.
 *
 * Excluded, each for its own reason: document-type words (a better one is an
 * improvement); noise; Martin's own name; years (the text may correct them);
 * short alphabetic tokens, because an abbreviation is routinely EXPANDED by a
 * good rename -- vso.tdn.pdf becoming Beeindigingsovereenkomst.TrueFullstaq is
 * right, and demanding "vso" survive would refuse it.
 *
 * A name whose every alphabetic part is noise carries nothing at all, digits
 * included: IMG_2231 names a camera sequence, not a case number.
 */
export function identifierTokens(name: string): string[] {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, "");
  const parts = stem.split(/[.\-_ ]+/).map((t) => t.trim()).filter(Boolean);
  const alpha = parts.filter((t) => /[a-z\u00C0-\u024F]/i.test(t));
  if (alpha.length === 0 || alpha.every((t) => NOISE.test(t))) return [];
  const keep: string[] = [];
  for (const t of parts) {
    const low = t.toLowerCase();
    if (/^\d+$/.test(t)) {
      if (t.length >= 3 && !YEAR.test(t)) keep.push(low);
      continue;
    }
    if (t.length < 4) continue;
    if (NOISE.test(t) || PERSON.test(t)) continue;
    if (SOORT_SUFFIXES.some((sfx) => low === sfx || low.endsWith(sfx))) continue;
    keep.push(low);
  }
  return keep;
}

/** Squashed to letters and digits, so Saurens.Marketing matches SaurensMarketing. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/g, "");
}

/**
 * A rename may improve a name; it may never make the document harder to tell
 * apart. machtiging.carolien.pdf -> Machtiging.pdf drops the only thing that
 * said WHICH machtiging, and the first production run did exactly that five
 * times. The model cannot be trusted to hold on to detail the document text
 * does not repeat, so the rule is enforced here rather than asked for in the
 * prompt.
 */
export function retainsIdentifiers(oldName: string, newName: string): boolean {
  const hay = squash(newName);
  return identifierTokens(oldName).every((t) => hay.includes(squash(t)));
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
  if (!retainsIdentifiers(oldName, candidate)) return null;
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
    // Garbled OCR is worse than no OCR: it gives the model enough to be
    // confident about and nothing to be right about.
    if (!looksLikeProse(row.text)) {
      log(`  ~ ${oldName}: text is not readable (OCR)`); refused++; continue;
    }

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
