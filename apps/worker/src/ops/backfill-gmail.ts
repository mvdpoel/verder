// One-shot Gmail history backfill. Reuses the exact production ingest path
// (pollGmail: evidence-first raw storage, idempotent on message id, per-message
// error isolation) with a wider query window. Safe to re-run at any time.
// Usage: BACKFILL_QUERY="newer_than:1y" pnpm --filter worker backfill
import PgBoss from "pg-boss";
import { createDb } from "@verder/db";
import { pollGmail } from "../gmail";
import { realGmailPort } from "../gmail-auth";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
const query = process.env.BACKFILL_QUERY ?? "newer_than:1y";

const { db, pool } = createDb(url);
const boss = new PgBoss(url);
await boss.start();

const gmail = await realGmailPort();
const result = await pollGmail({
  db, gmail, vaultDir: process.env.VAULT_DIR ?? "./vault-files", query,
  enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); },
});
console.log(`backfill (${query}): ingested ${result.ingested} emails`);
await boss.stop({ close: true, timeout: 5000 });
await pool.end();
