import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent } from "@verder/core";
import { effectiveTaskStatus, setTaskStatus, taskStatusPayload } from "./task-decide";
import { makeLedgerRecompute, taskStatusPayloadHash } from "./verification";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("task status changes", () => {
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `taskdecide${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  const mkTask = async (title = "Send payslip copy") => {
    const [task] = await db.insert(schema.tasks)
      .values({ title, createdBy: userId }).returning();
    return task;
  };
  const allEvents = async (): Promise<ChainEvent[]> => {
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    return rows.map((e) => ({ seq: e.seq, eventType: e.eventType,
      entityType: e.entityType, entityId: e.entityId,
      payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash }));
  };
  // Chain verification scoped to task.status recomputes: other test files
  // register documents whose vault files never existed, so whole-chain
  // runFullVerification cannot be asserted green here without truncating —
  // and evidence tables are never truncated by new tests.
  const verifyTaskStatuses = async () =>
    verifyChain(await allEvents(), (e) =>
      e.eventType === "task.status"
        ? taskStatusPayloadHash(db, e.entityId)
        : e.payloadHash);

  it("happy path: inserts change + ledger event in the same transaction", async () => {
    const task = await mkTask();
    const change = await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress",
        note: "Started collecting the documents." }));
    expect(change.taskId).toBe(task.id);
    expect(change.status).toBe("in-progress");
    expect(change.note).toBe("Started collecting the documents.");
    expect(change.overrideReason).toBeNull();
    expect(change.createdBy).toBe(userId);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, change.id));
    expect(ev).toBeTruthy();
    expect(ev.eventType).toBe("task.status");
    expect(ev.entityType).toBe("task_status_change");
    expect(ev.payloadHash)
      .toBe(sha256Hex(canonicalJson(taskStatusPayload(change))));
    expect(ev.payloadHash).toBe(await taskStatusPayloadHash(db, change.id));
    expect((await verifyTaskStatuses()).ok).toBe(true);
  });

  it("invalid transition without override throws and records nothing", async () => {
    const task = await mkTask("Already finished task");
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "done" }));
    await expect(db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress" }),
    )).rejects.toThrow(/transition/i);
    const rows = await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(await effectiveTaskStatus(db, task.id)).toBe("done");
  });

  it("invalid transition WITH override is allowed and the reason is stored", async () => {
    const task = await mkTask("Reopened task");
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "done" }));
    const change = await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress",
        note: "Turns out there was more to do.",
        overrideReason: "VerderGroep asked for an extra document after completion." }));
    expect(change.status).toBe("in-progress");
    expect(change.overrideReason)
      .toBe("VerderGroep asked for an extra document after completion.");
    expect(await effectiveTaskStatus(db, task.id)).toBe("in-progress");
    expect((await verifyTaskStatuses()).ok).toBe(true);
  });

  it("effectiveTaskStatus defaults to open and follows the latest change", async () => {
    const task = await mkTask("Fresh task");
    expect(await effectiveTaskStatus(db, task.id)).toBe("open");
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "waiting" }));
    expect(await effectiveTaskStatus(db, task.id)).toBe("waiting");
    await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "done" }));
    expect(await effectiveTaskStatus(db, task.id)).toBe("done");
  });

  it("two changes in ONE transaction: latest wins despite identical createdAt", async () => {
    // createdAt defaults to now(), which is the transaction timestamp — two
    // changes in the same transaction produce byte-identical createdAt values.
    // Ordering must therefore use a monotonic tiebreaker (the ledger seq).
    const task = await mkTask("Two-step task");
    await db.transaction(async (tx) => {
      await setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress" });
      await setTaskStatus(tx, userId, { taskId: task.id, status: "waiting" });
    });
    const rows = await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, task.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt.getTime()).toBe(rows[1].createdAt.getTime());
    expect(await effectiveTaskStatus(db, task.id)).toBe("waiting");
    expect((await verifyTaskStatuses()).ok).toBe(true);
  });

  it("transition validation sees an uncommitted change from the same transaction", async () => {
    // From "open" every status is a valid target, so the second call below is
    // only rejected if it reads the "done" recorded a statement earlier in
    // this transaction (seq-ordered, not createdAt — the timestamps tie).
    const task = await mkTask("Tie-break validation task");
    await expect(db.transaction(async (tx) => {
      await setTaskStatus(tx, userId, { taskId: task.id, status: "done" });
      await setTaskStatus(tx, userId, { taskId: task.id, status: "in-progress" });
    })).rejects.toThrow(/transition/i);
    // The whole transaction rolled back: nothing recorded.
    const rows = await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, task.id));
    expect(rows).toHaveLength(0);
    expect(await effectiveTaskStatus(db, task.id)).toBe("open");
  });

  it("concurrent setStatus calls on one task are serialized: exactly one wins", async () => {
    // Both racers start from "open" where done is a valid target, but
    // done→done is not an edge: after either commits, the other must re-read
    // the committed status and reject — never record an invalid transition
    // without an overrideReason.
    const task = await mkTask("Raced task");
    const attempt = (note: string) => db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "done", note }));
    const results = await Promise.allSettled([attempt("racer 1"), attempt("racer 2")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/transition/i);
    const rows = await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].overrideReason).toBeNull();
    expect(await effectiveTaskStatus(db, task.id)).toBe("done");
    expect((await verifyTaskStatuses()).ok).toBe(true);
  });

  it("setStatus on a nonexistent task throws not-found", async () => {
    await expect(db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: "00000000-0000-0000-0000-000000000000",
        status: "done" }),
    )).rejects.toThrow(/not found/i);
  });

  it("verifier detects tampering with a status-change row at the right seq", async () => {
    const task = await mkTask("Tamper target");
    const change = await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "waiting",
        note: "Waiting for VerderGroep to confirm." }));
    expect((await verifyTaskStatuses()).ok).toBe(true);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, change.id));
    // Tamper via the admin role (owner bypasses the app-role grants); only the
    // row this test created is touched, and it is restored afterwards.
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE task_status_changes
        SET note = 'tampered' WHERE id = ${change.id}`);
      const broken = await verifyTaskStatuses();
      expect(broken.ok).toBe(false);
      if (!broken.ok) {
        expect(broken.reason).toBe("payload_hash_mismatch");
        expect(broken.brokenAtSeq).toBe(ev.seq);
      }
      await admin.db.execute(sql`UPDATE task_status_changes
        SET note = ${change.note} WHERE id = ${change.id}`);
      expect((await verifyTaskStatuses()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("runFullVerification's recompute dispatch covers task.status events", async () => {
    // The untested-dispatch gap from sub-project 2: the dispatch line inside
    // runFullVerification was never exercised for the new event type. The
    // recompute callback is now built by makeLedgerRecompute — the very
    // function runFullVerification passes to verifyChain — so calling it here
    // tests the real dispatch, not a test-local reimplementation. Whole-chain
    // runFullVerification itself cannot run green on the shared dev DB (other
    // suites register documents whose vault files never existed).
    const task = await mkTask("Dispatch coverage task");
    const change = await db.transaction((tx) =>
      setTaskStatus(tx, userId, { taskId: task.id, status: "dropped",
        note: "No longer needed." }));
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, change.id));
    const recompute = makeLedgerRecompute(db, "/nonexistent-vault", {
      linkedLater: new Map(), resolvedLinkHash: new Map() });
    const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType,
      entityType: ev.entityType, entityId: ev.entityId,
      payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
    // Green: the dispatch recomputes the exact stored payload hash.
    expect(await recompute(event)).toBe(ev.payloadHash);
    // Tampered: the dispatch must NOT fall through to the e.payloadHash
    // passthrough — a real recompute from the live row detects the edit.
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE task_status_changes
        SET status = 'done' WHERE id = ${change.id}`);
      expect(await recompute(event)).not.toBe(ev.payloadHash);
      await admin.db.execute(sql`UPDATE task_status_changes
        SET status = ${change.status} WHERE id = ${change.id}`);
      expect(await recompute(event)).toBe(ev.payloadHash);
    } finally {
      await admin.pool.end();
    }
    // A missing row is flagged too, never silently passed through.
    const ghost: ChainEvent = { ...event,
      entityId: "00000000-0000-0000-0000-000000000000" };
    expect(await recompute(ghost)).not.toBe(ev.payloadHash);
  });
});
