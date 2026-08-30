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
// twin here that could drift from what actually runs against the database.
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

  // CRITICAL round 2 findings: nine sender-controlled headers that resolved
  // the decoy `demi@verdergroep.nl` before the WHOLE-VALUE anchor
  // `^[^<>]*<[^<>]*>[[:space:]]*$` replaced the bare `~ '<'` branch
  // condition. Each is pinned individually, by design: a future
  // "simplification" of the anchor back to a bare `<` check would turn every
  // one of these green tests red one at a time, rather than failing a single
  // combined assertion that is easy to special-case away.
  describe("nine decoy shapes a review found (all must resolve to NULL)", () => {
    const REAL = "demi@verdergroep.nl";
    const cases: [label: string, header: string][] = [
      [
        "quoted-string local part containing <real> (CRITICAL 1)",
        `"<${REAL}>"@evil.tld`,
      ],
      [
        "quoted-string local part, real address embedded mid-string",
        `"a<${REAL}>b"@evil.tld`,
      ],
      [
        "trailing bare address after the angle-addr",
        `<${REAL}> attacker@evil.tld`,
      ],
      [
        "trailing junk character after >",
        `<${REAL}>x`,
      ],
      [
        "a second > right after the first",
        `<${REAL}>>`,
      ],
      [
        "trailing ; and a second address",
        `<${REAL}>; attacker@evil.tld`,
      ],
      [
        "trailing tab and a second address",
        `<${REAL}>\tattacker@evil.tld`,
      ],
      [
        "trailing header-injection-shaped text",
        `<${REAL}>\nFrom: attacker@evil.tld`,
      ],
      [
        "RFC 5322 group syntax wrapping the real address",
        `Groep: <${REAL}>;`,
      ],
    ];

    it.each(cases)("%s", async (_label, header) => {
      expect(await extract(header)).toBeNull();
    });
  });

  // Documented, ACCEPTED trade-off (not a regression to chase): the anchor
  // above has no quoted-string awareness, so a bare `>` sitting inside a
  // quoted display name — itself legal `qtext`, RFC 5322 never requires it
  // to be escaped — is indistinguishable in SQL from a `>` that terminates
  // the real angle-addr. `apps/worker/src/gmail.ts`'s `senderAddress` DOES
  // track quote state and correctly resolves this to the real address; this
  // SQL expression cannot, and refuses instead. That is the same fail-closed
  // trade-off already accepted for a `<` hidden inside a quoted string (see
  // the migration's "more than one <" rule): refusing costs an "Onbekend" a
  // human corrects, and the alternative is guessing inside a quoted string
  // SQL cannot parse. Pinned so nobody "fixes" this into a re-opened decoy
  // path.
  it("refuses a legitimate address behind a quoted display name containing a bare > (accepted over-refusal)", async () => {
    expect(await extract('"weird > name" <demi@verdergroep.nl>')).toBeNull();
  });
});

describe("migration 0033 join safety", () => {
  it("never folds a party's KELVIN SIGN email onto a legitimate ASCII sender", async () => {
    // THE DIRECTION THAT ACTUALLY EXERCISES THE GUARD. An earlier version of
    // this test put the KELVIN SIGN in from_addr (the sender side) and
    // asserted no match — it passed, but for the wrong reason: Postgres's
    // case-insensitive `~*` bracket-class matching does not admit U+212A into
    // `[a-z]`, so the extraction's own address-shape check already refuses
    // that input, and `p."email" ~ '^[[:ascii:]]+$'` (migration line ~75) is
    // never even reached. The row shape that actually needs the guard is a
    // KELVIN SIGN sitting IN `parties.email` — exactly what
    // apps/worker/src/mail/relevance.ts:26-39 records reaching production —
    // compared via Postgres's Unicode-aware `lower()` against a perfectly
    // ordinary ASCII sender.
    const name = `Kelvin Testfixture ${crypto.randomUUID()}`;
    // U+212A KELVIN SIGN standing in for the leading "k" of "kvk.nl".
    const email = "incasso@" + String.fromCharCode(0x212A) + "vk.nl";
    expect(email).not.toBe("incasso@kvk.nl");
    expect(email.toLowerCase()).toBe("incasso@kvk.nl"); // the fold that must NOT happen in SQL

    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name, email }).returning();
    try {
      const senderAddr = "incasso@kvk.nl"; // pure ASCII, a legitimate sender
      const { rows } = await db.execute<{ id: string }>(sql`
        SELECT p."id"
        FROM (VALUES (${senderAddr}::text)) AS r(from_addr)
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
