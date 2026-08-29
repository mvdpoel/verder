import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { pollGmail, retryAfterFrom, buildQueries, type GmailPort } from "./gmail";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

function makeMsg(id: string) {
  return {
    id, threadId: "t-1", from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
    subject: "Please send your rental contract", sentAt: new Date(),
    bodyText: "Beste Martin, graag je huurcontract opsturen.",
    raw: Buffer.from(`raw-${id}`),
    attachments: [{ filename: "checklist.pdf", mime: "application/pdf", data: Buffer.from(`pdf-${id}`) }],
  };
}

function fakeGmail(id: string): GmailPort {
  const msg = makeMsg(id);
  return { listMessageIds: async () => [id], getMessage: async () => msg };
}

describe("pollGmail", () => {
  it("ingests raw email + attachment and enqueues suggestion, idempotently", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const enqueued: string[] = [];
    const deps = { db, gmail: fakeGmail(`m-${Date.now()}`), vaultDir,
      enqueueSuggest: async (x: string) => { enqueued.push(x); } };
    const first = await pollGmail(deps);
    const second = await pollGmail(deps);
    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);          // idempotent
    expect(enqueued).toHaveLength(1);
    const [raw] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, enqueued[0]));
    expect(raw.subject).toContain("rental contract");
    // Legal-evidence requirement (spec: persist raw message with full headers
    // *before* AI runs): the canonical RFC822 bytes must live in the vault at
    // the content-addressed path of the stored hash, not just as a hash that
    // is only verifiable while Gmail retains the message.
    const storedRaw = readFileSync(readFilePath(vaultDir, raw.rawRfc822Sha256));
    expect(storedRaw.toString()).toBe(`raw-${raw.gmailMessageId}`);
    const docs = await db.select().from(schema.documents)
      .where(eq(schema.documents.sourceRef, raw.gmailMessageId));
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("email-attachment");
    await pool.end();
  });

  it("re-enqueues the suggest job on a later poll when the enqueue failed after commit", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const id = `m-outbox-${Date.now()}`;
    // First poll: ingest commits, but the enqueue fails (pg-boss down / crash).
    await pollGmail({ db, gmail: fakeGmail(id), vaultDir,
      enqueueSuggest: async () => { throw new Error("pg-boss send failed"); },
    }).catch(() => { /* per-message failures must not lose the commit */ });
    const [raw] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, id));
    expect(raw).toBeDefined();                 // email was committed
    expect(raw.suggestQueuedAt).toBeNull();    // but the enqueue is still owed
    // Recovery poll: same message is seen, yet the suggest job must be enqueued.
    const enqueued: string[] = [];
    await pollGmail({ db, gmail: fakeGmail(id), vaultDir,
      enqueueSuggest: async (x: string) => { enqueued.push(x); } });
    expect(enqueued).toEqual([raw.id]);
    const [repaired] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, raw.id));
    expect(repaired.suggestQueuedAt).not.toBeNull();
    await pool.end();
  });

  it("records the parts the port skipped in the gmail worker run", async () => {
    // The skip is the one irreversible step in the whole pipeline: pollGmail
    // short-circuits on a seen gmailMessageId, so a message whose attachment
    // was wrongly skipped is never fetched again. It has to leave a trace
    // somewhere Martin can read — worker_runs is where every other gmail
    // anomaly already surfaces.
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const id = `m-skip-${Date.now()}`;
    const msg = { ...makeMsg(id),
      skippedParts: [{ filename: "image.png", mime: "image/png", contentId: "<ii_abc>" }] };
    await pollGmail({ db, vaultDir, enqueueSuggest: async () => {},
      gmail: { listMessageIds: async () => [id], getMessage: async () => msg } });

    const runs = await db.select().from(schema.workerRuns);
    const detail = runs.filter((r) => r.worker === "gmail")
      .map((r) => JSON.stringify(r.detail))
      .filter((d) => d.includes(id));
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.some((d) => d.includes("image.png") && d.includes("ii_abc"))).toBe(true);
    await pool.end();
  });

  it("isolates a failing message so healthy messages still ingest", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const badId = `m-bad-${Date.now()}`;
    const goodId = `m-good-${Date.now()}`;
    const gmail: GmailPort = {
      listMessageIds: async () => [badId, goodId],
      getMessage: async (mid) => {
        if (mid === badId) throw new Error("deterministic fetch failure");
        return makeMsg(mid);
      },
    };
    const enqueued: string[] = [];
    const result = await pollGmail({ db, gmail, vaultDir,
      enqueueSuggest: async (x: string) => { enqueued.push(x); } });
    expect(result.ingested).toBe(1);           // the healthy message got through
    const [good] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.gmailMessageId, goodId));
    expect(good).toBeDefined();
    expect(enqueued).toEqual([good.id]);
    // The failure is still surfaced on the dashboard via worker_runs.
    const runs = await db.select().from(schema.workerRuns);
    const errorRuns = runs.filter((r) => r.worker === "gmail" && r.status === "error"
      && JSON.stringify(r.detail).includes(badId));
    expect(errorRuns.length).toBeGreaterThan(0);
    await pool.end();
  });
});

describe("Gmail rate-limit backoff", () => {
  const RATE_LIMIT = (iso: string) =>
    new Error(`User-rate limit exceeded.  Retry after ${iso}`);

  it("reads the retry instant out of the error text, and only out of a 429", () => {
    expect(retryAfterFrom(RATE_LIMIT("2026-08-22T21:26:14.735Z"))?.toISOString())
      .toBe("2026-08-22T21:26:14.735Z");
    // Anything else must NOT set a deadline — a network blip that muted the
    // poller for fifteen minutes would be a worse bug than the one this fixes.
    expect(retryAfterFrom(new Error("socket hang up"))).toBeNull();
    expect(retryAfterFrom(new Error("Retry after soon"))).toBeNull();
  });

  it("records the deadline on a 429, then SKIPS the next poll instead of re-arming it", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const soon = new Date(Date.now() + 15 * 60_000).toISOString();
    let listCalls = 0;
    const limited: GmailPort = {
      listMessageIds: async () => { listCalls++; throw RATE_LIMIT(soon); },
      getMessage: async () => { throw new Error("unreachable"); },
    };
    const deps = { db, gmail: limited, vaultDir, enqueueSuggest: async () => {} };

    await expect(pollGmail(deps)).rejects.toThrow(/User-rate limit/);
    expect(listCalls).toBe(1);

    // The whole point: the second poll must not touch the API at all. Every
    // attempt against a live limit pushes the deadline out another fifteen
    // minutes, which is how one 429 became permanent in production.
    const second = await pollGmail(deps);
    expect(second.ingested).toBe(0);
    expect(listCalls).toBe(1);

    // ...and the skip carries the deadline forward. Reading the LATEST run is
    // how the memory works, so a skip that dropped it would let the very next
    // tick poll straight back into the limit.
    const third = await pollGmail(deps);
    expect(listCalls).toBe(1);
    expect(third.ingested).toBe(0);

    const [latest] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "gmail"))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
    expect(latest.status).toBe("ok");          // waiting correctly is not a failure
    expect((latest.detail as { retryAfter: string }).retryAfter).toBe(soon);
    await pool.end();
  });

  it("polls again once the deadline has passed", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const past = new Date(Date.now() - 1000).toISOString();
    await db.insert(schema.workerRuns).values({
      worker: "gmail", status: "error",
      detail: { message: "old", retryAfter: past },
    });
    const id = `m-after-${Date.now()}`;
    const result = await pollGmail({ db, gmail: fakeGmail(id), vaultDir,
      enqueueSuggest: async () => {} });
    expect(result.ingested).toBe(1);
    await pool.end();
  });

  it("does not mute the poller on an ordinary failure", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    let listCalls = 0;
    const flaky: GmailPort = {
      listMessageIds: async () => { listCalls++; throw new Error("socket hang up"); },
      getMessage: async () => { throw new Error("unreachable"); },
    };
    const deps = { db, gmail: flaky, vaultDir, enqueueSuggest: async () => {} };
    await expect(pollGmail(deps)).rejects.toThrow(/socket hang up/);
    await expect(pollGmail(deps)).rejects.toThrow(/socket hang up/);
    expect(listCalls).toBe(2);                 // tried again, as it should
    await pool.end();
  });
});

describe("buildQueries", () => {
  it("searches BOTH directions, so mail Martin sent TO a party is found too", () => {
    const [q] = buildQueries("newer_than:7d", ["case@verdergroep.nl"]);
    expect(q).toContain("newer_than:7d");
    expect(q).toContain("from:(case@verdergroep.nl)");
    expect(q).toContain("to:(case@verdergroep.nl)");
  });

  // A Gmail `q` is finite and the creditor list only grows. Chunking keeps the
  // filter server-side; the alternative is silently falling back to fetching
  // everything, which is the bug this whole change exists to remove.
  it("chunks a long address list, covering every address exactly once", () => {
    const addrs = Array.from({ length: 40 }, (_, i) => `creditor${i}@example.com`);
    const queries = buildQueries("newer_than:7d", addrs);
    expect(queries.length).toBeGreaterThan(1);
    for (const a of addrs) {
      expect(queries.filter((q) => q.includes(a))).toHaveLength(1);
    }
    for (const q of queries) expect(q.length).toBeLessThan(1800);
  });

  // THE TRAP: an empty list must yield NO query. Returning the bare window
  // would match the entire mailbox — exactly the burn being fixed.
  it("returns nothing to poll when there is nobody to watch", () => {
    expect(buildQueries("newer_than:7d", [])).toEqual([]);
  });
});

describe("pollGmail asks Gmail to do the filtering", () => {
  it("sends a sender-scoped query instead of the bare time window", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const seen: string[] = [];
    await pollGmail({ db, vaultDir, enqueueSuggest: async () => {},
      gmail: { listMessageIds: async (q) => { seen.push(q); return []; },
               getMessage: async () => { throw new Error("must not fetch"); } } });
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) {
      expect(q).toContain("newer_than:7d");
      expect(q).toContain("from:(");
      expect(q).toContain("to:(");
    }
    await pool.end();
  });

  it("ingests mail Martin SENT to a party, not only mail received from one", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const email = `creditor-${Date.now()}@stam-incasso.nl`;
    await db.insert(schema.parties).values({ kind: "organization", name: "Stam", email });
    const id = `m-sent-${Date.now()}`;
    const msg = { ...makeMsg(id), from: "martin@vanderpoel.pro", to: email,
      subject: "Bijgaand de gevraagde stukken" };
    const enqueued: string[] = [];
    const res = await pollGmail({ db, vaultDir,
      enqueueSuggest: async (x) => { enqueued.push(x); },
      gmail: { listMessageIds: async () => [id], getMessage: async () => msg } });
    expect(res.ingested).toBe(1);
    expect(enqueued).toHaveLength(1);
    await pool.end();
  });

  it("fetches a message once even when several chunked queries return it", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const id = `m-dupe-${Date.now()}`;
    let fetches = 0;
    await pollGmail({ db, vaultDir, enqueueSuggest: async () => {},
      gmail: { listMessageIds: async () => [id, id],
               getMessage: async () => { fetches++; return makeMsg(id); } } });
    expect(fetches).toBe(1);
    await pool.end();
  });
});
