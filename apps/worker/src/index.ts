import PgBoss from "pg-boss";
import { createDb } from "@verder/db";
import { recordRun } from "./heartbeat";
import { pollGmail } from "./gmail";
import { realGmailPort } from "./gmail-auth";

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

console.log("worker up");
