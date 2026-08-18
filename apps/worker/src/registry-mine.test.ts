import { describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import type { LlmPort } from "./ollama";
import { mineRegistry } from "./registry-mine";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

// Unique LETTERS only: normalizeName strips digits, so a numeric suffix would
// collide with earlier test runs (dedup keys live in the shared dev DB).
const letters = () => crypto.randomUUID().replace(/[^a-f]/g, "");

// Three monthly booking dates (gaps 30/31 days → monthly cadence).
const MONTHLY_DATES = [
  new Date("2026-05-15T09:00:00Z"),
  new Date("2026-06-14T09:00:00Z"),
  new Date("2026-07-15T09:00:00Z"),
];

async function insertCharges(
  db: ReturnType<typeof createDb>["db"],
  over: {
    counterpartyName?: string | null; counterpartyIban?: string | null;
    mandateId?: string | null; amountCents?: number; financialItemId?: string;
  },
  dates: Date[] = MONTHLY_DATES,
) {
  const statementSha256 = `stmt-${crypto.randomUUID()}`;
  const rows = await db.insert(schema.transactions).values(dates.map((d, i) => ({
    source: "abn-camt053" as const, bookedAt: d,
    amountCents: over.amountCents ?? -1499,
    counterpartyName: over.counterpartyName ?? null,
    counterpartyIban: over.counterpartyIban ?? null,
    mandateId: over.mandateId ?? null,
    financialItemId: over.financialItemId,
    statementSha256, rowIndex: i,
  }))).returning();
  return rows;
}

const suggestionsByKey = (db: ReturnType<typeof createDb>["db"], key: string) =>
  db.select().from(schema.suggestions)
    .where(sql`${schema.suggestions.proposed} ->> 'key' = ${key}`);

const fixedLlm = (out: unknown): LlmPort => ({ chatJson: async () => out });

describe("mineRegistry", () => {
  it("suggests a classified registry-item for a recurring mandate, idempotently", async () => {
    const { db, pool } = createDb(URL);
    const mandateId = `MD-${crypto.randomUUID()}`;
    await insertCharges(db, { counterpartyName: "Testenergie NV", mandateId });
    const prompts: string[] = [];
    const llm: LlmPort = { chatJson: async (p) => { prompts.push(p);
      return { name: "Test Energie", category: "energy", isDebtCollector: false }; } };
    await mineRegistry({ db, llm });
    const found = await suggestionsByKey(db, `mandate:${mandateId}`);
    expect(found).toHaveLength(1);
    const s = found[0];
    expect(s.kind).toBe("registry-item");
    expect(s.status).toBe("pending");
    expect(s.promptVersion).toBe("registry-v1");
    expect(s.model).toBeTruthy();
    const p = s.proposed as Record<string, unknown>;
    expect(p.name).toBe("Test Energie");
    expect(p.category).toBe("energy");
    expect(p.amountCents).toBe(1499);            // positive integer cents
    expect(p.billingCycle).toBe("monthly");
    expect(p.paymentChannel).toBe("direct-debit"); // mandate ⇒ direct debit
    expect(p.mandateId).toBe(mandateId);
    expect(p.transactionIds).toHaveLength(3);
    expect(p.aggregator).toBeNull();
    expect(p.resolved).toBe(true);               // nothing left to resolve
    expect(p.discoveredVia).toBe("bank");
    // The candidate's counterparty must actually reach the prompt.
    expect(prompts.some((x) => x.includes("Testenergie"))).toBe(true);
    // Mining is idempotent: a second sweep must not re-suggest the same key.
    await mineRegistry({ db, llm });
    expect(await suggestionsByKey(db, `mandate:${mandateId}`)).toHaveLength(1);
    // The run is visible on the dashboard.
    const runs = await db.select().from(schema.workerRuns);
    expect(runs.some((r) => r.worker === "registry-mine" && r.status === "ok")).toBe(true);
    await pool.end();
  });

  it("never resurfaces a rejected suggestion", async () => {
    const { db, pool } = createDb(URL);
    const mandateId = `MD-${crypto.randomUUID()}`;
    await insertCharges(db, { counterpartyName: "Sportschool Fit", mandateId });
    await db.insert(schema.suggestions).values({
      kind: "registry-item", status: "rejected",
      proposed: { key: `mandate:${mandateId}`, name: "Sportschool Fit" } });
    await mineRegistry({ db, llm: fixedLlm({ name: "Sportschool Fit", category: "other", isDebtCollector: false }) });
    const found = await suggestionsByKey(db, `mandate:${mandateId}`);
    expect(found).toHaveLength(1);               // only the rejected one
    expect(found[0].status).toBe("rejected");
    await pool.end();
  });

  it("links new charges to an existing item matched by mandate instead of suggesting", async () => {
    const { db, pool } = createDb(URL);
    const mandateId = `MD-${crypto.randomUUID()}`;
    const [item] = await db.insert(schema.financialItems).values({
      name: `Energieleverancier ${letters()}`, category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit", discoveredVia: "bank",
    }).returning();
    // One already-linked charge carries the mandate → proves item identity.
    await insertCharges(db, { mandateId, financialItemId: item.id },
      [new Date("2026-04-15T09:00:00Z")]);
    const fresh = await insertCharges(db, { mandateId });
    await mineRegistry({ db, llm: fixedLlm({ name: "x", category: "other", isDebtCollector: false }) });
    const after = await db.select().from(schema.transactions)
      .where(inArray(schema.transactions.id, fresh.map((r) => r.id)));
    expect(after.every((t) => t.financialItemId === item.id)).toBe(true);
    expect(await suggestionsByKey(db, `mandate:${mandateId}`)).toHaveLength(0);
    await pool.end();
  });

  it("links by normalized counterparty name match", async () => {
    const { db, pool } = createDb(URL);
    const l = letters();
    const [item] = await db.insert(schema.financialItems).values({
      name: `Ziggo ${l} B.V.`, category: "telecom", amountCents: 5250,
      billingCycle: "monthly", paymentChannel: "direct-debit", discoveredVia: "manual",
    }).returning();
    const fresh = await insertCharges(db, { counterpartyName: `ZIGGO ${l} b.v. 4271` });
    await mineRegistry({ db, llm: fixedLlm({ name: "x", category: "other", isDebtCollector: false }) });
    const after = await db.select().from(schema.transactions)
      .where(inArray(schema.transactions.id, fresh.map((r) => r.id)));
    expect(after.every((t) => t.financialItemId === item.id)).toBe(true);
    await pool.end();
  });

  it("never links via an empty normalized name (digits-only names must not collide)", async () => {
    const { db, pool } = createDb(URL);
    // Item whose name normalizes to "" (digits/punctuation only).
    const digits = String(Date.now()) + Math.floor(Math.random() * 1e6);
    const [item] = await db.insert(schema.financialItems).values({
      name: digits, category: "other", amountCents: 999,
      billingCycle: "monthly", paymentChannel: "invoice", discoveredVia: "manual",
    }).returning();
    // Candidate with its own fresh mandate whose counterparty name also
    // normalizes to "" — it must NOT be treated as evidence for that item.
    const mandateId = `MD-${crypto.randomUUID()}`;
    const fresh = await insertCharges(db, { counterpartyName: "999-888", mandateId });
    await mineRegistry({ db, llm: fixedLlm({ name: "x", category: "other", isDebtCollector: false }) });
    const after = await db.select().from(schema.transactions)
      .where(inArray(schema.transactions.id, fresh.map((r) => r.id)));
    expect(after.every((t) => t.financialItemId === null)).toBe(true);
    expect(after.some((t) => t.financialItemId === item.id)).toBe(false);
    // The real payee reaches the review queue instead of silently vanishing.
    expect(await suggestionsByKey(db, `mandate:${mandateId}`)).toHaveLength(1);
    await pool.end();
  });

  it("keeps a payee whose normalized name equals another payee's mandate id (keys namespaced by group)", async () => {
    const { db, pool } = createDb(URL);
    // A mandate id of letters+space only, so another payee's NAME can
    // normalize to the exact same string (normalizeName strips digits/punct).
    const shared = `md ${letters()}`;
    const payeeAName = `Energie ${letters()}`;
    const payeeBName = shared.toUpperCase();     // normalizes back to `shared`
    await insertCharges(db, { counterpartyName: payeeAName, mandateId: shared });
    await insertCharges(db, { counterpartyName: payeeBName });
    const llm = fixedLlm({ name: "x", category: "other", isDebtCollector: false });
    await mineRegistry({ db, llm });
    const byCounterparty = (name: string) => db.select().from(schema.suggestions)
      .where(sql`${schema.suggestions.proposed} ->> 'counterpartyName' = ${name}`);
    // BOTH payees must reach the review queue — a bare-key collision would
    // silently suppress one of them forever.
    const forA = await byCounterparty(payeeAName);
    const forB = await byCounterparty(payeeBName);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    // Keys carry the group namespace so they can never collide across kinds.
    expect((forA[0].proposed as Record<string, unknown>).key).toBe(`mandate:${shared}`);
    expect((forB[0].proposed as Record<string, unknown>).key).toBe(`name:${shared}`);
    // Second sweep stays idempotent for both.
    await mineRegistry({ db, llm });
    expect(await byCounterparty(payeeAName)).toHaveLength(1);
    expect(await byCounterparty(payeeBName)).toHaveLength(1);
    await pool.end();
  });

  it("classifies a debt collector into a debt suggestion", async () => {
    const { db, pool } = createDb(URL);
    const mandateId = `MD-${crypto.randomUUID()}`;
    await insertCharges(db, { counterpartyName: "Incasso Bureau Snel", mandateId, amountCents: -25000 });
    await mineRegistry({ db,
      llm: fixedLlm({ name: "Incassobureau Snel", category: "other", isDebtCollector: true }) });
    const [s] = await suggestionsByKey(db, `mandate:${mandateId}`);
    expect(s.kind).toBe("debt");
    const p = s.proposed as Record<string, unknown>;
    expect(p.creditorName).toBe("Incassobureau Snel");
    expect(p.claimedCents).toBe(25000);
    expect(p.transactionIds).toHaveLength(3);
    await pool.end();
  });

  it("falls back to needs-manual when the LLM fails", async () => {
    const { db, pool } = createDb(URL);
    const mandateId = `MD-${crypto.randomUUID()}`;
    await insertCharges(db, { counterpartyName: "Onbekende Afschrijver", mandateId });
    await mineRegistry({ db, llm: { chatJson: async () => { throw new Error("ollama down"); } } });
    const [s] = await suggestionsByKey(db, `mandate:${mandateId}`);
    expect(s.kind).toBe("registry-item");
    expect(s.status).toBe("needs-manual");
    const p = s.proposed as Record<string, unknown>;
    expect(p.name).toBe("Onbekende Afschrijver");
    expect(p.category).toBe("other");
    await pool.end();
  });

  it("flags aggregator candidates unresolved and enqueues receipt resolution", async () => {
    const { db, pool } = createDb(URL);
    const name = `APPLE.COM/BILL ${letters()}`;
    const key = name.toLowerCase().replace(/[^a-z\s]+/g, "").replace(/\s+/g, " ").trim();
    await insertCharges(db, { counterpartyName: name, amountCents: -999 });
    const enqueued: string[] = [];
    await mineRegistry({ db,
      llm: fixedLlm({ name: "Apple", category: "software", isDebtCollector: false }),
      enqueueResolve: async (id) => { enqueued.push(id); } });
    const [s] = await suggestionsByKey(db, `name:${key}`);
    expect(s).toBeDefined();
    const p = s.proposed as Record<string, unknown>;
    expect(p.aggregator).toBe("apple");
    expect(p.resolved).toBe(false);
    expect(p.paymentChannel).toBe("apple");
    expect(enqueued).toContain(s.id);
    await pool.end();
  });
});
