import { beforeAll, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("bundles router", () => {
  let db: Db; let userId: string; let mark: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `bu${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    mark = crypto.randomUUID().slice(0, 8);
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const add = (docType: string) => caller().documents.registerUpload({
    sha256: sha(), sizeBytes: 10, mime: "application/pdf", title: `${mark} stuk`,
    source: "upload", receivedAt: new Date(), docType });

  it("creates a manual bundle and holds exactly what was put in it", async () => {
    const a = await add(`m ${mark}`);
    const b = await caller().bundles.create({ name: `Team Opstart ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [a.id] });
    const got = await caller().bundles.get({ id: b.id });
    expect(got.documentIds).toEqual([a.id]);
    expect(got.kind).toBe("manual");
  });

  it("adds the same document twice without complaining or duplicating", async () => {
    const a = await add(`dup ${mark}`);
    const b = await caller().bundles.create({ name: `Dubbel ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [a.id] });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [a.id] });
    expect((await caller().bundles.get({ id: b.id })).documentIds).toEqual([a.id]);
  });

  it("computes a rule bundle's members and keeps discarded ones out", async () => {
    const keep = await add(`regel ${mark}`);
    const gone = await add(`regel ${mark}`);
    await caller().documents.update({ id: gone.id, status: "discarded" });
    const b = await caller().bundles.create({
      name: `Loonstroken ${mark}`, kind: "rule", rule: { docType: `regel ${mark}` } });
    const got = await caller().bundles.get({ id: b.id });
    expect(got.documentIds).toEqual([keep.id]);
  });

  // The one way a rule may hold discarded documents: by asking for them.
  it("lets a rule ask for discarded documents by name", async () => {
    const gone = await add(`weg ${mark}`);
    await caller().documents.update({ id: gone.id, status: "discarded" });
    const b = await caller().bundles.create({ name: `Weggelegd ${mark}`, kind: "rule",
      rule: { docType: `weg ${mark}`, status: "discarded" } });
    expect((await caller().bundles.get({ id: b.id })).documentIds).toEqual([gone.id]);
  });

  it("refuses to put documents into a rule bundle", async () => {
    const a = await add(`nope ${mark}`);
    const b = await caller().bundles.create({ name: `Regel ${mark}`, kind: "rule",
      rule: { docType: `nope ${mark}` } });
    await expect(caller().bundles.addDocuments({ id: b.id, documentIds: [a.id] }))
      .rejects.toThrow(/regel/i);
  });

  it("reports a corrupt rule as a broken bundle instead of throwing", async () => {
    const b = await caller().bundles.create({ name: `Stuk ${mark}`, kind: "rule",
      rule: { docType: `ok ${mark}` } });
    // Simulating a hand-edit in psql, which is the only way this happens.
    await db.execute(
      sql`UPDATE bundles SET rule = '{"kleur":"blauw"}'::jsonb WHERE id = ${b.id}`);
    const got = await caller().bundles.get({ id: b.id });
    expect(got.broken).toBeTruthy();
    expect(got.documentIds).toEqual([]);
  });

  it("deletes a bundle and its links, and no document", async () => {
    const a = await add(`del ${mark}`);
    const b = await caller().bundles.create({ name: `Weg ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [a.id] });
    await caller().bundles.remove({ id: b.id });
    expect(await caller().documents.get({ id: a.id })).toBeTruthy();
    await expect(caller().bundles.get({ id: b.id })).rejects.toThrow(/NOT_FOUND|not found/i);
  });

  // Bundles are not evidence. If this test ever fails, the law was broken.
  it("appends no ledger event for any of it", async () => {
    const before = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const b = await caller().bundles.create({ name: `Stil ${mark}`, kind: "manual" });
    await caller().bundles.rename({ id: b.id, name: `Stiller ${mark}` });
    await caller().bundles.remove({ id: b.id });
    const after = await db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    expect(after.length).toBe(before.length);
  });

  // Ruling 21: a rule must select exactly what the tree's branch selects. If a
  // rule's soort folds differently from the tree's soort branch, a bundle's
  // count disagrees with the branch it was built from, on the same screen.
  it("a soort rule matches exactly what the tree's soort branch matches", async () => {
    // Deliberately messy casing and doubled inner whitespace, so this only
    // passes if the rule is folded through the SAME key the tree groups on
    // (docTypeKeySql) rather than a lookalike lower/trim.
    const rawDocType = `Regel  Soort ${mark}`;
    const foldedKey = rawDocType.trim().toLowerCase().replace(/\s+/g, " ");
    const a = await add(rawDocType);
    const b = await add(rawDocType);
    const b2 = await caller().bundles.create({
      name: `Gefold ${mark}`, kind: "rule", rule: { docType: rawDocType } });
    const got = await caller().bundles.get({ id: b2.id });
    const branch = await caller().documents.browse({
      branch: { kind: "soort", key: foldedKey } });
    expect(new Set(got.documentIds)).toEqual(new Set(branch.rows.map((r) => r.id)));
    expect(new Set(got.documentIds)).toEqual(new Set([a.id, b.id]));
  });

  // documents.browse({ branch: { kind: "bundel", id } }) has no test anywhere
  // else — Task 6's tree never emits a bundel branch, and this is the first
  // task with real bundles.
  it("browse's bundel branch returns a manual bundle's members, minus a discarded one", async () => {
    const kept = await add(`bundelbrowse ${mark}`);
    const removed = await add(`bundelbrowse ${mark}`);
    await caller().documents.update({ id: removed.id, status: "discarded" });
    const b = await caller().bundles.create({ name: `Doorblader ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [kept.id, removed.id] });
    const res = await caller().documents.browse({ branch: { kind: "bundel", id: b.id } });
    expect(res.rows.map((r) => r.id)).toEqual([kept.id]);
  });
});
