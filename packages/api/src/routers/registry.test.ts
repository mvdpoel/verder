import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

const sha = (seed: string) =>
  seed.repeat(64).slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, "0");

describe("registry router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `reg${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  const itemInput = (over: Record<string, unknown> = {}) => ({
    name: "Eneco", category: "energy" as const, amountCents: 14280,
    billingCycle: "monthly" as const, paymentChannel: "direct-debit" as const,
    ...over,
  });

  it("items.create → list shows effectiveStatus identified and monthlyCents per cycle", async () => {
    const c = caller();
    const monthly = await c.registry.items.create(itemInput({ name: "M", amountCents: 1000 }));
    const quarterly = await c.registry.items.create(itemInput({
      name: "Q", amountCents: 1000, billingCycle: "quarterly" }));
    const yearly = await c.registry.items.create(itemInput({
      name: "Y", amountCents: 1250, billingCycle: "yearly" }));
    const irregular = await c.registry.items.create(itemInput({
      name: "I", amountCents: 7700, billingCycle: "irregular" }));
    expect(monthly.id).toBeTruthy();
    expect(monthly.discoveredVia).toBe("manual");
    const list = await c.registry.items.list();
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(monthly.id)).toMatchObject({ effectiveStatus: "identified", monthlyCents: 1000 });
    expect(byId.get(quarterly.id)).toMatchObject({ effectiveStatus: "identified", monthlyCents: 333 });
    expect(byId.get(yearly.id)).toMatchObject({ effectiveStatus: "identified", monthlyCents: 104 });
    expect(byId.get(irregular.id)).toMatchObject({ effectiveStatus: "identified", monthlyCents: 0 });
  });

  it("decide changes the effective status seen by list and get", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Netflix", amountCents: 1399 }));
    const decision = await c.registry.decide({ financialItemId: item.id,
      status: "to-cancel", explanation: "Streaming can go for now." });
    expect(decision.status).toBe("to-cancel");
    expect(decision.createdBy).toBe(userId);
    const list = await c.registry.items.list();
    expect(list.find((r) => r.id === item.id)?.effectiveStatus).toBe("to-cancel");
    const got = await c.registry.items.get({ id: item.id });
    expect(got.effectiveStatus).toBe("to-cancel");
  });

  it("decide rejects invalid transitions without an override", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Spotify" }));
    await expect(c.registry.decide({ financialItemId: item.id,
      status: "canceled", explanation: "skip ahead" })).rejects.toThrow(/transition/i);
  });

  it("items.get returns decision timeline newest first + transactions + evidence docs", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "KPN", amountCents: 4250 }));
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha(`${Date.now()}a`), title: "KPN cancellation letter",
      mime: "application/pdf", sizeBytes: 123, source: "upload",
      receivedAt: new Date(),
    }).returning();
    await c.registry.decide({ financialItemId: item.id,
      status: "allowed", explanation: "Internet stays for now." });
    await c.registry.decide({ financialItemId: item.id, status: "to-cancel",
      explanation: "Cheaper provider found.", documentId: doc.id,
      blockerNote: "keep until mailbox migration complete" });
    const [tx] = await db.insert(schema.transactions).values({
      source: "abn-camt053", bookedAt: new Date("2026-07-01T00:00:00Z"),
      amountCents: -4250, counterpartyName: "KPN B.V.",
      statementSha256: sha(`${Date.now()}b`), rowIndex: 0,
    }).returning();
    await c.registry.transactions.link({ transactionId: tx.id, financialItemId: item.id });

    const got = await c.registry.items.get({ id: item.id });
    expect(got.name).toBe("KPN");
    expect(got.effectiveStatus).toBe("to-cancel");
    expect(got.decisions).toHaveLength(2);
    expect(got.decisions[0].status).toBe("to-cancel"); // newest first
    expect(got.decisions[0].blockerNote).toBe("keep until mailbox migration complete");
    expect(got.decisions[1].status).toBe("allowed");
    expect(got.transactions.map((t) => t.id)).toEqual([tx.id]);
    expect(got.documents.map((d) => d.id)).toEqual([doc.id]);
  });

  it("items.update edits fact fields (a typo is a typo)", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Enecoo", amountCents: 100 }));
    const updated = await c.registry.items.update({ id: item.id,
      name: "Eneco", amountCents: 14280, noticePeriod: "1 month" });
    expect(updated.name).toBe("Eneco");
    expect(updated.amountCents).toBe(14280);
    expect(updated.noticePeriod).toBe("1 month");
    // untouched fields survive
    expect(updated.category).toBe("energy");
    const got = await c.registry.items.get({ id: item.id });
    expect(got.name).toBe("Eneco");
  });

  it("items.update on a nonexistent id throws NOT_FOUND", async () => {
    const c = caller();
    await expect(c.registry.items.update({
      id: "00000000-0000-0000-0000-000000000000", name: "ghost",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("debts.create/list/update/get with decisions", async () => {
    const c = caller();
    const debt = await c.registry.debts.create({
      creditorName: "Incassobureau X", claimedCents: 250000,
      principalCents: 200000, references: "dossier 12345", origin: "business",
    });
    expect(debt.claimedCents).toBe(250000);
    expect(debt.references_).toBe("dossier 12345");
    const list = await c.registry.debts.list();
    expect(list.find((d) => d.id === debt.id)?.effectiveStatus).toBe("identified");
    await c.registry.decide({ debtId: debt.id, status: "acknowledged",
      explanation: "Claim matches the invoices." });
    const updated = await c.registry.debts.update({ id: debt.id, claimedCents: 260000 });
    expect(updated.claimedCents).toBe(260000);
    const got = await c.registry.debts.get({ id: debt.id });
    expect(got.effectiveStatus).toBe("acknowledged");
    expect(got.decisions).toHaveLength(1);
    expect(got.decisions[0].status).toBe("acknowledged");
  });

  it("debts.get surfaces logbook entries whose participant is the creditor party", async () => {
    const c = caller();
    const party = await c.parties.create({ kind: "organization", name: `Deurwaarder ${Date.now()}` });
    const debt = await c.registry.debts.create({
      creditorName: "Deurwaarder Y", claimedCents: 90000, creditorPartyId: party.id });
    const entry = await c.entries.create({
      occurredAt: new Date("2026-08-10T09:00:00Z"), channel: "letter",
      direction: "inbound", summary: "Aanmaning received",
      participantPartyIds: [party.id], actionItems: [], documentIds: [],
    });
    const got = await c.registry.debts.get({ id: debt.id });
    expect(got.relatedEntries.map((e) => e.id)).toContain(entry.id);
    // a debt without a party link surfaces nothing and does not throw
    const lone = await c.registry.debts.create({ creditorName: "Zonder Partij", claimedCents: 100 });
    const loneGot = await c.registry.debts.get({ id: lone.id });
    expect(loneGot.relatedEntries).toEqual([]);
  });

  it("transactions.listByItem returns only linked transactions", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Ziggo", amountCents: 5500 }));
    const stmt = sha(`${Date.now()}c`);
    const [t1] = await db.insert(schema.transactions).values({
      source: "abn-tsv", bookedAt: new Date("2026-06-01T00:00:00Z"),
      amountCents: -5500, statementSha256: stmt, rowIndex: 0 }).returning();
    const [t2] = await db.insert(schema.transactions).values({
      source: "abn-tsv", bookedAt: new Date("2026-07-01T00:00:00Z"),
      amountCents: -5500, statementSha256: stmt, rowIndex: 1 }).returning();
    await db.insert(schema.transactions).values({
      source: "abn-tsv", bookedAt: new Date("2026-07-02T00:00:00Z"),
      amountCents: -999, statementSha256: stmt, rowIndex: 2 });
    await c.registry.transactions.link({ transactionId: t1.id, financialItemId: item.id });
    await c.registry.transactions.link({ transactionId: t2.id, financialItemId: item.id });
    const rows = await c.registry.transactions.listByItem({ financialItemId: item.id });
    expect(rows.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
    // newest first
    expect(rows[0].id).toBe(t2.id);
  });

  it("transactions.link on a nonexistent transaction throws NOT_FOUND", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Odido" }));
    await expect(c.registry.transactions.link({
      transactionId: "00000000-0000-0000-0000-000000000000", financialItemId: item.id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stats math: counts, monthly totals, to-cancel rollup, pending decisions", async () => {
    const c = caller();
    const before = await c.registry.stats();
    // four identified items across all cycles: 1000 + 333 + 104 + 0
    await c.registry.items.create(itemInput({ name: "S-M", amountCents: 1000 }));
    await c.registry.items.create(itemInput({ name: "S-Q", amountCents: 1000, billingCycle: "quarterly" }));
    await c.registry.items.create(itemInput({ name: "S-Y", amountCents: 1250, billingCycle: "yearly" }));
    await c.registry.items.create(itemInput({ name: "S-I", amountCents: 7700, billingCycle: "irregular" }));
    // one to-cancel item: counts toward total AND to-cancel rollup
    const toCancel = await c.registry.items.create(itemInput({ name: "S-TC", amountCents: 500 }));
    await c.registry.decide({ financialItemId: toCancel.id, status: "to-cancel",
      explanation: "Dropping this." });
    // one canceled item (override): excluded from monthly total
    const canceled = await c.registry.items.create(itemInput({ name: "S-X", amountCents: 800 }));
    await c.registry.decide({ financialItemId: canceled.id, status: "canceled",
      explanation: "Already gone.", overrideReason: "Canceled outside the workflow." });
    // one identified debt (pending) and one acknowledged debt (not pending)
    await c.registry.debts.create({ creditorName: "S-D1", claimedCents: 1 });
    const ack = await c.registry.debts.create({ creditorName: "S-D2", claimedCents: 2 });
    await c.registry.decide({ debtId: ack.id, status: "acknowledged", explanation: "Checked." });

    const after = await c.registry.stats();
    expect(after.itemCount - before.itemCount).toBe(6);
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(1000 + 333 + 104 + 0 + 500);
    expect(after.toCancelMonthlyCents - before.toCancelMonthlyCents).toBe(500);
    // 4 identified items + 1 identified debt (to-cancel/canceled/acknowledged are decided)
    expect(after.pendingDecisions - before.pendingDecisions).toBe(5);
  });

  it("validNext lists the allowed next statuses per kind and from-status", async () => {
    const c = caller();
    expect((await c.registry.validNext({ kind: "item", from: "identified" })).sort())
      .toEqual(["allowed", "mandatory", "requested", "to-cancel"]);
    expect(await c.registry.validNext({ kind: "item", from: "mandatory" }))
      .toEqual(["allowed"]);
    expect(await c.registry.validNext({ kind: "item", from: "canceled" })).toEqual([]);
    expect((await c.registry.validNext({ kind: "debt", from: "identified" })).sort())
      .toEqual(["acknowledged", "disputed"]);
    expect(await c.registry.validNext({ kind: "debt", from: "in-settlement" }))
      .toEqual(["settled"]);
    expect(await c.registry.validNext({ kind: "debt", from: "settled" })).toEqual([]);
    // unknown from-status (possible via override) → no valid edges, not a crash
    expect(await c.registry.validNext({ kind: "item", from: "constructor" })).toEqual([]);
  });

  it("rejects unauthenticated calls", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.registry.items.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.registry.stats()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
