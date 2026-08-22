import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { setTaskStatus } from "../task-decide";
import { documentStatusChangePayload } from "../verification";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// Scoped to the tracks this suite creates. The seeded root is shared with every
// other suite, so nothing here asserts a total.
//
// The app role has no DELETE on tracks or stops (they are an editable display
// aid, not evidence, but still append-only to the app), so a fixture a test
// creates stays on Martin's dev map forever. Hence fixed titles, found-or-
// created: a suite that runs a hundred times must not grow the map a hundred
// side tracks.
describe("tracks router", () => {
  let db: Db; let userId: string; let rootId: string; let anchorId: string;

  // Fixed, not Date.now()-suffixed — see the note above.
  const mine = "probe (tracks router)";

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `tracks${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    // The main line and its first stop normally come from migration 0023's
    // seed. verify.test.ts truncates the evidence tables CASCADE, which reaches
    // stops (entry_id, document_id) and through them tracks, so in a whole-suite
    // run the map may be gone by the time this file starts. Found-or-created,
    // so this suite is honest about the router either way and never depends on
    // which file ran first.
    const [root] = await db.select().from(schema.tracks)
      .where(isNull(schema.tracks.parentTrackId));
    rootId = root?.id
      ?? (await caller().tracks.createTrack({ title: "Einde bewindvoering" })).id;
    const [anchor] = await db.select().from(schema.stops)
      .where(eq(schema.stops.trackId, rootId))
      .orderBy(asc(schema.stops.orderIndex), asc(schema.stops.id)).limit(1);
    anchorId = anchor?.id
      ?? (await caller().tracks.createStop({
        trackId: rootId, title: "Start", kind: "process", state: "done",
        happenedAt: new Date(),
      })).id;
  });

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  /** Oldest wins, so a run always resolves the same fixture as the run before. */
  const track = async (title: string, parentTrackId: string, branchesAtStopId: string) => {
    const [found] = await db.select().from(schema.tracks)
      .where(eq(schema.tracks.title, title))
      .orderBy(asc(schema.tracks.createdAt), asc(schema.tracks.id)).limit(1);
    return found ?? await caller().tracks.createTrack({ title, parentTrackId, branchesAtStopId });
  };

  const stop = async (
    trackId: string, title: string,
    rest: { state?: "done" | "open" | "expected"; happenedAt?: Date } = {},
  ) => {
    const [found] = await db.select().from(schema.stops)
      .where(and(eq(schema.stops.trackId, trackId), eq(schema.stops.title, title)))
      .orderBy(asc(schema.stops.orderIndex), asc(schema.stops.id)).limit(1);
    return found ?? await caller().tracks.createStop({ trackId, title, ...rest });
  };

  it("creates a side track that branches from a stop on the main line", async () => {
    const created = await track(`${mine} Ontruiming`, rootId, anchorId);
    expect(created.parentTrackId).toBe(rootId);
    expect(created.branchesAtStopId).toBe(anchorId);
    expect(created.mergesAtStopId).toBeNull(); // it may simply end; that is a real outcome
    const { map } = await caller().tracks.map();
    expect(map.tracks.some((t) => t.id === created.id)).toBe(true);
  });

  it("refuses a second root track", async () => {
    await expect(caller().tracks.createTrack({ title: `${mine} tweede hoofdlijn` }))
      .rejects.toThrow(/hoofdlijn/i);
  });

  it("refuses a track that would become its own ancestor", async () => {
    const a = await track(`${mine} A`, rootId, anchorId);
    const stopOnA = await stop(a.id, "halte");
    const b = await track(`${mine} B`, a.id, stopOnA.id);
    await expect(caller().tracks.updateTrack({ id: a.id, parentTrackId: b.id }))
      .rejects.toThrow(/eigen/i);
    // Refused means refused: A still departs from the main line.
    const [after] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, a.id));
    expect(after.parentTrackId).toBe(rootId);
  });

  it("appends a stop at the end of its track and hands back the evidence map", async () => {
    const opstart = await track(`${mine} Team Opstart`, rootId, anchorId);
    const first = await stop(opstart.id, "documenten opgevraagd", {
      state: "done", happenedAt: new Date("2026-08-01T00:00:00Z"),
    });
    const second = await stop(opstart.id, "bijzondere bijstand aanvragen", { state: "open" });
    expect(second.orderIndex).toBeGreaterThan(first.orderIndex);
    // "At the end" is the invariant, on the run that inserts and on every run
    // after it: these two are the last stops on their track, in this order.
    const onTrack = await db.select({ id: schema.stops.id }).from(schema.stops)
      .where(eq(schema.stops.trackId, opstart.id))
      .orderBy(asc(schema.stops.orderIndex), asc(schema.stops.id));
    expect(onTrack.slice(-2).map((s) => s.id)).toEqual([first.id, second.id]);

    const { map, evidence } = await caller().tracks.map();
    const cols = (id: string) => map.stops.find((s) => s.id === id)!.column;
    expect(cols(second.id)).toBeGreaterThan(cols(first.id));
    // Every stop on the map has an evidence entry, even an empty one.
    expect(evidence[second.id]).toBeDefined();
    expect(evidence[second.id].documents).toEqual([]);
  });

  it("marks the furthest open stop as current", async () => {
    const { map } = await caller().tracks.map();
    const current = map.stops.find((s) => s.id === map.currentStopId);
    if (current) expect(current.state).toBe("open");
  });

  it("refuses a branch point that is not on the line the spoor leaves", async () => {
    const a = await track(`${mine} A`, rootId, anchorId);
    const stopOnA = await stop(a.id, "halte");
    // Departing from the main line, but pointing at a halte on A: the map would
    // have to draw a departure from a line this spoor never touches, and
    // branching off a descendant is how the cycle gets in.
    await expect(caller().tracks.createTrack({
      title: `${mine} verkeerde aftakking`, parentTrackId: rootId,
      branchesAtStopId: stopOnA.id,
    })).rejects.toThrow(/verlaat/i);
  });

  it("refuses a merge point that is not on the line the spoor left", async () => {
    const a = await track(`${mine} A`, rootId, anchorId);
    const c = await track(`${mine} C`, rootId, anchorId);
    const stopOnC = await stop(c.id, "halte op C");
    await expect(caller().tracks.updateTrack({ id: a.id, mergesAtStopId: stopOnC.id }))
      .rejects.toThrow(/verliet/i);
    // Refused means refused: A still simply ends, which is a real outcome.
    const [after] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, a.id));
    expect(after.mergesAtStopId).toBeNull();
  });

  it("offers linkable evidence, and never a discarded document", async () => {
    // Without linkOptions nothing can ever set entryId/documentId on a stop
    // through the UI, so the whole third level of the map is unreachable.
    const token = `linkopt${Date.now()}`;
    const [entry] = await db.insert(schema.logEntries).values({
      occurredAt: new Date(), channel: "email", direction: "inbound",
      summary: `Documenten opgevraagd ${token}`, source: "manual", createdBy: userId,
    }).returning();
    const document = async (title: string) => {
      const [d] = await db.insert(schema.documents).values({
        title, source: "upload", mime: "application/pdf", sizeBytes: 12,
        sha256: createHash("sha256").update(title).digest("hex"), receivedAt: new Date(),
      }).returning();
      return d;
    };
    const live = await document(`Loonstrook ${token}.pdf`);
    const gone = await document(`Weggegooid ${token}.png`);
    // Through the append-only path with its ledger event, the way
    // documents.update does it — a status change without one is tampering.
    await db.transaction(async (tx) => {
      const [change] = await tx.insert(schema.documentStatusChanges)
        .values({ documentId: gone.id, status: "discarded" }).returning();
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: gone.id,
        payload: documentStatusChangePayload(change),
      });
    });

    const options = await caller().tracks.linkOptions({ search: token });
    expect(options.entries.map((e) => e.id)).toContain(entry.id);
    expect(options.entries.find((e) => e.id === entry.id)!.channel).toBe("email");
    expect(options.documents.map((d) => d.id)).toContain(live.id);
    // The discard is appended, never written back to documents.status, so a raw
    // read would offer Martin the file he threw away.
    expect(options.documents.map((d) => d.id)).not.toContain(gone.id);
  });

  it("hands back a task's live status with the link options", async () => {
    const [task] = await db.insert(schema.tasks)
      .values({ title: `Linkoptie ${Date.now()}`, createdBy: userId }).returning();
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress" }));
    const options = await caller().tracks.linkOptions();
    // Read live from task_status_changes: tasks has no status column, so
    // anything else would have to invent one.
    expect(options.tasks.find((t) => t.id === task.id)?.status).toBe("in-progress");
  });
});
