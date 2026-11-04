import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "@grip/core";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";

describe("parties router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `pt${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("accepts parentPartyId and carries it into the party.created ledger payload", async () => {
    const c = caller();
    const creditor = await c.parties.create({
      kind: "organization", name: "Intrum Justitia B.V.",
    });
    const contact = await c.parties.create({
      kind: "person", name: "J. de Vries", parentPartyId: creditor.id,
    });

    // The returned row carries the edge.
    expect(contact.parentPartyId).toBe(creditor.id);

    // ledger_events stores payload_hash, never the payload itself, so "the
    // field is inside the party.created payload" is asserted the way
    // verification.ts asserts it: rebuild the canonical payload from the live
    // row (same shape parties.ts's create() builds) and check it against the
    // recorded hash.
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.entityId, contact.id),
        eq(schema.ledgerEvents.eventType, "party.created")));
    expect(ev).toBeTruthy();
    const payload = {
      id: contact.id, kind: contact.kind, name: contact.name,
      organization: contact.organization, email: contact.email,
      phone: contact.phone, notes: contact.notes,
      parentPartyId: contact.parentPartyId,
    };
    expect(payload.parentPartyId).toBe(creditor.id);
    expect(sha256Hex(canonicalJson(payload))).toBe(ev.payloadHash);
  });
  it("recent lists parties by their newest log entry, then by name", async () => {
    const c = caller();
    const tag = crypto.randomUUID();
    const older = await c.parties.create({ kind: "organization", name: `Older Testfixture ${tag}` });
    const newer = await c.parties.create({ kind: "organization", name: `Newer Testfixture ${tag}` });
    const never = await c.parties.create({ kind: "organization", name: `A Never Testfixture ${tag}` });
    const entry = (partyId: string, occurredAt: string) => c.entries.create({
      occurredAt: new Date(occurredAt), channel: "call", direction: "inbound",
      summary: `Testfixture ${tag}`, source: "manual", participantPartyIds: [partyId],
      documentIds: [], actionItems: [] });
    await entry(older.id, "2026-10-01T09:00:00.000Z");
    await entry(older.id, "2026-09-01T09:00:00.000Z");
    await entry(newer.id, "2026-10-20T09:00:00.000Z");
    const list = await c.parties.recent();
    const at = (id: string) => list.findIndex((p) => p.id === id);
    expect(at(newer.id)).toBeGreaterThanOrEqual(0);
    expect(at(newer.id)).toBeLessThan(at(older.id));
    expect(at(older.id)).toBeLessThan(at(never.id));
    const row = list[at(older.id)];
    expect(row.lastContactAt?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(list[at(never.id)].lastContactAt).toBeNull();
    // Every party appears once, however many entries it has.
    expect(list.filter((p) => p.id === older.id)).toHaveLength(1);
  });
});
