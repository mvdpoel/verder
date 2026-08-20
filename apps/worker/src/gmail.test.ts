import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@verder/db";
import { readFilePath } from "@verder/api/src/storage";
import { pollGmail, type GmailPort } from "./gmail";

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
