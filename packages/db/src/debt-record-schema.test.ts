import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "./index";

// APP role: exercises the real grants (no UPDATE/DELETE on evidence tables).
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

let db: Db; let close: () => Promise<void>;
let appDb: Db; let appClose: () => Promise<void>;
beforeAll(() => {
  const c = createDb(process.env.DATABASE_URL
    ?? "postgres://verder:verder@localhost:5432/verder");
  db = c.db; close = () => c.pool.end();
  const a = createDb(APP_URL);
  appDb = a.db; appClose = () => a.pool.end();
});
afterAll(() => close());
afterAll(() => appClose());

async function aDebt(claimedCents: number | null) {
  const [d] = await db.insert(schema.debts)
    .values({ creditorName: "Testschuldeiser", claimedCents }).returning();
  return d;
}

describe("debt record", () => {
  it("records an amount the notice never stated", async () => {
    // The KvK aanmaning names an invoice number and no total. `0` would assert
    // they claim nothing, which is false; NULL says the notice did not say.
    const d = await aDebt(null);
    expect(d.claimedCents).toBeNull();
  });

  it("carries a creditor and the intermediary collecting for them", async () => {
    const d = await aDebt(262315);
    const [eiser] = await db.insert(schema.parties)
      // Not the real creditor's name: applyCaseDebts (case-debts.ts) dedups a
      // debt/party BY NAME, so a fixture literally named "PLM Investments II
      // B.V." would make that seed bind to this test row forever, in any dev
      // database this suite has run against.
      .values({ kind: "organization", name: `PLM Investments Testfixture ${crypto.randomUUID()}` })
      .returning();
    const [incasso] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Trust and Law" }).returning();
    await db.insert(schema.debtParties).values([
      { debtId: d.id, partyId: eiser.id, role: "eiser" },
      { debtId: d.id, partyId: incasso.id, role: "incasso" },
    ]);
    const links = await db.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(links.map((l) => l.role).sort()).toEqual(["eiser", "incasso"]);
  });

  it("refuses the same party in the same role twice on one debt", async () => {
    const d = await aDebt(100);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Dubbel" }).returning();
    await db.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "eiser" });
    await expect(db.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "eiser" }))
      .rejects.toThrow(/debt_party_uq/);
  });

  it("lets one party act in two roles on one debt", async () => {
    // A deurwaarder that is also the claimant is a real thing; the unique index
    // is on (debt, party, role) and must not collapse it to (debt, party).
    const d = await aDebt(100);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Beide rollen" }).returning();
    await db.insert(schema.debtParties).values([
      { debtId: d.id, partyId: p.id, role: "eiser" },
      { debtId: d.id, partyId: p.id, role: "deurwaarder" },
    ]);
    const links = await db.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(links).toHaveLength(2);
  });

  it("hangs a document on the debt itself, not only on a decision", async () => {
    const d = await aDebt(100);
    const [doc] = await db.insert(schema.documents).values({
      sha256: `test-${d.id}`, title: "Informatieblad vordering.pdf",
      mime: "application/pdf", sizeBytes: 1, source: "upload",
      receivedAt: new Date(),
    }).returning();
    await db.insert(schema.debtDocuments)
      .values({ debtId: d.id, documentId: doc.id });
    const links = await db.select().from(schema.debtDocuments)
      .where(eq(schema.debtDocuments.debtId, d.id));
    expect(links).toHaveLength(1);
  });

  it("records whether Verder knows, and NULL means not yet", async () => {
    const d = await aDebt(114161);
    expect(d.reportedToVerderAt).toBeNull();
    await db.update(schema.debts)
      .set({ reportedToVerderAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(schema.debts.id, d.id));
    const [after] = await db.select().from(schema.debts)
      .where(eq(schema.debts.id, d.id));
    expect(after.reportedToVerderAt).not.toBeNull();
  });

  it("makes a contact person belong to an organisation", async () => {
    const [org] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Incassokantoor" }).returning();
    const [person] = await db.insert(schema.parties).values({
      kind: "person", name: "J. de Vries", parentPartyId: org.id,
    }).returning();
    expect(person.parentPartyId).toBe(org.id);
  });

  it("refuses a party that is its own parent", async () => {
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "Ouroboros" }).returning();
    await expect(db.update(schema.parties)
      .set({ parentPartyId: p.id }).where(eq(schema.parties.id, p.id)))
      .rejects.toThrow(/parties_no_self_parent_ck/);
  });

  it("lets the app role unlink a party, and still refuses to delete evidence", async () => {
    // The one place DELETE is granted. registry_decisions must stay untouchable.
    const d = await aDebt(100);
    const [p] = await appDb.insert(schema.parties)
      .values({ kind: "organization", name: "Verkeerd gekoppeld" }).returning();
    await appDb.insert(schema.debtParties)
      .values({ debtId: d.id, partyId: p.id, role: "incasso" });
    await appDb.delete(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id));
    expect(await appDb.select().from(schema.debtParties)
      .where(eq(schema.debtParties.debtId, d.id))).toHaveLength(0);

    await expect(appDb.delete(schema.registryDecisions)
      .where(eq(schema.registryDecisions.id, crypto.randomUUID())))
      .rejects.toThrow(/permission denied/);
  });
});
