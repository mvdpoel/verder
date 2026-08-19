import { readFile } from "node:fs/promises";
import PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";
import { pollGmail } from "./gmail";
import { realGmailPort } from "./gmail-auth";
import { realLlmPort, suggestDocMeta, suggestEntry } from "./ollama";
import { scanNasFolder } from "./nas";
import { mineRegistry } from "./registry-mine";
import { suggestTask } from "./task-mine";
import { resolveAggregator } from "./receipts";
import { sendPush } from "./push";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
export const { db } = createDb(url);
const boss = new PgBoss(url);

boss.on("error", (err) => { void recordRun(db, "pg-boss", "error", { message: String(err) }); });

await boss.start();
await boss.createQueue("heartbeat");
await boss.schedule("heartbeat", "*/5 * * * *");
await boss.work("heartbeat", async () => { await recordRun(db, "heartbeat", "ok"); });
// Tasks 16–19 append their queues, schedules and workers below this line.

await boss.createQueue("gmail.poll");
await boss.createQueue("suggest.entry");
await boss.schedule("gmail.poll", "*/3 * * * *");
await boss.work("gmail.poll", async () => {
  const gmail = await realGmailPort();
  await pollGmail({ db, gmail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); } });
});

const llm = realLlmPort();

async function extractText(mime: string, buf: Buffer): Promise<string> {
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return (await pdfParse(buf)).text;
  }
  if (mime.startsWith("image/")) {
    const { recognize } = await import("tesseract.js");
    return (await recognize(buf, "nld+eng")).data.text;
  }
  return "";
}

await boss.work("suggest.entry", async ([job]) => {
  const { rawEmailId } = job.data as { rawEmailId: string };
  await suggestEntry({ db, llm, sendPush }, rawEmailId);
  // Action-item mining rides along, error-isolated: suggestTask swallows its
  // own failures, and this guard makes sure a task-mine crash can never fail
  // (and re-run) the entry suggestion above.
  try { await suggestTask({ db, llm }, rawEmailId); }
  catch (err) { await recordRun(db, "task-mine", "error", { rawEmailId, message: String(err) }); }
});

await boss.createQueue("suggest.docmeta");
await boss.work("suggest.docmeta", async ([job]) => {
  const { documentId } = job.data as { documentId: string };
  const [doc] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  await suggestDocMeta({ db, llm, extractText, sendPush }, documentId, buf);
});

await boss.createQueue("nas.scan");
await boss.schedule("nas.scan", "*/2 * * * *");
await boss.work("nas.scan", async () => {
  await scanNasFolder({ db, scanDir: process.env.NAS_SCAN_DIR ?? "/mnt/nas/scans",
    vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueDocMeta: async (documentId) => { await boss.send("suggest.docmeta", { documentId }); } });
});

// Registry mining sweep: no direct enqueue from web — the cron sweeps all
// un-mined transactions (idempotent via suggestion-key dedup, matches the
// watcher architecture). receipts.resolve is consumed by Task 8; the queue
// exists already so aggregator candidates enqueue safely.
await boss.createQueue("registry.mine");
await boss.createQueue("receipts.resolve");
await boss.schedule("registry.mine", "*/2 * * * *");
await boss.work("registry.mine", async () => {
  await mineRegistry({ db, llm,
    enqueueResolve: async (suggestionId) => { await boss.send("receipts.resolve", { suggestionId }); } });
});

// Aggregator resolution: APPLE.COM/BILL and PayPal statement lines resolve
// into real subscriptions via targeted Gmail receipt searches.
await boss.work("receipts.resolve", async ([job]) => {
  const gmail = await realGmailPort();
  await resolveAggregator({ db, gmail, llm,
    vaultDir: process.env.VAULT_DIR ?? "./vault-files" },
    (job.data as { suggestionId: string }).suggestionId);
});

console.log("worker up");
