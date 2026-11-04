import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { entryFromProposed } from "../entry-from-proposed";

const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";
// Only to give a fixture document its extractor-`none` text row, which the app
// role cannot write (it would otherwise grow pendingDocMeta's backlog).
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://grip:grip@localhost:5432/grip";

/**
 * The voice quick-log (Plan 3 Task 24): a call Martin dictates on the phone
 * arrives as a PENDING log-entry suggestion and never as an entry. The dev DB
 * is shared and other test files append to the ledger in parallel, so "no
 * event" is asserted on everything appended since a recorded seq that could
 * belong to THIS call, never on the global count.
 */
describe("suggestions.createVoice", () => {
  let db: Db; let userId: string; let partyId: string; let partyName: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `v${crypto.randomUUID()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    partyName = `Verder Testfixture ${crypto.randomUUID()}`;
    const p = await caller().parties.create({ kind: "organization", name: partyName });
    partyId = p.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const anonCaller = () => appRouter.createCaller(createContext({ db, userId: null }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const headSeq = async () => {
    const r = await db.execute(sql`SELECT coalesce(max(seq), 0)::bigint AS s FROM ledger_events`);
    return Number(r.rows[0].s);
  };
  const eventsSince = (seq: number) =>
    db.select().from(schema.ledgerEvents).where(gt(schema.ledgerEvents.seq, seq));
  const entriesWithDetails = (details: string) =>
    db.select().from(schema.logEntries).where(eq(schema.logEntries.details, details));
  const voiceRows = (clientId: string) =>
    db.select().from(schema.suggestions).where(and(
      eq(schema.suggestions.promptVersion, "voice-v1"),
      sql`${schema.suggestions.proposed}->>'clientId' = ${clientId}`));
  const input = (over: Record<string, unknown> = {}) => ({
    clientId: crypto.randomUUID(), occurredAt: new Date("2026-11-01T10:15:00.000Z"),
    partyId, transcript: `Gebeld over de loonstroken ${crypto.randomUUID()}. Ze sturen een mail.`,
    ...over,
  });

  it("voice creates a pending log-entry suggestion and no entry", async () => {
    const before = await headSeq();
    const i = input();
    const res = await caller().suggestions.createVoice(i);
    expect(res.duplicate).toBe(false);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, res.id));
    expect(s.kind).toBe("log-entry");
    expect(s.status).toBe("pending");
    expect(s.model).toBe("apple-speech-on-device");
    expect(s.promptVersion).toBe("voice-v1");
    expect(s.rawEmailId).toBeNull();
    expect(s.resultEntryId).toBeNull();
    expect(s.proposed).toEqual({
      clientId: i.clientId, occurredAt: "2026-11-01T10:15:00.000Z", channel: "call",
      direction: "inbound", summary: i.transcript.split(". ")[0], details: i.transcript,
      participantPartyIds: [partyId], participantNames: [partyName],
      attachmentDocumentIds: [], actionItems: [],
    });
    // No entry, and nothing appended to the ledger for it.
    expect(await entriesWithDetails(i.transcript)).toHaveLength(0);
    const since = await eventsSince(before);
    expect(since.filter((e) => e.entityId === res.id || e.entityId === partyId)).toEqual([]);
  });

  it("kept audio appends exactly one document.ingested and no entry", async () => {
    const before = await headSeq();
    const clientId = crypto.randomUUID();
    const doc = await caller().documents.registerUpload({ sha256: sha(), sizeBytes: 2048,
      mime: "audio/mp4", title: "Gesprek.m4a", source: "phone-voice",
      sourceRef: `phone:${clientId}`, receivedAt: new Date() });
    const admin = createDb(ADMIN_URL).db;
    await admin.insert(schema.documentTexts).values({ documentId: doc.id, sha256: doc.sha256,
      text: "", extractor: "none", charCount: 0 });
    const i = input({ clientId, audioDocumentId: doc.id });
    const res = await caller().suggestions.createVoice(i);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, res.id));
    expect((s.proposed as { attachmentDocumentIds: string[] }).attachmentDocumentIds)
      .toEqual([doc.id]);
    expect(doc.source).toBe("phone-voice");
    const ours = (await eventsSince(before))
      .filter((e) => [doc.id, res.id, partyId].includes(e.entityId));
    expect(ours.map((e) => e.eventType)).toEqual(["document.ingested"]);
    expect(await entriesWithDetails(i.transcript)).toHaveLength(0);
  });

  it("same clientId twice gives one suggestion", async () => {
    const i = input();
    const one = await caller().suggestions.createVoice(i);
    const two = await caller().suggestions.createVoice({ ...i, transcript: "Iets anders." });
    expect(two.id).toBe(one.id);
    expect(two.duplicate).toBe(true);
    expect(await voiceRows(i.clientId)).toHaveLength(1);
  });

  it("two concurrent createVoice calls with one clientId give one suggestion", async () => {
    const i = input();
    // Two connections, so the two inserts really race rather than queue on one.
    const db2 = createDb(APP_URL).db;
    const c2 = appRouter.createCaller(createContext({ db: db2, userId }));
    const [a, b] = await Promise.all([
      caller().suggestions.createVoice(i), c2.suggestions.createVoice(i)]);
    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await voiceRows(i.clientId)).toHaveLength(1);
  });

  it("refuses an unknown party and an unknown audio document", async () => {
    await expect(caller().suggestions.createVoice(input({ partyId: crypto.randomUUID() })))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().suggestions.createVoice(
      input({ audioDocumentId: crypto.randomUUID() })))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an empty transcript and an anonymous caller", async () => {
    await expect(caller().suggestions.createVoice(input({ transcript: "   " }))).rejects.toThrow();
    await expect(anonCaller().suggestions.createVoice(input())).rejects.toThrow();
  });

  it("approval writes a manual entry with the picked party", async () => {
    const res = await caller().suggestions.createVoice(input());
    const s = await caller().suggestions.get({ id: res.id });
    const entry = entryFromProposed(s);
    expect(entry.source).toBe("manual");
    expect(entry.participantPartyIds).toEqual([partyId]);
    const { entryId } = await caller().suggestions.approveEntry({ id: res.id, entry });
    const [row] = await db.select().from(schema.logEntries)
      .where(eq(schema.logEntries.id, entryId));
    expect(row.source).toBe("manual");
    const parts = await db.select().from(schema.entryParticipants)
      .where(inArray(schema.entryParticipants.entryId, [entryId]));
    expect(parts.map((p) => p.partyId)).toEqual([partyId]);
  });
});
