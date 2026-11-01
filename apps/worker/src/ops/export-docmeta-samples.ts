import { chmod, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { notDiscardedSql, notPurgedSql } from "@verder/api/src/effective-status";
import { docTypeKey } from "@verder/api/src/doc-type";

/**
 * The docmeta eval's samples: Martin's real verdicts on document-meta
 * suggestions, each with the text the model was given.
 *
 * Hand-run from the homelab HOST on the WORKER role (plan 3, Task 13), which
 * holds SELECT on every table read here. Output goes to $DOCMETA_EVAL_SAMPLES.
 *
 * THE FILE HOLDS MARTIN'S REAL DOCUMENT TEXT AND IS NEVER COMMITTED. It lives
 * at /srv/verder/eval/docmeta-samples.json, outside ~/apps/verder, so neither
 * git nor `rsync --delete` can reach it; writeDocMetaSamples refuses any path
 * inside this repository and writes the file 0600.
 */

export type DocMetaVerdict = "edited" | "approved-differs" | "approved-unchanged";

export interface DocMetaSample {
  documentId: string;
  /**
   * `edited` is the honest verdict Task 10 records. Before Task 10 every
   * approval was written `approved`, edited or not, so an `approved` row whose
   * proposal differs from what Martin saved is an edit too (`approved-differs`)
   * — the same comparison Task 10 makes: title exactly, soort through the fold.
   */
  verdict: DocMetaVerdict;
  /** document_texts.text, first 4000 characters — what buildDocMetaPrompt keeps. */
  text: string;
  /**
   * The document's effective title AS IT STOOD WHEN THE SUGGESTION WAS MADE:
   * the newest titled change row older than the suggestion, else the raw
   * title. That is what docmeta-v2 is shown (auto-name's rename lands before
   * the suggestion, in the same job), and it deliberately excludes the change
   * row Martin's approval wrote — the CURRENT title would hand the model his
   * answer as its "filename".
   */
  promptTitle: string;
  expected: { title: string; docType: string | null };
}

interface Row {
  document_id: string; status: "approved" | "edited";
  proposed_title: string | null; proposed_doc_type: string | null;
  final_title: string; final_doc_type: string | null;
  prompt_title: string; text: string;
}

export async function loadDocMetaSamples(db: Db): Promise<DocMetaSample[]> {
  const rows = (await db.execute(sql`
    SELECT s.document_id, s.status::text AS status,
      s.proposed->>'title' AS proposed_title, s.proposed->>'docType' AS proposed_doc_type,
      s.final_payload->>'title' AS final_title, s.final_payload->>'docType' AS final_doc_type,
      COALESCE((
        SELECT c.title FROM document_status_changes c
        WHERE c.document_id = documents.id AND c.title IS NOT NULL
          AND c.created_at < s.created_at
        ORDER BY c.created_at DESC LIMIT 1), documents.title) AS prompt_title,
      left(t.text, 4000) AS text
    FROM ${schema.suggestions} s
    JOIN ${schema.documents} ON documents.id = s.document_id
    JOIN ${schema.documentTexts} t ON t.document_id = documents.id
    WHERE s.kind = 'document-meta'
      -- Rejected is left out on purpose: "Niet relevant" is a judgement about
      -- relevance, not about the metadata. auto-applied is verder's own verdict.
      AND s.status IN ('approved', 'edited')
      AND s.final_payload ? 'title'
      -- A needs-manual fallback copies the raw title with no soort: approving
      -- one records Martin's answer to a question the model never answered.
      AND NOT (s.proposed->>'docType' IS NULL AND s.proposed->>'title' = documents.title)
      AND ${notDiscardedSql}
      AND ${notPurgedSql}
    ORDER BY s.created_at ASC
  `)).rows as unknown as Row[];
  return rows.map((r) => ({
    documentId: r.document_id,
    verdict: r.status === "edited" ? "edited"
      : r.proposed_title === r.final_title
        && docTypeKey(r.proposed_doc_type) === docTypeKey(r.final_doc_type)
        ? "approved-unchanged" : "approved-differs",
    text: r.text,
    promptTitle: r.prompt_title,
    expected: { title: r.final_title, docType: r.final_doc_type },
  }));
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export async function writeDocMetaSamples(path: string, samples: DocMetaSample[]): Promise<void> {
  const target = resolve(path);
  if (target.startsWith(resolve(REPO_ROOT) + sep))
    throw new Error(`refusing to write real document text inside the repository: ${target}`);
  await writeFile(target, JSON.stringify(samples, null, 2), { mode: 0o600 });
  // `mode` applies only when the file is created; a re-export keeps the old mode.
  await chmod(target, 0o600);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.env.DOCMETA_EVAL_SAMPLES;
  if (!out) {
    console.error("export-docmeta-samples: set DOCMETA_EVAL_SAMPLES (e.g. /srv/verder/eval/docmeta-samples.json)");
    process.exit(1);
  }
  const { db, pool } = createDb(process.env.DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder");
  try {
    const samples = await loadDocMetaSamples(db);
    await writeDocMetaSamples(out, samples);
    const count = (v: DocMetaVerdict) => samples.filter((s) => s.verdict === v).length;
    // Counts only: never a title or a line of text on the terminal.
    console.log(`export-docmeta-samples: n=${samples.length}`
      + ` edited=${count("edited")} approved-differs=${count("approved-differs")}`
      + ` approved-unchanged=${count("approved-unchanged")} -> ${out}`);
  } catch (err) {
    console.error(`export-docmeta-samples: failed — ${String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
