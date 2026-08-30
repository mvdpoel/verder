import { beforeAll, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { docTypeKey } from "../doc-type";

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

  // Ruling 21, part 1: a soort rule must fold whitespace/case exactly like
  // docTypeKeySql, the same key the tree's soort branch groups on and
  // browse's soort branch filters on. Three documents that differ ONLY in
  // inner whitespace/case, and a rule spelled a third way again, so this can
  // only pass if all three collapse to one key through the shared fold —
  // under the raw lower/trim comparison Ruling 21 rejected, this matches
  // NEITHER document (verified: see the fix report).
  it("a soort rule folds whitespace and case exactly like the tree's soort branch", async () => {
    const a = await add(`Regel  Soort ${mark}`); // doubled inner space, mixed case
    const b = await add(`regel soort ${mark}`); // single space, lowercase
    const ruleDocType = ` REGEL   SOORT ${mark} `; // leading/trailing + tripled inner space
    const bundle = await caller().bundles.create({
      name: `Gefold ${mark}`, kind: "rule", rule: { docType: ruleDocType } });
    const got = await caller().bundles.get({ id: bundle.id });
    const branch = await caller().documents.browse({
      branch: { kind: "soort", key: docTypeKey(ruleDocType) } });
    expect(new Set(got.documentIds)).toEqual(new Set([a.id, b.id]));
    expect(new Set(got.documentIds)).toEqual(new Set(branch.rows.map((r) => r.id)));
  });

  // Ruling 21, part 2: a soort rule must read the EFFECTIVE doc_type
  // (corrections travel through document_status_changes and the raw column
  // never changes — the append-only law). A rule naming the corrected soort
  // must find the document; a rule still naming the original soort must not.
  // Under a raw-column comparison this is exactly backwards: it would find
  // the document by its stale name and miss it by its current one (verified:
  // see the fix report).
  it("a soort rule reads the corrected doc_type, not the original one", async () => {
    const original = `origineel ${mark}`;
    const corrected = `gecorrigeerd ${mark}`;
    const doc = await add(original);
    await caller().documents.update({ id: doc.id, status: "inbox", docType: corrected });

    const findsCorrected = await caller().bundles.create({
      name: `Naar het echte soort ${mark}`, kind: "rule", rule: { docType: corrected } });
    expect((await caller().bundles.get({ id: findsCorrected.id })).documentIds)
      .toEqual([doc.id]);

    const findsOriginal = await caller().bundles.create({
      name: `Naar het oude soort ${mark}`, kind: "rule", rule: { docType: original } });
    expect((await caller().bundles.get({ id: findsOriginal.id })).documentIds).toEqual([]);
  });

  // Ruling 21, part 3: a party rule must read the EFFECTIVE sender the same
  // way — a sender set only by correction, never at ingest, so the raw
  // documents.party_id stays NULL forever and only effectivePartyIdSql sees
  // it. Under a raw-column comparison `NULL = partyId` is NULL, which a WHERE
  // clause treats as false, so this document would never be found by any
  // party rule (verified: see the fix report).
  it("a party rule reads the sender set by a correction, never the raw column", async () => {
    const partyName = `Kennisbank Testfixture ${crypto.randomUUID()}`;
    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name: partyName }).returning();
    const doc = await add(`afzender ${mark}`);
    await caller().documents.update({ id: doc.id, status: "inbox", partyId: party.id });

    const before = await caller().documents.get({ id: doc.id });
    expect(before.partyId).toBeNull(); // the raw column: never written after ingest
    expect(before.effectivePartyId).toBe(party.id); // what the correction actually set

    const bundle = await caller().bundles.create({
      name: `Van deze partij ${mark}`, kind: "rule", rule: { partyId: party.id } });
    expect((await caller().bundles.get({ id: bundle.id })).documentIds).toEqual([doc.id]);
  });

  // documents.browse({ branch: { kind: "bundel", id } }) has no test anywhere
  // else — Task 6's tree never emits a bundel branch, and this is the first
  // task with real bundles.
  //
  // A MANUAL bundle shows what it CONTAINS, discarded members included. This
  // used to assert the opposite, and the opposite is what made the card say 3,
  // the table show 2 and the download hold 3 — three answers to one question,
  // on one screen. The spec settles it in §6.2 for the zip ("the selection was
  // deliberate, and a silent inclusion is the lie, not the inclusion") and the
  // same reasoning governs the count and the table; FilesTable marks the row
  // "weggelegd" so the inclusion is visible rather than silent.
  it("browse's bundel branch returns a manual bundle's members, discarded included", async () => {
    const kept = await add(`bundelbrowse ${mark}`);
    const removed = await add(`bundelbrowse ${mark}`);
    await caller().documents.update({ id: removed.id, status: "discarded" });
    const b = await caller().bundles.create({ name: `Doorblader ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: b.id, documentIds: [kept.id, removed.id] });
    const res = await caller().documents.browse({ branch: { kind: "bundel", id: b.id } });
    expect(res.rows.map((r) => r.id).sort()).toEqual([kept.id, removed.id].sort());
    expect(res.rows.find((r) => r.id === removed.id)?.status).toBe("discarded");
    // The three answers agree: card count, table total, zip manifest.
    expect(res.total).toBe(2);
    expect((await caller().bundles.get({ id: b.id })).documentIds).toHaveLength(2);
  });

  // The defect this catches: browse's bundel branch used to filter
  // bundle_documents, where a RULE bundle deliberately holds nothing at all.
  // The tree rendered "<naam> · 2" from bundles.list().count, the table
  // rendered "Niets in deze tak", and the card's Download .zip handed over 2
  // files. Three answers, one bundle.
  it("browse's bundel branch computes a rule bundle's members", async () => {
    const key = `regelbrowse ${mark}`;
    const one = await add(key);
    const two = await add(key);
    const b = await caller().bundles.create({
      name: `Regelblader ${mark}`, kind: "rule", rule: { docType: key } });
    const res = await caller().documents.browse({ branch: { kind: "bundel", id: b.id } });
    expect(res.rows.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
    expect(res.total).toBe(2);
  });

  // A bundle deleted in another tab leaves a ?tak=bundel:<id> URL behind. An
  // empty middle pane is the honest answer; a NOT_FOUND would 404 the page.
  it("browse's bundel branch is empty, not an error, for a bundle that is gone", async () => {
    const b = await caller().bundles.create({ name: `Weg ${mark}`, kind: "manual" });
    await caller().bundles.remove({ id: b.id });
    const res = await caller().documents.browse({ branch: { kind: "bundel", id: b.id } });
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
  });
});
