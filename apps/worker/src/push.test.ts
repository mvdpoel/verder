import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { sendPush, type PushTransport } from "./push";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("sendPush", () => {
  it("sends to live subscriptions and revokes dead ones", async () => {
    const { db, pool } = createDb(URL);
    const [live] = await db.insert(schema.pushSubscriptions).values({
      endpoint: `https://push.example/${crypto.randomUUID()}`, p256dh: "k", auth: "a" }).returning();
    const [dead] = await db.insert(schema.pushSubscriptions).values({
      endpoint: `https://push.example/dead-${crypto.randomUUID()}`, p256dh: "k", auth: "a" }).returning();
    const sent: string[] = [];
    const transport: PushTransport = { send: async (sub) => {
      if (sub.endpoint.includes("dead")) { const e = new Error("gone") as Error & { statusCode: number }; e.statusCode = 410; throw e; }
      sent.push(sub.endpoint); } };
    await sendPush(db, { title: "t", body: "b" }, transport);
    expect(sent).toContain(live.endpoint);
    const [deadAfter] = await db.select().from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.id, dead.id));
    expect(deadAfter.revoked).toBe(true);
    await pool.end();
  });
});
