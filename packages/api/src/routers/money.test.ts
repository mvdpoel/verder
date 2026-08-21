import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

// The dev postgres is shared: every assertion below is scoped to the statement
// sha this suite invented, never to absolute totals.
describe("money router", () => {
  let db: Db; let userId: string; let sha: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `money${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    // A real 64-hex digest: documents.sha256 holds one, and the whole point of
    // the third test is that the two tables meet on this value.
    sha = createHash("sha256").update(`money-${Date.now()}-${Math.random()}`).digest("hex");
    await db.insert(schema.transactions).values([
      { source: "abn-camt053", bookedAt: new Date("2026-06-01T00:00:00Z"), amountCents: -21_000,
        accountIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 0 },
      { source: "abn-camt053", bookedAt: new Date("2026-06-30T00:00:00Z"), amountCents: 241_304,
        counterpartyIban: "NL02ABNA0123456789", counterpartyName: "TrueFullstaq BV",
        accountIban: "NL91ABNA0417164300", statementSha256: sha, rowIndex: 1 },
    ]);
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("returns a series for the account the rows belong to", async () => {
    const { series } = await caller().money.series();
    const mine = series.find((s) => s.accountIban === "NL91ABNA0417164300");
    expect(mine).toBeDefined();
    expect(mine!.months.some((m) => m.month === "2026-06")).toBe(true);
  });

  it("month detail lists the bank rows behind a category", async () => {
    const detail = await caller().money.month({
      accountIban: "NL91ABNA0417164300", month: "2026-06",
    });
    const overig = detail.categories.find((c) => c.category === "overig");
    expect(overig!.transactions.some((t) => t.statementSha256 === sha)).toBe(true);
  });

  it("keeps transactions when their statement document is discarded", async () => {
    // Discard is a status change on the document, never a delete, and the
    // document link is evidence — not ownership of the rows.
    const [doc] = await db.insert(schema.documents).values({
      title: "afschrift.xml", source: "upload", sha256: sha,
      mime: "application/xml", sizeBytes: 10, receivedAt: new Date(),
    }).returning();
    // Through the real procedure, not a raw insert: document_status_changes is
    // an evidence table, and a row appended without its ledger event would make
    // verify.run() red for every later suite on this shared dev database.
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const detail = await caller().money.month({
      accountIban: "NL91ABNA0417164300", month: "2026-06",
    });
    const mine = detail.categories
      .flatMap((c) => c.transactions)
      .filter((t) => t.statementSha256 === sha);
    expect(mine.length).toBeGreaterThan(0);
  });
});
