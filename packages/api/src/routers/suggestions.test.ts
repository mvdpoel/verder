import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "@verder/core";
import { createDb, schema, type Db } from "@verder/db";
import { entryEventPayload } from "./entries";
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

  it("approveRegistryItem marks edited when only the amount changed", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    await caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, amountCents: 9999 } });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveRegistryItem marks edited when only billing cycle and payment channel changed", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    await caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, billingCycle: "yearly", paymentChannel: "invoice" } });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveRegistryItem stores the client-sent discoveredVia when the payload lacks it", async () => {
    const txs = await makeChargeTransactions();
    // Miner payload without discoveredVia — the form's value must win, and a
    // field the miner never proposed is not an edit.
    const [s] = await db.insert(schema.suggestions).values({
      kind: "registry-item", model: "qwen3.5:9b", promptVersion: "registry-v1",
      proposed: {
        key: `iban:NL91ABNA0417164300-${crypto.randomUUID()}`, groupBy: "iban",
        transactionIds: txs.map((t) => t.id),
        name: "Netflix", category: "streaming", amountCents: 1299,
        billingCycle: "monthly", paymentChannel: "direct-debit",
      },
    }).returning();
    const res = await caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, discoveredVia: "bank" } });
    const [item] = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.id, res.itemId));
    expect(item.discoveredVia).toBe("bank"); // not silently defaulted to manual
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("approved");
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

  it("concurrent double-approve creates exactly one financial item", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    const uniqueName = `Netflix-${crypto.randomUUID()}`;
    const item = { ...itemForApproval, name: uniqueName };
    // Two concurrent HTTP requests (two pool connections): only one may win.
    const results = await Promise.allSettled([
      caller().suggestions.approveRegistryItem({ id: s.id, item }),
      caller().suggestions.approveRegistryItem({ id: s.id, item }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const items = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.name, uniqueName));
    expect(items).toHaveLength(1);
    for (const t of txs) {
      const [tx] = await db.select().from(schema.transactions)
        .where(eq(schema.transactions.id, t.id));
      expect(tx.financialItemId).toBe(items[0].id);
    }
  });

  it("approveRegistryItem fails loudly when the payload references nonexistent transactions", async () => {
    const s = await makeRegistryItemSuggestion([crypto.randomUUID(), crypto.randomUUID()]);
    const uniqueName = `Ghost-${crypto.randomUUID()}`;
    await expect(caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, name: uniqueName } })).rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("pending"); // no verdict recorded
    expect(after.verdictAt).toBeNull();
    const items = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.name, uniqueName));
    expect(items).toHaveLength(0); // rolled back — no half-created item
  });

  it("approveRegistryItem fails loudly on malformed (non-string) transactionIds", async () => {
    const s = await makeRegistryItemSuggestion([123, {}, null] as unknown as string[]);
    const uniqueName = `Malformed-${crypto.randomUUID()}`;
    await expect(caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, name: uniqueName } })).rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("pending");
    const items = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.name, uniqueName));
    expect(items).toHaveLength(0);
  });

  it("approveRegistryItem never steals transactions already linked to another item", async () => {
    const txs = await makeChargeTransactions();
    const [manual] = await db.insert(schema.financialItems).values({
      name: `Manual-${crypto.randomUUID()}`, category: "streaming", amountCents: 1299,
      billingCycle: "monthly", paymentChannel: "direct-debit", discoveredVia: "manual",
    }).returning();
    await db.update(schema.transactions).set({ financialItemId: manual.id })
      .where(inArray(schema.transactions.id, txs.map((t) => t.id)));
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    const uniqueName = `Dup-${crypto.randomUUID()}`;
    await expect(caller().suggestions.approveRegistryItem({
      id: s.id, item: { ...itemForApproval, name: uniqueName } })).rejects.toThrow();
    for (const t of txs) {
      const [tx] = await db.select().from(schema.transactions)
        .where(eq(schema.transactions.id, t.id));
      expect(tx.financialItemId).toBe(manual.id); // evidence stayed with the manual item
    }
    const items = await db.select().from(schema.financialItems)
      .where(eq(schema.financialItems.name, uniqueName));
    expect(items).toHaveLength(0);
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("pending");
  });

  it("reject after approve is refused: the verdict and edit diff stand", async () => {
    const txs = await makeChargeTransactions();
    const s = await makeRegistryItemSuggestion(txs.map((t) => t.id));
    await caller().suggestions.approveRegistryItem({ id: s.id, item: itemForApproval });
    await expect(caller().suggestions.reject({ id: s.id, reason: "oops double click" }))
      .rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("approved");
    expect((after.finalPayload as { name?: string }).name).toBe("Netflix"); // diff preserved
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

  it("approveDebt creates the debt and marks edited when a reference was added", async () => {
    const s = await makeDebtSuggestion();
    // proposed.references is null — adding "dossier 12345" is an edit
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
    expect(after.status).toBe("edited");
  });

  it("approveDebt marks approved when every proposed field is unchanged", async () => {
    const s = await makeDebtSuggestion();
    // references omitted vs proposed null: absent submitted nullish = proposed
    // null, not an edit.
    await caller().suggestions.approveDebt({
      id: s.id, debt: { creditorName: "Intrum Justitia", claimedCents: 25000 } });
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

  it("concurrent double-approve creates exactly one debt", async () => {
    const s = await makeDebtSuggestion();
    const creditorName = `Intrum-${crypto.randomUUID()}`;
    const results = await Promise.allSettled([
      caller().suggestions.approveDebt({ id: s.id, debt: { creditorName, claimedCents: 25000 } }),
      caller().suggestions.approveDebt({ id: s.id, debt: { creditorName, claimedCents: 25000 } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const debts = await db.select().from(schema.debts)
      .where(eq(schema.debts.creditorName, creditorName));
    expect(debts).toHaveLength(1);
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

  // --- task approval (sub-project 3, Task 6) ---------------------------------

  async function makeTaskSuggestion(opts?: { title?: string; dueAt?: string | null }) {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t-task",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Loonstroken opsturen", sentAt: new Date(),
      rawRfc822Sha256: "b".repeat(64), bodyText: "Graag loonstroken juni en juli opsturen.",
    }).returning();
    const title = opts?.title ?? `Send payslips ${crypto.randomUUID()}`;
    const [s] = await db.insert(schema.suggestions).values({
      kind: "task", rawEmailId: raw.id, model: "qwen3.5:9b", promptVersion: "task-v1",
      proposed: {
        key: `task:${raw.id}:${title.toLowerCase()}`,
        title, details: "June and July payslips.",
        dueAt: opts?.dueAt === undefined ? "2026-09-01" : opts.dueAt,
        assigneeHint: "martin", rawEmailId: raw.id,
      },
    }).returning();
    return s;
  }

  async function makeParty() {
    const [party] = await db.insert(schema.parties).values({
      kind: "organization", name: `VerderGroep-${crypto.randomUUID()}`,
    }).returning();
    return party;
  }

  it("approveTask creates the task and marks approved when unchanged (assignee pick is not an edit)", async () => {
    const s = await makeTaskSuggestion();
    const party = await makeParty();
    const p = s.proposed as { title: string; details: string };
    const task = await caller().suggestions.approveTask({
      id: s.id,
      task: { title: p.title, details: p.details,
        dueAt: new Date("2026-09-01"), assigneePartyId: party.id },
    });
    expect(task.id).toBeTruthy();
    const [row] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, task.id));
    expect(row.title).toBe(p.title);
    expect(row.assigneePartyId).toBe(party.id);
    expect(row.createdBy).toBe(userId);
    expect(row.dueAt?.toISOString()).toBe(new Date("2026-09-01").toISOString());
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    // Same title/details/dueAt as proposed; assigneePartyId was never proposed
    // (only a hint), so picking one is not an edit.
    expect(after.status).toBe("approved");
    expect(after.finalPayload).toBeTruthy();
    expect(after.verdictAt).toBeTruthy();
  });

  it("approveTask marks approved when empty proposed details are left empty", async () => {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t-task",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Bellen", sentAt: new Date(),
      rawRfc822Sha256: "b".repeat(64), bodyText: "Graag even terugbellen.",
    }).returning();
    const title = `Call back ${crypto.randomUUID()}`;
    // The miner records details: "" when the model gives none; the card
    // submits an empty textarea as absent. Same emptiness — not an edit.
    const [s] = await db.insert(schema.suggestions).values({
      kind: "task", rawEmailId: raw.id, model: "qwen3.5:9b", promptVersion: "task-v1",
      proposed: { key: `task:${raw.id}:call back`, title, details: "",
        dueAt: null, assigneeHint: "martin", rawEmailId: raw.id },
    }).returning();
    await caller().suggestions.approveTask({ id: s.id, task: { title } });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("approved");
  });

  it("approveTask marks edited when the title was changed", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string; details: string };
    await caller().suggestions.approveTask({
      id: s.id,
      task: { title: `${p.title} (reworded)`, details: p.details, dueAt: new Date("2026-09-01") },
    });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveTask marks edited when only the due date was changed", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string; details: string };
    await caller().suggestions.approveTask({
      id: s.id,
      task: { title: p.title, details: p.details, dueAt: new Date("2026-09-15") },
    });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
  });

  it("approveTask refuses non-task suggestions", async () => {
    const s = await makeSuggestion(); // kind: "log-entry"
    await expect(caller().suggestions.approveTask({
      id: s.id, task: { title: "Not a task suggestion" } })).rejects.toThrow();
  });

  it("approveTask after reject is refused and creates nothing", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string };
    await caller().suggestions.reject({ id: s.id, reason: "Not a task" });
    await expect(caller().suggestions.approveTask({
      id: s.id, task: { title: p.title } })).rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.title, p.title));
    expect(rows).toHaveLength(0);
  });

  it("concurrent double-approve creates exactly one task", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string };
    const results = await Promise.allSettled([
      caller().suggestions.approveTask({ id: s.id, task: { title: p.title } }),
      caller().suggestions.approveTask({ id: s.id, task: { title: p.title } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.title, p.title));
    expect(rows).toHaveLength(1);
  });

  it("approveTask fails loudly on a nonexistent assigneePartyId and leaves the suggestion open", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string };
    await expect(caller().suggestions.approveTask({
      id: s.id, task: { title: p.title, assigneePartyId: crypto.randomUUID() } }))
      .rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("pending"); // no verdict recorded — rolled back
    expect(after.verdictAt).toBeNull();
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.title, p.title));
    expect(rows).toHaveLength(0);
  });

  it("approveTask fails loudly on a nonexistent linked entry id", async () => {
    const s = await makeTaskSuggestion();
    const p = s.proposed as { title: string };
    await expect(caller().suggestions.approveTask({
      id: s.id, task: { title: p.title, entryId: crypto.randomUUID() } }))
      .rejects.toThrow();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("pending");
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.title, p.title));
    expect(rows).toHaveLength(0);
  });

  it("list returns retrievedRefs and the refs never affect the edit diff", async () => {
    const s = await makeTaskSuggestion();
    await db.update(schema.suggestions).set({
      retrievedRefs: [{ entityType: "document",
        entityId: "44444444-4444-4444-4444-444444444444",
        title: "Loonstrook juni", score: 0.03, snippet: "…loonstrook…" }],
    }).where(eq(schema.suggestions.id, s.id));
    const listed = (await caller().suggestions.list({ status: "pending" }))
      .find((row) => row.id === s.id);
    expect(listed?.retrievedRefs).toHaveLength(1);

    const p = s.proposed as { title: string; details: string };
    await caller().suggestions.approveTask({
      id: s.id,
      task: { title: p.title, details: p.details, dueAt: new Date("2026-09-01") },
    });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    // Citations are provenance, not a proposal: an unedited approval stays
    // "approved" even though retrievedRefs is populated, and finalPayload
    // records only what was actually stored.
    expect(after.status).toBe("approved");
    expect((after.finalPayload as Record<string, unknown>).retrievedRefs).toBeUndefined();
  });

  // --- discarded documents drop out of the queue (Task 5) --------------------

  async function makeDocument(title: string, mime: string) {
    const [doc] = await db.insert(schema.documents).values({
      sha256: randomSha(), sizeBytes: 4096, mime, title,
      source: "email-attachment", receivedAt: new Date(),
    }).returning();
    return doc;
  }

  async function makeDocumentMetaSuggestion(documentId: string) {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { title: "image.png" },
    }).returning();
    return s;
  }

  it("omits suggestions whose document has been discarded", async () => {
    const junk = await makeDocument("image.png", "image/png");
    const junkSuggestion = await makeDocumentMetaSuggestion(junk.id);
    const keep = await makeDocument("Beschikking.pdf", "application/pdf");
    const keepSuggestion = await makeDocumentMetaSuggestion(keep.id);

    await caller().documents.update({ id: junk.id, status: "discarded" });
    // The trap: discard lives in document_status_changes and is never written
    // back, so the column still reads "inbox" — only the EFFECTIVE status knows.
    const [row] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, junk.id));
    expect(row.status).toBe("inbox");

    const ids = (await caller().suggestions.list({ status: "pending" })).map((s) => s.id);
    expect(ids).toContain(keepSuggestion.id);
    expect(ids).not.toContain(junkSuggestion.id);
  });

  it("keeps suggestions that have no document at all", async () => {
    const s = await makeSuggestion(); // kind: "log-entry", documentId null
    const list = await caller().suggestions.list({ status: "pending" });
    expect(list.map((x) => x.id)).toContain(s.id);
    // Most pending suggestions carry no document; filtering must not touch them.
    expect(list.some((x) => x.documentId === null)).toBe(true);
  });

  it("brings a suggestion back when the discard is undone", async () => {
    const doc = await makeDocument("image.png", "image/png");
    const s = await makeDocumentMetaSuggestion(doc.id);
    await caller().documents.update({ id: doc.id, status: "discarded" });
    expect((await caller().suggestions.list({ status: "pending" })).map((x) => x.id))
      .not.toContain(s.id);

    await caller().documents.update({ id: doc.id, status: "inbox" });
    expect((await caller().suggestions.list({ status: "pending" })).map((x) => x.id))
      .toContain(s.id);
  });

  it("approveEntry never puts a discarded document back into the record", async () => {
    // suggestEntry snapshots every attachment id into proposed at poll time,
    // and the queue card sends that snapshot back unconditionally. So an entry
    // suggestion — which correctly stays in the queue, it has no documentId of
    // its own — carries the signature logos with it. Approving would link a
    // document Martin already judged junk into entry_documents, where it shows
    // up in entries.get, in the entry's own search body, and in the signed
    // verify.exportRange payload meant for the bewindvoerder.
    const junk = await makeDocument("image.png", "image/png");
    const keep = await makeDocument("Beschikking.pdf", "application/pdf");
    await caller().documents.update({ id: junk.id, status: "discarded" });
    const s = await makeSuggestion();

    const { entryId } = await caller().suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "Beschikking ontvangen", source: "gmail-watch",
        participantPartyIds: [], documentIds: [junk.id, keep.id], actionItems: [] },
    });

    const linked = await db.select().from(schema.entryDocuments)
      .where(eq(schema.entryDocuments.entryId, entryId));
    expect(linked.map((l) => l.documentId)).toEqual([keep.id]);
  });

  it("approveEntry never cites a document that has been purged", async () => {
    // The same class of bug as the discard above, one step worse: an
    // entry_documents row has no DELETE grant, so approving a snapshot whose
    // attachment was definitief verwijderd in the meantime writes a PERMANENT
    // citation of a destroyed file into the ledgered entry, into its search
    // body and into the signed export.
    const gone = await makeDocument("Per ongeluk gescand.pdf", "application/pdf");
    const keep = await makeDocument("Beschikking bewind.pdf", "application/pdf");
    await caller().documents.purge({ id: gone.id, reason: "hoort niet in het dossier" });
    const s = await makeSuggestion();

    const { entryId } = await caller().suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "Stukken ontvangen", source: "gmail-watch",
        participantPartyIds: [], documentIds: [gone.id, keep.id], actionItems: [] },
    });

    const linked = await db.select().from(schema.entryDocuments)
      .where(eq(schema.entryDocuments.entryId, entryId));
    expect(linked.map((l) => l.documentId)).toEqual([keep.id]);
  });

  it("list flags a document request and approving links the picked document to the entry", async () => {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t-doc",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Loonstroken", sentAt: new Date(),
      rawRfc822Sha256: "c".repeat(64), bodyText: "Graag loonstroken opsturen.",
    }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, model: "qwen3.5:9b", promptVersion: "entry-v1",
      proposed: { occurredAt: new Date().toISOString(), channel: "email",
        direction: "inbound", summary: "VerderGroep vraagt loonstroken",
        details: "Juni en juli.", participantNames: ["VerderGroep"],
        actionItems: [{ description: "Loonstroken opsturen", clarity: "clear" }],
        attachmentDocumentIds: [] },
    }).returning();
    const listed = (await caller().suggestions.list({ status: "pending" }))
      .find((row) => row.id === s.id);
    expect(listed?.documentRequest).toBe("Loonstroken opsturen");

    const [doc] = await db.insert(schema.documents).values({
      sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"),
      sizeBytes: 999, mime: "application/pdf", title: "Loonstrook juni",
      source: "upload", receivedAt: new Date(),
    }).returning();
    const { entryId } = await caller().suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "VerderGroep vraagt loonstroken", details: "Juni en juli.",
        source: "gmail-watch", participantPartyIds: [], documentIds: [doc.id],
        actionItems: [{ description: "Loonstroken opsturen", clarity: "clear" }] },
    });
    // The association goes through the existing linking path (insertEntry):
    // an entry_documents row AND the documentId inside the entry.created payload.
    const links = await db.select().from(schema.entryDocuments)
      .where(eq(schema.entryDocuments.entryId, entryId));
    expect(links.map((l) => l.documentId)).toContain(doc.id);
    const [ev] = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.entityId, entryId),
        eq(schema.ledgerEvents.eventType, "entry.created")));
    expect(ev).toBeTruthy();
    // ledger_events stores payload_hash, never the payload itself, so "the
    // documentId is inside the entry.created payload" is asserted the way
    // verification.ts asserts it: rebuild the canonical payload from the live
    // rows and check it against the recorded hash.
    const [entry] = await db.select().from(schema.logEntries)
      .where(eq(schema.logEntries.id, entryId));
    const items = await db.select().from(schema.actionItems)
      .where(eq(schema.actionItems.entryId, entryId));
    const payload = entryEventPayload({
      id: entry.id, occurredAt: entry.occurredAt,
      channel: entry.channel, direction: entry.direction,
      summary: entry.summary, details: entry.details,
      source: entry.source, sourceRef: entry.sourceRef,
      supersedesId: entry.supersedesId,
      participantPartyIds: [],
      documentIds: links.map((l) => l.documentId),
      actionItems: items.map((a) => ({ description: a.description,
        ownerPartyId: a.ownerPartyId, dueAt: a.dueAt, clarity: a.clarity })),
    });
    expect(payload.documentIds).toContain(doc.id);
    expect(sha256Hex(canonicalJson(payload))).toBe(ev.payloadHash);
  });
});
