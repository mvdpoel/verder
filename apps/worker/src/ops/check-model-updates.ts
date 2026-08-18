// Nightly Ollama model freshness check. Ollama pulls are idempotent — pulling
// an up-to-date tag is a no-op, an updated tag downloads the new weights.
// Records what happened to worker_runs so the dashboard heartbeat list shows
// when the model last changed.
import { createDb } from "@verder/db";
import { recordRun } from "../heartbeat";

const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const base = process.env.OLLAMA_URL ?? "http://localhost:11434";
const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";

const { db, pool } = createDb(url);
try {
  const local = await fetch(`${base}/api/show`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) })
    .then((r) => r.json()) as { details?: { parameter_size?: string }; modified_at?: string };
  const pull = await fetch(`${base}/api/pull`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false }) }).then((r) => r.json()) as { status?: string };
  await recordRun(db, "model-check", "ok", {
    model, localModifiedAt: local.modified_at, pullStatus: pull.status });
  console.log(`model-check: ${model} → ${pull.status}`);
} catch (err) {
  await recordRun(db, "model-check", "error", { model, message: String(err) }).catch(() => {});
  console.error(`model-check: failed — ${String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
