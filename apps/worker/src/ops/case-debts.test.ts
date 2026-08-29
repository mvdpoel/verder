import { describe, expect, it } from "vitest";
import { DEBT_SEED } from "./case-debts";

describe("case debts seed", () => {
  it("names exactly one eiser for every debt", () => {
    // The eiser is who the money is owed to. A debt with none is a debt with no
    // creditor; a debt with two is almost always the intermediary miscoded.
    for (const d of DEBT_SEED) {
      const eisers = d.parties.filter((p) => p.role === "eiser");
      expect(eisers, `${d.creditorName}`).toHaveLength(1);
    }
  });

  it("gives the two intermediated debts an intermediary", () => {
    const byName = new Map(DEBT_SEED.map((d) => [d.creditorName, d]));
    expect(byName.get("PLM Investments II B.V.")!.parties
      .find((p) => p.role === "incasso")?.name).toBe("Trust and Law Incassoservices");
    expect(byName.get("Het CAK")!.parties
      .find((p) => p.role === "deurwaarder")?.name).toBe("Stam Gerechtsdeurwaarders");
  });

  it("leaves the KvK amount unknown rather than calling it zero", () => {
    const kvk = DEBT_SEED.find((d) => d.creditorName === "Kamer van Koophandel")!;
    expect(kvk.claimedCents).toBeNull();
  });

  it("records the amounts and references that the notices actually state", () => {
    const plm = DEBT_SEED.find((d) => d.creditorName === "PLM Investments II B.V.")!;
    expect(plm.claimedCents).toBe(262315);
    expect(plm.principalCents).toBe(219789);
    expect(plm.references).toBe("26TNL-001031");
    const cak = DEBT_SEED.find((d) => d.creditorName === "Het CAK")!;
    expect(cak.claimedCents).toBe(114161);
  });

  it("reuses the intermediary parties the case already has, by exact name", () => {
    // Trust and Law and Stam are already in `parties` from PARTY_SEED. A name
    // that does not match theirs creates a second row for the same firm.
    const names = DEBT_SEED.flatMap((d) => d.parties.map((p) => p.name));
    expect(names).toContain("Trust and Law Incassoservices");
    expect(names).toContain("Stam Gerechtsdeurwaarders");
  });
});

// --- applyCaseDebts against the database --------------------------------------
//
// Everything above asserts the shape of the static seed. This is the part that
// actually exercises the dedup and the idempotency this task exists for — the
// admin connection is the same one case-history.ts's entry point uses (the
// script needs to write ledger_events, parties, debts, debt_parties and
// debt_documents in one run).
import { beforeAll, describe as describeDb, expect as expectDb, it as itDb } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { applyCaseDebts, findPartyByNameCI } from "./case-debts";

const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

describeDb("applyCaseDebts (database)", () => {
  let db: Db;
  beforeAll(() => { db = createDb(ADMIN_URL).db; });

  itDb("converges: a second run reports nothing new", async () => {
    await applyCaseDebts(db);
    const second = await applyCaseDebts(db);
    expectDb(second.debts).toEqual([]);
    expectDb(second.debtParties).toEqual([]);
    expectDb(second.debtDocLinks).toEqual([]);
  });

  itDb("leaves exactly one row for each of the five seed party names", async () => {
    // Exact string match, not case-insensitive: the case-insensitive-collision
    // test below deliberately leaves a differently-cased duplicate behind for
    // one of these names, and that is a separate concern from this one — did
    // the seed itself insert its own exact name only once.
    await applyCaseDebts(db);
    const names = new Set<string>();
    for (const d of DEBT_SEED) for (const p of d.parties) names.add(p.name);
    for (const name of names) {
      const rows = await db.select().from(schema.parties)
        .where(eq(schema.parties.name, name));
      expectDb(rows, name).toHaveLength(1);
    }
  });

  itDb("finds a differently-cased row it did not create, and cleans up after " +
    "itself", async () => {
    // Tests findPartyByNameCI directly rather than through applyCaseDebts: the
    // seed's own runs accumulate exact-case rows for its own names, so a plain
    // eq() lookup would find those and pass this test for the wrong reason (see
    // fix-round-2 notes in the report — this is exactly what happened here
    // before). A fresh, randomly-named row this test creates and deletes itself
    // is the only way to make the case-insensitivity claim actually falsifiable
    // and leave nothing behind.
    const base = `Findpartytest ${crypto.randomUUID()}`;
    const [inserted] = await db.insert(schema.parties)
      .values({ kind: "organization", name: base.toUpperCase() }).returning();
    try {
      const found = await findPartyByNameCI(db, base.toLowerCase());
      expectDb(found?.id).toBe(inserted.id);
    } finally {
      await db.delete(schema.parties).where(eq(schema.parties.id, inserted.id));
    }
  });

  itDb("never sets reportedToVerderAt, and appends no debt-ish ledger event", async () => {
    await applyCaseDebts(db);
    for (const seed of DEBT_SEED) {
      const [debt] = await db.select().from(schema.debts)
        .where(eq(schema.debts.creditorName, seed.creditorName))
        .orderBy(asc(schema.debts.createdAt), asc(schema.debts.id)).limit(1);
      expectDb(debt, seed.creditorName).toBeDefined();
      expectDb(debt.reportedToVerderAt, seed.creditorName).toBeNull();
    }
    const debtish = await db.select().from(schema.ledgerEvents)
      .where(sql`${schema.ledgerEvents.entityType} ILIKE '%debt%'`);
    expectDb(debtish).toEqual([]);
  });
});
