import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { loadWaiting, waitingOnMartin } from "../waiting";
import { requestFailureText, requestProgress } from "../request-progress";

// Runs as grip_app, the role the phone's routes meet in production. Every test
// is ONE transaction that is ROLLED BACK: the shared dev database never keeps a
// fixture request, so the dev Voor jou never grows by one per run.
const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(APP_URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db, userId: string) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [u] = await db.insert(schema.users)
        .values({ email: `requests-${crypto.randomUUID()}@test.local`, name: "Martin" }).returning();
      await fn(db, u.id);
      throw new Rollback();
    });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}
const caller = (db: Db, userId: string) => appRouter.createCaller(createContext({ db, userId }));
const code = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return e instanceof TRPCError ? e.code : String(e); }
};

describe("requests router", () => {
  it("create is idempotent on clientId and lists the request as queued", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      const clientId = crypto.randomUUID();
      const a = await c.requests.create({ clientId, text: "  Zeg mijn UNHCR-donatie op  " });
      expect(a).toMatchObject({ status: "queued", duplicate: false });
      const b = await c.requests.create({ clientId: clientId.toUpperCase(), text: "anders" });
      expect(b).toEqual({ id: a.id, status: "queued", duplicate: true });
      const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, a.id));
      expect(row.text).toBe("Zeg mijn UNHCR-donatie op");
      const listed = (await c.requests.list()).find((r) => r.id === a.id);
      expect(listed).toMatchObject({ status: "queued", unread: false, proposal: null });
    });
  });

  it("refuses an empty text, an about with two keys, and an about that does not exist", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      await expect(c.requests.create({ clientId: crypto.randomUUID(), text: "   " })).rejects.toThrow();
      await expect(c.requests.create({ clientId: crypto.randomUUID(), text: "x",
        about: { partyId: crypto.randomUUID(), taskId: crypto.randomUUID() } })).rejects.toThrow();
      expect(await code(c.requests.create({ clientId: crypto.randomUUID(), text: "x",
        about: { partyId: crypto.randomUUID() } }))).toBe("BAD_REQUEST");
      const [party] = await db.insert(schema.parties)
        .values({ kind: "organization", name: `Requests Testfixture ${crypto.randomUUID()}` }).returning();
      const ok = await c.requests.create({ clientId: crypto.randomUUID(), text: "Wat wil deze partij?",
        about: { partyId: party.id } });
      expect((await c.requests.get({ id: ok.id })).about).toEqual({ type: "party", id: party.id, label: party.name });
    });
  });

  it("a follow-up needs an answered (or failed) parent and shows the thread", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      const first = await c.requests.create({ clientId: crypto.randomUUID(), text: "Wat moet ik met de boedelbeschrijving?" });
      expect(await code(c.requests.create({ clientId: crypto.randomUUID(), text: "En dan?",
        parentRequestId: first.id }))).toBe("CONFLICT");
      await db.update(schema.requests).set({ status: "answered", answer: "Vul de schulden aan.",
        answeredAt: new Date(), claimedAt: new Date() }).where(eq(schema.requests.id, first.id));
      const next = await c.requests.create({ clientId: crypto.randomUUID(), text: "En dan?", parentRequestId: first.id });
      const got = await c.requests.get({ id: next.id });
      expect(got.thread).toEqual([expect.objectContaining({ id: first.id, answer: "Vul de schulden aan." })]);
      expect((await c.requests.get({ id: first.id })).followUps.map((f) => f.id)).toEqual([next.id]);
    });
  });

  it("cancel: only queued or working; repeat is a no-op; an answered one is a conflict", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      const r = await c.requests.create({ clientId: crypto.randomUUID(), text: "Zoek de polis" });
      expect(await c.requests.cancel({ id: r.id })).toEqual({ id: r.id, status: "cancelled" });
      expect(await c.requests.cancel({ id: r.id })).toEqual({ id: r.id, status: "cancelled" });
      expect((await c.requests.list()).some((x) => x.id === r.id)).toBe(false);
      const s = await c.requests.create({ clientId: crypto.randomUUID(), text: "Nog een" });
      await db.update(schema.requests).set({ status: "answered", answer: "a", answeredAt: new Date(),
        claimedAt: new Date() }).where(eq(schema.requests.id, s.id));
      expect(await code(c.requests.cancel({ id: s.id }))).toBe("CONFLICT");
      expect(await code(c.requests.cancel({ id: crypto.randomUUID() }))).toBe("NOT_FOUND");
    });
  });

  it("an answered, unopened request waits on Martin until he opens it", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      const r = await c.requests.create({ clientId: crypto.randomUUID(), text: "Klopt de boedelbeschrijving?" });
      expect(await code(c.requests.markOpened({ id: r.id }))).toBe("CONFLICT");
      const ids = async () => (await loadWaiting(db)).filter((i) => i.kind === "request").map((i) => i.id);
      expect(await ids()).not.toContain(r.id);
      await db.update(schema.requests).set({ status: "working", claimedAt: new Date() })
        .where(eq(schema.requests.id, r.id));
      expect(await ids()).not.toContain(r.id);
      await db.update(schema.requests).set({ status: "answered", answer: "Twee schulden ontbreken.",
        answeredAt: new Date() }).where(eq(schema.requests.id, r.id));
      expect(await ids()).toContain(r.id);
      expect((await c.requests.list()).find((x) => x.id === r.id)?.unread).toBe(true);
      const [count, list] = await Promise.all([c.inbox.count(), c.inbox.list()]);
      expect(count).toBe(list.length);
      const opened = await c.requests.markOpened({ id: r.id });
      expect(opened.openedAt).toBeInstanceOf(Date);
      expect((await c.requests.markOpened({ id: r.id })).openedAt).toEqual(opened.openedAt);
      expect(await ids()).not.toContain(r.id);
    });
  });

  it("get: progress from the tool log while working, the proposal card once answered", async () => {
    await isolated(async (db, uid) => {
      const c = caller(db, uid);
      const r = await c.requests.create({ clientId: crypto.randomUUID(), text: "Zeg het abonnement op" });
      const call = (tool: string) => ({ tool, args: {}, resultSha256: "x", ids: [], ms: 5, at: new Date().toISOString() });
      await db.update(schema.requests).set({ status: "working", claimedAt: new Date(),
        toolLog: [call("get_document"), call("get_document"), call("gmail_search")] })
        .where(eq(schema.requests.id, r.id));
      const working = await c.requests.get({ id: r.id });
      expect(working.progress?.line).toBe("leest 2 documenten, zoekt in Gmail");
      expect(working.answer).toBeNull();

      const [p] = await db.insert(schema.proposals).values({
        kind: "compose", status: "pending", priority: "other", triggerRequestId: r.id,
        context: { trigger: { type: "request", id: r.id, label: "Zeg het abonnement op" }, thread: [],
          party: null, parentParty: null, entries: [], debts: [], tasks: [], stops: [], kb: [],
          sentDocuments: [], attachable: [], addresses: ["donateurs@unhcr.example"] },
        payload: { reply: { to: ["donateurs@unhcr.example"], cc: [], subject: "Opzegging", body: "b",
          attachmentDocumentIds: [] } },
      }).returning();
      await db.update(schema.requests).set({ status: "answered", answer: "Zo zeg je het op.",
        answeredAt: new Date(), proposalId: p.id,
        sources: [{ type: "transaction", id: crypto.randomUUID(), why: "€ 10 per maand" }],
        martinSteps: ["Zeg de machtiging op via je bank"] })
        .where(eq(schema.requests.id, r.id));
      const answered = await c.requests.get({ id: r.id });
      expect(answered).toMatchObject({
        status: "answered", answer: "Zo zeg je het op.", progress: null,
        martinSteps: ["Zeg de machtiging op via je bank"],
        proposal: { id: p.id, kind: "compose", status: "pending", to: ["donateurs@unhcr.example"], subject: "Opzegging" },
      });
      // The proposal screen shows the request as the trigger.
      const prop = await c.proposals.get({ id: p.id });
      expect(prop.trigger).toMatchObject({ type: "request", id: r.id, from: "Martin" });
    });
  });

  it("grip_app cannot delete a request", async () => {
    await isolated(async (db) => {
      await db.execute(sql`SAVEPOINT d`);
      await expect(db.execute(sql`DELETE FROM requests WHERE false`)).rejects.toThrow(/permission denied/);
      await db.execute(sql`ROLLBACK TO SAVEPOINT d`);
    });
  });
});

describe("request progress and the waiting list (pure)", () => {
  it("names activity, never content", () => {
    expect(requestProgress([]).line).toBeNull();
    const log = ["search", "list_documents"].map((tool) => ({ tool }));
    expect(requestProgress(log).line).toBe("zoekt in het dossier");
    expect(requestProgress([{ tool: "get_mail" }, { tool: "list_transactions" }, { tool: "get_document", error: "cap" }]).line)
      .toBe("leest 1 mail, bekijkt de bankafschriften");
    expect(requestFailureText("timeout after 600 s")).toBe("Duurde te lang");
    expect(requestFailureText("a source id never appeared")).toBe("Lukte niet");
  });

  it("an answered request sits after the Verder proposals and before suggestions", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    const items = waitingOnMartin({
      proposals: [{ id: "p1", kind: "reply", priority: "verder", createdAt: now, payload: { ask: "Antwoord Ilse" },
        partyName: "Noordkust", senderGuess: null }],
      requests: [{ id: "r1", text: "Zeg  het\nabonnement op", answeredAt: now }],
      suggestions: [{ id: "s1", kind: "task", createdAt: now, proposed: { title: "Bellen" }, documentTitle: null, emailSubject: null }],
      tasks: [], currentStop: null, now,
    });
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["proposal:p1", "request:r1", "suggestion:s1"]);
    expect(items[1]).toMatchObject({ title: "Zeg het abonnement op", priority: 2, verder: false });
  });
});
