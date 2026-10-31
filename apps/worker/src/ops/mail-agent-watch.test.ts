import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { MAIL_AGENT_WORKER_NAME } from "@verder/api/src/worker-names";
import { rateLimitedUntil } from "../gmail";
import { fixtureContext } from "../proposals/draft-fixture";
import {
  bodyOf, parseWatchInput, stripHtml, toExternal, watchMail, watchQueries, type WatchMessage, type WatchPort,
} from "./mail-agent-watch";
import { storeExternal } from "./proposals-store";

// Runs as verder_worker, the role the watcher meets in production. Every test
// is a transaction that is ROLLED BACK: the shared dev database is never
// truncated. Gmail is a fake port: nothing is fetched, nothing is sent.
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

const hex = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
// Far from any real deadline in the dev DB's worker_runs, in either direction.
const NOW = new Date("2031-03-01T12:00:00Z");

function msg(o: Partial<WatchMessage> & { from: string }): WatchMessage & Record<string, unknown> {
  return {
    id: hex(), threadId: hex(), messageId: `<${crypto.randomUUID()}@bungas.example>`,
    to: "Martin van der Poel <martin@vanderpoel.pro>", subject: "Uw bestelling",
    date: new Date("2031-03-01T09:00:00Z"), body: "Beste Martin, uw bestelling is onderweg.",
    attachments: [], ...o,
  };
}

function fakePort(messages: WatchMessage[], o: { listError?: unknown; getError?: unknown } = {}) {
  const calls = { factory: 0, list: [] as string[], get: [] as string[] };
  const port: WatchPort = {
    async listMessageIds(q) {
      calls.list.push(q);
      if (o.listError) throw o.listError;
      return messages.map((m) => m.id);
    },
    async getMessage(id) {
      calls.get.push(id);
      if (o.getError) throw o.getError;
      const m = messages.find((x) => x.id === id);
      if (!m) throw new Error(`no ${id}`);
      return m;
    },
  };
  return { calls, factory: async () => { calls.factory++; return port; } };
}

async function lastRun(db: Db) {
  const [r] = await db.select().from(schema.workerRuns)
    .where(eq(schema.workerRuns.worker, MAIL_AGENT_WORKER_NAME))
    .orderBy(desc(schema.workerRuns.ranAt), desc(schema.workerRuns.id)).limit(1);
  return r;
}

describe("parseWatchInput / watchQueries", () => {
  it("reads addresses, domains and seen ids; refuses what is not an address", () => {
    const r = parseWatchInput([
      "# watchlist", "info@statiegeld.example  # Statiegeld", "@bungas.example", "tikkie.example",
      "from:hanneke@mail.example", "Hanneke", "", "martin@vanderpoel.pro",
      "seen:18c0ffee1234abcd", "seen:../../etc",
    ].join("\n"));
    expect(r.addrs).toEqual(["info@statiegeld.example", "@bungas.example", "@tikkie.example", "hanneke@mail.example"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["malformed", "own-mailbox"]);
    expect([...r.seen]).toEqual(["18c0ffee1234abcd"]);
  });

  it("no addresses means no query", () => {
    expect(watchQueries([])).toEqual([]);
    expect(watchQueries(["a@b.example", "@c.example"])).toEqual(["from:(a@b.example OR c.example) newer_than:3d"]);
  });

  it("an HTML-only body is stripped to text", () => {
    expect(stripHtml("<html><style>p{}</style><p>Beste&nbsp;Martin,</p><p>Groet &amp; tot&#33;</p></html>"))
      .toBe("Beste Martin,\nGroet & tot!");
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(bodyOf({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: b64("<b>Hoi</b>") } },
    ] })).toBe("Hoi");
    expect(bodyOf({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("plain") } },
      { mimeType: "text/html", body: { data: b64("<b>html</b>") } },
    ] })).toBe("plain");
  });
});

describe("watchMail", () => {
  const WATCH = "@bungas.example\n@verdergroep.nl\n";

  it("skips a message relevance already ingests", async () => {
    await isolated(async (db) => {
      const verder = msg({ from: "Demi <demi@verdergroep.nl>" });
      const bungas = msg({ from: "Bungas <service@bungas.example>" });
      const { factory, calls } = fakePort([verder, bungas]);
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.status).toBe("ok");
      expect(r.lines.map((l) => l.gmailId)).toEqual([bungas.id]);
      expect(calls.list).toEqual(["from:(bungas.example OR verdergroep.nl) newer_than:3d"]);
      const run = await lastRun(db);
      expect(run.status).toBe("ok");
      expect(run.detail).toMatchObject({ relevant: 1, emitted: 1 });
    });
  });

  it("skips seen ids, before fetching them", async () => {
    await isolated(async (db) => {
      const a = msg({ from: "service@bungas.example" });
      const b = msg({ from: "service@bungas.example" });
      const { factory, calls } = fakePort([a, b]);
      const r = await watchMail({ db, port: factory, input: `${WATCH}seen:${a.id}\n`, now: () => NOW });
      expect(r.lines.map((l) => l.gmailId)).toEqual([b.id]);
      expect(calls.get).toEqual([b.id]);
    });
  });

  it("skips an id that already has an external proposal", async () => {
    await isolated(async (db) => {
      const a = msg({ from: "service@bungas.example" });
      await db.insert(schema.proposals).values({
        kind: "reply", status: "pending", priority: "other",
        triggerExternal: { gmailId: a.id, threadId: a.threadId, messageId: null, from: a.from,
          to: a.to, subject: a.subject, date: a.date.toISOString(), body: a.body },
        context: fixtureContext(),
      });
      const { factory, calls } = fakePort([a]);
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.lines).toEqual([]);
      expect(calls.get).toEqual([]);
    });
  });

  it("a display-name spoof of a watchlist address is not on the watchlist", async () => {
    await isolated(async (db) => {
      const spoof = msg({ from: '"service@bungas.example" <attacker@evil.example>' });
      const { factory } = fakePort([spoof]);
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.lines).toEqual([]);
      expect((await lastRun(db)).detail).toMatchObject({ notOnWatchlist: 1 });
    });
  });

  it("prints no token or header beyond the listed fields", async () => {
    await isolated(async (db) => {
      const thread = hex();
      const older = msg({ from: "service@bungas.example", threadId: thread,
        date: new Date("2031-02-28T09:00:00Z"), subject: "Eerder" });
      const newer = {
        ...msg({ from: "service@bungas.example", threadId: thread, body: "x".repeat(9000),
          attachments: [{ filename: "factuur.pdf", mime: "application/pdf", size: 2048 }] }),
        raw: Buffer.from("Authorization: Bearer ya29.secret"), headers: { authorization: "Bearer ya29.secret" },
        access_token: "ya29.secret",
      };
      const { factory } = fakePort([older, newer]);
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.lines).toHaveLength(1);
      const [line] = r.lines;
      expect(Object.keys(line).sort()).toEqual(
        ["attachments", "body", "date", "from", "gmailId", "messageId", "subject", "thread", "threadId", "to"]);
      expect(Object.keys(line.thread![0]).sort()).toEqual(["body", "date", "from", "gmailId", "subject"]);
      expect(Object.keys(line.attachments![0]).sort()).toEqual(["filename", "mime", "size"]);
      expect(line.gmailId).toBe(newer.id);
      expect(line.thread!.map((t) => t.gmailId)).toEqual([older.id]);
      expect(line.body.length).toBeLessThanOrEqual(6001);
      expect(JSON.stringify(r.lines)).not.toContain("ya29");
      expect(JSON.stringify(r.lines)).not.toContain("Authorization");
    });
  });

  it("rate-limited run records ok skipped and calls nothing", async () => {
    await isolated(async (db) => {
      const deadline = new Date(NOW.getTime() + 10 * 60_000);
      await db.insert(schema.workerRuns).values({ worker: "gmail", status: "error",
        detail: { message: "429", retryAfter: deadline.toISOString() }, ranAt: NOW });
      const { factory, calls } = fakePort([msg({ from: "service@bungas.example" })]);
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.status).toBe("skipped");
      expect(calls.factory).toBe(0);
      const run = await lastRun(db);
      expect(run.status).toBe("ok");
      expect(run.detail).toEqual({ skipped: "rate-limited", retryAfter: deadline.toISOString() });
    });
  });

  for (const [name, input] of [
    ["missing", ""], ["comments only", "# nothing yet\n\n"], ["no usable address", "Hanneke\nBungas\n"],
    ["only seen ids", "seen:18c0ffee1234abcd\n"],
  ] as const) {
    it(`an empty or missing watchlist records an error and makes no Gmail call (${name})`, async () => {
      await isolated(async (db) => {
        const { factory, calls } = fakePort([msg({ from: "service@bungas.example" })]);
        const r = await watchMail({ db, port: factory, input, now: () => NOW });
        expect(r.status).toBe("error");
        expect(r.lines).toEqual([]);
        expect(calls.factory).toBe(0);
        const run = await lastRun(db);
        expect(run.status).toBe("error");
        expect(run.detail).toMatchObject({ reason: "empty-watchlist" });
      });
    });
  }

  it("a 429 is persisted where rateLimitedUntil reads it", async () => {
    await isolated(async (db) => {
      const deadline = new Date(NOW.getTime() + 15 * 60_000);
      const err = new Error(`User-rate limit exceeded.  Retry after ${deadline.toISOString()}`);
      const { factory } = fakePort([msg({ from: "service@bungas.example" })], { getError: err });
      const r = await watchMail({ db, port: factory, input: WATCH, now: () => NOW });
      expect(r.status).toBe("error");
      expect(r.lines).toEqual([]);
      expect((await lastRun(db)).detail).toMatchObject({ retryAfter: deadline.toISOString() });
      expect((await rateLimitedUntil(db, NOW))?.toISOString()).toBe(deadline.toISOString());
      // ...and the next run waits it out without touching Gmail.
      const next = fakePort([msg({ from: "service@bungas.example" })]);
      expect((await watchMail({ db, port: next.factory, input: WATCH, now: () => NOW })).status).toBe("skipped");
      expect(next.calls.factory).toBe(0);
    });
  });

  it("one bad message is reported and the rest still print", async () => {
    await isolated(async (db) => {
      const good = msg({ from: "service@bungas.example" });
      const missing = msg({ from: "service@bungas.example" });
      const { factory } = fakePort([good]);
      const port = await factory();
      const list = port.listMessageIds;
      port.listMessageIds = async (q) => [...(await list(q)), missing.id];
      const r = await watchMail({ db, port: async () => port, input: WATCH, now: () => NOW });
      expect(r.status).toBe("error");
      expect(r.lines.map((l) => l.gmailId)).toEqual([good.id]);
    });
  });
});

describe("proposals-store --external", () => {
  const deps = (db: Db) => ({ db, retrieveRefs: async () => [], vaultDir: "/nonexistent" });

  it("makes one drafting proposal per gmailId, priority other, with the sender's party", async () => {
    await isolated(async (db) => {
      const email = `service-${crypto.randomUUID()}@bungas.example`;
      const [party] = await db.insert(schema.parties)
        .values({ name: `Bungas Testfixture ${crypto.randomUUID()}`, kind: "organization", email }).returning();
      const m = msg({ from: `Bungas <${email}>`,
        attachments: [{ filename: "factuur.pdf", mime: "application/pdf", size: 4096 }] });
      const older = msg({ from: `Bungas <${email}>`, threadId: m.threadId });
      // Built with the watcher's own formatter rather than run through it: a
      // sender whose address IS a party's is relevant, so the watcher skips it
      // (ingest has it) — the party branch is reachable only by a party created
      // between the watch and the store.
      const line = toExternal(m, [older]);
      const first = await storeExternal(deps(db), JSON.stringify(line));
      expect(first.outcome).toBe("created");
      expect(first.seen.sort()).toEqual([m.id, older.id].sort());
      const again = await storeExternal(deps(db), JSON.stringify(line));
      expect(again).toMatchObject({ outcome: "exists", proposalId: first.proposalId });

      const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, first.proposalId!));
      expect(p).toMatchObject({ status: "drafting", priority: "other", kind: "reply", partyId: party.id,
        threadKey: `gmail:${m.threadId}` });
      const ctx = p.context as { addresses: string[]; thread: { id: string }[]; trigger: { text: string } };
      expect(ctx.addresses).toContain(email);
      expect(ctx.thread.map((t) => t.id)).toEqual([older.id, m.id]);
      expect(ctx.trigger.text).toContain("factuur.pdf");
    });
  });

  it("no party: the proposal has none, so the sent entry will have no participant", async () => {
    await isolated(async (db) => {
      const m = msg({ from: `Tikkie <noreply-${hex()}@tikkie.example>` });
      const [line] = (await watchMail({ db, port: async () => ({
        listMessageIds: async () => [m.id], getMessage: async () => m,
      }), input: "@tikkie.example\n", now: () => NOW })).lines;
      const r = await storeExternal(deps(db), JSON.stringify(line));
      const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, r.proposalId!));
      expect(p.partyId).toBeNull();
    });
  });

  it("refuses an unknown field or a malformed line, and marks nothing seen", async () => {
    await isolated(async (db) => {
      const base = { gmailId: hex(), threadId: hex(), messageId: null, from: "a@b.example", to: "",
        subject: "s", date: NOW.toISOString(), body: "b", attachments: [], thread: [] };
      for (const bad of ["not json", JSON.stringify({ ...base, token: "x" }),
        JSON.stringify({ ...base, gmailId: "../x" })]) {
        const r = await storeExternal(deps(db), bad);
        expect(r).toMatchObject({ outcome: "invalid", seen: [] });
      }
      const n = await db.select().from(schema.proposals)
        .where(and(eq(schema.proposals.priority, "other"), eq(schema.proposals.status, "drafting")));
      expect(n.filter((p) => (p.triggerExternal as { gmailId?: string } | null)?.gmailId === base.gmailId))
        .toEqual([]);
    });
  });
});
