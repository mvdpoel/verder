import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "./root";
import { createContext } from "./trpc";
import { loadWaiting } from "./waiting";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// verder_app has no INSERT on document_texts (0016): the worker writes it in
// production, so the fixture does too. Without the row every fixture document
// would sit in pendingDocMeta's backlog on the shared dev database forever.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const RUN_REF = `waiting-load-test-${crypto.randomUUID()}`;

describe("loadWaiting", () => {
  let db: Db; let writer: Db; let close: () => Promise<void>; let userId: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    const w = createDb(WORKER_URL);
    db = c.db; writer = w.db;
    close = async () => { await c.pool.end(); await w.pool.end(); };
    // documents.purge reads the vault; an empty one is the ENOENT path, which a
    // purge proceeds through by design.
    process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-waiting-"));
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN_REF}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  /** A document with a docmeta suggestion on it, pending review. */
  async function docWithSuggestion(label: string) {
    const sha = crypto.randomUUID().replaceAll("-", "").padEnd(64, "b");
    const doc = await caller().documents.registerUpload({
      sha256: sha, sizeBytes: 10, mime: "application/pdf", title: `${label} ${RUN_REF}`,
      source: "upload", sourceRef: RUN_REF, receivedAt: new Date() });
    await writer.execute(sql`INSERT INTO document_texts
      (document_id, sha256, text, extractor, char_count)
      VALUES (${doc.id}, ${sha}, '', 'none', 0)`);
    const [s] = await db.insert(schema.suggestions).values({
      kind: "document-meta", status: "pending", documentId: doc.id,
      proposed: { title: `Voorstel ${label}`, docType: null } }).returning();
    return { doc, suggestion: s };
  }

  const waitingIds = async () => new Set((await loadWaiting(db)).map((i) => i.id));
  const listedSuggestionIds = async () => {
    const c = caller();
    const [pending, manual] = await Promise.all([
      c.suggestions.list({ status: "pending" }), c.suggestions.list({ status: "needs-manual" })]);
    return [...pending, ...manual].map((s) => s.id);
  };

  it("a pending docmeta suggestion is waiting, titled by its proposal", async () => {
    const { suggestion } = await docWithSuggestion("Levend");
    const item = (await loadWaiting(db)).find((i) => i.id === suggestion.id);
    expect(item).toMatchObject({ kind: "suggestion", title: "Voorstel Levend", priority: 3 });
    // Decided, so the dev database's /queue does not grow by one per run.
    await caller().suggestions.reject({ id: suggestion.id, reason: "test fixture" });
    expect(await waitingIds()).not.toContain(suggestion.id);
  });

  it("purged document's suggestion is not waiting", async () => {
    const { doc, suggestion } = await docWithSuggestion("Vernietigd");
    expect(await waitingIds()).toContain(suggestion.id);
    await caller().documents.purge({ id: doc.id, reason: "test" });
    expect(await waitingIds()).not.toContain(suggestion.id);
    expect(await listedSuggestionIds()).not.toContain(suggestion.id);
  });

  it("discarded document's suggestion is not waiting", async () => {
    const { doc, suggestion } = await docWithSuggestion("Weggegooid");
    expect(await waitingIds()).toContain(suggestion.id);
    await caller().documents.update({ id: doc.id, status: "discarded" });
    expect(await waitingIds()).not.toContain(suggestion.id);
  });

  it("dashboard pendingSuggestions agrees with suggestions.list on a purged document", async () => {
    const { doc } = await docWithSuggestion("Teller");
    await caller().documents.purge({ id: doc.id, reason: "test" });
    const [stats, listed, waiting] = await Promise.all([
      caller().dashboard.stats(), listedSuggestionIds(), loadWaiting(db)]);
    // The two display surfaces and the waiting list, one definition. The dev
    // database already holds purged documents with pending suggestions left by
    // other suites, so a dashboard that only excludes discards over-counts here.
    expect(stats.pendingSuggestions).toBe(listed.length);
    expect(waiting.filter((i) => i.kind === "suggestion").length).toBe(listed.length);
  });

  it("an in-progress task is waiting and a waiting task is not, by effective status", async () => {
    const c = caller();
    const t = await c.tasks.create({ title: `Taak ${RUN_REF}` });
    expect(await waitingIds()).toContain(t.id);
    await c.tasks.setStatus({ taskId: t.id, status: "in-progress" });
    const item = (await loadWaiting(db)).find((i) => i.id === t.id);
    expect(item).toMatchObject({ kind: "task", title: `Taak ${RUN_REF}` });
    await c.tasks.setStatus({ taskId: t.id, status: "waiting" });
    expect(await waitingIds()).not.toContain(t.id);
  });

  it("count equals list length", async () => {
    const c = caller();
    const [list, count] = await Promise.all([c.inbox.list(), c.inbox.count()]);
    expect(count).toBe(list.length);
    expect(list.length).toBeGreaterThan(0);
  });
});
