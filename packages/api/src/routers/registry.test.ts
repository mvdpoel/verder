import { beforeAll, describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
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

  it("exportReport: items with provider name + latest explanation, debts, head hash", async () => {
    const c = caller();
    const party = await c.parties.create({ kind: "organization", name: `Eneco NV ${Date.now()}` });
    const item = await c.registry.items.create(itemInput({
      name: "Export-Eneco", amountCents: 14280, providerPartyId: party.id }));
    await c.registry.decide({ financialItemId: item.id, status: "mandatory",
      explanation: "Energie is een basisvoorziening." });
    const plain = await c.registry.items.create(itemInput({
      name: "Export-Plain", amountCents: 1200, billingCycle: "quarterly" }));
    const debt = await c.registry.debts.create({
      creditorName: "Export-Incasso", claimedCents: 123400 });
    await c.registry.decide({ debtId: debt.id, status: "acknowledged",
      explanation: "Vordering komt overeen met de facturen." });

    const report = await c.registry.exportReport();
    expect(new Date(report.generatedAt).getTime()).not.toBeNaN();
    const [head] = await db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    expect(report.headHash).toBe(head.eventHash);

    const decided = report.items.find((r) => r.id === item.id);
    expect(decided).toMatchObject({
      name: "Export-Eneco", providerName: party.name, status: "mandatory",
      amountCents: 14280, billingCycle: "monthly", monthlyCents: 14280,
      latestExplanation: "Energie is een basisvoorziening.",
    });
    const undecided = report.items.find((r) => r.id === plain.id);
    expect(undecided).toMatchObject({
      status: "identified", providerName: null, latestExplanation: null,
      monthlyCents: 400,
    });
    const debtRow = report.debts.find((r) => r.id === debt.id);
    expect(debtRow).toMatchObject({
      creditorName: "Export-Incasso", claimedCents: 123400, status: "acknowledged",
    });
  });

  it("items.get returns live blockingTasks that clear when tasks complete", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Blocked-Item" }));
    const other = await c.registry.items.create(itemInput({ name: "Other-Item" }));
    const blocking = await c.tasks.create({
      title: "Migrate mailbox", financialItemId: item.id,
      dueAt: new Date("2026-09-01T00:00:00Z"),
    });
    const dropped = await c.tasks.create({ title: "Old idea", financialItemId: item.id });
    const otherTask = await c.tasks.create({ title: "Unrelated", financialItemId: other.id });
    await c.tasks.create({ title: "No link at all" });

    // open + dropped-later task both block while open; dueAt-first ordering
    let got = await c.registry.items.get({ id: item.id });
    expect(got.blockingTasks).toEqual([
      { id: blocking.id, title: "Migrate mailbox", effectiveStatus: "open",
        dueAt: new Date("2026-09-01T00:00:00Z") },
      { id: dropped.id, title: "Old idea", effectiveStatus: "open", dueAt: null },
    ]);

    // dropped tasks stop blocking; in-progress stays live with its new status
    await c.tasks.setStatus({ taskId: dropped.id, status: "dropped" });
    await c.tasks.setStatus({ taskId: blocking.id, status: "in-progress" });
    got = await c.registry.items.get({ id: item.id });
    expect(got.blockingTasks.map((t) => [t.id, t.effectiveStatus]))
      .toEqual([[blocking.id, "in-progress"]]);

    // completing the last blocking task clears the list
    await c.tasks.setStatus({ taskId: blocking.id, status: "done" });
    got = await c.registry.items.get({ id: item.id });
    expect(got.blockingTasks).toEqual([]);

    // the other item's task never bled in — and still blocks its own item
    const otherGot = await c.registry.items.get({ id: other.id });
    expect(otherGot.blockingTasks.map((t) => t.id)).toEqual([otherTask.id]);
  });

  it("a blockerNote without ever-linked tasks is a note, not a clearance", async () => {
    const c = caller();
    const item = await c.registry.items.create(itemInput({ name: "Note-Only" }));
    await c.registry.decide({ financialItemId: item.id, status: "to-cancel",
      explanation: "Can go, but not yet.", blockerNote: "wait for contract end" });
    const got = await c.registry.items.get({ id: item.id });
    expect(got.blockingTasks).toEqual([]);
    // no task was ever linked → nothing was "cleared"
    expect(got.clearedTaskCount).toBe(0);
    const cleared = await c.registry.clearedBlockers();
    expect(cleared.map((b) => b.id)).not.toContain(item.id);
  });

  it("clearedBlockers lists items whose linked tasks all completed, not live-blocked ones", async () => {
    const c = caller();
    // item with a blockerNote whose only linked task is done → cleared
    const clearedItem = await c.registry.items.create(itemInput({ name: "Cleared-Item" }));
    await c.registry.decide({ financialItemId: clearedItem.id, status: "to-cancel",
      explanation: "Cancel after migration.", blockerNote: "migrate mailbox first" });
    const doneTask = await c.tasks.create({
      title: "Migrate mailbox", financialItemId: clearedItem.id });
    await c.tasks.setStatus({ taskId: doneTask.id, status: "done" });
    const got = await c.registry.items.get({ id: clearedItem.id });
    expect(got.blockingTasks).toEqual([]);
    expect(got.clearedTaskCount).toBe(1);

    // item with a blockerNote, one done task but one still-open task → not cleared
    const blockedItem = await c.registry.items.create(itemInput({ name: "Still-Blocked" }));
    await c.registry.decide({ financialItemId: blockedItem.id, status: "to-cancel",
      explanation: "Cancel later.", blockerNote: "two steps left" });
    const finished = await c.tasks.create({ title: "Step one", financialItemId: blockedItem.id });
    await c.tasks.setStatus({ taskId: finished.id, status: "done" });
    await c.tasks.create({ title: "Step two", financialItemId: blockedItem.id });

    const cleared = await c.registry.clearedBlockers();
    expect(cleared.find((b) => b.id === clearedItem.id)).toEqual({
      id: clearedItem.id, name: "Cleared-Item", blockerNote: "migrate mailbox first" });
    expect(cleared.map((b) => b.id)).not.toContain(blockedItem.id);
    const blockedGot = await c.registry.items.get({ id: blockedItem.id });
    expect(blockedGot.clearedTaskCount).toBe(1);
    expect(blockedGot.blockingTasks).toHaveLength(1);

    // a NEWER decision without a blockerNote supersedes the note → nudge gone
    await c.registry.decide({ financialItemId: clearedItem.id, status: "canceled",
      explanation: "Migration done, cancellation sent." });
    const afterDecide = await c.registry.clearedBlockers();
    expect(afterDecide.map((b) => b.id)).not.toContain(clearedItem.id);
  });

  it("rejects unauthenticated calls", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.registry.items.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.registry.stats()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  describe("debt parties and documents", () => {
    it("list() carries the eiser/intermediary/reported projection in one grouped query", async () => {
      // Not the real creditors' names — see the comment below on
      // case-debts.ts's name-based dedup.
      const eiserName = `Wehkamp Testfixture ${crypto.randomUUID()}`;
      const deurwaarderName = `GGN Testfixture ${crypto.randomUUID()}`;
      const c = caller();
      const withParties = await c.registry.debts.create({
        creditorName: eiserName, claimedCents: 45000,
      });
      const eiser = await c.parties.create({ kind: "organization", name: eiserName });
      const deurwaarder = await c.parties.create({ kind: "organization", name: deurwaarderName });
      await c.registry.debts.linkParty({
        debtId: withParties.id, partyId: eiser.id, role: "eiser",
      });
      await c.registry.debts.linkParty({
        debtId: withParties.id, partyId: deurwaarder.id, role: "deurwaarder",
      });
      await c.registry.debts.setReported({
        debtId: withParties.id, reportedAt: new Date("2026-09-01T10:00:00Z"),
      });
      // The empty case matters just as much: a debt with no linked party and
      // not yet reported must render an empty array, never throw or drop the
      // row (this is also the shape of most of the seeded test fixtures).
      const bare = await c.registry.debts.create({
        creditorName: `Bare Testfixture ${crypto.randomUUID()}`, claimedCents: null,
      });

      const list = await c.registry.debts.list();
      const withPartiesRow = list.find((d) => d.id === withParties.id);
      const bareRow = list.find((d) => d.id === bare.id);

      expect(withPartiesRow?.parties.map((p) => [p.role, p.name])).toEqual(
        expect.arrayContaining([
          ["eiser", eiserName],
          ["deurwaarder", deurwaarderName],
        ]));
      expect(withPartiesRow?.reportedToVerderAt).not.toBeNull();
      // list()'s effectiveStatus must still agree with get()'s
      // decisions[0]?.status — the new projection must not disturb it.
      const got = await c.registry.debts.get({ id: withParties.id });
      expect(withPartiesRow?.effectiveStatus).toBe(got.effectiveStatus);

      expect(bareRow?.parties).toEqual([]);
      expect(bareRow?.reportedToVerderAt).toBeNull();
      expect(bareRow?.claimedCents).toBeNull();
    });

    it("returns the creditor and the intermediary with their roles", async () => {
      // Not the real creditors' names: case-debts.ts's applyCaseDebts dedups a
      // debt/party BY NAME, so a fixture literally named "PLM Investments II
      // B.V." or "Trust and Law Incassoservices" would make that seed bind to
      // this test's rows forever, in any dev database this suite has run in.
      const eiserName = `PLM Investments Testfixture ${crypto.randomUUID()}`;
      const incassoName = `Trust and Law Testfixture ${crypto.randomUUID()}`;
      const c = caller();
      const debt = await c.registry.debts.create({
        creditorName: eiserName, claimedCents: 262315,
      });
      const eiser = await c.parties.create({
        kind: "organization", name: eiserName,
      });
      const incasso = await c.parties.create({
        kind: "organization", name: incassoName,
      });
      await c.registry.debts.linkParty({
        debtId: debt.id, partyId: eiser.id, role: "eiser",
      });
      await c.registry.debts.linkParty({
        debtId: debt.id, partyId: incasso.id, role: "incasso",
        note: "Kenmerk 26TNL-001031",
      });

      const got = await c.registry.debts.get({ id: debt.id });
      expect(got.parties.map((p) => [p.role, p.name])).toEqual(
        expect.arrayContaining([
          ["eiser", eiserName],
          ["incasso", incassoName],
        ]));
    });

    it("unlinks a party that was linked to the wrong debt", async () => {
      const c = caller();
      const debt = await c.registry.debts.create({
        creditorName: "Verkeerd", claimedCents: 100,
      });
      const p = await c.parties.create({ kind: "organization", name: "Fout" });
      await c.registry.debts.linkParty({
        debtId: debt.id, partyId: p.id, role: "incasso",
      });
      await c.registry.debts.unlinkParty({
        debtId: debt.id, partyId: p.id, role: "incasso",
      });
      expect((await c.registry.debts.get({ id: debt.id })).parties).toEqual([]);
    });

    it("accepts a debt whose notice stated no total", async () => {
      // Not the real creditor's name — see the comment above on case-debts.ts's
      // name-based dedup.
      const c = caller();
      const debt = await c.registry.debts.create({
        creditorName: `Kamer van Koophandel Testfixture ${crypto.randomUUID()}`,
        claimedCents: null,
      });
      expect((await c.registry.debts.get({ id: debt.id })).claimedCents).toBeNull();
    });

    it("records that Verder was told, and lets it be taken back", async () => {
      const c = caller();
      const debt = await c.registry.debts.create({
        creditorName: `Het CAK Testfixture ${crypto.randomUUID()}`, claimedCents: 114161,
      });
      expect((await c.registry.debts.get({ id: debt.id })).reportedToVerderAt)
        .toBeNull();
      await c.registry.debts.setReported({
        debtId: debt.id, reportedAt: new Date("2026-09-01T10:00:00Z"),
      });
      expect((await c.registry.debts.get({ id: debt.id })).reportedToVerderAt)
        .not.toBeNull();
      // Reversible: marking it by mistake must not be permanent.
      await c.registry.debts.setReported({ debtId: debt.id, reportedAt: null });
      expect((await c.registry.debts.get({ id: debt.id })).reportedToVerderAt)
        .toBeNull();
    });

    it("records the entry it was reported via, and clears it too on undo", async () => {
      const c = caller();
      const debt = await c.registry.debts.create({
        creditorName: `Het CAK Testfixture ${crypto.randomUUID()}`, claimedCents: 114161,
      });
      const entry = await c.entries.create({
        occurredAt: new Date("2026-09-01T10:00:00Z"), channel: "email",
        direction: "outbound", summary: "Schuld aan CAK gemeld bij VerderGroep.",
        participantPartyIds: [], actionItems: [], documentIds: [],
      });
      await c.registry.debts.setReported({
        debtId: debt.id, reportedAt: new Date("2026-09-01T10:00:00Z"),
        entryId: entry.id,
      });
      const reported = await c.registry.debts.get({ id: debt.id });
      expect(reported.reportedToVerderAt).not.toBeNull();
      expect(reported.reportedViaEntryId).toBe(entry.id);
      // Reversible: BOTH halves clear together, or a cleared timestamp would
      // leave a dangling reference to the entry that "told" Verder.
      await c.registry.debts.setReported({ debtId: debt.id, reportedAt: null });
      const cleared = await c.registry.debts.get({ id: debt.id });
      expect(cleared.reportedToVerderAt).toBeNull();
      expect(cleared.reportedViaEntryId).toBeNull();
    });
  });
});
