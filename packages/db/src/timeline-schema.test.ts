import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// APP role: exercises the real grants (fact tables edit, never delete).
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("timeline_events schema", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    ({ db, pool } = createDb(APP_URL));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inserts a key event with defaults and optional links unset", async () => {
    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Verzoek verstuurd naar de rechtbank",
      happenedAt: new Date("2026-06-12T00:00:00Z"),
      kind: "process",
    }).returning();
    expect(event.id).toBeTruthy();
    expect(event.kind).toBe("process");
    expect(event.note).toBeNull();
    expect(event.entryId).toBeNull();
    expect(event.documentId).toBeNull();
    expect(event.milestoneId).toBeNull();
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  it("defaults kind to 'other' and links to a logbook entry and milestone", async () => {
    const [user] = await db.insert(schema.users)
      .values({ email: `tl${Date.now()}@test.local`, name: "Martin" }).returning();
    const [entry] = await db.insert(schema.logEntries).values({
      channel: "call",
      direction: "outbound",
      source: "manual",
      occurredAt: new Date("2026-07-02T10:00:00Z"),
      summary: "Gebeld met VerderGroep over de inventarisatie",
      createdBy: user.id,
    }).returning();
    const [milestone] = await db.insert(schema.milestones)
      .values({ stage: "onboarding", title: "Onboarding gestart (timeline test)" }).returning();

    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Gebeld met VerderGroep",
      happenedAt: new Date("2026-07-02T10:00:00Z"),
      entryId: entry.id,
      milestoneId: milestone.id,
    }).returning();
    expect(event.kind).toBe("other"); // default
    expect(event.entryId).toBe(entry.id);
    expect(event.milestoneId).toBe(milestone.id);
  });

  it("allows UPDATE but never DELETE (app role)", async () => {
    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Tyop in het onderwerp",
      happenedAt: new Date("2026-07-05T00:00:00Z"),
    }).returning();
    const [fixed] = await db.update(schema.timelineEvents)
      .set({ title: "Typo in het onderwerp", note: "bijgewerkt" })
      .where(eq(schema.timelineEvents.id, event.id)).returning();
    expect(fixed.title).toBe("Typo in het onderwerp");
    expect(fixed.note).toBe("bijgewerkt");
    await expect(
      db.delete(schema.timelineEvents).where(eq(schema.timelineEvents.id, event.id)),
    ).rejects.toThrow(/permission denied/);
  });
});
