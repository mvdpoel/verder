/**
 * The three creditors that have written to Martin and are in no dossier.
 *
 * A separate file from case-history.ts because that file is already 850 lines
 * and this is a different subject; the same run because it is the same case and
 * wants the same idempotency discipline.
 *
 * PARTIES ARE DEDUPED BY NAME, not by email. case-history's PARTY_SEED keys on
 * email, which works there because every party in it has one. None of these
 * three creditors does — `eq(email, NULL)` is never true, so an email-keyed
 * guard would insert a fresh Kamer van Koophandel on every run, forever.
 *
 * Nothing here appends a ledger event except the party creation path, which is
 * case-history's existing one. Debts and both link tables are not evidence.
 */
import { asc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "@verder/api/src/ledger";

export interface DebtSeed {
  creditorName: string; // what the notice literally said
  claimedCents: number | null;
  principalCents?: number;
  references?: string;
  origin?: string;
  parties: {
    name: string; organization?: string; email?: string;
    role: "eiser" | "incasso" | "deurwaarder" | "gemachtigde";
  }[];
  doc?: string; // vault filename, linked when present
}

// These are facts about a real person's case — the amounts, invoice numbers,
// KVK numbers and dates are copied verbatim from the notices themselves.
export const DEBT_SEED: DebtSeed[] = [
  {
    creditorName: "Kamer van Koophandel",
    // The notice states an invoice number and a KVK number and NO total. NULL
    // says the notice did not say; 0 would say they claim nothing.
    claimedCents: null,
    references: "factuur 260194200, KVK 77463102",
    origin: "Aanmaning op OpsMate — een onderneming die op 22 april 2026 al was " +
      "uitgeschreven bij de KvK.",
    parties: [
      { name: "Kamer van Koophandel", organization: "KvK", role: "eiser" },
    ],
  },
  {
    creditorName: "PLM Investments II B.V.",
    claimedCents: 262315,
    principalCents: 219789,
    references: "26TNL-001031",
    origin: "Vordering gecedeerd door Qred. De hoofdsom van € 2.197,89 staat op " +
      "naam van OpsMate; het verschil is rente en kosten.",
    parties: [
      { name: "PLM Investments II B.V.", organization: "PLM Investments",
        role: "eiser" },
      { name: "Trust and Law Incassoservices", organization: "Trust and Law",
        email: "info@collections.trustandlaw.nl", role: "incasso" },
    ],
    doc: "Informatieblad vordering (nieuw).pdf",
  },
  {
    creditorName: "Het CAK",
    claimedCents: 114161,
    references: "3805606, 3900757",
    origin: "Er ligt al een vonnis. De sommatie spreekt over het voorkomen van " +
      "verdere uitvoering van de veroordeling.",
    parties: [
      { name: "Het CAK", organization: "CAK", role: "eiser" },
      { name: "Stam Gerechtsdeurwaarders", organization: "Stam",
        email: "info@stamdeurwaarders.nl", role: "deurwaarder" },
    ],
  },
];

/**
 * Case-insensitive party lookup by name — the whole reason this file does not
 * dedup on email. Oldest wins under duplicates, the same convention
 * `stopAnywhere` and the task lookup in case-history.ts use: without the
 * orderBy, LIMIT 1 on a name with more than one row has no stability
 * guarantee, and two runs could bind to two different rows.
 *
 * Exported (not inlined in applyCaseDebts) so the case-insensitivity claim can
 * be tested directly, against a row the test creates and cleans up itself,
 * rather than through applyCaseDebts — whose own seed accumulates exact-case
 * rows that would make a same-case lookup pass the test for the wrong reason.
 */
export async function findPartyByNameCI(db: Db, name: string) {
  const [row] = await db.select().from(schema.parties)
    .where(sql`lower(${schema.parties.name}) = lower(${name})`)
    .orderBy(asc(schema.parties.createdAt), asc(schema.parties.id)).limit(1);
  return row;
}

export async function applyCaseDebts(db: Db): Promise<{
  debts: string[]; parties: string[];
  debtParties: string[]; debtDocLinks: string[];
}> {
  const out = {
    debts: [] as string[], parties: [] as string[],
    debtParties: [] as string[], debtDocLinks: [] as string[],
  };

  // --- parties, deduped by name (case-insensitive), not email ----------------
  const partyIdByName = new Map<string, string>();
  const seedParties = new Map<string, DebtSeed["parties"][number]>();
  for (const d of DEBT_SEED) for (const p of d.parties) seedParties.set(p.name, p);

  for (const p of seedParties.values()) {
    const seen = await findPartyByNameCI(db, p.name);
    if (seen) {
      partyIdByName.set(p.name, seen.id);
      continue;
    }
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.parties).values({
        kind: "organization",
        name: p.name,
        organization: p.organization,
        email: p.email,
      }).returning();
      await appendLedgerEvent(tx, {
        eventType: "party.created", entityType: "party", entityId: row.id,
        payload: { id: row.id, kind: row.kind, name: row.name,
          organization: row.organization, email: row.email, phone: row.phone,
          notes: row.notes },
      });
      partyIdByName.set(p.name, row.id);
    });
    out.parties.push(p.name);
  }

  // --- documents, by filename --------------------------------------------------
  // Oldest wins under a duplicate title (the same rule case-history.ts's
  // documents lookup and this file's own party/debt lookups use): without the
  // orderBy, two vault rows sharing a title have no stable pick, and a later
  // run could bind the debt-document link to a different row than an earlier
  // run did, adding a second link under the (debt_id, document_id) unique key.
  const documents = await db.select().from(schema.documents)
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
  const docIdByTitle = new Map<string, string>();
  for (const d of documents) if (!docIdByTitle.has(d.title)) docIdByTitle.set(d.title, d.id);

  // --- debts, never updating amounts on an existing row -----------------------
  for (const seed of DEBT_SEED) {
    let [debt] = await db.select().from(schema.debts)
      .where(eq(schema.debts.creditorName, seed.creditorName))
      .orderBy(asc(schema.debts.createdAt), asc(schema.debts.id)).limit(1);
    if (!debt) {
      const eiser = seed.parties.find((p) => p.role === "eiser")!;
      [debt] = await db.insert(schema.debts).values({
        creditorPartyId: partyIdByName.get(eiser.name) ?? null,
        creditorName: seed.creditorName,
        principalCents: seed.principalCents ?? null,
        claimedCents: seed.claimedCents,
        references_: seed.references ?? null,
        origin: seed.origin ?? null,
      }).returning();
      out.debts.push(seed.creditorName);
    }

    for (const p of seed.parties) {
      const partyId = partyIdByName.get(p.name);
      if (!partyId) continue;
      const inserted = await db.insert(schema.debtParties).values({
        debtId: debt.id, partyId, role: p.role,
      }).onConflictDoNothing().returning();
      if (inserted.length > 0) out.debtParties.push(`${seed.creditorName}:${p.name}:${p.role}`);
    }

    if (seed.doc) {
      const documentId = docIdByTitle.get(seed.doc);
      if (documentId) {
        const inserted = await db.insert(schema.debtDocuments).values({
          debtId: debt.id, documentId,
        }).onConflictDoNothing().returning();
        if (inserted.length > 0) out.debtDocLinks.push(`${seed.creditorName}:${seed.doc}`);
      }
      // Else: skip silently. Fill-in-on-a-later-run, the same rule writeStop
      // uses — safe to run before or after a Gmail backfill.
    }
  }

  return out;
}
