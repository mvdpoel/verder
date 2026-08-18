import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("entries router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `t${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("creates an entry with participants and action items in one transaction", async () => {
    const c = caller();
    const p = await c.parties.create({ kind: "organization", name: "VerderGroep" });
    const entry = await c.entries.create({
      occurredAt: new Date("2026-08-18T10:00:00Z"),
      channel: "call", direction: "inbound",
      summary: "Intake call about missing payslips",
      details: "They need payslips for June and July.",
      participantPartyIds: [p.id],
      actionItems: [{ description: "Send payslips June+July", clarity: "clear" }],
      documentIds: [],
    });
    expect(entry.id).toBeTruthy();
    const got = await c.entries.get({ id: entry.id });
    expect(got.participants.map((x) => x.partyId)).toEqual([p.id]);
    expect(got.actionItems).toHaveLength(1);
    expect(got.supersededBy).toBeNull();
  });

  it("correct() creates a new entry linked via supersedesId; original remains", async () => {
    const c = caller();
    const orig = await c.entries.create({
      occurredAt: new Date(), channel: "email", direction: "inbound",
      summary: "Wrong summary", participantPartyIds: [], actionItems: [], documentIds: [],
    });
    const fixed = await c.entries.correct({
      supersedesId: orig.id,
      occurredAt: new Date(), channel: "email", direction: "inbound",
      summary: "Right summary", participantPartyIds: [], actionItems: [], documentIds: [],
    });
    expect(fixed.supersedesId).toBe(orig.id);
    const both = await c.entries.get({ id: orig.id });
    expect(both.supersededBy).toBe(fixed.id);
  });

  it("rejects unauthenticated calls", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.entries.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
