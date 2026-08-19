import { describe, expect, it } from "vitest";
import { eq, sql, and, gt } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import type { LlmPort } from "./ollama";
import { suggestTask } from "./task-mine";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

async function insertEmail(
  db: ReturnType<typeof createDb>["db"],
  over: { subject?: string; bodyText?: string } = {},
) {
  const [email] = await db.insert(schema.rawEmails).values({
    gmailMessageId: `task-mine-test-${crypto.randomUUID()}`,
    gmailThreadId: `thread-${crypto.randomUUID()}`,
    fromAddr: "contact@verdergroep.nl",
    toAddr: "martin@vanderpoel.pro",
    subject: over.subject ?? "Documenten aanleveren",
    sentAt: new Date("2026-08-10T09:00:00Z"),
    rawRfc822Sha256: `sha-${crypto.randomUUID()}`,
    bodyText: over.bodyText ?? "Graag een kopie van uw paspoort opsturen voor 20 augustus.",
  }).returning();
  return email;
}

const taskSuggestionsFor = (db: ReturnType<typeof createDb>["db"], rawEmailId: string) =>
  db.select().from(schema.suggestions)
    .where(and(eq(schema.suggestions.kind, "task"),
      sql`${schema.suggestions.proposed} ->> 'rawEmailId' = ${rawEmailId}`));

const fixedLlm = (out: unknown): LlmPort => ({ chatJson: async () => out });

describe("suggestTask", () => {
  it("turns a clear action-item email into a task suggestion with the full payload", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    const prompts: string[] = [];
    const llm: LlmPort = { chatJson: async (p) => { prompts.push(p);
      return { isTask: true, title: "Kopie paspoort opsturen 2026",
        details: "VerderGroep vraagt om een kopie paspoort.",
        dueAt: "2026-08-20", assigneeHint: "martin" }; } };
    await suggestTask({ db, llm }, email.id);
    const found = await taskSuggestionsFor(db, email.id);
    expect(found).toHaveLength(1);
    const s = found[0];
    expect(s.kind).toBe("task");
    expect(s.status).toBe("pending");
    expect(s.rawEmailId).toBe(email.id);
    expect(s.promptVersion).toBe("task-v1");
    expect(s.model).toBeTruthy();
    const p = s.proposed as Record<string, unknown>;
    expect(p.title).toBe("Kopie paspoort opsturen 2026");
    expect(p.details).toBe("VerderGroep vraagt om een kopie paspoort.");
    expect(p.dueAt).toBe("2026-08-20");
    expect(p.assigneeHint).toBe("martin");
    expect(p.rawEmailId).toBe(email.id);
    // Namespaced dedup key: task:<rawEmailId>:<normalized title> (digits stripped).
    expect(p.key).toBe(`task:${email.id}:kopie paspoort opsturen`);
    // The email actually reaches the prompt.
    expect(prompts.some((x) => x.includes("Documenten aanleveren"))).toBe(true);
    expect(prompts.some((x) => x.includes("kopie van uw paspoort"))).toBe(true);
    // The run is visible on the dashboard.
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "task-mine"));
    expect(runs.some((r) => r.status === "ok"
      && (r.detail as Record<string, unknown> | null)?.rawEmailId === email.id)).toBe(true);
    await pool.end();
  });

  it("mines each email exactly once — the second call inserts nothing", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    const llm1 = fixedLlm({ isTask: true, title: "Eerste titel", details: "",
      dueAt: null, assigneeHint: "martin" });
    await suggestTask({ db, llm: llm1 }, email.id);
    // Even a different title on re-run must not create a second suggestion:
    // convergence is per-email, not per-title.
    const llm2 = fixedLlm({ isTask: true, title: "Andere titel", details: "",
      dueAt: null, assigneeHint: "other" });
    await suggestTask({ db, llm: llm2 }, email.id);
    expect(await taskSuggestionsFor(db, email.id)).toHaveLength(1);
    await pool.end();
  });

  it("never resurrects a rejected task suggestion for the same email", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    await db.insert(schema.suggestions).values({
      kind: "task", status: "rejected", rawEmailId: email.id,
      proposed: { key: `task:${email.id}:oude titel`, title: "Oude titel",
        rawEmailId: email.id } });
    await suggestTask({ db,
      llm: fixedLlm({ isTask: true, title: "Nieuwe titel", details: "",
        dueAt: null, assigneeHint: "martin" }) }, email.id);
    const found = await taskSuggestionsFor(db, email.id);
    expect(found).toHaveLength(1);               // only the rejected one
    expect(found[0].status).toBe("rejected");
    await pool.end();
  });

  it("inserts nothing when the model says the email is not a task", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db, { subject: "Statusupdate dossier",
      bodyText: "Ter informatie: uw dossier is in behandeling. U hoeft niets te doen." });
    await suggestTask({ db,
      llm: fixedLlm({ isTask: false, title: "", details: "", dueAt: null,
        assigneeHint: "other" }) }, email.id);
    expect(await taskSuggestionsFor(db, email.id)).toHaveLength(0);
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "task-mine"));
    expect(runs.some((r) => r.status === "ok"
      && (r.detail as Record<string, unknown> | null)?.rawEmailId === email.id
      && (r.detail as Record<string, unknown> | null)?.isTask === false)).toBe(true);
    await pool.end();
  });

  it("swallows an LLM failure: nothing inserted, failed run recorded, no exception escapes", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    const before = new Date();
    await expect(suggestTask({ db,
      llm: { chatJson: async () => { throw new Error("ollama down"); } } },
      email.id)).resolves.toBeUndefined();
    expect(await taskSuggestionsFor(db, email.id)).toHaveLength(0);
    const runs = await db.select().from(schema.workerRuns)
      .where(and(eq(schema.workerRuns.worker, "task-mine"),
        gt(schema.workerRuns.ranAt, before)));
    expect(runs.some((r) => r.status === "error"
      && (r.detail as Record<string, unknown> | null)?.rawEmailId === email.id)).toBe(true);
    await pool.end();
  });

  it("records a failure (not an insert) when the model reply is unparseable", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    // isTask true without a usable title is unparseable, not a task.
    await expect(suggestTask({ db,
      llm: fixedLlm({ isTask: true, title: "", details: "", dueAt: null,
        assigneeHint: "martin" }) }, email.id)).resolves.toBeUndefined();
    expect(await taskSuggestionsFor(db, email.id)).toHaveLength(0);
    const runs = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "task-mine"));
    expect(runs.some((r) => r.status === "error"
      && (r.detail as Record<string, unknown> | null)?.rawEmailId === email.id)).toBe(true);
    await pool.end();
  });

  it("degrades a garbage dueAt to null instead of dropping the task", async () => {
    const { db, pool } = createDb(URL);
    const email = await insertEmail(db);
    await suggestTask({ db,
      llm: fixedLlm({ isTask: true, title: "Formulier invullen", details: "",
        dueAt: "zo snel mogelijk", assigneeHint: "onzin" }) }, email.id);
    const [s] = await taskSuggestionsFor(db, email.id);
    expect(s).toBeDefined();
    const p = s.proposed as Record<string, unknown>;
    expect(p.dueAt).toBeNull();
    expect(p.assigneeHint).toBe("other");        // unknown hint degrades too
    await pool.end();
  });

  it("returns silently for a nonexistent email id", async () => {
    const { db, pool } = createDb(URL);
    const ghost = crypto.randomUUID();
    await expect(suggestTask({ db, llm: fixedLlm({}) }, ghost))
      .resolves.toBeUndefined();
    expect(await taskSuggestionsFor(db, ghost)).toHaveLength(0);
    await pool.end();
  });
});
