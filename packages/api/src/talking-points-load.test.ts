import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@grip/db";
import { appRouter } from "./root";
import { createContext } from "./trpc";
import { addressesIn, loadTalkingPoints } from "./talking-points-load";
import * as pure from "./talking-points";

// The loader's OWN discard/purge filter is tested on what it hands the pure
// half, not only on the final answer: buildTalkingPoints re-checks discarded
// and purged as a second guard, so an assertion on the output alone passes
// with the loader's SQL filter removed. The spy wraps the real function.
vi.mock("./talking-points", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./talking-points")>();
  return { ...orig, buildTalkingPoints: vi.fn(orig.buildTalkingPoints) };
});

const APP_URL = "postgres://grip_app:grip_app@localhost:5432/grip";
// raw_emails, document_texts and party_briefs are written by the WORKER in
// production, so the fixture writes them on that role too.
const WORKER_URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";
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

  /** An upload linked to the party by default; `via` makes it an attachment of that mail instead, with no party. */
  async function doc(title: string, via?: { gmailMessageId: string }) {
    const sha = crypto.randomUUID().replaceAll("-", "").padEnd(64, "c");
    const d = await caller().documents.registerUpload({
      sha256: sha, sizeBytes: 10, mime: "application/pdf", title: `${title} ${RUN}`,
      ...(via
        ? { source: "email-attachment" as const, sourceRef: via.gmailMessageId }
        : { source: "upload" as const, sourceRef: `tp-${RUN}`, partyId }),
      receivedAt: ago(1) });
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
    // The path a thrown-away document can REALLY leak by: an attachment of
    // Martin's own mail to them is listed as "sent" whatever its status, so
    // only the loader's discard/purge filter keeps these two off the screen.
    // `kept` is the control that proves the path is reached at all.
    const kept = await doc("Huurcontract", silent);
    const sentDiscarded = await doc("Handtekening", silent);
    await caller().documents.update({ id: sentDiscarded.id, status: "discarded" });
    const sentPurged = await doc("Paspoort", silent);
    await caller().documents.purge({ id: sentPurged.id, reason: "test" });
    vi.mocked(pure.buildTalkingPoints).mockClear();

    const before = await db.execute(sql`SELECT count(*)::int AS n FROM ledger_events`);
    const r = await caller().parties.talkingPoints({ id: partyId });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM ledger_events`);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // The call sheet's "Bel" dials the party's own number; the fixture party has none.
    expect(r.party).toEqual({ id: partyId, name: `Bewindkantoor Testfixture ${RUN}`, phone: null });
    expect(r.ask.map((p) => p.id)).toEqual([
      `ask:task:${waiting.id}`, `ask:mail:${silent.id}`, `ask:debt:${debt.id}`]);
    expect(r.ask[1].text).toMatch(/^Nog geen antwoord op je mail van \d+ \w+: Stukken huur$/);
    const tellIds = r.tell.map((p) => p.id);
    expect(tellIds).toEqual(expect.arrayContaining([
      `tell:mail:${fresh.id}`, `tell:task:${done.id}`, `tell:document:${filed.id}`, `tell:document:${kept.id}`]));
    expect(tellIds).toHaveLength(4);
    const all = JSON.stringify(r);
    for (const gone of [discarded.id, purged.id, sentDiscarded.id, sentPurged.id]) expect(all).not.toContain(gone);
    // …and the loader itself never handed them on (the pure re-check is the second guard, not the first).
    const input = vi.mocked(pure.buildTalkingPoints).mock.calls.at(-1)![0];
    const handed = input.documents.map((d) => d.id);
    expect(handed).toContain(kept.id);
    expect(input.documents.find((d) => d.id === kept.id)?.how).toBe("sent");
    for (const gone of [discarded.id, purged.id, sentDiscarded.id, sentPurged.id]) expect(handed).not.toContain(gone);
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
