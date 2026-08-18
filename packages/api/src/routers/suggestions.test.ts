import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("suggestions router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `s${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function makeSuggestion() {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t1",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Documents needed", sentAt: new Date(),
      rawRfc822Sha256: "a".repeat(64), bodyText: "Please send payslips.",
    }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, model: "qwen2.5:14b", promptVersion: "v1",
      proposed: { occurredAt: new Date().toISOString(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips", details: "June and July payslips requested.",
        participantNames: ["VerderGroep"], actionItems: [{ description: "Send payslips", clarity: "clear" }],
        attachmentDocumentIds: [] },
    }).returning();
    return s;
  }

  it("approveEntry creates a ledger-backed entry and marks status edited when changed", async () => {
    const s = await makeSuggestion();
    const c = caller();
    const res = await c.suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips June+July", // edited summary
        source: "gmail-watch", participantPartyIds: [], documentIds: [],
        actionItems: [{ description: "Send payslips", clarity: "clear" }] },
    });
    expect(res.entryId).toBeTruthy();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
    expect(after.resultEntryId).toBe(res.entryId);
    expect(after.finalPayload).toBeTruthy();
  });

  it("reject stores verdict without touching the ledger", async () => {
    const s = await makeSuggestion();
    await caller().suggestions.reject({ id: s.id, reason: "Not relevant" });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
  });
});
