import { asc, desc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent } from "@verder/core";
import { decide, effectiveStatus, registryDecisionPayload } from "./registry-decide";
import { registryDecisionPayloadHash } from "./verification";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("registry decisions", () => {
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `decide${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  const mkItem = async (name = "Eneco") => {
    const [item] = await db.insert(schema.financialItems).values({
      name, category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    return item;
  };
  const mkDebt = async (creditorName = "Incassobureau X") => {
    const [debt] = await db.insert(schema.debts)
      .values({ creditorName, claimedCents: 250000 }).returning();
    return debt;
  };
  const allEvents = async (): Promise<ChainEvent[]> => {
    const rows = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    return rows.map((e) => ({ seq: e.seq, eventType: e.eventType,
      entityType: e.entityType, entityId: e.entityId,
      payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash }));
  };
  // Chain verification scoped to registry.decision recomputes: other test
  // files register documents whose vault files never existed, so whole-chain
  // runFullVerification cannot be asserted green here without truncating —
  // and evidence tables are never truncated by new tests.
  const verifyDecisions = async () =>
    verifyChain(await allEvents(), (e) =>
      e.eventType === "registry.decision"
        ? registryDecisionPayloadHash(db, e.entityId)
        : e.payloadHash);

  it("happy path: inserts decision + ledger event in the same transaction", async () => {
    const item = await mkItem();
    const decision = await db.transaction((tx) =>
      decide(tx, userId, { financialItemId: item.id, status: "allowed",
        explanation: "Energy is a basic need — keep it." }));
    expect(decision.financialItemId).toBe(item.id);
    expect(decision.debtId).toBeNull();
    expect(decision.status).toBe("allowed");
    expect(decision.createdBy).toBe(userId);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, decision.id));
    expect(ev).toBeTruthy();
    expect(ev.eventType).toBe("registry.decision");
    expect(ev.entityType).toBe("registry_decision");
    expect(ev.payloadHash)
      .toBe(sha256Hex(canonicalJson(registryDecisionPayload(decision))));
    const res = await verifyDecisions();
    expect(res.ok).toBe(true);
  });

  it("invalid transition without override throws and records nothing", async () => {
    const item = await mkItem("Netflix");
    await expect(db.transaction((tx) =>
      decide(tx, userId, { financialItemId: item.id, status: "canceled",
        explanation: "skip the workflow" }),
    )).rejects.toThrow(/transition/i);
    const rows = await db.select().from(schema.registryDecisions)
      .where(eq(schema.registryDecisions.financialItemId, item.id));
    expect(rows).toHaveLength(0);
    expect(await effectiveStatus(db, { financialItemId: item.id })).toBe("identified");
  });

  it("invalid transition WITH override is allowed and the reason is stored", async () => {
    const item = await mkItem("Spotify");
    const decision = await db.transaction((tx) =>
      decide(tx, userId, { financialItemId: item.id, status: "canceled",
        explanation: "Already canceled it myself last month.",
        overrideReason: "Cancellation happened outside the workflow." }));
    expect(decision.status).toBe("canceled");
    expect(decision.overrideReason).toBe("Cancellation happened outside the workflow.");
    expect(await effectiveStatus(db, { financialItemId: item.id })).toBe("canceled");
    expect((await verifyDecisions()).ok).toBe(true);
  });

  it("effectiveStatus reflects the latest decision (default identified)", async () => {
    const item = await mkItem("KPN");
    expect(await effectiveStatus(db, { financialItemId: item.id })).toBe("identified");
    await db.transaction((tx) => decide(tx, userId, { financialItemId: item.id,
      status: "allowed", explanation: "Internet stays." }));
    expect(await effectiveStatus(db, { financialItemId: item.id })).toBe("allowed");
    await db.transaction((tx) => decide(tx, userId, { financialItemId: item.id,
      status: "to-cancel", explanation: "Cheaper provider found." }));
    expect(await effectiveStatus(db, { financialItemId: item.id })).toBe("to-cancel");
  });

  it("debt decisions follow the debt matrix", async () => {
    const debt = await mkDebt();
    expect(await effectiveStatus(db, { debtId: debt.id })).toBe("identified");
    const decision = await db.transaction((tx) =>
      decide(tx, userId, { debtId: debt.id, status: "acknowledged",
        explanation: "Claim matches the invoices." }));
    expect(decision.debtId).toBe(debt.id);
    expect(decision.financialItemId).toBeNull();
    expect(await effectiveStatus(db, { debtId: debt.id })).toBe("acknowledged");
    // item statuses are invalid for debts
    await expect(db.transaction((tx) =>
      decide(tx, userId, { debtId: debt.id, status: "to-cancel",
        explanation: "wrong kind" }),
    )).rejects.toThrow(/transition/i);
  });

  it("requires exactly one of financialItemId | debtId", async () => {
    const item = await mkItem("Ziggo");
    const debt = await mkDebt("Deurwaarder Y");
    await expect(db.transaction((tx) =>
      decide(tx, userId, { financialItemId: item.id, debtId: debt.id,
        status: "allowed", explanation: "both" }),
    )).rejects.toThrow(/exactly one/i);
    await expect(db.transaction((tx) =>
      decide(tx, userId, { status: "allowed", explanation: "neither" }),
    )).rejects.toThrow(/exactly one/i);
  });

  it("verifier detects tampering with a decision row", async () => {
    const item = await mkItem("Vattenfall");
    const decision = await db.transaction((tx) =>
      decide(tx, userId, { financialItemId: item.id, status: "mandatory",
        explanation: "Heating must stay on." }));
    expect((await verifyDecisions()).ok).toBe(true);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, decision.id));
    // Tamper via the admin role (owner bypasses the app-role grants); only the
    // row this test created is touched, and it is restored afterwards.
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE registry_decisions
        SET explanation = 'tampered' WHERE id = ${decision.id}`);
      const broken = await verifyDecisions();
      expect(broken.ok).toBe(false);
      if (!broken.ok) {
        expect(broken.reason).toBe("payload_hash_mismatch");
        expect(broken.brokenAtSeq).toBe(ev.seq);
      }
      await admin.db.execute(sql`UPDATE registry_decisions
        SET explanation = ${decision.explanation} WHERE id = ${decision.id}`);
      expect((await verifyDecisions()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("latest decision wins even after an admin-side ordering probe", async () => {
    // effectiveStatus must order by createdAt: two decisions in separate
    // transactions get distinct now() timestamps.
    const debt = await mkDebt("Belastingdienst");
    await db.transaction((tx) => decide(tx, userId, { debtId: debt.id,
      status: "acknowledged", explanation: "Checked." }));
    await db.transaction((tx) => decide(tx, userId, { debtId: debt.id,
      status: "in-settlement", explanation: "Payment plan agreed." }));
    const [latest] = await db.select().from(schema.registryDecisions)
      .where(eq(schema.registryDecisions.debtId, debt.id))
      .orderBy(desc(schema.registryDecisions.createdAt)).limit(1);
    expect(latest.status).toBe("in-settlement");
    expect(await effectiveStatus(db, { debtId: debt.id })).toBe("in-settlement");
  });
});
