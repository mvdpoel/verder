import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("dashboard router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `dash${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  it("counts move when a pending suggestion, inbox doc, and open action item appear", async () => {
    const c = caller();
    const before = await c.dashboard.stats();

    await db.insert(schema.suggestions).values({
      kind: "log-entry",
      proposed: { summary: "Test suggestion" },
    });
    await c.documents.registerUpload({ sha256: sha(), sizeBytes: 3,
      mime: "application/pdf", title: "Inbox doc", source: "upload", receivedAt: new Date() });
    await c.entries.create({ occurredAt: new Date(), channel: "call", direction: "inbound",
      summary: "Call with case manager", participantPartyIds: [], documentIds: [],
      actionItems: [{ description: "Send payslips", clarity: "clear" }] });

    const after = await c.dashboard.stats();
    expect(after.pendingSuggestions).toBe(before.pendingSuggestions + 1);
    expect(after.inboxDocs).toBe(before.inboxDocs + 1);
    expect(after.openActionItems).toBe(before.openActionItems + 1);
  });

  it("inbox count drops when a document is filed; done action items stop counting", async () => {
    const c = caller();
    const doc = await c.documents.registerUpload({ sha256: sha(), sizeBytes: 3,
      mime: "application/pdf", title: "To file", source: "upload", receivedAt: new Date() });
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "email",
      direction: "inbound", summary: "Request", participantPartyIds: [], documentIds: [],
      actionItems: [{ description: "Reply", clarity: "clear" }] });
    const before = await c.dashboard.stats();

    await c.documents.update({ id: doc.id, status: "filed", title: "Filed doc" });
    const [item] = await db.select().from(schema.actionItems)
      .where((await import("drizzle-orm")).eq(schema.actionItems.entryId, entry.id));
    await db.insert(schema.actionItemStatusChanges)
      .values({ actionItemId: item.id, status: "done" });

    const after = await c.dashboard.stats();
    expect(after.inboxDocs).toBe(before.inboxDocs - 1);
    expect(after.openActionItems).toBe(before.openActionItems - 1);
  });

  it("stops counting a suggestion once its document is discarded", async () => {
    // The tile and the queue must agree. suggestions.list drops a suggestion
    // whose document is discarded, so a tile that keeps counting it renders
    // "1 to review" linking to a page that says the queue is empty — and the
    // count never drains, because there is no surface left to decide it on.
    const c = caller();
    const doc = await c.documents.registerUpload({ sha256: sha(), sizeBytes: 3,
      mime: "image/png", title: "image.png", source: "email-attachment",
      receivedAt: new Date() });
    await db.insert(schema.suggestions).values({
      kind: "document-meta", documentId: doc.id, proposed: { title: "image.png" } });
    const before = await c.dashboard.stats();
    const queueBefore = (await c.suggestions.list({ status: "pending" })).length;

    await c.documents.update({ id: doc.id, status: "discarded", title: "image.png" });

    const after = await c.dashboard.stats();
    expect(after.pendingSuggestions).toBe(before.pendingSuggestions - 1);
    expect((await c.suggestions.list({ status: "pending" })).length).toBe(queueBefore - 1);
  });

  it("leaves incident markers out of the watcher list", async () => {
    // THE BUG THIS PINS. `search-rerank` is written only by search/retrieve.ts,
    // only with status "error", when a deep search's rerank times out — no code
    // path anywhere writes it "ok", and nothing in apps/web requests
    // mode:"deep". The dashboard reads this list as "things that should be
    // running" (down = stale || status !== "ok", 15-minute staleness), so one
    // Ollama timeout on 2026-08-23 turned the tile red permanently: clearing it
    // needed a success row nothing writes, from a mode nothing requests.
    //
    // The row must still be RECORDED — the history is the point — so this
    // asserts both halves: written to worker_runs, absent from the tile.
    const c = caller();
    await db.insert(schema.workerRuns).values({
      worker: "search-rerank", status: "error",
      detail: { promptVersion: "rerank-v1", message: "TimeoutError" },
    });
    const stats = await c.dashboard.stats();
    expect(stats.lastWorkerRuns.find((w) => w.worker === "search-rerank")).toBeUndefined();
    const [kept] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "search-rerank"))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
    expect(kept?.status).toBe("error");
  });

  it("reports the latest run per worker", async () => {
    const c = caller();
    const worker = `test-worker-${Date.now()}`;
    await db.insert(schema.workerRuns).values({ worker, status: "error",
      ranAt: new Date(Date.now() - 60_000) });
    await db.insert(schema.workerRuns).values({ worker, status: "ok", ranAt: new Date() });
    const stats = await c.dashboard.stats();
    const run = stats.lastWorkerRuns.find((w) => w.worker === worker);
    expect(run?.status).toBe("ok");
    expect(run?.ranAt).toBeInstanceOf(Date);
  });
});
