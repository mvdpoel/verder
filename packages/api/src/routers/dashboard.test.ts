import { beforeAll, describe, expect, it } from "vitest";
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
