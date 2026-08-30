import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb, schema, type Db } from "./index";

// A new file rather than an addition to bundles-schema.test.ts: that file
// asserts grants and CHECK constraints on the schema 0032 changed, and this
// migration changes no schema at all — it is one UPDATE, and what needs
// pinning is the extraction rule inside it, not a table shape.
//
// Admin role, not verder_app: this file inserts and deletes `parties` rows
// directly, and parties is an evidence table (INSERT + SELECT only for the
// app/worker roles) — the same reason debt-record-schema.test.ts and
// raw-emails-source.test.ts run their fixture cleanup as `verder`.
const ADMIN_URL = "postgres://verder:verder@localhost:5432/verder";

// Read 0033's exact CASE/substring extraction straight out of the migration
// file, between its SENDER-EXTRACT markers, instead of keeping a hand-copied
// twin here that could drift from what actually runs against the database —
// the drift the docblock on `case-history.ts`'s doc-id lookup and this
// project's other markers all guard against.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.join(__dirname, "../drizzle/0033_sender_backfill.sql"),
  "utf8",
);
const EXTRACT_MATCH = MIGRATION_SQL.match(
  /-- SENDER-EXTRACT-BEGIN\n([\s\S]*?)-- SENDER-EXTRACT-END/,
);
if (!EXTRACT_MATCH) {
  throw new Error("0033_sender_backfill.sql is missing its SENDER-EXTRACT markers");
}
const EXTRACT_EXPR = EXTRACT_MATCH[1];

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  const c = createDb(ADMIN_URL);
  db = c.db;
  close = () => c.pool.end();
});
afterAll(() => close());

/** Runs 0033's exact extraction expression against one `from_addr` value. */
async function extract(fromAddr: string): Promise<string | null> {
  const { rows: [row] } = await db.execute<{ extracted: string | null }>(sql`
    SELECT (${sql.raw(EXTRACT_EXPR)}) AS extracted
    FROM (VALUES (${fromAddr}::text)) AS r(from_addr)
  `);
  return row.extracted;
}

describe("migration 0033 sender extraction", () => {
  it("extracts the addr-spec out of a Display Name <addr> header", async () => {
    expect(await extract("Demi Willemse <demi@verdergroep.nl>")).toBe("demi@verdergroep.nl");
  });

  it("accepts a bare address unchanged", async () => {
    expect(await extract("demi@verdergroep.nl")).toBe("demi@verdergroep.nl");
  });

  it("takes the angle-addr, never a quoted decoy display name", async () => {
    // The same defect Task 3 fixed in the worker's senderAddress: a quoted
    // string can itself look like an address and must never win over the
    // real angle-addr.
    expect(await extract('"quoted@display.nl" <real@addr.nl>')).toBe("real@addr.nl");
  });

  it("refuses a header with a parenthesis, even a legal quoted-pair escape", async () => {
    // The exact header that cost the worker its third review round: a naive
    // comment-stripper mis-terminates this and leaks the watched address.
    expect(await extract("<attacker@evil.tld> ( \\) <spoofed@watched.nl> \\( )")).toBeNull();
  });

  it("refuses a plain trailing comment too", async () => {
    expect(await extract("<attacker@evil.tld> (spoofed@watched.nl)")).toBeNull();
  });

  it("refuses more than one <", async () => {
    expect(await extract("<attacker@evil.tld> <spoofed@watched.nl>")).toBeNull();
  });

  it("refuses a comma-separated list", async () => {
    expect(await extract("demi@verdergroep.nl, attacker@evil.tld")).toBeNull();
  });

  it("refuses an unterminated <", async () => {
    expect(await extract("Demi Willemse <spoofed@watched.nl")).toBeNull();
  });
});

describe("migration 0033 join safety", () => {
  it("never folds a KELVIN SIGN header onto an ASCII party email", async () => {
    const name = `Kelvin Testfixture ${crypto.randomUUID()}`;
    const email = "incasso@kvk.nl";
    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name, email }).returning();
    try {
      // U+212A KELVIN SIGN standing in for the leading "k" of "kvk.nl" —
      // folds to ASCII "k" under Unicode `lower()`, which is exactly the
      // hazard apps/worker/src/mail/relevance.ts:26-39 documents.
      const spoofed = "incasso@Kvk.nl";
      expect(spoofed).not.toBe(email);
      expect(spoofed.toLowerCase()).toBe(email); // the fold that must NOT happen in SQL

      const { rows } = await db.execute<{ id: string }>(sql`
        SELECT p."id"
        FROM (VALUES (${spoofed}::text)) AS r(from_addr)
        JOIN "parties" p
          ON p."email" IS NOT NULL
         AND p."email" ~ '^[[:ascii:]]+$'
         AND lower(p."email") = lower(${sql.raw(EXTRACT_EXPR)})
        WHERE r."from_addr" ~ '^[[:ascii:]]*$'
          AND p."id" = ${party.id}
      `);
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(schema.parties).where(eq(schema.parties.id, party.id));
    }
  });

  it("never matches a party whose email is NULL", async () => {
    const name = `No-Email Testfixture ${crypto.randomUUID()}`;
    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name, email: null }).returning();
    try {
      const { rows } = await db.execute<{ id: string }>(sql`
        SELECT p."id"
        FROM (VALUES ('demi@verdergroep.nl'::text)) AS r(from_addr)
        JOIN "parties" p
          ON p."email" IS NOT NULL
         AND p."email" ~ '^[[:ascii:]]+$'
         AND lower(p."email") = lower(${sql.raw(EXTRACT_EXPR)})
        WHERE r."from_addr" ~ '^[[:ascii:]]*$'
          AND p."id" = ${party.id}
      `);
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(schema.parties).where(eq(schema.parties.id, party.id));
    }
  });
});
