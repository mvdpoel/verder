import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@grip/db";
import type { EmbedPort } from "@grip/api/src/search/embed";
import { ToolServer } from "./server";

// The real tools, through the real server (so through runReadOnly), as
// grip_worker, against fixtures in ONE rolled-back transaction per test.
const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";
let conn: { db: Db; pool: { end(): Promise<void> } };
beforeAll(() => { conn = createDb(URL); });
afterAll(async () => { await conn.pool.end(); });

class Rollback extends Error {}
async function isolated(fn: (db: Db, call: (name: string, args?: object) => Promise<Record<string, any>>) => Promise<void>) {
  try {
    await conn.db.transaction(async (raw) => {
      const db = raw as unknown as Db;
      const [r] = await db.insert(schema.requests).values({ clientId: uid(), text: "t", status: "working",
        claimedAt: new Date() }).returning();
      const embed: EmbedPort = { embed: async (t) => t.map(() => null) };
      const s = new ToolServer({ db, requestId: r.id, embed, gmail: async () => null, vaultDir: "/nonexistent",
        now: () => new Date("2032-05-01T00:00:00Z") });
      await fn(db, async (name, args = {}) => {
        const out = await s.call(name, args);
        if (out.isError) throw new Error(`${name}: ${out.text}`);
        return JSON.parse(out.text);
      });
      throw new Rollback();
    });
  } catch (err) { if (!(err instanceof Rollback)) throw err; }
}

const uid = () => crypto.randomUUID();
const TAG = () => `Toolfixture ${uid().slice(0, 8)}`;

async function doc(db: Db, title: string, extra: Partial<typeof schema.documents.$inferInsert> = {}) {
  const sha = (uid() + uid()).replaceAll("-", "");
  const [d] = await db.insert(schema.documents).values({ sha256: sha, title, mime: "application/pdf", sizeBytes: 2048,
    source: "upload", sourceRef: `tools-test-${uid()}`, receivedAt: new Date("2026-10-30T09:00:00Z"), ...extra }).returning();
  await db.insert(schema.documentTexts).values({ documentId: d.id, sha256: sha, text: `Tekst van ${title}`, extractor: "pdf-parse", charCount: 20 });
  return d;
}

describe("grip-tools: the dossier", () => {
  it("documents are read through the effective status: discarded and purged are never returned", async () => {
    await isolated(async (db, call) => {
      const tag = TAG();
      const live = await doc(db, `${tag} beschikking`);
      const gone = await doc(db, `${tag} logo`);
      const purged = await doc(db, `${tag} vernietigd`);
      await db.insert(schema.documentStatusChanges).values({ documentId: gone.id, status: "discarded" });
      await db.insert(schema.documentStatusChanges).values({ documentId: live.id, status: "filed", title: `${tag} Beschikking rechtbank`, docType: "beschikking" });
      const [u] = await db.insert(schema.users).values({ email: `tools-${uid()}@test.local`, name: "Martin" }).returning();
      await db.insert(schema.documentPurges).values({ documentId: purged.id, sha256: purged.sha256, sizeBytes: 2048,
        reason: "test", createdBy: u.id });
      const listed = await call("list_documents", { title: tag });
      expect(listed.items.map((d: { id: string }) => d.id)).toEqual([live.id]);
      expect(listed.items[0]).toMatchObject({ title: `${tag} Beschikking rechtbank`, soort: "beschikking" });
      expect((await call("get_document", { id: gone.id })).error).toMatch(/weggegooid/);
      const got = await call("get_document", { id: live.id });
      expect(got.document.id).toBe(live.id);
      expect(got.text).toContain("<<<DATA");
      expect(got.text).toContain("Tekst van");
    });
  });

  it("get_mail: strict addresses, attachments as live documents, HTML stripped, the reply subject", async () => {
    await isolated(async (db, call) => {
      const gid = `gm-${uid()}`;
      const [m] = await db.insert(schema.rawEmails).values({ gmailMessageId: gid, gmailThreadId: `th-${uid()}`,
        fromAddr: '"ilse@noordkust.example" <ilse.lookalike@evil.example>',
        toAddr: "Martin <martin@vanderpoel.pro>", subject: "Boedelbeschrijving", sentAt: new Date("2026-11-04T08:00:00Z"),
        rawRfc822Sha256: "0".repeat(64), bodyText: "<html><body><p>Beste Martin,</p><p>Graag de lijst.</p></body></html>" }).returning();
      const att = await doc(db, "Boedelformulier.pdf", { source: "email-attachment", sourceRef: gid });
      const thrown = await doc(db, "image.png", { source: "email-attachment", sourceRef: gid });
      await db.insert(schema.documentStatusChanges).values({ documentId: thrown.id, status: "discarded" });
      const got = await call("get_mail", { id: m.id });
      expect(got.mail).toMatchObject({ type: "mail", id: m.id, replySubject: "Re: Boedelbeschrijving" });
      // Parsed strictly: the display name is never read as an address, so the
      // decoy contributes nothing and the REAL sender is what Martin would see.
      expect(got.mail.addresses).not.toContain("ilse@noordkust.example");
      expect(got.mail.addresses).toEqual(["ilse.lookalike@evil.example", "martin@vanderpoel.pro"]);
      expect(got.attachments.map((a: { id: string }) => a.id)).toEqual([att.id]);
      expect(got.body.text).toContain("Beste Martin,");
      expect(got.body.text).not.toContain("<p>");
    });
  });

  it("list_transactions, list_debts (unknown stays unknown), get_party and list_entries", async () => {
    await isolated(async (db, call) => {
      const tag = TAG();
      const [p] = await db.insert(schema.parties).values({ kind: "organization", name: `UNHCR ${tag}`, email: `donor-${uid().slice(0, 6)}@unhcr.example` }).returning();
      const [contact] = await db.insert(schema.parties).values({ kind: "person", name: `Contact ${tag}`, parentPartyId: p.id }).returning();
      await db.insert(schema.transactions).values({ source: "abn-camt053", bookedAt: new Date("2026-10-15T10:00:00Z"),
        amountCents: -1000, counterpartyName: `UNHCR ${tag}`, description: `Incasso donatie ${tag}`,
        statementSha256: uid(), rowIndex: 0, accountIban: "NL00TEST0000000001" });
      const tx = await call("list_transactions", { counterparty: tag });
      expect(tx.items).toEqual([expect.objectContaining({ type: "transaction", amount: "-€ 10,00", amountCents: -1000 })]);
      const [d] = await db.insert(schema.debts).values({ creditorName: `KvK ${tag}`, creditorPartyId: p.id, claimedCents: null }).returning();
      await db.insert(schema.debtParties).values({ debtId: d.id, partyId: p.id, role: "eiser" });
      const debts = await call("list_debts", { partyId: p.id });
      expect(debts.items).toEqual([expect.objectContaining({ type: "debt", id: d.id, claimed: "onbekend",
        parties: [{ role: "eiser", type: "party", id: p.id, name: p.name }] })]);
      const party = await call("get_party", { id: p.id });
      expect(party.contacts.map((c: { id: string }) => c.id)).toEqual([contact.id]);
      expect(party.debts.map((x: { id: string }) => x.id)).toEqual([d.id]);

      const [u] = await db.insert(schema.users).values({ email: `tools-${uid()}@test.local`, name: "Martin" }).returning();
      const [old] = await db.insert(schema.logEntries).values({ occurredAt: new Date("2026-10-01T09:00:00Z"), channel: "call",
        direction: "outbound", summary: `Gebeld ${tag}`, source: "manual", createdBy: u.id }).returning();
      const [fix] = await db.insert(schema.logEntries).values({ occurredAt: new Date("2026-10-01T09:00:00Z"), channel: "call",
        direction: "outbound", summary: `Gebeld ${tag} (verbeterd)`, source: "manual", supersedesId: old.id, createdBy: u.id }).returning();
      const entries = await call("list_entries", { query: tag });
      expect(entries.items.map((e: { id: string }) => e.id)).toEqual([fix.id]);
      const mails = await call("list_mail", { partyId: contact.id });
      expect(mails.items).toEqual([]);
    });
  });

  it("gmail tools say Gmail is not configured instead of failing", async () => {
    await isolated(async (_db, call) => {
      expect((await call("gmail_search", { query: "from:x" })).unavailable).toMatch(/niet ingesteld/);
    });
  });
});
