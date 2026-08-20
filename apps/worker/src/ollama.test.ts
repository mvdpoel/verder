import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { suggestEntry, type LlmPort } from "./ollama";

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
    await suggestEntry({ db, llm, sendPush: async () => {} }, raw.id);
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
    await suggestEntry({ db, llm, sendPush: async () => {} }, raw.id);
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
      db, llm, sendPush: async () => {},
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
      db, llm, sendPush: async () => {},
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
