import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "./root";
import { createContext } from "./trpc";
import { addressesIn, loadTalkingPoints } from "./talking-points-load";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// raw_emails, document_texts and party_briefs are written by the WORKER in
// production, so the fixture writes them on that role too.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";
const RUN = crypto.randomUUID().slice(0, 8);
const DAY = 24 * 3600 * 1000;

describe("addressesIn", () => {
  it("reads bare and angle addresses, ASCII-folded", () => {
    expect(addressesIn("Ilse <Ilse@Noordkust.example>, team@noordkust.example"))
      .toEqual(["ilse@noordkust.example", "team@noordkust.example"]);
  });
  it("never takes an address out of a display name or a comment", () => {
    expect(addressesIn('"ilse@noordkust.example" <x@evil.example>')).toEqual(["x@evil.example"]);
    expect(addressesIn("x@evil.example (ilse@noordkust.example)")).toEqual(["x@evil.example"]);
  });
});

describe("loadTalkingPoints", () => {
  let db: Db; let writer: Db; let close: () => Promise<void>; let userId: string;
  let partyId: string; let contactEmail: string; let partyEmail: string;

  beforeAll(async () => {
    const c = createDb(APP_URL);
    const w = createDb(WORKER_URL);
    db = c.db; writer = w.db;
    close = async () => { await c.pool.end(); await w.pool.end(); };
    process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-talking-"));
    const [u] = await db.insert(schema.users)
      .values({ email: `talking-${RUN}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    partyEmail = `kantoor-${RUN}@noordkust.example`;
    contactEmail = `ilse-${RUN}@noordkust.example`;
    const party = await caller().parties.create({
      kind: "organization", name: `Bewindkantoor Testfixture ${RUN}`, email: partyEmail });
    partyId = party.id;
    await caller().parties.create({
      kind: "person", name: `Ilse Testfixture ${RUN}`, email: contactEmail, parentPartyId: partyId });
  });
  afterAll(() => close());

  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  async function mail(from: string, to: string, subject: string, sentAt: Date, thread: string) {
    const [r] = await writer.insert(schema.rawEmails).values({
      gmailMessageId: `tp-${RUN}-${crypto.randomUUID()}`, gmailThreadId: `tp-${RUN}-${thread}`,
      fromAddr: from, toAddr: to, subject, sentAt, rawRfc822Sha256: "0".repeat(64), bodyText: "",
      // Stamped, so a dev worker's outbox repair never enqueues an LLM job for a fixture.
      suggestQueuedAt: new Date(),
    }).returning();
    return r;
  }

  async function doc(title: string) {
    const sha = crypto.randomUUID().replaceAll("-", "").padEnd(64, "c");
    const d = await caller().documents.registerUpload({
      sha256: sha, sizeBytes: 10, mime: "application/pdf", title: `${title} ${RUN}`,
      source: "upload", sourceRef: `tp-${RUN}`, receivedAt: ago(1), partyId });
    // What storeDocumentText writes for an unreadable file: keeps the fixture
    // out of pendingDocMeta's backlog on the shared dev database.
    await writer.execute(sql`INSERT INTO document_texts (document_id, sha256, text, extractor, char_count)
      VALUES (${d.id}, ${sha}, '', 'none', 0)`);
    return d;
  }

  it("builds tell and ask from the dossier, never shows a discarded or purged document, and writes nothing", async () => {
    // Their request, five days ago — from the contact person, which counts for the office.
    await mail(`Ilse <${contactEmail}>`, "martin@vanderpoel.pro", "Graag uw loonstrook", ago(5), "req");
    // Martin's mail four days ago, unanswered: an ask. One a few hours ago: a tell.
    const silent = await mail("martin@vanderpoel.pro", partyEmail, "Stukken huur", ago(4), "silent");
    const fresh = await mail("martin@vanderpoel.pro", `Kantoor <${partyEmail}>`, "Loonstrook oktober", new Date(now.getTime() - 3 * 3600 * 1000), "fresh");
    // A spoofed display name is NOT them.
    await mail(`"${partyEmail}" <someone-${RUN}@evil.example>`, "martin@vanderpoel.pro", "Spoof", ago(1), "spoof");

    const waiting = await caller().tasks.create({ title: `Beschikking afwachten ${RUN}`, assigneePartyId: partyId });
    await caller().tasks.setStatus({ taskId: waiting.id, status: "waiting" });
    const done = await caller().tasks.create({ title: `Formulier ingevuld ${RUN}`, assigneePartyId: partyId });
    await caller().tasks.setStatus({ taskId: done.id, status: "done" });

    const debt = await caller().registry.debts.create({ creditorName: `Stroomnet Testfixture ${RUN}`, claimedCents: null });
    await caller().registry.debts.linkParty({ debtId: debt.id, partyId, role: "gemachtigde" });

    const filed = await doc("Brief");
    await caller().documents.update({ id: filed.id, status: "filed" });
    const discarded = await doc("Logo");
    await caller().documents.update({ id: discarded.id, status: "discarded" });
    const purged = await doc("Vernietigd");
    await caller().documents.update({ id: purged.id, status: "filed" });
    await caller().documents.purge({ id: purged.id, reason: "test" });

    const before = await db.execute(sql`SELECT count(*)::int AS n FROM ledger_events`);
    const r = await caller().parties.talkingPoints({ id: partyId });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM ledger_events`);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    expect(r.party).toEqual({ id: partyId, name: `Bewindkantoor Testfixture ${RUN}` });
    expect(r.ask.map((p) => p.id)).toEqual([
      `ask:task:${waiting.id}`, `ask:mail:${silent.id}`, `ask:debt:${debt.id}`]);
    expect(r.ask[1].text).toMatch(/^Nog geen antwoord op je mail van \d+ \w+: Stukken huur$/);
    const tellIds = r.tell.map((p) => p.id);
    expect(tellIds).toEqual(expect.arrayContaining([
      `tell:mail:${fresh.id}`, `tell:task:${done.id}`, `tell:document:${filed.id}`]));
    expect(tellIds).toHaveLength(3);
    const all = JSON.stringify(r);
    expect(all).not.toContain(discarded.id);
    expect(all).not.toContain(purged.id);
    expect(all).not.toContain("Spoof");
    expect(r.summary).toBeNull();
  });

  it("the AI line appears only once the brief is ready", async () => {
    await writer.insert(schema.partyBriefs).values({ partyId, status: "pending", summary: "Oud" })
      .onConflictDoUpdate({ target: schema.partyBriefs.partyId, set: { status: "pending", summary: "Oud" } });
    expect((await loadTalkingPoints(db, partyId)).summary).toBeNull();
    await writer.update(schema.partyBriefs).set({ status: "drafting" }).where(eq(schema.partyBriefs.partyId, partyId));
    expect((await loadTalkingPoints(db, partyId)).summary).toBeNull();
    await writer.update(schema.partyBriefs).set({
      status: "ready", summary: "Ilse vroeg om je loonstrook; die is onderweg.", model: "claude-cli test",
      promptVersion: "brief-v1", generatedAt: new Date(), sourceRefs: [{ type: "mail", id: "x" }],
    }).where(eq(schema.partyBriefs.partyId, partyId));
    expect((await loadTalkingPoints(db, partyId)).summary).toMatchObject({
      text: "Ilse vroeg om je loonstrook; die is onderweg.", ai: true, promptVersion: "brief-v1" });
  });

  it("an unknown party is NOT_FOUND", async () => {
    await expect(caller().parties.talkingPoints({ id: crypto.randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
