import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

// Runs as verder_app, the role the phone's routes meet in production. Every
// test is ONE transaction that is ROLLED BACK at the end: the shared dev
// database is never truncated, and a rolled-back fixture document can never
// grow pendingDocMeta's backlog. The router's own transactions nest as
// savepoints inside it.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(APP_URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db, f: Fixture) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await fn(db, await fixture(db));
      throw new Rollback();
    });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function doc(db: Db, title: string, partyId?: string) {
  const [d] = await db.insert(schema.documents).values({
    sha256: (uid() + uid()).replaceAll("-", ""), title, mime: "application/pdf", sizeBytes: 1234,
    source: "upload", sourceRef: `proposals-test-${uid()}`, receivedAt: new Date("2026-10-30T09:00:00Z"),
    partyId,
  }).returning();
  return d;
}

async function fixture(db: Db) {
  const [u] = await db.insert(schema.users)
    .values({ email: `proposals-${uid()}@test.local`, name: "Martin" }).returning();
  const addr = `opstart-${uid()}@verdergroep.nl`;
  const [party] = await db.insert(schema.parties)
    .values({ kind: "organization", name: `Team Opstart Testfixture ${uid()}`, email: addr }).returning();
  const [debt] = await db.insert(schema.debts)
    .values({ creditorName: `PLM Testfixture ${uid()}`, claimedCents: 12345 }).returning();
  const [task] = await db.insert(schema.tasks)
    .values({ title: `Loonstroken aanleveren ${uid()}`, createdBy: u.id }).returning();
  const [outsideTask] = await db.insert(schema.tasks)
    .values({ title: `Niet in de context ${uid()}`, createdBy: u.id }).returning();
  const attach = await doc(db, "Loonstrook september.pdf");
  const second = await doc(db, "Loonstrook augustus.pdf");
  const notOffered = await doc(db, "Paspoort.pdf");
  const context = {
    trigger: { type: "email", id: uid(), label: "Informatie over uw dossier" },
    thread: [],
    party: { type: "party", id: party.id, label: party.name },
    parentParty: null,
    entries: [],
    debts: [{ type: "debt", id: debt.id, label: debt.creditorName }],
    tasks: [{ type: "task", id: task.id, label: task.title, status: "open" }],
    stops: [],
    kb: [],
    sentDocuments: [],
    attachable: [
      { type: "document", id: attach.id, label: "Loonstrook september.pdf" },
      { type: "document", id: second.id, label: "Loonstrook augustus.pdf" },
    ],
    addresses: [addr, "demi@verdergroep.nl"],
    threadKey: null, gmailThreadId: null,
    reply: { subject: "Re: Informatie over uw dossier" },
  };
  return { user: u, addr, party, debt, task, outsideTask, attach, second, notOffered, context };
}

function replyPayload(f: Fixture) {
  return {
    ask: "Loonstrook oktober aanleveren", dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
    entrySummary: "Loonstroken gestuurd aan Team Opstart",
    reply: {
      to: [f.addr], cc: [], subject: "Re: Informatie over uw dossier",
      body: "Beste Team Opstart,\n\nHierbij de loonstroken.\n\nMet vriendelijke groet,\nMartin van der Poel",
      attachmentDocumentIds: [f.attach.id, f.second.id],
    },
    task: { title: `Loonstrook oktober opvragen ${uid()}`, dueAt: "2026-11-05" },
    question: null,
    reliedOn: [{ type: "document", id: f.attach.id, why: "de gevraagde loonstrook" }],
  };
}

function questionPayload(f: Fixture, options?: unknown[]) {
  return {
    ask: "Is de taak klaar?", dueAt: null, missing: [], entrySummary: "Vraag beantwoord",
    reply: null, task: null,
    question: {
      prompt: "Wat moet er gebeuren?",
      options: options ?? [
        { action: "set-task-status", taskId: f.task.id, status: "done", label: "Taak afronden" },
        { action: "link-document-to-debt", documentId: f.attach.id, debtId: f.debt.id, label: "Koppelen" },
        { action: "create-task", title: "Bellen met Verder", dueAt: "2026-11-07", label: "Taak maken" },
        { action: "none", label: "Niets doen" },
      ],
    },
    reliedOn: [],
  };
}

async function proposal(db: Db, f: Fixture, o: {
  kind?: string; status?: string; payload?: unknown; trigger?: Record<string, unknown>;
  senderGuess?: unknown; partyId?: string | null; context?: unknown;
} = {}) {
  const [p] = await db.insert(schema.proposals).values({
    kind: o.kind ?? "reply", status: o.status ?? "pending", priority: "verder",
    ...(o.trigger ?? { triggerExternal: { gmailId: `g-${uid()}`, threadId: "x", messageId: null,
      from: f.addr, to: "martin@vanderpoel.pro", subject: "Informatie over uw dossier",
      date: "2026-10-30T09:00:00Z", body: "Wilt u uw loonstroken sturen?" } }),
    partyId: o.partyId === undefined ? f.party.id : o.partyId,
    senderGuess: o.senderGuess ?? null,
    context: o.context ?? f.context, prompt: "the prompt", model: "claude-cli test",
    promptVersion: "reply-v1", modelOutput: "{\"raw\":\"model answer\"}",
    payload: o.payload ?? replyPayload(f),
  }).returning();
  return p;
}

const caller = (db: Db, userId: string) => appRouter.createCaller(createContext({ db, userId }));
const row = async (db: Db, id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0];

function approveInput(f: Fixture, id: string, over: Record<string, unknown> = {}, revision = 1) {
  const r = replyPayload(f).reply;
  return { id, revision, payload: { ...r, entrySummary: "Loonstroken gestuurd aan Team Opstart", ...over } };
}

/** Ledger events about this proposal or any of the fixture's rows, or about a
 *  log entry carrying this proposal's source_ref (what a send would write). */
async function eventsTouching(db: Db, ids: string[], proposalId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents)
    .where(sql`${schema.ledgerEvents.entityId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      OR ${schema.ledgerEvents.entityId} IN (SELECT id FROM log_entries WHERE source_ref = ${`proposal:${proposalId}`})`);
  return n;
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof TRPCError ? e.code : String(e)));

describe("proposals router", () => {
  it("approve is refused once decided", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const c = caller(db, f.user.id);
    const res = await c.proposals.approve(approveInput(f, p.id));
    expect(res.status).toBe("approved");
    // A retried POST carrying the original revision, and one carrying the new one.
    expect(await code(c.proposals.approve(approveInput(f, p.id)))).toBe("CONFLICT");
    expect(await code(c.proposals.approve(approveInput(f, p.id, {}, res.revision)))).toBe("CONFLICT");
    expect(await code(c.proposals.reject({ id: p.id }))).toBe("CONFLICT");
    expect((await row(db, p.id)).status).toBe("approved");
  }));

  it("stale revision is 409", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const c = caller(db, f.user.id);
    expect(await code(c.proposals.approve(approveInput(f, p.id, {}, 2)))).toBe("CONFLICT");
    expect((await row(db, p.id)).status).toBe("pending");
  }));

  it("approve with the model's text untouched is verdict approved", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const res = await caller(db, f.user.id).proposals.approve(approveInput(f, p.id));
    expect(res.verdict).toBe("approved");
    const after = await row(db, p.id);
    expect(after.verdict).toBe("approved");
    expect(after.diff).toEqual({ fields: [], body: null });
  }));

  it("approve records verdict edited and the diff", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const body = "Beste Team Opstart,\n\nHierbij de loonstrook van september.\n\nMet vriendelijke groet,\nMartin van der Poel";
    await caller(db, f.user.id).proposals.approve(approveInput(f, p.id, {
      body, attachmentDocumentIds: [f.attach.id], entrySummary: "Loonstrook september gestuurd",
    }));
    const after = await row(db, p.id);
    expect(after.status).toBe("approved");
    expect(after.verdict).toBe("edited");
    expect(after.decidedBy).toBe(f.user.id);
    expect(after.decidedAt).toBeInstanceOf(Date);
    expect(after.revision).toBe(2);
    const diff = after.diff as { fields: string[]; body: string | null };
    expect(diff.fields).toEqual(["body", "attachmentDocumentIds", "entrySummary"]);
    expect(diff.body).toContain("+Hierbij de loonstrook van september.");
    expect(diff.body).toContain("-Hierbij de loonstroken.");
    expect(after.finalPayload).toMatchObject({
      body, attachmentDocumentIds: [f.attach.id], entrySummary: "Loonstrook september gestuurd",
    });
  }));

  it("approve refuses a purged attachment", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    await db.insert(schema.documentPurges).values({
      documentId: f.second.id, sha256: f.second.sha256, sizeBytes: 1234, createdBy: f.user.id });
    expect(await code(caller(db, f.user.id).proposals.approve(approveInput(f, p.id)))).toBe("BAD_REQUEST");
    expect((await row(db, p.id)).status).toBe("pending");
  }));

  it("approve refuses a discarded attachment", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    await db.insert(schema.documentStatusChanges).values({ documentId: f.second.id, status: "discarded" });
    expect(await code(caller(db, f.user.id).proposals.approve(approveInput(f, p.id)))).toBe("BAD_REQUEST");
  }));

  it("approve refuses an attachment not offered in context", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const res = code(caller(db, f.user.id).proposals.approve(approveInput(f, p.id, {
      attachmentDocumentIds: [f.attach.id, f.notOffered.id] })));
    expect(await res).toBe("BAD_REQUEST");
    expect((await row(db, p.id)).status).toBe("pending");
  }));

  it("approve refuses a recipient not in context", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const c = caller(db, f.user.id);
    expect(await code(c.proposals.approve(approveInput(f, p.id, { to: ["attacker@evil.tld"] })))).toBe("BAD_REQUEST");
    expect(await code(c.proposals.approve(approveInput(f, p.id, { cc: ["attacker@evil.tld"] })))).toBe("BAD_REQUEST");
    // Case is not a difference: the context stores addresses lowercased.
    const ok = await c.proposals.approve(approveInput(f, p.id, { to: [f.addr.toUpperCase()] }));
    expect(ok.status).toBe("approved");
  }));

  it("approve refuses a question", () => isolated(async (db, f) => {
    const p = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    expect(await code(caller(db, f.user.id).proposals.approve(approveInput(f, p.id)))).toBe("BAD_REQUEST");
  }));

  it("approve appends no ledger event", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const ids = [p.id, f.attach.id, f.second.id, f.party.id];
    const before = await eventsTouching(db, ids, p.id);
    await caller(db, f.user.id).proposals.approve(approveInput(f, p.id));
    expect(await eventsTouching(db, ids, p.id)).toBe(before);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.logEntries)
      .where(eq(schema.logEntries.sourceRef, `proposal:${p.id}`));
    expect(n).toBe(0);
  }));

  it("reject keeps model_output", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    await caller(db, f.user.id).proposals.reject({ id: p.id, reason: "klopt niet" });
    const after = await row(db, p.id);
    expect(after).toMatchObject({
      status: "rejected", verdict: "rejected", rejectReason: "klopt niet",
      modelOutput: "{\"raw\":\"model answer\"}", decidedBy: f.user.id,
    });
    expect(after.payload).toEqual(p.payload);
  }));

  it("answer runs tasks.setStatus and appends exactly one task.status event", () => isolated(async (db, f) => {
    const p = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    const taskEvents = async () => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEvents)
        .innerJoin(schema.taskStatusChanges, eq(schema.taskStatusChanges.id, schema.ledgerEvents.entityId))
        .where(and(eq(schema.ledgerEvents.eventType, "task.status"), eq(schema.taskStatusChanges.taskId, f.task.id)));
      return n;
    };
    expect(await taskEvents()).toBe(0);
    const res = await caller(db, f.user.id).proposals.answer({ id: p.id, revision: 1, option: 0 });
    expect(res.status).toBe("sent");
    expect(await taskEvents()).toBe(1);
    const [change] = await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, f.task.id));
    expect(change).toMatchObject({ status: "done", createdBy: f.user.id });
    const after = await row(db, p.id);
    expect(after).toMatchObject({ status: "sent", verdict: "approved", decidedBy: f.user.id });
    expect(after.finalPayload).toMatchObject({ answer: { option: 0, action: "set-task-status" } });
    // A second answer is refused: the question is closed.
    expect(await code(caller(db, f.user.id).proposals.answer({ id: p.id, revision: 2, option: 3 }))).toBe("CONFLICT");
    expect(await taskEvents()).toBe(1);
  }));

  it("answer links a document to a debt and creates a task through the existing procedures", () => isolated(async (db, f) => {
    const link = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    await caller(db, f.user.id).proposals.answer({ id: link.id, revision: 1, option: 1 });
    const links = await db.select().from(schema.debtDocuments)
      .where(and(eq(schema.debtDocuments.debtId, f.debt.id), eq(schema.debtDocuments.documentId, f.attach.id)));
    expect(links).toHaveLength(1);

    const create = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    const res = await caller(db, f.user.id).proposals.answer({ id: create.id, revision: 1, option: 2 });
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, res.taskId!));
    expect(t).toMatchObject({ title: "Bellen met Verder", createdBy: f.user.id });
  }));

  it("answer with free text records it and runs nothing", () => isolated(async (db, f) => {
    const p = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    await caller(db, f.user.id).proposals.answer({ id: p.id, revision: 1, freeText: "Ik bel ze zelf" });
    const after = await row(db, p.id);
    expect(after).toMatchObject({ status: "sent", verdict: "edited", finalPayload: { answer: { freeText: "Ik bel ze zelf" } } });
    expect(await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, f.task.id))).toHaveLength(0);
  }));

  it("answer refuses an option whose target was not validated", () => isolated(async (db, f) => {
    // (1) A stored option naming a task the context never offered.
    const forged = await proposal(db, f, { kind: "question", payload: questionPayload(f, [
      { action: "set-task-status", taskId: f.outsideTask.id, status: "done", label: "Afronden" },
      { action: "none", label: "Niets" },
    ]) });
    const c = caller(db, f.user.id);
    expect(await code(c.proposals.answer({ id: forged.id, revision: 1, option: 0 }))).toBe("BAD_REQUEST");
    // (2) A link to a debt outside the context.
    const [otherDebt] = await db.insert(schema.debts).values({ creditorName: `Ander ${uid()}` }).returning();
    const forgedDebt = await proposal(db, f, { kind: "question", payload: questionPayload(f, [
      { action: "link-document-to-debt", documentId: f.attach.id, debtId: otherDebt.id, label: "Koppelen" },
      { action: "none", label: "Niets" },
    ]) });
    expect(await code(c.proposals.answer({ id: forgedDebt.id, revision: 1, option: 0 }))).toBe("BAD_REQUEST");
    // (3) A validated option whose transition is no longer valid: the task was
    // finished in the meantime, and done → done is not a move.
    const stale = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    await c.tasks.setStatus({ taskId: f.task.id, status: "done" });
    expect(await code(c.proposals.answer({ id: stale.id, revision: 1, option: 0 }))).toBe("BAD_REQUEST");
    // (4) An option index the question does not have.
    expect(await code(c.proposals.answer({ id: stale.id, revision: 1, option: 9 }))).toBe("BAD_REQUEST");
    for (const p of [forged, forgedDebt, stale]) expect((await row(db, p.id)).status).toBe("pending");
    expect(await db.select().from(schema.taskStatusChanges)
      .where(eq(schema.taskStatusChanges.taskId, f.outsideTask.id))).toHaveLength(0);
    expect(await db.select().from(schema.debtDocuments)
      .where(eq(schema.debtDocuments.debtId, otherDebt.id))).toHaveLength(0);
  }));

  it("answer refuses a reply", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    expect(await code(caller(db, f.user.id).proposals.answer({ id: p.id, revision: 1, option: 0 }))).toBe("BAD_REQUEST");
  }));

  it("get returns dueAt and missing", () => isolated(async (db, f) => {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `prop-${uid()}`, gmailThreadId: `t-${uid()}`,
      fromAddr: `Team Opstart <${f.addr}>`, toAddr: "martin@vanderpoel.pro",
      subject: "Informatie over uw dossier", sentAt: new Date("2026-10-30T09:00:00Z"),
      rawRfc822Sha256: "0".repeat(64), bodyText: "Beste Martin,\n\nWilt u uw loonstroken sturen?", source: "gmail",
    }).returning();
    const p = await proposal(db, f, { trigger: { triggerRawEmailId: raw.id } });
    await db.insert(schema.documentPurges).values({
      documentId: f.second.id, sha256: f.second.sha256, sizeBytes: 1234, createdBy: f.user.id });
    const g = await caller(db, f.user.id).proposals.get({ id: p.id });
    expect(g).toMatchObject({
      id: p.id, kind: "reply", status: "pending", priority: "verder", revision: 1,
      ask: "Loonstrook oktober aanleveren", partyName: f.party.name,
      dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
      entrySummary: "Loonstroken gestuurd aan Team Opstart",
      senderUnconfirmed: false,
      trigger: { type: "email", id: raw.id, subject: "Informatie over uw dossier" },
    });
    expect(g.trigger.excerpt).toContain("loonstroken");
    expect(g.trigger.date).toEqual(raw.sentAt);
    expect(g.proposedTask).toEqual({ title: (p.payload as { task: { title: string } }).task.title, dueAt: "2026-11-05" });
    expect(g.reliedOn).toEqual([{ type: "document", id: f.attach.id, label: "Loonstrook september.pdf", why: "de gevraagde loonstrook" }]);
    expect(g.attachments).toEqual([
      { id: f.attach.id, title: "Loonstrook september.pdf", sizeBytes: 1234, unavailable: false },
      { id: f.second.id, title: "Loonstrook augustus.pdf", sizeBytes: 1234, unavailable: true },
    ]);
    // The picker offers only what approve would accept.
    expect(g.attachable).toEqual([{ id: f.attach.id, title: "Loonstrook september.pdf" }]);
    expect(g.options).toEqual([]);
    expect(g.payload).toMatchObject({ reply: { to: [f.addr] } });
  }));

  it("get renders a Dutch target for every option from the validated ids", () => isolated(async (db, f) => {
    const p = await proposal(db, f, { kind: "question", payload: questionPayload(f) });
    const g = await caller(db, f.user.id).proposals.get({ id: p.id });
    expect(g.options).toEqual([
      { index: 0, action: "set-task-status", label: "Taak afronden", target: `Taak '${f.task.title}' → klaar` },
      { index: 1, action: "link-document-to-debt", label: "Koppelen",
        target: `Document 'Loonstrook september.pdf' koppelen aan vordering ${f.debt.creditorName}` },
      { index: 2, action: "create-task", label: "Taak maken", target: "Nieuwe taak 'Bellen met Verder', uiterlijk 7-11" },
      { index: 3, action: "none", label: "Niets doen", target: "Geen actie" },
    ]);
  }));

  it("a letter's sender is unconfirmed until the filing names the guessed party", () => isolated(async (db, f) => {
    const letter = await doc(db, "Brief PLM.pdf");
    const p = await proposal(db, f, {
      trigger: { triggerDocumentId: letter.id }, partyId: f.party.id,
      senderGuess: { kind: "creditor", partyId: f.party.id },
    });
    const c = caller(db, f.user.id);
    const before = await c.proposals.get({ id: p.id });
    expect(before.senderUnconfirmed).toBe(true);
    expect(before.trigger).toMatchObject({ type: "document", id: letter.id, subject: "Brief PLM.pdf" });
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: letter.id, status: "filed", partyId: f.party.id });
    expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(false);
  }));

  it("a Verder letter is confirmed only when filed under a party on Verder's addresses", () => isolated(async (db, f) => {
    const letter = await doc(db, "Brief Verder.pdf");
    const p = await proposal(db, f, {
      trigger: { triggerDocumentId: letter.id }, partyId: null, senderGuess: { kind: "verder" },
    });
    const c = caller(db, f.user.id);
    expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(true);
    const [other] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `Ander ${uid()}`, email: `x-${uid()}@elders.nl` }).returning();
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: letter.id, status: "filed", partyId: other.id });
    expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(true);
    await db.insert(schema.documentStatusChanges)
      .values({ documentId: letter.id, status: "filed", partyId: f.party.id, createdAt: new Date(Date.now() + 1000) });
    expect((await c.proposals.get({ id: p.id })).senderUnconfirmed).toBe(false);
  }));

  it("list shows pending and recent in-flight proposals, never decided ones", () => isolated(async (db, f) => {
    const pending = await proposal(db, f);
    const rejected = await proposal(db, f, { status: "rejected" });
    const drafting = await proposal(db, f, { status: "drafting" });
    const failed = await proposal(db, f, { status: "failed" });
    const [oldFailed] = await db.update(schema.proposals)
      .set({ updatedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) })
      .where(eq(schema.proposals.id, (await proposal(db, f, { status: "failed" })).id)).returning();
    const list = await caller(db, f.user.id).proposals.list();
    const ids = list.map((p) => p.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(failed.id);
    for (const gone of [rejected.id, drafting.id, oldFailed.id]) expect(ids).not.toContain(gone);
    expect(list.find((p) => p.id === pending.id)).toMatchObject({
      kind: "reply", status: "pending", priority: "verder", ask: "Loonstrook oktober aanleveren",
      partyName: f.party.name, triggerAt: new Date("2026-10-30T09:00:00Z"),
    });
    expect(ids.indexOf(pending.id)).toBeLessThan(ids.indexOf(failed.id));
  }));

  it("proposed task is created only on Martin's tap", () => isolated(async (db, f) => {
    const p = await proposal(db, f);
    const title = (p.payload as { task: { title: string } }).task.title;
    const count = async () => (await db.select().from(schema.tasks).where(eq(schema.tasks.title, title))).length;
    const c = caller(db, f.user.id);
    expect(await count()).toBe(0); // not on drafting
    await c.proposals.approve(approveInput(f, p.id));
    expect(await count()).toBe(0); // not on approve
    const first = await c.proposals.createProposedTask({ id: p.id });
    expect(first.created).toBe(true);
    expect(await count()).toBe(1);
    expect((await row(db, p.id)).createdTaskId).toBe(first.taskId);
    const second = await c.proposals.createProposedTask({ id: p.id });
    expect(second).toEqual({ taskId: first.taskId, created: false });
    expect(await count()).toBe(1);
  }));

  it("needs a signed-in user", () => isolated(async (db) => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    expect(await code(anon.proposals.list())).toBe("UNAUTHORIZED");
  }));

  it("an unknown id is NOT_FOUND", () => isolated(async (db, f) => {
    expect(await code(caller(db, f.user.id).proposals.get({ id: uid() }))).toBe("NOT_FOUND");
  }));
});
