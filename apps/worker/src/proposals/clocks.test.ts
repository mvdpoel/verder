import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { storeFile } from "@verder/api/src/storage";
import { setTaskStatus } from "@verder/api/src/task-decide";
import type { NotifyFn, NotifyInput } from "../notify/notify";
import type { RetrieveRefsFn } from "../retrieval-refs";
import {
  followUpCreator, followUpDue, runClocks, silentFor, type ClockDeps, type ThreadState,
} from "./clocks";

// Runs as verder_worker, the role the proposals.clock job meets in production.
// Every test is a transaction that is ROLLED BACK: the shared dev database is
// never truncated. NOTHING is sent: notify is a fake that records and dedups on
// the key exactly as notify() does.
const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
let conn: { db: Db; pool: { end(): Promise<void> } };
const vaultDir = mkdtempSync(join(tmpdir(), "proposal-clocks-vault-"));
const retrieveRefs: RetrieveRefsFn = async () => [];

beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

const env = { senders: process.env.RELEVANT_SENDERS, own: process.env.MAIL_OWN_ADDRESSES,
  days: process.env.PROPOSAL_FOLLOWUP_DAYS };
beforeEach(() => {
  process.env.RELEVANT_SENDERS = "@verdergroep.nl,@verderbewindmidden.nl";
  process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
  delete process.env.PROPOSAL_FOLLOWUP_DAYS;
});
afterEach(() => {
  for (const [k, v] of [["RELEVANT_SENDERS", env.senders], ["MAIL_OWN_ADDRESSES", env.own],
    ["PROPOSAL_FOLLOWUP_DAYS", env.days]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

class Rollback extends Error {}
async function isolated(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await conn.db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MARTIN = "Martin van der Poel <martin@vanderpoel.pro>";

/** A controlled clock far past anything the shared dev database holds, so no
 *  committed row from another suite can fall inside a clock's window. */
function clock() {
  let t = Date.parse("2031-03-03T09:00:00Z") + Math.floor(Math.random() * 1000) * MIN;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, at: (ms: number) => new Date(t + ms) };
}

/** notify() as far as a clock can see it: one notification per dedup key. */
function dedupNotify() {
  const sent: NotifyInput[] = [];
  const keys = new Set<string>();
  const notify: NotifyFn = async (n) => {
    if (n.dedupKey && keys.has(n.dedupKey)) {
      return { notificationId: null, duplicate: true, delivered: 0, failed: 0, skipped: 0 };
    }
    if (n.dedupKey) keys.add(n.dedupKey);
    sent.push(n);
    return { notificationId: uid(), duplicate: false, delivered: 1, failed: 0, skipped: 0 };
  };
  return { notify, sent, mine: (prefix: string) => sent.filter((s) => s.dedupKey?.startsWith(prefix)) };
}

/** A createFollowUp that records the thread and inserts the row the real one
 *  would (a `follow-up` in `drafting`), without assembling a context. */
function fakeFollowUp(db: Db) {
  const calls: ThreadState[] = [];
  const create = async (t: ThreadState) => {
    calls.push(t);
    const [p] = await db.insert(schema.proposals).values({
      kind: "follow-up", status: "drafting", priority: t.priority, threadKey: t.threadKey,
      ...(t.lastOutbound.kind === "proposal"
        ? { parentProposalId: t.lastOutbound.id } : { triggerRawEmailId: t.lastOutbound.id }),
      context: {},
    }).returning({ id: schema.proposals.id });
    return p.id;
  };
  return { create, calls };
}

function depsFor(db: Db, c: ReturnType<typeof clock>, extra: Partial<ClockDeps> = {}) {
  const n = dedupNotify();
  const f = fakeFollowUp(db);
  const deps: ClockDeps = { db, notify: n.notify, createFollowUp: f.create, now: c.now, ...extra };
  return { deps, n, f };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function mail(db: Db, o: {
  threadId: string; from: string; to?: string; sentAt: Date; messageId?: string;
  gmailMessageId?: string; source?: string;
}) {
  const messageId = o.messageId ?? `${uid()}@mail.example`;
  const to = o.to ?? "martin@vanderpoel.pro";
  const raw = Buffer.from([`From: ${o.from}`, `To: ${to}`, "Subject: Informatie over uw dossier",
    `Message-ID: <${messageId}>`, "", "Graag uw loonstroken."].join("\r\n"));
  const { sha256 } = await storeFile(vaultDir, raw);
  const [row] = await db.insert(schema.rawEmails).values({
    gmailMessageId: o.gmailMessageId ?? `clock-${uid()}`, gmailThreadId: o.threadId,
    fromAddr: o.from, toAddr: to, subject: "Informatie over uw dossier", sentAt: o.sentAt,
    rawRfc822Sha256: sha256, bodyText: "Graag uw loonstroken.", source: o.source ?? "gmail",
    messageId, suggestQueuedAt: new Date(),
  }).returning();
  return row;
}

const verderAddr = () => `opstart-${uid()}@verdergroep.nl`;
const verder = (addr = verderAddr()) => `Team Opstart <${addr}>`;

async function sentProposal(db: Db, o: {
  triggerRawEmailId: string; threadId: string; sentAt: Date; messageId?: string;
  gmailMessageId?: string; priority?: string;
}) {
  const [p] = await db.insert(schema.proposals).values({
    kind: "reply", status: "sent", priority: o.priority ?? "verder",
    triggerRawEmailId: o.triggerRawEmailId, threadKey: `gmail:${o.threadId}`,
    context: {}, payload: { ask: "Loonstrook oktober aanleveren" },
    finalPayload: { subject: "Re: Informatie over uw dossier", body: "Hierbij." },
    messageId: o.messageId ?? `<${uid()}@verder.vanderpoel.pro>`,
    gmailMessageId: o.gmailMessageId ?? `gm-${uid()}`, gmailThreadId: o.threadId,
    sendingAt: o.sentAt, sentAt: o.sentAt,
  }).returning();
  return p;
}

async function pending(db: Db, o: { createdAt: Date; priority?: string; ask?: string }) {
  const trigger = await mail(db, { threadId: `t-${uid()}`, from: verder(), sentAt: o.createdAt });
  const [p] = await db.insert(schema.proposals).values({
    kind: "reply", status: "pending", priority: o.priority ?? "verder",
    triggerRawEmailId: trigger.id, context: {},
    payload: { ask: o.ask ?? `Loonstrook oktober ${uid()}` },
    createdAt: o.createdAt, updatedAt: o.createdAt,
  }).returning();
  return p;
}

async function user(db: Db) {
  const [u] = await db.insert(schema.users)
    .values({ email: `clock-${uid()}@test.local`, name: "Martin" }).returning();
  return u;
}

async function task(db: Db, userId: string, dueAt: Date) {
  const [t] = await db.insert(schema.tasks).values({
    title: `Loonstrook aanleveren ${uid()}`, dueAt, createdBy: userId,
  }).returning();
  return t;
}

const byId = async (db: Db, id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0];

// ---------------------------------------------------------------------------

describe("silentFor", () => {
  it("silentFor counts Amsterdam days across the DST change", () => {
    // 2026-10-24 23:30 CEST is 21:30Z; 2026-10-31 23:30 CET is 22:30Z. The
    // clocks went back on 2026-10-25, so the elapsed time is 7 days + 1 h, and
    // a UTC-midnight count would also say 7 — but 23:30 CEST on the 24th is
    // already the 24th in Amsterdam, which is the point.
    expect(silentFor(new Date("2026-10-24T21:30:00Z"), new Date("2026-10-31T22:30:00Z"))).toBe(7);
    // 00:30 CEST on the 25th is 22:30Z on the 24th: UTC says the 24th, Amsterdam the 25th.
    expect(silentFor(new Date("2026-10-24T22:30:00Z"), new Date("2026-10-31T22:30:00Z"))).toBe(6);
    expect(silentFor(new Date("2026-10-31T08:00:00Z"), new Date("2026-10-31T22:30:00Z"))).toBe(0);
  });

  it("followUpDue needs the outbound to be the newest word", () => {
    const t: ThreadState = { threadKey: "gmail:x", priority: "verder", counterparty: "Verder",
      lastOutbound: { kind: "raw-email", id: "a" },
      lastOutboundAt: new Date("2026-10-20T10:00:00Z"), lastInboundAt: null };
    const now = new Date("2026-10-27T10:00:00Z");
    expect(followUpDue(t, now, 7)).toBe(true);
    expect(followUpDue(t, new Date("2026-10-26T21:00:00Z"), 7)).toBe(false);
    expect(followUpDue({ ...t, lastInboundAt: new Date("2026-10-21T10:00:00Z") }, now, 7)).toBe(false);
    expect(followUpDue({ ...t, lastInboundAt: new Date("2026-10-19T10:00:00Z") }, now, 7)).toBe(true);
  });
});

describe("runClocks: the 24 h reminder", () => {
  it("reminds once after 24 h", async () => {
    await isolated(async (db) => {
      const c = clock();
      const p = await pending(db, { createdAt: c.at(-25 * HOUR), ask: "Stuur de loonstrook van oktober" });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      const mine = n.mine(`reminder:${p.id}`);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: "reminder", level: "time-sensitive",
        title: "Wacht nog: Stuur de loonstrook van oktober", link: `verder://proposal/${p.id}` });
      expect((await byId(db, p.id)).remindedAt).toEqual(c.now());

      // Once, ever: a later tick does not even ask notify again.
      c.advance(3 * DAY);
      await runClocks(deps);
      expect(n.mine(`reminder:${p.id}`)).toHaveLength(1);
    });
  });

  it("23h59 does not remind", async () => {
    await isolated(async (db) => {
      const c = clock();
      const p = await pending(db, { createdAt: c.at(-(24 * HOUR - MIN)) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`reminder:${p.id}`)).toHaveLength(0);
      expect((await byId(db, p.id)).remindedAt).toBeNull();
    });
  });

  it("a creditor proposal is reminded at its own level, and a decided one not at all", async () => {
    await isolated(async (db) => {
      const c = clock();
      const p = await pending(db, { createdAt: c.at(-2 * DAY), priority: "creditor" });
      const q = await pending(db, { createdAt: c.at(-2 * DAY) });
      await db.update(schema.proposals).set({ status: "rejected" }).where(eq(schema.proposals.id, q.id));
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`reminder:${p.id}`)[0].level).toBe("active");
      expect(n.mine(`reminder:${q.id}`)).toHaveLength(0);
    });
  });
});

describe("runClocks: the follow-up clock", () => {
  it("follow-up fires once per outbound message", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-10 * DAY) });
      const out = await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.at(-8 * DAY) });
      const { deps, n, f } = depsFor(db, c);

      const r = await runClocks(deps);
      expect(r.followUps).toBeGreaterThanOrEqual(1);
      const key = `followup:gmail:${th}:raw-email:${out.id}`;
      const mine = n.mine(`followup:gmail:${th}:`);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: "follow-up", level: "time-sensitive", dedupKey: key });
      expect(mine[0].title).toMatch(/^Nog geen antwoord van .+ sinds \d{2}-\d{2}$/);
      const created = f.calls.filter((t) => t.threadKey === `gmail:${th}`);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ priority: "verder", lastOutbound: { kind: "raw-email", id: out.id } });

      // Further ticks change nothing.
      c.advance(HOUR); await runClocks(deps);
      c.advance(5 * DAY); await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(1);
      expect(f.calls.filter((t) => t.threadKey === `gmail:${th}`)).toHaveLength(1);

      // A new outbound message starts a new clock, and it runs out once too.
      const again = await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.now() });
      c.advance(6 * DAY); await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(1);
      c.advance(2 * DAY); await runClocks(deps);
      const all = n.mine(`followup:gmail:${th}:`);
      expect(all.map((x) => x.dedupKey)).toEqual([key, `followup:gmail:${th}:raw-email:${again.id}`]);
    });
  });

  it("an inbound reply stops the clock", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.at(-9 * DAY) });
      await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-3 * DAY) });
      const { deps, n, f } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(0);
      expect(f.calls.filter((t) => t.threadKey === `gmail:${th}`)).toHaveLength(0);
    });
  });

  it("a thread with no outbound has no clock", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      await mail(db, { threadId: th, from: verder(), sentAt: c.at(-20 * DAY) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(0);
    });
  });

  it("jmap rows never start a clock", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `jt-${uid()}`;
      await mail(db, { threadId: th, from: MARTIN, to: verderAddr(), sentAt: c.at(-9 * DAY), source: "jmap" });
      const { deps, n, f } = depsFor(db, c);
      await runClocks(deps);
      expect(n.sent.filter((s) => s.dedupKey?.includes(th))).toHaveLength(0);
      expect(f.calls.filter((t) => t.threadKey.includes(th))).toHaveLength(0);
    });
  });

  it("other-priority threads have no clock", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      await mail(db, { threadId: th, from: "Bol <klantenservice@bol.example>", sentAt: c.at(-12 * DAY) });
      await mail(db, { threadId: th, from: MARTIN, to: "klantenservice@bol.example", sentAt: c.at(-9 * DAY) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(0);
    });
  });

  it("a creditor thread chases at active", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const addr = `incasso-${uid()}@stam.example`;
      const [pt] = await db.insert(schema.parties).values({ kind: "organization",
        name: `Stam Testfixture ${uid()}`, email: addr }).returning();
      await db.insert(schema.debts).values({ creditorPartyId: pt.id, creditorName: pt.name });
      await mail(db, { threadId: th, from: addr, sentAt: c.at(-12 * DAY) });
      await mail(db, { threadId: th, from: MARTIN, to: addr, sentAt: c.at(-9 * DAY) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      const mine = n.mine(`followup:gmail:${th}:`);
      expect(mine).toHaveLength(1);
      expect(mine[0].level).toBe("active");
      expect(mine[0].title).toContain(pt.name);
    });
  });

  it("a follow-up after a sent proposal uses parent_proposal_id", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      const inbound = await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-10 * DAY) });
      const p = await sentProposal(db, { triggerRawEmailId: inbound.id, threadId: th, sentAt: c.at(-8 * DAY) });
      const { deps, n } = depsFor(db, c, {
        createFollowUp: followUpCreator({ db, retrieveRefs, vaultDir }),
      });
      await runClocks(deps);
      const mine = n.mine(`followup:gmail:${th}:`);
      expect(mine.map((x) => x.dedupKey)).toEqual([`followup:gmail:${th}:proposal:${p.id}`]);
      const follow = await db.select().from(schema.proposals).where(eq(schema.proposals.parentProposalId, p.id));
      expect(follow).toHaveLength(1);
      expect(follow[0]).toMatchObject({ kind: "follow-up", status: "drafting", priority: "verder",
        triggerRawEmailId: null, threadKey: `gmail:${th}` });
      expect(mine[0].link).toBe(`verder://proposal/${follow[0].id}`);
      expect(follow[0].prompt).toMatch(/follow-up/i);
    });
  });

  it("a follow-up after Martin's own mail uses trigger_raw_email_id", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-10 * DAY) });
      const out = await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.at(-8 * DAY) });
      const { deps } = depsFor(db, c, { createFollowUp: followUpCreator({ db, retrieveRefs, vaultDir }) });
      await runClocks(deps);
      const follow = await db.select().from(schema.proposals)
        .where(eq(schema.proposals.triggerRawEmailId, out.id));
      expect(follow).toHaveLength(1);
      expect(follow[0]).toMatchObject({ kind: "follow-up", status: "drafting", parentProposalId: null });
    });
  });

  it("a sent proposal and its re-ingested row start one clock, not two", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      const inbound = await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-10 * DAY) });
      const mid = `${uid()}@verder.vanderpoel.pro`;
      const p = await sentProposal(db, { triggerRawEmailId: inbound.id, threadId: th,
        sentAt: c.at(-8 * DAY), messageId: `<${mid}>` });
      const { deps, n, f } = depsFor(db, c);
      await runClocks(deps);
      // The re-ingest of the sent mail lands between two ticks.
      await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.at(-8 * DAY + MIN), messageId: mid });
      c.advance(15 * MIN);
      await runClocks(deps);
      const mine = n.mine(`followup:gmail:${th}:`);
      expect(mine.map((x) => x.dedupKey)).toEqual([`followup:gmail:${th}:proposal:${p.id}`]);
      expect(f.calls.filter((t) => t.threadKey === `gmail:${th}`)).toHaveLength(1);
    });
  });

  it("a sent proposal in a thread the poller never saw has no clock", async () => {
    // A mail-agent reply to a watchlist sender: its answer will never be
    // ingested, so a clock there would chase a reply that may have come.
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const [p] = await db.insert(schema.proposals).values({
        kind: "reply", status: "sent", priority: "creditor",
        triggerExternal: { gmailId: `x-${uid()}` }, context: {},
        gmailThreadId: th, messageId: `<${uid()}@verder.vanderpoel.pro>`, gmailMessageId: `gm-${uid()}`,
        sendingAt: c.at(-9 * DAY), sentAt: c.at(-9 * DAY),
      }).returning();
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.sent.filter((s) => s.dedupKey?.includes(p.id))).toHaveLength(0);
    });
  });

  it("a clock silent for more than the chase window is not chased", async () => {
    await isolated(async (db) => {
      const c = clock();
      const th = `th-${uid()}`;
      const vAddr = verderAddr();
      await mail(db, { threadId: th, from: verder(vAddr), sentAt: c.at(-200 * DAY) });
      await mail(db, { threadId: th, from: MARTIN, to: vAddr, sentAt: c.at(-180 * DAY) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(0);
    });
  });

  it("PROPOSAL_FOLLOWUP_DAYS is the one setting", async () => {
    await isolated(async (db) => {
      process.env.PROPOSAL_FOLLOWUP_DAYS = "3";
      const c = clock();
      const th = `th-${uid()}`;
      await mail(db, { threadId: th, from: MARTIN, to: verderAddr(), sentAt: c.at(-4 * DAY) });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`followup:gmail:${th}:`)).toHaveLength(1);
    });
  });
});

describe("runClocks: due within 24 h", () => {
  it("due task alerts once and again after due_at changes", async () => {
    await isolated(async (db) => {
      const c = clock();
      const u = await user(db);
      const t = await task(db, u.id, c.at(5 * HOUR));
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      await runClocks(deps);
      const first = n.mine(`due:${t.id}:`);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ kind: "task-due", level: "time-sensitive",
        dedupKey: `due:${t.id}:${c.at(5 * HOUR).toISOString()}` });
      expect(first[0].title).toMatch(new RegExp(`^(Vandaag|Morgen): ${t.title}$`));

      const moved = c.at(20 * HOUR);
      await db.update(schema.tasks).set({ dueAt: moved }).where(eq(schema.tasks.id, t.id));
      await runClocks(deps);
      await runClocks(deps);
      expect(n.mine(`due:${t.id}:`).map((x) => x.dedupKey))
        .toEqual([`due:${t.id}:${c.at(5 * HOUR).toISOString()}`, `due:${t.id}:${moved.toISOString()}`]);
    });
  });

  it("an overdue task alerts once", async () => {
    await isolated(async (db) => {
      const c = clock();
      const u = await user(db);
      const t = await task(db, u.id, c.at(-3 * DAY));
      const { deps, n } = depsFor(db, c);
      for (let i = 0; i < 4; i++) { await runClocks(deps); c.advance(15 * MIN); }
      const mine = n.mine(`due:${t.id}:`);
      expect(mine).toHaveLength(1);
      expect(mine[0].title).toBe(`Te laat: ${t.title}`);
    });
  });

  it("a task due after 24 h does not alert yet", async () => {
    await isolated(async (db) => {
      const c = clock();
      const u = await user(db);
      const t = await task(db, u.id, c.at(24 * HOUR + MIN));
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`due:${t.id}:`)).toHaveLength(0);
    });
  });

  it("waiting task does not alert", async () => {
    await isolated(async (db) => {
      const c = clock();
      const u = await user(db);
      const t = await task(db, u.id, c.at(2 * HOUR));
      await setTaskStatus(db, u.id, { taskId: t.id, status: "waiting" });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`due:${t.id}:`)).toHaveLength(0);
    });
  });

  it("an in-progress task alerts, because Martin is the one doing it", async () => {
    await isolated(async (db) => {
      const c = clock();
      const u = await user(db);
      const t = await task(db, u.id, c.at(2 * HOUR));
      await setTaskStatus(db, u.id, { taskId: t.id, status: "in-progress" });
      const done = await task(db, u.id, c.at(2 * HOUR));
      await setTaskStatus(db, u.id, { taskId: done.id, status: "done" });
      const { deps, n } = depsFor(db, c);
      await runClocks(deps);
      expect(n.mine(`due:${t.id}:`)).toHaveLength(1);
      expect(n.mine(`due:${done.id}:`)).toHaveLength(0);
    });
  });
});
