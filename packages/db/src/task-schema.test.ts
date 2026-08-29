import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// APP role: exercises the real grants (no UPDATE/DELETE on evidence tables).
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("task schema", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];
  let userId: string;
  let partyId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb(APP_URL));
    const [u] = await db.insert(schema.users)
      .values({ email: `task${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "VerderGroep (task-schema test)" }).returning();
    partyId = p.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inserts a task and a status change", async () => {
    const [task] = await db.insert(schema.tasks).values({
      title: "Kopie paspoort opsturen",
      details: "Gevraagd door VerderGroep per mail.",
      assigneePartyId: partyId,
      dueAt: new Date("2026-09-01T00:00:00Z"),
      createdBy: userId,
    }).returning();
    expect(task.id).toBeTruthy();
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.entryId).toBeNull();

    const [change] = await db.insert(schema.taskStatusChanges).values({
      taskId: task.id,
      status: "in-progress",
      note: "Started digging through the drawer.",
      createdBy: userId,
    }).returning();
    expect(change.id).toBeTruthy();
    expect(change.overrideReason).toBeNull();
  });

  it("task_status_changes is insert-only for the app role (UPDATE denied)", async () => {
    const [task] = await db.insert(schema.tasks).values({
      title: "Immutable history check", createdBy: userId,
    }).returning();
    const [change] = await db.insert(schema.taskStatusChanges).values({
      taskId: task.id, status: "done", createdBy: userId,
    }).returning();
    await expect(
      db.update(schema.taskStatusChanges)
        .set({ note: "tampered" })
        .where(eq(schema.taskStatusChanges.id, change.id)),
    ).rejects.toThrow(/permission denied/);
  });

  it("fact tables allow UPDATE but never DELETE (app role)", async () => {
    const [task] = await db.insert(schema.tasks).values({
      title: "Tyop in title", createdBy: userId,
    }).returning();
    // a typo is a typo: UPDATE is allowed on fact tables
    const [fixed] = await db.update(schema.tasks)
      .set({ title: "Typo in title" })
      .where(eq(schema.tasks.id, task.id)).returning();
    expect(fixed.title).toBe("Typo in title");
    // but nothing is ever deleted
    await expect(
      db.delete(schema.tasks).where(eq(schema.tasks.id, task.id)),
    ).rejects.toThrow(/permission denied/);
  });

  it("accepts a suggestion with kind 'task'", async () => {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "task",
      proposed: { key: "task:test", title: "Bewijs van inschrijving aanleveren" },
    }).returning();
    expect(s.id).toBeTruthy();
    expect(s.kind).toBe("task");
    expect(s.status).toBe("pending"); // default
  });
});
