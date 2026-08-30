import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("documents.tree", () => {
  let db: Db; let userId: string; let partyId: string; let mark: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `t${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    mark = crypto.randomUUID().slice(0, 8);
    const [p] = await db.insert(schema.parties).values({
      kind: "organization", name: `Woonhave Testfixture ${crypto.randomUUID()}`,
    }).returning();
    partyId = p.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const add = (over: Partial<{ title: string; docType: string; receivedAt: Date }>) =>
    caller().documents.registerUpload({ sha256: sha(), sizeBytes: 10,
      mime: "application/pdf", title: `${mark} doc`, source: "upload",
      receivedAt: new Date("2026-08-15T12:00:00Z"), ...over });

  it("folds two spellings of one soort into one branch", async () => {
    await add({ docType: `Loonstrook ${mark}` });
    await add({ docType: `loonstrook ${mark}` });
    const tree = await caller().documents.tree();
    const branch = tree.soort.find((s) => s.key === `loonstrook ${mark}`.toLowerCase());
    expect(branch?.n).toBe(2);
    expect(branch?.label).toBe(`Loonstrook ${mark}`);
  });

  // Ruling 1: docTypeKey (Task 4) folds INNER whitespace runs too
  // (`.replace(/\s+/g, " ")`), so the SQL grouping must fold them the same
  // way or two spellings differing only by an inner double space would land
  // in two SQL branches while the JS key treats them as one.
  it("folds an inner double space the same way docTypeKey does", async () => {
    await add({ docType: `bank  afschrift ${mark}` });
    await add({ docType: `bank afschrift ${mark}` });
    const tree = await caller().documents.tree();
    const branch = tree.soort.find((s) => s.key === `bank afschrift ${mark}`);
    expect(branch?.n).toBe(2);
  });

  it("counts documents with no soort under the empty key", async () => {
    const before = (await caller().documents.tree()).soort.find((s) => s.key === "")?.n ?? 0;
    await add({});
    const after = (await caller().documents.tree()).soort.find((s) => s.key === "")?.n ?? 0;
    expect(after).toBe(before + 1);
  });

  // A month is an AMSTERDAM question. 2026-08-31T23:00Z is 1 September in
  // Amsterdam; a UTC bucket would file it under August and the periode branch
  // would disagree with every date the app prints.
  it("buckets a month by the Amsterdam calendar", async () => {
    const doc = await add({ receivedAt: new Date("2026-08-31T23:00:00Z"),
      docType: `grens ${mark}` });
    expect(doc.id).toBeTruthy();
    const tree = await caller().documents.tree();
    const sep = tree.periode.find((p) => p.month === "2026-09");
    expect(sep).toBeTruthy();
    expect(sep!.n).toBeGreaterThan(0);
  });

  it("keeps a discarded document out of every branch but its own status", async () => {
    const doc = await add({ docType: `weg ${mark}` });
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const tree = await caller().documents.tree();
    expect(tree.soort.find((s) => s.key === `weg ${mark}`)).toBeUndefined();
    expect(tree.status.find((s) => s.status === "discarded")!.n).toBeGreaterThan(0);
  });

  it("counts an unknown sender as its own branch", async () => {
    await add({ docType: `zonder ${mark}` });
    const tree = await caller().documents.tree();
    expect(tree.vanWie.find((v) => v.partyId === null)!.n).toBeGreaterThan(0);
    expect(partyId).toBeTruthy();
  });
});
