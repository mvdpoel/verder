import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("suggestions router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `s${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function makeSuggestion() {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t1",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Documents needed", sentAt: new Date(),
      rawRfc822Sha256: "a".repeat(64), bodyText: "Please send payslips.",
    }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, model: "qwen2.5:14b", promptVersion: "v1",
      proposed: { occurredAt: new Date().toISOString(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips", details: "June and July payslips requested.",
        participantNames: ["VerderGroep"], actionItems: [{ description: "Send payslips", clarity: "clear" }],
        attachmentDocumentIds: [] },
    }).returning();
    return s;
  }

  it("approveEntry creates a ledger-backed entry and marks status edited when changed", async () => {
    const s = await makeSuggestion();
    const c = caller();
    const res = await c.suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips June+July", // edited summary
        source: "gmail-watch", participantPartyIds: [], documentIds: [],
        actionItems: [{ description: "Send payslips", clarity: "clear" }] },
    });
    expect(res.entryId).toBeTruthy();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
    expect(after.resultEntryId).toBe(res.entryId);
    expect(after.finalPayload).toBeTruthy();
  });

  it("reject stores verdict without touching the ledger", async () => {
    const s = await makeSuggestion();
    await caller().suggestions.reject({ id: s.id, reason: "Not relevant" });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
  });

  // --- registry-item + debt approval (Task 11) -------------------------------

  const randomSha = () =>
    (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

  async function makeChargeTransactions() {
    const sha = randomSha();
    const rows = await db.insert(schema.transactions).values([
      { source: "abn-camt053" as const, bookedAt: new Date("2026-06-01T00:00:00Z"),
        amountCents: -1299, counterpartyName: "Netflix International B.V.",
        counterpartyIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 0 },
      { source: "abn-camt053" as const, bookedAt: new Date("2026-07-01T00:00:00Z"),
        amountCents: -1299, counterpartyName: "Netflix International B.V.",
        counterpartyIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 1 },
    ]).returning();
    return rows;
  }

  async function makeRegistryItemSuggestion(txIds: string[]) {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "registry-item", model: "qwen3.5:9b", promptVersion: "registry-v1",
      proposed: {
        key: `iban:NL91ABNA0417164300-${crypto.randomUUID()}`, groupBy: "iban",
        counterpartyName: "Netflix International B.V.",
        counterpartyIban: "NL91ABNA0417164300", mandateId: null,
        transactionIds: txIds, chargeCount: txIds.length, typicalAmountCents: -1299,
        firstAt: "2026-06-01T00:00:00.000Z", lastAt: "2026-07-01T00:00:00.000Z",
        receiptRawEmailIds: [], aggregator: null, resolved: true,
        paymentChannel: "direct-debit", discoveredVia: "bank",
        name: "Netflix", category: "streaming", amountCents: 1299, billingCycle: "monthly",
      },
    }).returning();
    return s;
  }

  const itemForApproval = {
    name: "Netflix", category: "streaming" as const, amountCents: 1299,
    billingCycle: "monthly" as const, paymentChannel: "direct-debit" as const,
    discoveredVia: "bank" as const,
  };

  it("approveRegistryItem creates the item, links evidence transactions, marks approved when unchanged", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    const res = await caller().suggestions.approveRegistryItem({ id: s.id, item: itemForApproval });
    expect(res.itemId).toBeTruthy();
    const [item] = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.id, res.itemId));
    expect(item.name).toBe("Netflix");
    expect(item.discoveredVia).toBe("bank"); // from the payload, not defaulted to manual
    for (const t of txs) {
      const [after] = await db.select().from(schema.transactions)
        .where(eq(schema.transactions.id, t.id));
      expect(after.financialItemId).toBe(res.itemId);
    }
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("approved");
    expect(after.finalPayload).toBeTruthy();
    expect(after.verdictAt).toBeTruthy();
  });

  it("approveRegistryItem marks edited when Martin changed name or category", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    await caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, name: "Netflix Premium" } });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveRegistryItem leaves rejected suggestions untouched", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    await caller().suggestions.reject({ id: s.id, reason: "Not a subscription" });
    await expect(caller().suggestions.approveRegistryItem({ id: s.id, item: itemForApproval }))
      .rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
    for (const t of txs) {
      const [tx] = await db.select().from(schema.transactions)
        .where(eq(schema.transactions.id, t.id));
      expect(tx.financialItemId).toBeNull(); // no evidence linked either
    }
  });

  async function makeDebtSuggestion() {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "debt", model: "qwen3.5:9b", promptVersion: "registry-v1",
      proposed: {
        key: `name:intrum-${crypto.randomUUID()}`, groupBy: "name",
        counterpartyName: "Intrum Justitia", counterpartyIban: null, mandateId: null,
        transactionIds: [], chargeCount: 2, typicalAmountCents: -25000,
        firstAt: "2026-06-01T00:00:00.000Z", lastAt: "2026-07-01T00:00:00.000Z",
        receiptRawEmailIds: [], aggregator: null, resolved: true,
        paymentChannel: "invoice", discoveredVia: "bank",
        creditorName: "Intrum Justitia", claimedCents: 25000, references: null,
      },
    }).returning();
    return s;
  }

  it("approveDebt creates the debt and marks approved when unchanged", async () => {
    const s = await makeDebtSuggestion();
    const res = await caller().suggestions.approveDebt({
      id: s.id, debt: { creditorName: "Intrum Justitia", claimedCents: 25000, references: "dossier 12345" } });
    expect(res.debtId).toBeTruthy();
    const [debt] = await db.select().from(schema.debts)
      .where(eq(schema.debts.id, res.debtId));
    expect(debt.creditorName).toBe("Intrum Justitia");
    expect(debt.claimedCents).toBe(25000);
    expect(debt.references_).toBe("dossier 12345");
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("approved");
  });

  it("approveDebt marks edited when the claim was corrected", async () => {
    const s = await makeDebtSuggestion();
    await caller().suggestions.approveDebt({
      id: s.id, debt: { creditorName: "Intrum Justitia", claimedCents: 20000 } });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveDebt leaves rejected suggestions untouched", async () => {
    const s = await makeDebtSuggestion();
    await caller().suggestions.reject({ id: s.id });
    await expect(caller().suggestions.approveDebt({
      id: s.id, debt: { creditorName: "Intrum Justitia", claimedCents: 25000 } }))
      .rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
  });
});
