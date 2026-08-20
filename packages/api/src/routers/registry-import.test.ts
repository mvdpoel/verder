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

/**
 * Same freshness trick for the BIFF8 workbook, but a binary container cannot be
 * round-tripped through a string: BIFF8 stores labels as UTF-16LE, so the
 * account-number token is patched IN PLACE with an equal-length replacement.
 * Length-preserving means no offset in the OLE2 container moves. The account
 * number is column 0, which `abnRowToParsed` ignores, so nothing this test
 * asserts on changes.
 */
function abnXlsFixture(): Buffer {
  const buf = Buffer.from(
    readFileSync(new URL("../../../parsers/fixtures/abn.xls", import.meta.url)));
  const from = Buffer.from("123456789", "utf16le");
  const to = Buffer.from(RUN.slice(-9), "utf16le"); // 9 chars in, 9 chars out
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) to.copy(buf, i);
  return buf;
}

/**
 * The OOXML workbook is a ZIP, whose entries carry CRC32s — patching a cell
 * would corrupt it. Freshness comes from the ZIP end-of-central-directory
 * COMMENT instead: trailing bytes the format reserves for exactly this, which
 * change the sha256 without touching a single sheet byte.
 */
function abnXlsxFixture(): Buffer {
  const raw = readFileSync(new URL("../../../parsers/fixtures/abn.xlsx", import.meta.url));
  const note = Buffer.from(`run-${RUN}`);
  const buf = Buffer.concat([raw, note]);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  buf.writeUInt16LE(note.length, eocd + 20); // EOCD comment length
  return buf;
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

  it("ingests ABN's Excel export, recording the mime the bytes actually are", async () => {
    const buf = abnXlsFixture();
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    // The real file arrives from ABN AMRO named .xlsx while being BIFF8 inside.
    const res = await caller().registry.import.ingest({
      sha256, filename: "abn.amro.afschriften.vanaf.april.2026.xlsx" });

    expect(res.source).toBe("abn-xls");
    expect(res.inserted).toBe(5); // 4 parsed rows + 1 parse-error row
    expect(res.errors).toBe(1);

    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    expect(doc.mime).toBe("application/vnd.ms-excel"); // NOT the .xlsx mime
  });

  it("records a genuine .xlsx under the OOXML mime, not the .xls one", async () => {
    const buf = abnXlsxFixture();
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    const res = await caller().registry.import.ingest({ sha256, filename: "statement.xlsx" });
    expect(res.source).toBe("abn-xls");
    expect(res.inserted).toBe(5);

    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    // one source, two containers: the mime follows the bytes
    expect(doc.mime)
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("registers an unreadable workbook as evidence before failing", async () => {
    // OLE2 magic, but not a workbook behind it.
    const buf = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const { sha256 } = await storeFile(process.env.VAULT_DIR!, buf);
    // A parser that throws is a bad upload, not a server fault: 400, not 500.
    await expect(caller().registry.import.ingest({ sha256, filename: "broken.xls" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256));
    expect(doc).toBeDefined(); // bytes on record beat clean failures
  });
});
