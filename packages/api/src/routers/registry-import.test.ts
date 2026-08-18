import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { storeFile } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// Fixtures live in @verder/parsers (source of truth for the formats). The
// shared dev DB is never truncated, so every run must produce fresh
// statement sha256s: we swap a constant token in the fixture for a per-run
// unique one. The swapped token is in ignored/free-text columns only, so
// row/error counts and parsed fields stay exactly those of the fixture.
const RUN = Date.now().toString();

function abnTsvFixture(): Buffer {
  const raw = readFileSync(new URL("../../../parsers/fixtures/abn.tsv", import.meta.url));
  // latin1 round-trip preserves the 0xE9 'é' byte the fixture exercises
  return Buffer.from(raw.toString("latin1").replaceAll("123456789", RUN), "latin1");
}

describe("registry.import", () => {
  let db: Db;
  let userId: string;
  beforeAll(async () => {
    process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "verder-import-vault-"));
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `import${RUN}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("ingests a vaulted ABN TSV statement: rows + parse-error rows, document registered", async () => {
    const buf = abnTsvFixture();
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    const c = caller();
    const res = await c.registry.import.ingest({ sha256, filename: "abn-juli.tsv" });
    expect(res).toEqual({
      statementSha256: sha256, inserted: 5, skipped: 0, errors: 1, source: "abn-tsv",
    });

    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.statementSha256, sha256))
      .orderBy(schema.transactions.rowIndex);
    expect(rows).toHaveLength(5);
    // parsed row values survive the trip into the fact table
    expect(rows[0]).toMatchObject({
      source: "abn-tsv", rowIndex: 0, amountCents: -7250, parseError: false,
      counterpartyName: "Ziggo Services BV", counterpartyIban: "NL66INGB0007654321",
      mandateId: "NL-MND-0012345",
    });
    expect(rows[0].bookedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(rows[3].amountCents).toBe(-123456); // NL thousands "-1.234,56"
    // the malformed line is kept, flagged, raw text preserved, never dropped
    const errRow = rows[4];
    expect(errRow.parseError).toBe(true);
    expect(errRow.rowIndex).toBe(4);
    expect(errRow.amountCents).toBe(0);
    expect(errRow.rawRow).toContain("kapot");

    // vault-first evidence: the statement is a document with a ledger event
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    expect(doc).toMatchObject({
      title: "abn-juli.tsv", docType: "bank-statement", source: "upload",
      sizeBytes: buf.length,
    });
    const events = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.entityId, doc.id),
        eq(schema.ledgerEvents.eventType, "document.ingested")));
    expect(events).toHaveLength(1);
  });

  it("re-ingest is idempotent: every row skipped, no duplicate document event", async () => {
    const buf = abnTsvFixture();
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    const c = caller();
    const res = await c.registry.import.ingest({ sha256, filename: "abn-juli.tsv" });
    expect(res).toEqual({
      statementSha256: sha256, inserted: 0, skipped: 5, errors: 1, source: "abn-tsv",
    });
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.statementSha256, sha256));
    expect(rows).toHaveLength(5);
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    const events = await db.select().from(schema.ledgerEvents)
      .where(and(eq(schema.ledgerEvents.entityId, doc.id),
        eq(schema.ledgerEvents.eventType, "document.ingested")));
    expect(events).toHaveLength(1);
  });

  it("rejects a file that is not in the vault yet (vault-first, no side effects)", async () => {
    const missing = "0".repeat(63) + "1";
    await expect(caller().registry.import.ingest({ sha256: missing, filename: "ghost.tsv" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.statementSha256, missing));
    expect(rows).toHaveLength(0);
  });

  it("unknown format: file stays registered as evidence, ingest fails loudly, no rows", async () => {
    const buf = Buffer.from(`totally not a statement ${RUN}\njust prose\n`);
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    await expect(caller().registry.import.ingest({ sha256, filename: "notes.dat" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    // evidence-first: the uploaded bytes are still on record as a document
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    expect(doc).toMatchObject({ title: "notes.dat", docType: "bank-statement" });
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.statementSha256, sha256));
    expect(rows).toHaveLength(0);
  });

  it("list groups past imports by statement with counts and the document title", async () => {
    const buf = abnTsvFixture();
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    await caller().registry.import.ingest({ sha256, filename: "abn-juli.tsv" });
    const list = await caller().registry.import.list();
    const mine = list.find((g) => g.statementSha256 === sha256);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      statementSha256: sha256, source: "abn-tsv", total: 5, errors: 1,
      documentTitle: "abn-juli.tsv",
    });
    expect(mine!.documentId).toBeTruthy();
  });

  it("ingests a PayPal CSV (BOM + Completed-only) through the same path", async () => {
    const raw = readFileSync(new URL("../../../parsers/fixtures/paypal.csv", import.meta.url));
    // Transaction IDs are free-form — swapping in the run id gives a fresh sha
    const buf = Buffer.from(
      raw.toString("utf8").replaceAll("7AB12345CD6789012", `RUN${RUN}`), "utf8");
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    const res = await caller().registry.import.ingest({ sha256, filename: "paypal.csv" });
    expect(res.source).toBe("paypal-csv");
    expect(res.inserted).toBe(4); // 3 parsed rows + 1 error row
    expect(res.errors).toBe(1);
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.statementSha256, sha256));
    expect(rows.filter((r) => r.parseError)).toHaveLength(1);
  });
});
