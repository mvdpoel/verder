import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared with other suites: timeline_events is a global
// table, so every assertion below is about rows THIS file created (or ordering
// invariants that hold regardless of foreign rows) — never absolute counts.

describe("timeline router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `tl${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("create returns the row with defaults applied", async () => {
    const created = await caller().timeline.create({
      title: "Verzoek verstuurd naar de rechtbank",
      happenedAt: new Date("2026-06-12T00:00:00Z"),
      kind: "process",
    });
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe("process");
    expect(created.happenedAt.toISOString()).toBe("2026-06-12T00:00:00.000Z");
    expect(created.note).toBeNull();
    expect(created.entryId).toBeNull();
  });

  it("list returns events newest first with linked evidence summaries", async () => {
    const c = caller();
    const [entry] = await db.insert(schema.logEntries).values({
      channel: "call", direction: "outbound", source: "manual",
      occurredAt: new Date("2026-07-02T10:00:00Z"),
      summary: `Gebeld met VerderGroep ${Date.now()}`, createdBy: userId,
    }).returning();
    const milestone = await c.milestones.create({
      stage: "onboarding", title: `Onboarding ${Date.now()}`,
    });

    const older = await c.timeline.create({
      title: "Intake gesprek", happenedAt: new Date("2026-05-01T00:00:00Z"),
      kind: "meeting", milestoneId: milestone.id,
    });
    const newer = await c.timeline.create({
      title: "Gebeld met VerderGroep", happenedAt: new Date("2026-07-02T10:00:00Z"),
      kind: "call", note: "Inventarisatie doorgesproken", entryId: entry.id,
    });

    const rows = await c.timeline.list();
    const mine = rows.filter((r) => r.id === older.id || r.id === newer.id);
    expect(mine.map((r) => r.id)).toEqual([newer.id, older.id]); // newest first

    const newerRow = mine[0];
    expect(newerRow.kind).toBe("call");
    expect(newerRow.note).toBe("Inventarisatie doorgesproken");
    expect(newerRow.entry?.id).toBe(entry.id);
    expect(newerRow.entry?.summary).toContain("Gebeld met VerderGroep");
    expect(newerRow.document).toBeNull();
    expect(newerRow.milestone).toBeNull();

    const olderRow = mine[1];
    expect(olderRow.milestone?.id).toBe(milestone.id);
    expect(olderRow.milestone?.title).toBe(milestone.title);
    expect(olderRow.entry).toBeNull();

    // whole list stays ordered newest-first even with foreign rows present
    const times = rows.map((r) => r.happenedAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("update edits fields and leaves the rest untouched", async () => {
    const c = caller();
    const created = await c.timeline.create({
      title: "Brief van de rechtbank", happenedAt: new Date("2026-06-20T00:00:00Z"),
      kind: "mail",
    });
    const updated = await c.timeline.update({
      id: created.id, note: "Aangetekend ontvangen", kind: "document",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.note).toBe("Aangetekend ontvangen");
    expect(updated.kind).toBe("document");
    expect(updated.title).toBe("Brief van de rechtbank"); // untouched
    expect(updated.happenedAt.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("update on a nonexistent id throws NOT_FOUND", async () => {
    await expect(caller().timeline.update({
      id: "00000000-0000-0000-0000-000000000000", title: "ghost",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recent caps the list at the requested limit, newest first", async () => {
    const c = caller();
    const base = Date.parse("2027-01-01T00:00:00Z"); // far future: our rows lead
    for (let i = 0; i < 4; i++) {
      await c.timeline.create({
        title: `Recent ${i} ${Date.now()}`,
        happenedAt: new Date(base + i * 86_400_000),
      });
    }
    const rows = await c.timeline.recent({ limit: 3 });
    expect(rows).toHaveLength(3);
    const times = rows.map((r) => r.happenedAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
