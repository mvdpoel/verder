import { beforeAll, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

/*
 * WORKER NAMES THIS FILE MAY WRITE. Three rules produced these four strings,
 * and every one of them was learned from a row that is still sitting in the dev
 * database.
 *
 * 1. NEVER A REAL WORKER'S NAME. This file used to insert a row for
 *    `case-history` and assert `state: "idle"`, and `case-history` is a real
 *    hand-run script that really runs against the dev database — 23 rows of it
 *    on 2026-09-01. There is no TRUNCATE here and dashboard.stats reads
 *    `DISTINCT ON (worker) … ORDER BY ran_at DESC`, so the assertion sees
 *    whatever ran LAST, not what this test inserted. Measured: one
 *    `('case-history','error')` row inserted by hand turned the assertion into
 *    `expected state "idle", received "down"` — a red test caused by somebody
 *    else's failed script, with nothing wrong in the code under test. A test
 *    that fails for a reason unconnected to the code is how a suite stops being
 *    read, which is the same disease on the test side that the amber panel had
 *    on the display side.
 *
 * 2. THE NAMES ARE STABLE, NOT `${Date.now()}`-SUFFIXED, and this is the
 *    deliberate half. worker_runs has no DELETE grant for verder_app or
 *    verder_worker (0001_grants.sql, 0004_worker_role.sql), so every distinct
 *    name a test invents is on the dev dashboard FOREVER — there is no role in
 *    the app that can clean it up. Measured on the dev database: 10 931 rows
 *    under 2 746 distinct worker names, 60 of them minted by the three
 *    assertions in this file alone, and `test-stale-*` renders amber by design.
 *    With a fixed name each run simply appends a newer row, DISTINCT ON picks
 *    it, and the dashboard shows exactly four extra rows no matter how often
 *    the suite runs. The cost is that two vitest processes running this file at
 *    the same instant would race for "newest row" — accepted, because
 *    verify.test.ts already TRUNCATEs the evidence tables and this suite has
 *    never been safe to run twice at once anyway (vitest.config.ts spells that
 *    out).
 *
 * 3. THE `test-` PREFIX IS WHAT MAKES THEM SAFE. declFor's fallback is
 *    "unknown name ⇒ watcher", deliberately, so an unclassified name is judged
 *    on age — which is exactly what the fresh/stale pair below wants and is why
 *    those two need no stub at all.
 */
const WATCHER_FRESH = "test-watcher-fresh";
const WATCHER_STALE = "test-watcher-stale";
const LATEST_ROW = "test-worker-latest";

/*
 * A hand-run row needs a KIND, and a kind comes from the DECLS table in
 * worker-health.ts — which holds only real workers. Rather than borrow one (see
 * rule 1) the declaration is stubbed for one made-up name and delegated for
 * every other, so the incident assertions below keep meeting the REAL taxonomy.
 *
 * vi.hoisted, because vi.mock is hoisted above this module's own const
 * initialisers and the factory would otherwise read `undefined` for the name it
 * is switching on.
 */
const HAND_RUN = vi.hoisted(() => "test-hand-run-script");
vi.mock("../worker-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-health")>();
  return {
    ...actual,
    declFor: (worker: string) =>
      worker === HAND_RUN ? { kind: "hand-run" as const } : actual.declFor(worker),
  };
});

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
    //
    // THE ONE PLACE A REAL WORKER NAME IS RIGHT, and it is safe for a reason
    // worth stating: `search-rerank` is the subject, not a stand-in, and an
    // incident marker is filtered out of the list REGARDLESS of status or age,
    // so no assertion here depends on what the newest row says. A real rerank
    // timeout landing between the insert and the query changes nothing — the
    // row is absent either way. That is exactly what the `case-history`
    // assertion could not claim: it read a status and a staleness.
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

  it("leaves pg-boss out of the watcher list too", async () => {
    // Same shape as search-rerank and the reason the ad-hoc list became a
    // taxonomy: boss.on("error") is the ONLY writer of a pg-boss row, so it too
    // can never go green, and it was never in INCIDENT_MARKERS. Both are now
    // classified in one place, so a third marker is a one-line declaration
    // rather than a second constant somebody has to remember to update.
    // The real name is safe here for the same reason as above: an incident row
    // is dropped whatever its status, so a genuine boss.on("error") landing
    // mid-test cannot move this assertion.
    const c = caller();
    await db.insert(schema.workerRuns).values({
      worker: "pg-boss", status: "error", detail: { message: "connection lost" } });
    const stats = await c.dashboard.stats();
    expect(stats.lastWorkerRuns.find((w) => w.worker === "pg-boss")).toBeUndefined();
  });

  it("reports the latest run per worker", async () => {
    const c = caller();
    await db.insert(schema.workerRuns).values({ worker: LATEST_ROW, status: "error",
      ranAt: new Date(Date.now() - 60_000) });
    await db.insert(schema.workerRuns).values({ worker: LATEST_ROW, status: "ok",
      ranAt: new Date() });
    const stats = await c.dashboard.stats();
    const run = stats.lastWorkerRuns.find((w) => w.worker === LATEST_ROW);
    expect(run?.status).toBe("ok");
    expect(run?.ranAt).toBeInstanceOf(Date);
  });

  it("serves the judgement as data: every row carries its kind and state", async () => {
    // THE POINT OF THE WHOLE CHANGE. The web app must never recompute
    // staleness: a second copy of the rule in a React component is how the two
    // drift, and the drift is invisible until a dead watcher renders green.
    const c = caller();
    await db.insert(schema.workerRuns).values({ worker: WATCHER_FRESH, status: "ok" });
    await db.insert(schema.workerRuns).values({ worker: WATCHER_STALE, status: "ok",
      ranAt: new Date(Date.now() - 60 * 60_000) });
    // A hand-run script silent for eleven days: the case that used to render
    // amber on a system where nothing at all was wrong. The NAME is invented
    // and its kind is stubbed — see the note at the top of this file. Borrowing
    // `case-history` here made the assertion depend on whether a real script
    // had run more recently than the row this test writes, which DISTINCT ON
    // would then hand back instead.
    await db.insert(schema.workerRuns).values({ worker: HAND_RUN, status: "ok",
      ranAt: new Date(Date.now() - 11 * 24 * 60 * 60_000) });

    const stats = await c.dashboard.stats();
    const row = (w: string) => stats.lastWorkerRuns.find((r) => r.worker === w);
    // Unknown names default to a watcher, so these two are judged on age — no
    // stub needed, and the default itself is what they pin.
    expect(row(WATCHER_FRESH)).toMatchObject({ kind: "watcher", state: "ok" });
    expect(row(WATCHER_STALE)).toMatchObject({ kind: "watcher", state: "down" });
    expect(row(HAND_RUN)).toMatchObject({ kind: "hand-run", state: "idle" });
  });
});
