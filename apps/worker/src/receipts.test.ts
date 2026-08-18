import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import type { GmailMessage, GmailPort } from "./gmail";
import type { LlmPort } from "./ollama";
import { resolveAggregator } from "./receipts";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

// Three monthly Apple/PayPal charge dates; the resolver searches around the
// last <=3 of these.
const CHARGE_DATES = [
  new Date("2026-05-15T09:00:00Z"),
  new Date("2026-06-15T09:00:00Z"),
  new Date("2026-07-15T09:00:00Z"),
];

type Db = ReturnType<typeof createDb>["db"];

async function seedAggregatorSuggestion(db: Db, aggregator: "apple" | "paypal") {
  const key = `${aggregator}-${crypto.randomUUID()}`;
  const statementSha256 = `stmt-${crypto.randomUUID()}`;
  const txs = await db.insert(schema.transactions).values(CHARGE_DATES.map((d, i) => ({
    source: "abn-camt053" as const, bookedAt: d, amountCents: -999,
    counterpartyName: aggregator === "apple" ? "APPLE.COM/BILL" : "PayPal Europe S.a r.l.",
    statementSha256, rowIndex: i,
  }))).returning();
  const [s] = await db.insert(schema.suggestions).values({
    kind: "registry-item", model: "test-model", promptVersion: "registry-v1",
    proposed: {
      key, groupBy: "name",
      counterpartyName: txs[0].counterpartyName, counterpartyIban: null, mandateId: null,
      transactionIds: txs.map((t) => t.id), chargeCount: 3, typicalAmountCents: -999,
      firstAt: CHARGE_DATES[0].toISOString(), lastAt: CHARGE_DATES[2].toISOString(),
      receiptRawEmailIds: [], aggregator, resolved: false,
      paymentChannel: aggregator, discoveredVia: aggregator,
      name: aggregator === "apple" ? "Apple" : "PayPal", category: "software",
      amountCents: 999, billingCycle: "monthly",
    },
  }).returning();
  return { suggestion: s, txs, key };
}

function receiptMsg(id: string): GmailMessage {
  return {
    id, threadId: `t-${id}`, from: "no_reply@email.apple.com",
    to: "martin@vanderpoel.pro", subject: "Your receipt from Apple",
    sentAt: new Date("2026-07-15T10:00:00Z"),
    bodyText: "iCloud+ 50 GB €0,99\nTotaal €0,99",
    raw: Buffer.from(`receipt-raw-${id}`), attachments: [],
  };
}

/** Gmail fake: newest charge-date query yields one receipt, others nothing. */
function fakeGmail(receiptId: string) {
  const queries: string[] = [];
  const fetched: string[] = [];
  const port: GmailPort = {
    listMessageIds: async (q) => { queries.push(q); return queries.length === 1 ? [receiptId] : []; },
    getMessage: async (id) => { fetched.push(id); return receiptMsg(id); },
  };
  return { port, queries, fetched };
}

const reload = async (db: Db, id: string) => {
  const [s] = await db.select().from(schema.suggestions).where(eq(schema.suggestions.id, id));
  return s;
};

describe("resolveAggregator", () => {
  it("resolves an apple candidate from a receipt, evidence-first and idempotently", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "receipts-vault-"));
    const { suggestion } = await seedAggregatorSuggestion(db, "apple");
    const receiptId = `r-${crypto.randomUUID()}`;
    const { port, queries } = fakeGmail(receiptId);
    let llmCalls = 0;
    const llm: LlmPort = { chatJson: async () => { llmCalls++;
      return { items: [{ name: "iCloud+ 50 GB", amountCents: 99 }] }; } };
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);

    // Targeted queries: one per charge date (newest first), 2-day window.
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries.every((q) => q.includes("from:apple.com"))).toBe(true);
    expect(queries[0]).toContain("after:2026/07/13");
    expect(queries[0]).toContain("before:2026/07/17");

    const after = await reload(db, suggestion.id);
    const p = after.proposed as Record<string, unknown>;
    expect(p.resolved).toBe(true);
    expect(p.name).toBe("iCloud+ 50 GB");
    expect(p.amountCents).toBe(99);
    expect(p.receiptRawEmailIds).toHaveLength(1);
    expect(after.status).toBe("pending");       // still Martin's call

    // Evidence-first: the canonical RFC822 receipt bytes live in the vault.
    const rawEmailId = (p.receiptRawEmailIds as string[])[0];
    const [raw] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, rawEmailId));
    expect(raw.gmailMessageId).toBe(receiptId);
    const storedRaw = readFileSync(readFilePath(vaultDir, raw.rawRfc822Sha256));
    expect(storedRaw.toString()).toBe(`receipt-raw-${receiptId}`);
    // Receipts never owe a suggest.entry job — the poller's outbox repair
    // must not pick this row up later.
    expect(raw.suggestQueuedAt).not.toBeNull();

    // Run is visible on the dashboard.
    const runs = await db.select().from(schema.workerRuns);
    expect(runs.some((r) => r.worker === "receipts" && r.status === "ok")).toBe(true);

    // Already resolved → second call is a no-op (no new LLM call, no new email).
    const callsBefore = llmCalls;
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);
    expect(llmCalls).toBe(callsBefore);
    const emails = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, receiptId));
    expect(emails).toHaveLength(1);
    await pool.end();
  });

  it("fans a multi-line receipt out into one suggestion per line item", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "receipts-vault-"));
    const { suggestion, key, txs } = await seedAggregatorSuggestion(db, "apple");
    const receiptId = `r-${crypto.randomUUID()}`;
    const { port } = fakeGmail(receiptId);
    const llm: LlmPort = { chatJson: async () => ({ items: [
      { name: "Apple TV+", amountCents: 699 },
      { name: "iCloud+ 200 GB", amountCents: 299 },
    ] }) };
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);

    const first = await reload(db, suggestion.id);
    const p1 = first.proposed as Record<string, unknown>;
    expect(p1.name).toBe("Apple TV+");
    expect(p1.amountCents).toBe(699);
    expect(p1.resolved).toBe(true);

    const [extra] = await db.select().from(schema.suggestions)
      .where(sql`${schema.suggestions.proposed} ->> 'key' = ${`${key}#1`}`);
    expect(extra).toBeDefined();
    expect(extra.kind).toBe("registry-item");
    const p2 = extra.proposed as Record<string, unknown>;
    expect(p2.name).toBe("iCloud+ 200 GB");
    expect(p2.amountCents).toBe(299);
    expect(p2.resolved).toBe(true);
    // Same evidence on both: statement charges + the receipt email.
    expect(p2.transactionIds).toEqual(txs.map((t) => t.id));
    expect(p2.receiptRawEmailIds).toEqual(p1.receiptRawEmailIds);
    await pool.end();
  });

  it("degrades to needs-manual when no receipt is found (paypal queries)", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "receipts-vault-"));
    const { suggestion } = await seedAggregatorSuggestion(db, "paypal");
    const queries: string[] = [];
    const port: GmailPort = {
      listMessageIds: async (q) => { queries.push(q); return []; },
      getMessage: async () => { throw new Error("must not fetch"); },
    };
    const llm: LlmPort = { chatJson: async () => { throw new Error("must not classify"); } };
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);

    expect(queries.length).toBe(3);             // one per charge date
    expect(queries.every((q) => q.includes("from:paypal.nl") && q.includes("from:paypal.com"))).toBe(true);
    const after = await reload(db, suggestion.id);
    expect(after.status).toBe("needs-manual");  // surfaced, never dropped
    const p = after.proposed as Record<string, unknown>;
    expect(p.resolved).toBe(false);
    expect(String(p.note)).toContain("payee unknown");
    await pool.end();
  });

  it("keeps the receipt evidence but goes needs-manual when the LLM fails", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "receipts-vault-"));
    const { suggestion } = await seedAggregatorSuggestion(db, "apple");
    const receiptId = `r-${crypto.randomUUID()}`;
    const { port } = fakeGmail(receiptId);
    const llm: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);

    const after = await reload(db, suggestion.id);
    expect(after.status).toBe("needs-manual");
    const p = after.proposed as Record<string, unknown>;
    expect(p.resolved).toBe(true);              // lookup itself succeeded
    expect(p.receiptRawEmailIds).toHaveLength(1);
    expect(p.name).toBe("Apple");               // original classification kept
    await pool.end();
  });

  it("reuses an already-ingested receipt email instead of re-fetching", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "receipts-vault-"));
    const { suggestion } = await seedAggregatorSuggestion(db, "apple");
    const receiptId = `r-${crypto.randomUUID()}`;
    // The watcher (or an earlier resolve) already ingested this message.
    const [existing] = await db.insert(schema.rawEmails).values({
      gmailMessageId: receiptId, gmailThreadId: "t-x",
      fromAddr: "no_reply@email.apple.com", toAddr: "martin@vanderpoel.pro",
      subject: "Your receipt from Apple", sentAt: new Date("2026-07-15T10:00:00Z"),
      rawRfc822Sha256: "0".repeat(64), bodyText: "iCloud+ 50 GB €0,99",
      suggestQueuedAt: new Date(),
    }).returning();
    const { port, fetched } = fakeGmail(receiptId);
    const llm: LlmPort = { chatJson: async () => ({ items: [{ name: "iCloud+ 50 GB", amountCents: 99 }] }) };
    await resolveAggregator({ db, gmail: port, llm, vaultDir }, suggestion.id);

    expect(fetched).toHaveLength(0);            // no duplicate fetch/ingest
    const after = await reload(db, suggestion.id);
    const p = after.proposed as Record<string, unknown>;
    expect(p.receiptRawEmailIds).toEqual([existing.id]);
    expect(p.name).toBe("iCloud+ 50 GB");
    await pool.end();
  });
});
