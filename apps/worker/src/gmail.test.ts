import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@verder/db";
import { pollGmail, type GmailPort } from "./gmail";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

function fakeGmail(id: string): GmailPort {
  const msg = {
    id, threadId: "t-1", from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
    subject: "Please send your rental contract", sentAt: new Date(),
    bodyText: "Beste Martin, graag je huurcontract opsturen.",
    raw: Buffer.from(`raw-${id}`),
    attachments: [{ filename: "checklist.pdf", mime: "application/pdf", data: Buffer.from(`pdf-${id}`) }],
  };
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
    const docs = await db.select().from(schema.documents)
      .where(eq(schema.documents.sourceRef, raw.gmailMessageId));
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("email-attachment");
    await pool.end();
  });
});
