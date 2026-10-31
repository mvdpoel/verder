import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, gte } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { PROPOSAL_DRAFT_WORKER_NAME } from "@verder/api/src/worker-names";
import type { NotifyFn, NotifyInput } from "../notify/notify";
import { fixtureContext } from "../proposals/draft-fixture";
import { pendingDrafts, promptForDraft } from "./proposals-pending";
import { recordDrafterHeartbeat, storeDraft, storeDrafterFailure } from "./proposals-store";

// Runs as verder_worker, the role `proposals-store` meets in production. Every
// test is a transaction that is ROLLED BACK: the shared dev database is never
// truncated. Nothing is sent: notify is a fake that only records its input.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();
const MODEL = "claude-cli 2.1.0 (Claude Code)";

function fakeNotify() {
  const calls: NotifyInput[] = [];
  const notify: NotifyFn = async (n) => {
    calls.push(n);
    return { notificationId: uid(), duplicate: false, delivered: 1, failed: 0, skipped: 0 };
  };
  return { calls, notify };
}

type Ctx = ReturnType<typeof fixtureContext>;

async function proposal(db: Db, o: { ctx?: Ctx; priority?: string; rawEmail?: boolean; status?: string } = {}) {
  const ctx = o.ctx ?? fixtureContext();
  let triggerRawEmailId: string | undefined;
  if (o.rawEmail) {
    const [r] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `store-${uid()}`, gmailThreadId: `t-${uid()}`,
      fromAddr: `Team Opstart <opstart-${uid()}@verdergroep.nl>`, toAddr: "martin@vanderpoel.pro",
      subject: "Informatie over uw dossier", sentAt: new Date(), rawRfc822Sha256: "0".repeat(64),
      bodyText: "Beste Martin", source: "gmail", messageId: `${uid()}@verdergroep.nl`,
      suggestQueuedAt: new Date(),
    }).returning();
    triggerRawEmailId = r.id;
  }
  const [p] = await db.insert(schema.proposals).values({
    kind: "reply", status: o.status ?? "drafting", priority: o.priority ?? "verder",
    ...(triggerRawEmailId
      ? { triggerRawEmailId }
      : { triggerExternal: { gmailId: `g-${uid()}`, threadId: "x", messageId: null, from: "a", to: "b",
        subject: "s", date: "d", body: "b" } }),
    threadKey: ctx.threadKey, context: ctx, prompt: "the prompt",
  }).returning();
  return { p, ctx, triggerRawEmailId };
}

function replyAnswer(ctx: Ctx) {
  return JSON.stringify({
    ask: "Loonstrook oktober aanleveren", dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
    entrySummary: "Loonstrook september gestuurd",
    reply: {
      to: ["opstart@verdergroep.nl"], cc: [], subject: "Re: Informatie over uw dossier",
      body: "Beste Team Opstart,\n\nMet vriendelijke groet,\nMartin van der Poel",
      attachmentDocumentIds: [ctx.ids.attachment],
    },
    task: { title: "Loonstrook oktober opvragen", dueAt: null }, question: null,
    reliedOn: [{ type: "email", id: ctx.ids.trigger, why: "de vraag" }],
  });
}

function questionAnswer(ctx: Ctx) {
  return JSON.stringify({
    ask: "Aan wie moet dit antwoord?", dueAt: null, missing: [], entrySummary: "Vraag beantwoord",
    reply: null, task: null,
    question: { prompt: "Is de taak klaar?", options: [
      { action: "set-task-status", taskId: ctx.ids.task, status: "done", label: "Ja, klaar" },
      { action: "none", label: "Nee" },
    ] },
    reliedOn: [],
  });
}

const byId = async (db: Db, id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0];

async function runsSince(db: Db, since: Date) {
  return db.select().from(schema.workerRuns)
    .where(and(eq(schema.workerRuns.worker, PROPOSAL_DRAFT_WORKER_NAME), gte(schema.workerRuns.ranAt, since)))
    .orderBy(desc(schema.workerRuns.ranAt));
}

describe("storeDraft", () => {
  it("valid answer moves drafting to pending and notifies once", async () => {
    await isolated(async (db) => {
      const since = new Date((await db.execute<{ now: string }>("select now() as now")).rows[0].now);
      const { p, ctx, triggerRawEmailId } = await proposal(db, { rawEmail: true });
      const fake = fakeNotify();
      const r1 = await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      const r2 = await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      expect(r1.outcome).toBe("pending");
      expect(r2.outcome).toBe("not-drafting");

      const row = await byId(db, p.id);
      expect(row.status).toBe("pending");
      expect(row.kind).toBe("reply");
      expect(row.model).toBe(MODEL);
      expect(row.promptVersion).toBe("reply-v1");
      expect(row.modelOutput).toBe(replyAnswer(ctx));
      expect(row.payload).toMatchObject({
        ask: "Loonstrook oktober aanleveren", dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
        task: { title: "Loonstrook oktober opvragen" },
        reply: { to: ["opstart@verdergroep.nl"], attachmentDocumentIds: [ctx.ids.attachment] },
      });

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({
        kind: "proposal", level: "time-sensitive",
        title: "Voorstel: Loonstrook oktober aanleveren",
        body: "Antwoord klaar voor Team Opstart (Verder). Bekijk en verstuur.",
        link: `verder://proposal/${p.id}`, dedupKey: `proposal:${p.id}`,
        threadId: `mail:${triggerRawEmailId}`, collapseId: `mail:${triggerRawEmailId}`,
      });
      const runs = await runsSince(db, since);
      expect(runs.map((r) => r.status)).toEqual(["ok", "ok"]);
    });
  });

  it("creditor priority is active, and a non-mail trigger carries no collapse id", async () => {
    await isolated(async (db) => {
      const { p, ctx } = await proposal(db, { priority: "creditor" });
      const fake = fakeNotify();
      await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      expect(fake.calls[0].level).toBe("active");
      expect(fake.calls[0].collapseId).toBeUndefined();
    });
  });

  it("a letter's proposal push replaces the letter push (collapse id letter:<documentId>)", async () => {
    await isolated(async (db) => {
      const [d] = await db.insert(schema.documents).values({
        sha256: (uid() + uid()).replaceAll("-", ""), title: `Brief ${uid()}.pdf`, mime: "application/pdf",
        sizeBytes: 10, source: "nas-scan", sourceRef: `store-letter-${uid()}`, receivedAt: new Date(),
      }).returning();
      await db.insert(schema.documentTexts).values({
        documentId: d.id, sha256: d.sha256, text: "", charCount: 0, extractor: "none",
      });
      const ctx = fixtureContext();
      const [p] = await db.insert(schema.proposals).values({
        kind: "reply", status: "drafting", priority: "verder", triggerDocumentId: d.id,
        senderGuess: { kind: "verder" }, context: { ...ctx, party: null }, prompt: "the prompt",
      }).returning();
      const fake = fakeNotify();
      await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      expect(fake.calls[0]).toMatchObject({
        level: "time-sensitive", body: "Antwoord klaar voor Verder. Bekijk en verstuur.",
        threadId: `letter:${d.id}`, collapseId: `letter:${d.id}`,
      });
    });
  });

  it("invalid answer is draft-failed with the raw output kept", async () => {
    await isolated(async (db) => {
      const since = new Date((await db.execute<{ now: string }>("select now() as now")).rows[0].now);
      const { p, ctx } = await proposal(db);
      const evil = JSON.parse(replyAnswer(ctx));
      evil.reply.to = ["attacker@evil.tld"];
      const raw = JSON.stringify(evil);
      const fake = fakeNotify();
      const r = await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: raw });
      expect(r.outcome).toBe("draft-failed");
      const row = await byId(db, p.id);
      expect(row.status).toBe("draft-failed");
      expect(row.modelOutput).toBe(raw);
      expect(row.payload).toBeNull();
      expect(row.error).toMatch(/attacker@evil\.tld/);
      expect(row.model).toBe(MODEL);
      expect(fake.calls).toHaveLength(0);
      const runs = await runsSince(db, since);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("error");
      expect(runs[0].detail).toMatchObject({ proposalId: p.id, outcome: "draft-failed" });
    });
  });

  it("a pending proposal is not overwritten by a late answer", async () => {
    await isolated(async (db) => {
      const { p, ctx } = await proposal(db, { status: "pending" });
      await db.update(schema.proposals).set({ payload: { keep: true }, modelOutput: "first" })
        .where(eq(schema.proposals.id, p.id));
      const fake = fakeNotify();
      const r = await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      expect(r.outcome).toBe("not-drafting");
      const row = await byId(db, p.id);
      expect(row.status).toBe("pending");
      expect(row.payload).toEqual({ keep: true });
      expect(row.modelOutput).toBe("first");
      expect(fake.calls).toHaveLength(0);
      // A superseded one is left alone too.
      const s = await proposal(db, { status: "superseded" });
      expect((await storeDraft({ db, notify: fake.notify },
        { id: s.p.id, model: MODEL, answer: replyAnswer(s.ctx) })).outcome).toBe("not-drafting");
      expect((await byId(db, s.p.id)).status).toBe("superseded");
    });
  });

  it("a reply row that came back as a question becomes kind=question", async () => {
    await isolated(async (db) => {
      const { p, ctx } = await proposal(db);
      const fake = fakeNotify();
      const r = await storeDraft({ db, notify: fake.notify }, { id: p.id, model: MODEL, answer: questionAnswer(ctx) });
      expect(r.outcome).toBe("pending");
      const row = await byId(db, p.id);
      expect(row.kind).toBe("question");
      expect(row.promptVersion).toBe("question-v1");
      expect(fake.calls[0].body).toBe("Een vraag over Team Opstart (Verder). Kies een antwoord.");
    });
  });

  it("an unknown id writes an error row and notifies nothing", async () => {
    await isolated(async (db) => {
      const fake = fakeNotify();
      const r = await storeDraft({ db, notify: fake.notify }, { id: uid(), model: MODEL, answer: "{}" });
      expect(r.outcome).toBe("not-found");
      expect(fake.calls).toHaveLength(0);
    });
  });

  it("a notify that throws does not undo the stored draft", async () => {
    await isolated(async (db) => {
      const { p, ctx } = await proposal(db);
      const notify: NotifyFn = async () => { throw new Error("boom"); };
      const r = await storeDraft({ db, notify }, { id: p.id, model: MODEL, answer: replyAnswer(ctx) });
      expect(r.outcome).toBe("pending");
      expect((await byId(db, p.id)).status).toBe("pending");
    });
  });
});

describe("storeDrafterFailure and the heartbeat", () => {
  it("a drafter failure (claude did not answer) is draft-failed with the reason", async () => {
    await isolated(async (db) => {
      const { p } = await proposal(db);
      const r = await storeDrafterFailure(db, { id: p.id, model: MODEL, reason: "claude-exit-124" });
      expect(r.outcome).toBe("draft-failed");
      const row = await byId(db, p.id);
      expect(row.status).toBe("draft-failed");
      expect(row.error).toBe("drafter: claude-exit-124");
      expect(row.modelOutput).toBeNull();
    });
  });

  it("the heartbeat records ok {drafted: 0}", async () => {
    await isolated(async (db) => {
      const since = new Date((await db.execute<{ now: string }>("select now() as now")).rows[0].now);
      await recordDrafterHeartbeat(db);
      const runs = await runsSince(db, since);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "ok", detail: { drafted: 0 } });
    });
  });
});

describe("proposals-pending", () => {
  it("lists drafting rows oldest first, at most 5, and fills a missing prompt from the context", async () => {
    await isolated(async (db) => {
      // Push every pre-existing drafting row out of the way inside this rolled-back tx.
      await db.update(schema.proposals).set({ status: "draft-failed" })
        .where(eq(schema.proposals.status, "drafting"));
      const made: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { p } = await proposal(db);
        await db.update(schema.proposals)
          .set({ createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)), prompt: i === 0 ? null : `prompt ${i}` })
          .where(eq(schema.proposals.id, p.id));
        made.push(p.id);
      }
      const { p: done } = await proposal(db, { status: "pending" });

      const list = await pendingDrafts(db);
      expect(list.map((l) => l.id)).toEqual(made.slice(0, 5));
      expect(list.map((l) => l.id)).not.toContain(done.id);
      // The NULL prompt was built from the stored context, and persisted.
      expect(list[0].prompt).toContain("<<<DATA");
      expect((await byId(db, made[0])).prompt).toBe(list[0].prompt);
      expect(list[1].prompt).toBe("prompt 1");

      expect(await promptForDraft(db, made[2])).toBe("prompt 2");
      expect(await promptForDraft(db, done.id)).toBeNull();
    });
  });
});
