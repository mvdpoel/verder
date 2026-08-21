import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// APP role: exercises the real grants (no UPDATE/DELETE on evidence tables).
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("registry schema", () => {
  let db: Db;
  let userId: string;
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `reg${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  it("inserts an item, a debt, a transaction and a decision", async () => {
    const [item] = await db.insert(schema.financialItems).values({
      name: "Eneco", category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    expect(item.id).toBeTruthy();
    expect(item.discoveredVia).toBe("manual"); // default

    const [debt] = await db.insert(schema.debts).values({
      creditorName: "Incassobureau X", claimedCents: 250000, principalCents: 180000,
      references_: "dossier 12345",
    }).returning();
    expect(debt.id).toBeTruthy();
    expect(debt.references_).toBe("dossier 12345");

    const [tx] = await db.insert(schema.transactions).values({
      source: "abn-camt053", bookedAt: new Date("2026-08-01T00:00:00Z"),
      amountCents: -14280, counterpartyName: "Eneco Services",
      counterpartyIban: "NL13TEST0123456789", mandateId: "MND-001",
      statementSha256: sha(), rowIndex: 0, financialItemId: item.id,
    }).returning();
    expect(tx.id).toBeTruthy();
    expect(tx.parseError).toBe(false); // default

    const [decision] = await db.insert(schema.registryDecisions).values({
      financialItemId: item.id, status: "mandatory",
      explanation: "Energy is a basic need — must stay.", createdBy: userId,
    }).returning();
    expect(decision.id).toBeTruthy();
    expect(decision.debtId).toBeNull();
  });

  it("unique index rejects a duplicate (statementSha256, rowIndex)", async () => {
    const statementSha256 = sha();
    const row = {
      source: "abn-tsv" as const, bookedAt: new Date("2026-08-02T00:00:00Z"),
      amountCents: -1399, statementSha256, rowIndex: 7,
    };
    await db.insert(schema.transactions).values(row);
    await expect(db.insert(schema.transactions).values(row))
      .rejects.toThrow(/tx_stmt_row_uq|duplicate key/);
  });

  it("registry_decisions is insert-only for the app role (UPDATE denied)", async () => {
    const [debt] = await db.insert(schema.debts).values({
      creditorName: "Deurwaarder Y", claimedCents: 9900,
    }).returning();
    const [decision] = await db.insert(schema.registryDecisions).values({
      debtId: debt.id, status: "acknowledged",
      explanation: "Claim checked against invoices.", createdBy: userId,
    }).returning();
    await expect(
      db.update(schema.registryDecisions)
        .set({ explanation: "tampered" })
        .where(eq(schema.registryDecisions.id, decision.id)),
    ).rejects.toThrow(/permission denied/);
  });

  it("fact tables allow UPDATE but never DELETE (app role)", async () => {
    const [item] = await db.insert(schema.financialItems).values({
      name: "Netflik", category: "streaming", amountCents: 1399,
      billingCycle: "monthly", paymentChannel: "paypal",
    }).returning();
    // a typo is a typo: UPDATE is allowed on fact tables
    const [fixed] = await db.update(schema.financialItems)
      .set({ name: "Netflix" })
      .where(eq(schema.financialItems.id, item.id)).returning();
    expect(fixed.name).toBe("Netflix");
    // but nothing is ever deleted
    await expect(
      db.delete(schema.financialItems).where(eq(schema.financialItems.id, item.id)),
    ).rejects.toThrow(/permission denied/);
  });

  it("transactions carry the account the statement belongs to", async () => {
    const [row] = await db.insert(schema.transactions).values({
      source: "abn-camt053",
      bookedAt: new Date("2026-07-25T00:00:00Z"),
      amountCents: 241_304,
      accountIban: "NL91ABNA0417164300",
      statementSha256: `acct-${Date.now()}`,
      rowIndex: 0,
    }).returning();
    expect(row.accountIban).toBe("NL91ABNA0417164300");

    // Nullable: a PayPal export has no account IBAN and must still import.
    const [unknown] = await db.insert(schema.transactions).values({
      source: "paypal-csv",
      bookedAt: new Date("2026-07-25T00:00:00Z"),
      amountCents: -1_200,
      statementSha256: `acct-null-${Date.now()}`,
      rowIndex: 0,
    }).returning();
    expect(unknown.accountIban).toBeNull();
  });

  it("CHECK rejects a decision with both or neither target set", async () => {
    const [item] = await db.insert(schema.financialItems).values({
      name: "KPN", category: "telecom", amountCents: 4500,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    const [debt] = await db.insert(schema.debts).values({
      creditorName: "KPN incasso", claimedCents: 12000,
    }).returning();
    await expect(db.insert(schema.registryDecisions).values({
      financialItemId: item.id, debtId: debt.id, status: "identified",
      explanation: "both targets", createdBy: userId,
    })).rejects.toThrow(/registry_decision_target_ck|check constraint/);
    await expect(db.insert(schema.registryDecisions).values({
      status: "identified", explanation: "no target", createdBy: userId,
    })).rejects.toThrow(/registry_decision_target_ck|check constraint/);
  });
});
