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
});
