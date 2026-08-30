import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("documents.tree", () => {
  let db: Db; let userId: string; let partyId: string; let partyName: string; let mark: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `t${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    mark = crypto.randomUUID().slice(0, 8);
    partyName = `Woonhave Testfixture ${crypto.randomUUID()}`;
    const [p] = await db.insert(schema.parties).values({
      kind: "organization", name: partyName,
    }).returning();
    partyId = p.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const add = (over: Partial<{ title: string; docType: string; receivedAt: Date; partyId: string }>) =>
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

  // Ruling 18: array_agg used to carry DISTINCT, which delivers each
  // spelling exactly once and makes every count 1 — degrading docTypeLabel's
  // majority vote into an alphabetical tie-break. "Zorg" (capital Z) sorts
  // before "zorg" under docTypeLabel's caseFirst:"upper" tie-break, so the
  // bug would report "Zorg" here even though three rows actually say "zorg".
  it("labels a soort branch by the spelling most rows actually use, not the alphabetically first one", async () => {
    await add({ docType: `Zorg ${mark}` });
    await add({ docType: `zorg ${mark}` });
    await add({ docType: `zorg ${mark}` });
    await add({ docType: `zorg ${mark}` });
    const tree = await caller().documents.tree();
    const branch = tree.soort.find((s) => s.key === `zorg ${mark}`);
    expect(branch?.n).toBe(4);
    expect(branch?.label).toBe(`zorg ${mark}`);
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
    const receivedAt = new Date("2026-01-15T12:00:00Z");
    const before = await caller().documents.tree();
    const beforeVanWie = before.vanWie.find((v) => v.partyId === partyId)?.n ?? 0;
    const beforePeriode = before.periode.find((p) => p.month === "2026-01")?.n ?? 0;
    const beforeBron = before.bron.find((b) => b.source === "upload")?.n ?? 0;

    const doc = await add({ docType: `weg ${mark}`, receivedAt, partyId });

    // Sanity check: the document is visible in every branch before it is
    // discarded, so the assertions below actually exercise an exclusion
    // rather than trivially passing on a document that was never counted.
    const afterAdd = await caller().documents.tree();
    expect(afterAdd.soort.find((s) => s.key === `weg ${mark}`)?.n).toBe(1);
    expect(afterAdd.vanWie.find((v) => v.partyId === partyId)?.n ?? 0).toBe(beforeVanWie + 1);
    expect(afterAdd.periode.find((p) => p.month === "2026-01")?.n ?? 0).toBe(beforePeriode + 1);
    expect(afterAdd.bron.find((b) => b.source === "upload")?.n ?? 0).toBe(beforeBron + 1);

    await caller().documents.update({ id: doc.id, status: "discarded" });
    const tree = await caller().documents.tree();
    expect(tree.soort.find((s) => s.key === `weg ${mark}`)).toBeUndefined();
    expect(tree.vanWie.find((v) => v.partyId === partyId)?.n ?? 0).toBe(beforeVanWie);
    expect(tree.periode.find((p) => p.month === "2026-01")?.n ?? 0).toBe(beforePeriode);
    expect(tree.bron.find((b) => b.source === "upload")?.n ?? 0).toBe(beforeBron);
    expect(tree.status.find((s) => s.status === "discarded")!.n).toBeGreaterThan(0);
  });

  it("counts an unknown sender as its own branch", async () => {
    await add({ docType: `zonder ${mark}` });
    const tree = await caller().documents.tree();
    expect(tree.vanWie.find((v) => v.partyId === null)!.n).toBeGreaterThan(0);
  });

  it("counts a known sender under its own name and count", async () => {
    const before = await caller().documents.tree();
    const beforeBranch = before.vanWie.find((v) => v.partyId === partyId)?.n ?? 0;
    await add({ docType: `bekend ${mark}`, partyId });
    const tree = await caller().documents.tree();
    const branch = tree.vanWie.find((v) => v.partyId === partyId);
    expect(branch?.n).toBe(beforeBranch + 1);
    expect(branch?.name).toBe(partyName);
  });

  // Important 1: documents.update APPENDS a docType correction to
  // document_status_changes and never writes it back to documents.doc_type,
  // so grouping on the raw column would keep counting a corrected document
  // under its old soort forever. tree must resolve through
  // effectiveDocTypeSql, the same way the row-level views do.
  it("moves a soort correction into the tree's new key, and out of the old one", async () => {
    const oldKey = `oud ${mark}`;
    const newKey = `nieuw ${mark}`;
    const doc = await add({ docType: oldKey });
    const beforeMove = await caller().documents.tree();
    expect(beforeMove.soort.find((s) => s.key === oldKey)?.n).toBe(1);

    await caller().documents.update({ id: doc.id, status: "inbox", docType: newKey });
    const tree = await caller().documents.tree();
    expect(tree.soort.find((s) => s.key === oldKey)).toBeUndefined();
    expect(tree.soort.find((s) => s.key === newKey)?.n).toBe(1);
  });

  // Same trap, for the sender: a party correction lives only in
  // document_status_changes, so tree must move the document from "Onbekend"
  // to the named party rather than leaving it stuck under the old key.
  it("moves a sender correction from unknown to a named party", async () => {
    const doc = await add({ docType: `overdracht ${mark}` });
    const before = await caller().documents.tree();
    const beforeNull = before.vanWie.find((v) => v.partyId === null)?.n ?? 0;
    const beforeNamed = before.vanWie.find((v) => v.partyId === partyId)?.n ?? 0;

    await caller().documents.update({ id: doc.id, status: "inbox", partyId });
    const tree = await caller().documents.tree();
    expect(tree.vanWie.find((v) => v.partyId === null)?.n ?? 0).toBe(beforeNull - 1);
    expect(tree.vanWie.find((v) => v.partyId === partyId)?.n).toBe(beforeNamed + 1);
  });
});
