import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { WSNP_STAGES } from "../wsnp-timeline";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared with other suites: milestones is a global table,
// so every assertion below is about rows THIS file created (or shape/ordering
// invariants that hold regardless of foreign rows) — never absolute counts.

describe("milestones router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `ms${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("create returns the row with defaults applied", async () => {
    const c = caller();
    const created = await c.milestones.create({
      stage: "application", title: "Aanvraag ingediend",
    });
    expect(created.id).toBeTruthy();
    expect(created.stage).toBe("application");
    expect(created.title).toBe("Aanvraag ingediend");
    expect(created.done).toBe(false);
    expect(created.happenedAt).toBeNull();
    expect(created.expectedAt).toBeNull();
    expect(created.note).toBeNull();
  });

  it("list groups rows under their stage, all six stages in fixed order", async () => {
    const c = caller();
    const app = await c.milestones.create({ stage: "application", title: `L-app ${Date.now()}` });
    const settle = await c.milestones.create({ stage: "settlement", title: `L-settle ${Date.now()}` });
    const groups = await c.milestones.list();
    expect(groups.map((g) => g.stage)).toEqual([...WSNP_STAGES]);
    const appGroup = groups.find((g) => g.stage === "application")!;
    const settleGroup = groups.find((g) => g.stage === "settlement")!;
    expect(appGroup.milestones.some((m) => m.id === app.id)).toBe(true);
    expect(settleGroup.milestones.some((m) => m.id === settle.id)).toBe(true);
    // a row never leaks into another stage's group
    expect(settleGroup.milestones.some((m) => m.id === app.id)).toBe(false);
  });

  it("update edits fact fields and leaves the rest untouched", async () => {
    const c = caller();
    const created = await c.milestones.create({
      stage: "accepted", title: "Toelating", expectedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const updated = await c.milestones.update({
      id: created.id, done: true,
      happenedAt: new Date("2026-08-15T00:00:00Z"), note: "Bevestigd per brief",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.done).toBe(true);
    expect(updated.happenedAt?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(updated.note).toBe("Bevestigd per brief");
    // untouched fields survive
    expect(updated.title).toBe("Toelating");
    expect(updated.stage).toBe("accepted");
    expect(updated.expectedAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("update with only an id returns the row unchanged", async () => {
    const c = caller();
    const created = await c.milestones.create({ stage: "onboarding", title: "Intake" });
    const same = await c.milestones.update({ id: created.id });
    expect(same.id).toBe(created.id);
    expect(same.title).toBe("Intake");
  });

  it("update on a nonexistent id throws NOT_FOUND", async () => {
    const c = caller();
    await expect(c.milestones.update({
      id: "00000000-0000-0000-0000-000000000000", title: "ghost",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("timeline round-trip: created rows surface in their stage with a valid state", async () => {
    const c = caller();
    const created = await c.milestones.create({
      stage: "clean-slate", title: `T-clean ${Date.now()}`,
    });
    const result = await c.milestones.timeline();
    expect(result.stages.map((s) => s.stage)).toEqual([...WSNP_STAGES]);
    const clean = result.stages.find((s) => s.stage === "clean-slate")!;
    expect(clean.milestones.some((m) => m.id === created.id)).toBe(true);
    for (const s of result.stages)
      expect(["done", "current", "future", "empty"]).toContain(s.state);
  });

  it("timeline countdown reflects a done wsnp-start milestone (earliest wins)", async () => {
    const c = caller();
    // Very early happenedAt: earliest-wins means our row bounds endsAt from
    // above even if a foreign wsnp-start row exists on the shared DB.
    const happenedAt = new Date("2000-01-01T00:00:00Z");
    await c.milestones.create({
      stage: "wsnp-start", title: `T-start ${Date.now()}`, happenedAt, done: true,
    });
    const result = await c.milestones.timeline();
    expect(result.countdown).not.toBeNull();
    expect(result.countdown!.endsAt.getTime())
      .toBeLessThanOrEqual(happenedAt.getTime() + 547 * 86_400_000);
  });
});
