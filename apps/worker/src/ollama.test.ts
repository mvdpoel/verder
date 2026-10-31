import { describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { settleDocumentTexts } from "./test-support/document-texts";
import { suggestDocMeta, suggestEntry, type LlmPort } from "./ollama";

// Spies on the one alert path (push.test.ts pins that push.ts no longer exports
// a sender of its own), so a suggestion that alerts fails "sends no push"
// below. The generic "something new to review" push is exactly the "nieuwe
// mail" push spec §6.4 forbids; priority mail gets its own push.
const alerts = vi.hoisted(() => ({ notify: vi.fn(async () => ({
  notificationId: null, duplicate: false, delivered: 0, failed: 0, skipped: 0 })) }));
vi.mock("./notify/notify", async (orig) => ({ ...(await orig<object>()), notify: alerts.notify }));

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

async function insertEmail(db: ReturnType<typeof createDb>["db"]) {
  const [raw] = await db.insert(schema.rawEmails).values({
    gmailMessageId: `eval-${crypto.randomUUID()}`, gmailThreadId: "t",
    fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
    subject: "Huurcontract opsturen", sentAt: new Date(),
    rawRfc822Sha256: "b".repeat(64),
    bodyText: "Beste Martin, stuur je huurcontract voor vrijdag op.",
  }).returning();
  return raw;
}

describe("suggestEntry", () => {
  it("stores a parsed LLM suggestion with model + prompt version", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => ({
      summary: "VerderGroep vraagt huurcontract",
      details: "Huurcontract voor vrijdag opsturen.",
      direction: "inbound",
      actionItems: [{ description: "Huurcontract opsturen", clarity: "clear" }] }) };
    await suggestEntry({ db, llm }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id));
    expect(s.status).toBe("pending");
    expect(s.promptVersion).toBe("entry-v1");
    expect((s.proposed as { summary: string }).summary).toContain("huurcontract".slice(0, 4));
    await pool.end();
  });

  it("falls back to needs-manual when the LLM fails", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await suggestEntry({ db, llm }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id))
      .orderBy(desc(schema.suggestions.createdAt)).limit(1);
    expect(s.status).toBe("needs-manual");
    expect((s.proposed as { summary: string }).summary).toBe("Huurcontract opsturen");
    await pool.end();
  });

  it("stores retrieval citations alongside the proposal, never inside it", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => ({
      summary: "VerderGroep vraagt huurcontract",
      details: "Huurcontract voor vrijdag opsturen.",
      direction: "inbound", actionItems: [] }) };
    const queries: string[] = [];
    await suggestEntry({
      db, llm,
      retrieveRefs: async (q) => {
        queries.push(q);
        return [{ entityType: "document",
          entityId: "22222222-2222-2222-2222-222222222222",
          title: "Huurcontract 2024", score: 0.03, snippet: "…huurcontract…" }];
      },
    }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id));
    expect(s.retrievedRefs).toHaveLength(1);
    expect((s.retrievedRefs as { title: string }[])[0].title).toBe("Huurcontract 2024");
    expect((s.proposed as Record<string, unknown>).retrievedRefs).toBeUndefined();
    // Retrieval sees subject AND body — the subject alone is too thin a query.
    expect(queries[0]).toContain("Huurcontract opsturen");
    expect(queries[0]).toContain("stuur je huurcontract");
    await pool.end();
  });

  it("stores citations on the needs-manual fallback too", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await suggestEntry({
      db, llm,
      retrieveRefs: async () => [{ entityType: "entry",
        entityId: "33333333-3333-3333-3333-333333333333",
        title: "Gesprek met bewindvoerder", score: 0.02, snippet: "…leefgeld…" }],
    }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id))
      .orderBy(desc(schema.suggestions.createdAt)).limit(1);
    expect(s.status).toBe("needs-manual");
    expect(s.retrievedRefs).toHaveLength(1);
    await pool.end();
  });
});

describe("no generic suggestion push", () => {
  it("suggestEntry sends no push", async () => {
    const { db, pool } = createDb(URL);
    alerts.notify.mockClear();
    const ok: LlmPort = { chatJson: async () => ({ summary: "s", details: "", direction: "inbound", actionItems: [] }) };
    const down: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await suggestEntry({ db, llm: ok }, (await insertEmail(db)).id);
    await suggestEntry({ db, llm: down }, (await insertEmail(db)).id);
    expect(alerts.notify.mock.calls.length).toBe(0);
    await pool.end();
  });

  it("suggestDocMeta sends no push", async () => {
    const { db, pool } = createDb(URL);
    alerts.notify.mockClear();
    const buf = Buffer.from(`docmeta-${crypto.randomUUID()}`);
    const sourceRef = `ollama-test-${crypto.randomUUID()}`;
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha256Hex(buf), sizeBytes: buf.length,
      mime: "application/pdf", title: `Testfixture ${crypto.randomUUID()}.pdf`,
      source: "upload", sourceRef, receivedAt: new Date() }).returning();
    // Shared-dev-DB hygiene: a fixture document with no document_texts row
    // would sit in pendingDocMeta's backlog forever.
    await settleDocumentTexts(db, sourceRef);
    const ok: LlmPort = { chatJson: async () => ({ title: "t", docType: null }) };
    await suggestDocMeta({ db, llm: ok, extractText: async () => "" }, doc.id, buf);
    expect(alerts.notify.mock.calls.length).toBe(0);
    await pool.end();
  });
});
