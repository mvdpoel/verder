/**
 * CLI for normalizeFilenames. Defaults to a PREVIEW: it names every file it
 * would rename and touches nothing until --commit.
 *
 *   pnpm --filter worker normalize-names            # preview the opaque ones
 *   pnpm --filter worker normalize-names --all      # preview every scan doc
 *   pnpm --filter worker normalize-names --all --commit
 *   pnpm --filter worker normalize-names --undo <journal.jsonl>
 */
import { readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";
import { effectiveDocument } from "@verder/api/src/routers/documents";
import { normalizeFilenames } from "./normalize-filenames";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const scanDir = process.env.NAS_SCAN_DIR ?? "/scans";
const url = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL!;
const { db, pool } = createDb(url);

// Deliberately its OWN Ollama endpoint, not the worker's OLLAMA_URL: this is a
// one-off bulk pass on the M3 (48 GB unified memory, qwen3:30b-a3b), while the
// live pipeline keeps using the homelab — whose nomic-embed-text the M3 does
// not have, so repointing OLLAMA_URL wholesale would break search indexing.
const ollama = val("ollama", process.env.NORMALIZE_OLLAMA_URL ?? "http://192.168.188.114:11434");
const model = val("model", process.env.NORMALIZE_MODEL ?? "qwen3:30b-a3b");

async function chatJson(prompt: string): Promise<unknown> {
  const res = await fetch(`${ollama}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }],
      format: "json", stream: false, think: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message: { content: string } };
  return JSON.parse(data.message.content) as unknown;
}

/** Puts every file in the journal back, newest entry first. */
async function undo(path: string): Promise<void> {
  const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  let back = 0;
  for (const line of lines.reverse()) {
    const e = JSON.parse(line) as { documentId: string; oldName: string; newName: string };
    const cur = join(scanDir, e.newName);
    if (existsSync(cur)) { await rename(cur, join(scanDir, e.oldName)); }
    await db.transaction(async (tx) => {
      const current = await effectiveDocument(tx, e.documentId);
      if (current.effectiveTitle === e.oldName) return;
      await tx.insert(schema.documentStatusChanges).values({
        documentId: e.documentId, status: current.effectiveStatus, title: e.oldName });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: e.documentId,
        payload: { id: e.documentId, status: current.effectiveStatus,
          title: e.oldName, docType: null, partyId: null } });
    });
    back++;
  }
  console.log(`restored ${back} filenames from ${path}`);
}

const journalPath = val("journal",
  `/journal/normalize-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

if (flag("undo")) {
  await undo(val("undo", ""));
} else {
  const commit = flag("commit");
  console.log(commit ? `APPLYING — journal: ${journalPath}` : "PREVIEW — nothing is written");
  console.log(`ollama ${ollama} model ${model} dir ${scanDir}\n`);
  const res = await normalizeFilenames({
    db, scanDir, llm: chatJson, journalPath,
    all: flag("all"), limit: Number(val("limit", "9999")), commit,
    log: (s) => console.log(s),
  });
  console.log(`\nrenamed ${res.renamed}  proposed ${res.plans.length}  `
    + `skipped ${res.skipped}  refused ${res.refused}`);
  if (commit) console.log(`undo with: pnpm --filter worker normalize-names --undo ${journalPath}`);
}
await pool.end();
