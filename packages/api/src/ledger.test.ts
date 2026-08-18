import { asc } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { verifyChain } from "@verder/core";
import { appendLedgerEvent } from "./ledger";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("ledger + append-only enforcement", () => {
  let db: Db;
  beforeAll(() => { db = createDb(APP_URL).db; });

  it("appends chained events across transactions", async () => {
    const idA = crypto.randomUUID(); const idB = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await appendLedgerEvent(tx, { eventType: "test.created", entityType: "test", entityId: idA, payload: { a: 1 } });
    });
    await db.transaction(async (tx) => {
      await appendLedgerEvent(tx, { eventType: "test.created", entityType: "test", entityId: idB, payload: { b: 2 } });
    });
    const events = await db.select().from(schema.ledgerEvents).orderBy(asc(schema.ledgerEvents.seq));
    const res = await verifyChain(events.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash,
    })));
    expect(res.ok).toBe(true);
  });

  it("app role cannot UPDATE or DELETE evidence rows", async () => {
    await expect(
      db.update(schema.ledgerEvents).set({ eventType: "hacked" })
    ).rejects.toThrow(/permission denied/);
    await expect(db.delete(schema.ledgerEvents)).rejects.toThrow(/permission denied/);
    await expect(db.delete(schema.logEntries)).rejects.toThrow(/permission denied/);
  });

  it("serializes concurrent appends without forking", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      db.transaction(async (tx) =>
        appendLedgerEvent(tx, { eventType: "test.race", entityType: "test", entityId: crypto.randomUUID(), payload: { i } }))));
    const events = await db.select().from(schema.ledgerEvents).orderBy(asc(schema.ledgerEvents.seq));
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const res = await verifyChain(events.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash,
    })));
    expect(res.ok).toBe(true);
  });
});
