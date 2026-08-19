import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

const sha = (seed: string) =>
  seed.repeat(64).slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, "0");

describe("tasks router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `tasks${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("create → list shows effectiveStatus open and assignee name", async () => {
    const c = caller();
    const party = await c.parties.create({
      kind: "organization", name: `VerderGroep ${Date.now()}` });
    const task = await c.tasks.create({
      title: "Kopie paspoort opsturen", details: "Gevraagd per mail",
      assigneePartyId: party.id });
    expect(task.id).toBeTruthy();
    expect(task.createdBy).toBe(userId);
    const bare = await c.tasks.create({ title: "Zonder assignee" });
    const list = await c.tasks.list({});
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(task.id)).toMatchObject({
      effectiveStatus: "open", assigneeName: party.name,
      title: "Kopie paspoort opsturen",
    });
    expect(byId.get(bare.id)).toMatchObject({ effectiveStatus: "open", assigneeName: null });
  });

  it("setStatus walks open→in-progress→waiting→done and records an override", async () => {
    const c = caller();
    const task = await c.tasks.create({ title: "Statuswandeling" });
    const a = await c.tasks.setStatus({ taskId: task.id, status: "in-progress" });
    expect(a.status).toBe("in-progress");
    expect(a.createdBy).toBe(userId);
    await c.tasks.setStatus({ taskId: task.id, status: "waiting", note: "Wacht op VerderGroep" });
    await c.tasks.setStatus({ taskId: task.id, status: "done" });
    // done is terminal: reopening needs an override, which is then recorded
    await expect(c.tasks.setStatus({ taskId: task.id, status: "open" }))
      .rejects.toThrow(/transition/i);
    const reopened = await c.tasks.setStatus({ taskId: task.id, status: "open",
      overrideReason: "Toch niet af — document werd afgekeurd." });
    expect(reopened.overrideReason).toBe("Toch niet af — document werd afgekeurd.");
    const got = await c.tasks.get({ id: task.id });
    expect(got.effectiveStatus).toBe("open");
    // timeline newest first, seq-ordered
    expect(got.statusTimeline.map((s) => s.status))
      .toEqual(["open", "done", "waiting", "in-progress"]);
    expect(got.statusTimeline[2].note).toBe("Wacht op VerderGroep");
  });

  it("setStatus rejects garbage statuses before they reach the ledger", async () => {
    const c = caller();
    const task = await c.tasks.create({ title: "Vuilnisstatus" });
    await expect(c.tasks.setStatus({
      // @ts-expect-error — deliberately outside the enum
      taskId: task.id, status: "constructor", overrideReason: "smokkel",
    })).rejects.toThrow();
    const got = await c.tasks.get({ id: task.id });
    expect(got.statusTimeline).toHaveLength(0);
  });

  it("get returns linked evidence summaries (id + title/name only)", async () => {
    const c = caller();
    const party = await c.parties.create({ kind: "organization", name: `Eneco ${Date.now()}` });
    const entry = await c.entries.create({
      occurredAt: new Date("2026-08-15T10:00:00Z"), channel: "email",
      direction: "inbound", summary: "Afspraak: paspoort opsturen",
      participantPartyIds: [party.id], actionItems: [], documentIds: [],
    });
    const item = await c.registry.items.create({
      name: "Eneco", category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    });
    const debt = await c.registry.debts.create({
      creditorName: "Incasso Z", claimedCents: 5000 });
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha(`${Date.now()}t`), title: "Paspoortkopie",
      mime: "application/pdf", sizeBytes: 99, source: "upload",
      receivedAt: new Date(),
    }).returning();
    const task = await c.tasks.create({
      title: "Volledig gelinkt", entryId: entry.id, financialItemId: item.id,
      debtId: debt.id, documentId: doc.id, assigneePartyId: party.id,
    });
    const got = await c.tasks.get({ id: task.id });
    expect(got.effectiveStatus).toBe("open");
    expect(got.assigneeName).toBe(party.name);
    expect(got.linked.entry).toEqual({ id: entry.id, summary: "Afspraak: paspoort opsturen" });
    expect(got.linked.financialItem).toEqual({ id: item.id, name: "Eneco" });
    expect(got.linked.debt).toEqual({ id: debt.id, creditorName: "Incasso Z" });
    expect(got.linked.document).toEqual({ id: doc.id, title: "Paspoortkopie" });
    // unlinked task → all null, no crash
    const lone = await c.tasks.create({ title: "Zonder links" });
    const loneGot = await c.tasks.get({ id: lone.id });
    expect(loneGot.linked).toEqual({
      entry: null, financialItem: null, debt: null, document: null });
  });

  it("get on a nonexistent id throws NOT_FOUND", async () => {
    await expect(caller().tasks.get({ id: "00000000-0000-0000-0000-000000000000" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("update edits fact fields; nonexistent id throws NOT_FOUND", async () => {
    const c = caller();
    const task = await c.tasks.create({ title: "Tikfout", dueAt: new Date("2026-09-01T00:00:00Z") });
    const updated = await c.tasks.update({ id: task.id, title: "Typo hersteld", details: "nu goed" });
    expect(updated.title).toBe("Typo hersteld");
    expect(updated.details).toBe("nu goed");
    // untouched fields survive
    expect(updated.dueAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    await expect(c.tasks.update({
      id: "00000000-0000-0000-0000-000000000000", title: "spook",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("list filters map to effective-status sets", async () => {
    const c = caller();
    const open = await c.tasks.create({ title: "F-open" });
    const inProgress = await c.tasks.create({ title: "F-inprogress" });
    await c.tasks.setStatus({ taskId: inProgress.id, status: "in-progress" });
    const waiting = await c.tasks.create({ title: "F-waiting" });
    await c.tasks.setStatus({ taskId: waiting.id, status: "waiting" });
    const done = await c.tasks.create({ title: "F-done" });
    await c.tasks.setStatus({ taskId: done.id, status: "done" });
    const dropped = await c.tasks.create({ title: "F-dropped" });
    await c.tasks.setStatus({ taskId: dropped.id, status: "dropped" });
    const mine = [open.id, inProgress.id, waiting.id, done.id, dropped.id];
    const pick = (rows: { id: string }[]) =>
      rows.map((r) => r.id).filter((id) => mine.includes(id)).sort();

    expect(pick(await c.tasks.list({ filter: "open" })))
      .toEqual([open.id, inProgress.id].sort());
    expect(pick(await c.tasks.list({ filter: "waiting" }))).toEqual([waiting.id]);
    expect(pick(await c.tasks.list({ filter: "done" })))
      .toEqual([done.id, dropped.id].sort());
    // no filter → everything
    expect(pick(await c.tasks.list({}))).toEqual([...mine].sort());
  });

  it("list orders non-done first, then dueAt asc with nulls last, then createdAt", async () => {
    const c = caller();
    // created deliberately out of due-date order
    const dueLater = await c.tasks.create({
      title: "O-later", dueAt: new Date("2026-12-01T00:00:00Z") });
    const noDueA = await c.tasks.create({ title: "O-nodue-a" });
    const dueSoon = await c.tasks.create({
      title: "O-soon", dueAt: new Date("2026-08-20T00:00:00Z") });
    const doneTask = await c.tasks.create({
      title: "O-done", dueAt: new Date("2026-01-01T00:00:00Z") });
    await c.tasks.setStatus({ taskId: doneTask.id, status: "done" });
    const noDueB = await c.tasks.create({ title: "O-nodue-b" });
    const mine = new Set([dueLater.id, noDueA.id, dueSoon.id, doneTask.id, noDueB.id]);
    const ordered = (await c.tasks.list({}))
      .map((r) => r.id).filter((id) => mine.has(id));
    // done last despite the earliest dueAt; null dues after dated ones,
    // tie between the two null-due tasks broken by creation order
    expect(ordered).toEqual([dueSoon.id, dueLater.id, noDueA.id, noDueB.id, doneTask.id]);
  });

  it("stats counts open, overdue and waiting-on-others (deltas only — shared DB)", async () => {
    const c = caller();
    const before = await c.tasks.stats();
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await c.tasks.create({ title: "S-open-future", dueAt: future });   // open
    await c.tasks.create({ title: "S-open-overdue", dueAt: past });    // open + overdue
    const waiting = await c.tasks.create({ title: "S-waiting-overdue", dueAt: past });
    await c.tasks.setStatus({ taskId: waiting.id, status: "waiting" }); // open + overdue + waiting
    const doneTask = await c.tasks.create({ title: "S-done-past-due", dueAt: past });
    await c.tasks.setStatus({ taskId: doneTask.id, status: "done" });  // counts nowhere
    const after = await c.tasks.stats();
    expect(after.openCount - before.openCount).toBe(3);
    expect(after.overdueCount - before.overdueCount).toBe(2);
    expect(after.waitingOnOthersCount - before.waitingOnOthersCount).toBe(1);
  });

  it("validNext lists allowed next statuses; unknown from → empty, not a crash", async () => {
    const c = caller();
    expect((await c.tasks.validNext({ from: "open" })).sort())
      .toEqual(["done", "dropped", "in-progress", "waiting"]);
    expect((await c.tasks.validNext({ from: "waiting" })).sort())
      .toEqual(["done", "dropped", "in-progress"]);
    expect(await c.tasks.validNext({ from: "done" })).toEqual([]);
    expect(await c.tasks.validNext({ from: "dropped" })).toEqual([]);
    expect(await c.tasks.validNext({ from: "constructor" })).toEqual([]);
  });

  it("rejects unauthenticated calls", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.tasks.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.tasks.stats()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
