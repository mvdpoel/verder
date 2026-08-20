// Extract text for vault documents that have none — the one-off backfill for
// everything ingested before the knowledge base existed. Idempotent and safe to
// interrupt: a document whose stored sha256 still matches is skipped without
// re-reading or re-OCRing it.
//
//   pnpm --filter worker extract-texts
//
// In production it runs inside the worker container, like reindex:
//   docker compose --env-file .env.prod -f docker-compose.prod.yml \
//     exec -T worker pnpm --filter worker extract-texts
//
// Writing document_texts fires the migration-0019 trigger, so each extracted
// document re-enters search_outbox and the drain re-indexes it with its text.
import { createDb } from "@verder/db";
import { recordRun } from "../heartbeat";
import { extractMissingTexts } from "../extract-texts";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
const vaultDir = process.env.VAULT_DIR ?? "./vault-files";

const { db, pool } = createDb(url);
try {
  console.log("extract-texts: start");
  const res = await extractMissingTexts({
    db, vaultDir,
    onProgress: (done, total) => {
      // OCR is slow enough that silence looks like a hang.
      if (done % 10 === 0 || done === total) console.log(`extract-texts: ${done}/${total}`);
    },
  });
  await recordRun(db, "extract-texts", res.failed > 0 ? "error" : "ok", res);
  console.log(`extract-texts: done — scanned ${res.scanned}, extracted ${res.extracted},`
    + ` reused ${res.reused}, failed ${res.failed}`);
  if (res.failed > 0) process.exitCode = 1;
} catch (err) {
  await recordRun(db, "extract-texts", "error", { message: String(err) }).catch(() => {});
  console.error(`extract-texts: failed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
