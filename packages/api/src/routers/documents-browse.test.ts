import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("documents.browse", () => {
  let db: Db; let userId: string; let mark: string;
  let partyId: string; let partyName: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `b${Date.now()}@test.local`, name: "Martin" }).returning();
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
  const add = (title: string, over: Record<string, unknown> = {}) =>
    caller().documents.registerUpload({ sha256: sha(), sizeBytes: 10,
      mime: "application/pdf", title, source: "upload",
      receivedAt: new Date("2026-08-15T12:00:00Z"), docType: `soort ${mark}`, ...over });

  it("returns only the branch's rows, and the branch's true total", async () => {
    await add(`${mark} a`);
    await add(`${mark} b`);
    const res = await caller().documents.browse({
      branch: { kind: "soort", key: `soort ${mark}` }, sort: "naam", dir: "asc" });
    expect(res.rows.map((r) => r.title)).toEqual([`${mark} a`, `${mark} b`]);
    expect(res.total).toBe(2);
  });

  // The vault's law: a list that simply stops is indistinguishable from a
  // document that was never filed. `total` is what lets the page say so.
  it("reports a total larger than the page it returns", async () => {
    const res = await caller().documents.browse({
      branch: { kind: "soort", key: `soort ${mark}` }, limit: 1 });
    expect(res.rows).toHaveLength(1);
    expect(res.total).toBe(2);
  });

  it("sorts by size descending when asked", async () => {
    await add(`${mark} big`, { sizeBytes: 9999, docType: `groot ${mark}` });
    await add(`${mark} small`, { sizeBytes: 1, docType: `groot ${mark}` });
    const res = await caller().documents.browse({
      branch: { kind: "soort", key: `groot ${mark}` }, sort: "grootte", dir: "desc" });
    expect(res.rows[0].title).toBe(`${mark} big`);
  });

  it("hides a discarded document from every branch but status", async () => {
    const doc = await add(`${mark} weg`, { docType: `verdwijn ${mark}` });
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const hidden = await caller().documents.browse({
      branch: { kind: "soort", key: `verdwijn ${mark}` } });
    expect(hidden.rows).toHaveLength(0);
    const shown = await caller().documents.browse({
      branch: { kind: "status", status: "discarded" }, limit: 200 });
    expect(shown.rows.some((r) => r.id === doc.id)).toBe(true);
  });

  // Ruling 20: the tree/browse agreement. Every branch filter in `browse`
  // must use the EXACT expression `tree` grouped on — soort's folded key,
  // party's effective id, periode's Amsterdam month, status's effective
  // status. If browse drifted from tree by so much as a fold, clicking a
  // branch would show a different set than the count promised, on the same
  // screen.
  //
  // This walks the WHOLE tree returned against the shared, never-truncated
  // dev database — not just our fixtures. That is deliberate: the assertion
  // is an equality between two queries run back-to-back against the same
  // live state, so it holds regardless of how many other rows exist. The
  // fixtures below exist only to guarantee every branch KIND (soort
  // including the empty key, party including unknown, periode, bron
  // including a non-upload source, status including discarded) is actually
  // present for the walk to exercise, even on a freshly reset database.
  it("agrees with tree on every branch's true total", async () => {
    // soort (named) + soort (empty key) + known party + unknown party.
    const firstAgree = await add(`${mark} agree-1`, { docType: `agree ${mark}`, partyId });
    await add(`${mark} agree-2`, { docType: undefined });
    // A distinct bron so the "bron" walk includes more than "upload".
    await add(`${mark} agree-3`, { source: "nas-scan", docType: `agree-bron ${mark}` });
    // A distinct periode.
    await add(`${mark} agree-4`, {
      receivedAt: new Date("2020-03-10T12:00:00Z"), docType: `agree-periode ${mark}` });
    // A discarded document, so the "status" walk includes "discarded".
    const gone = await add(`${mark} agree-5`, { docType: `agree-gone ${mark}` });
    await caller().documents.update({ id: gone.id, status: "discarded" });

    // A MANUAL and a RULE bundle, because the tree pane renders both as a
    // `bundel` branch carrying bundles.list().count and the two resolve
    // membership in completely different places — a rule bundle holds zero
    // rows in bundle_documents by design. The manual one deliberately holds a
    // discarded member: the count, the table and the zip are one set.
    const manual = await caller().bundles.create({
      name: `Loonstroken ${mark}`, kind: "manual" });
    await caller().bundles.addDocuments({
      id: manual.id, documentIds: [firstAgree.id, gone.id] });
    await caller().bundles.create({
      name: `Alles van agree ${mark}`, kind: "rule", rule: { docType: `agree ${mark}` } });

    const tree = await caller().documents.tree();

    for (const s of tree.soort) {
      const res = await caller().documents.browse({ branch: { kind: "soort", key: s.key } });
      expect(res.total).toBe(s.n);
    }
    for (const v of tree.vanWie) {
      const res = await caller().documents.browse({ branch: { kind: "party", id: v.partyId } });
      expect(res.total).toBe(v.n);
    }
    for (const p of tree.periode) {
      const res = await caller().documents.browse({ branch: { kind: "periode", month: p.month } });
      expect(res.total).toBe(p.n);
    }
    for (const br of tree.bron) {
      const res = await caller().documents.browse({ branch: { kind: "bron", source: br.source } });
      expect(res.total).toBe(br.n);
    }
    for (const st of tree.status) {
      // tree.status's status column is typed as a bare `string` (it comes
      // straight off effectiveDocStatusSql), but it is always one of the
      // three doc_status enum values in practice.
      const status = st.status as "inbox" | "filed" | "discarded";
      const res = await caller().documents.browse({ branch: { kind: "status", status } });
      expect(res.total).toBe(st.n);
    }
    // The bundles are the branch the tree cannot emit: FilesTree renders every
    // row of bundles.list() as a `bundel` branch carrying that row's count, so
    // the same agreement has to hold there. It did not — browse filtered
    // bundle_documents, which a rule bundle leaves empty on purpose, so a rule
    // bundle read "Loonstroken · 12" in the tree and "Niets in deze tak" in
    // the table while its card downloaded 12 files.
    for (const bundle of await caller().bundles.list()) {
      const res = await caller().documents.browse({
        branch: { kind: "bundel", id: bundle.id }, limit: 200 });
      expect(res.total).toBe(bundle.count);
    }
  });

  it("hides a purged document from every branch but its own", async () => {
    const doc = await add(`${mark} purge-1`, { docType: `purge ${mark}` });
    await caller().documents.purge({ id: doc.id, reason: "test" });

    const inAlles = await caller().documents.browse({ branch: { kind: "alles" } });
    expect(inAlles.rows.map((r) => r.id)).not.toContain(doc.id);

    const inSoort = await caller().documents.browse({
      branch: { kind: "soort", key: `purge ${mark}` } });
    expect(inSoort.rows.map((r) => r.id)).not.toContain(doc.id);

    const inList = await caller().documents.list({ limit: 200, includeDiscarded: true });
    expect(inList.map((r) => r.id)).not.toContain(doc.id);

    // Its own branch is where the record of what was destroyed stays findable.
    // A record reachable only by typing a UUID is not a record.
    const purged = await caller().documents.browse({
      branch: { kind: "status", status: "purged" } });
    expect(purged.rows.map((r) => r.id)).toContain(doc.id);
  });

  it("moves a document from its status branch to the purged one", async () => {
    const count = async (status: string) => (await caller().documents.tree()).status
      .find((s) => s.status === status)?.n ?? 0;
    const purgedBefore = await count("purged");
    const doc = await add(`${mark} purge-2`);
    const inboxBefore = await count("inbox");
    await caller().documents.purge({ id: doc.id });
    // Both sides of the move, measured against the same fixture — a purged
    // document must LEAVE its old branch, not merely appear in a new one.
    expect(await count("purged")).toBe(purgedBefore + 1);
    expect(await count("inbox")).toBe(inboxBefore - 1);
  });

  // THE INVARIANT documents-browse.test.ts already enforces for every branch:
  // the tree's count and browse's total are one definition. A purge that left
  // them disagreeing would show "12" over a table of 11.
  it("keeps every tree count equal to its branch total after a purge", async () => {
    const doc = await add(`${mark} purge-3`, { docType: `purge-inv ${mark}` });
    await caller().documents.purge({ id: doc.id });
    const tree = await caller().documents.tree();
    for (const s of tree.soort) {
      const got = await caller().documents.browse({ branch: { kind: "soort", key: s.key } });
      expect(got.total).toBe(s.n);
    }
    for (const s of tree.status) {
      const status = s.status as "inbox" | "filed" | "discarded" | "purged";
      const got = await caller().documents.browse({ branch: { kind: "status", status } });
      expect(got.total).toBe(s.n);
    }
  });

  it("drops a purged document out of its bundle", async () => {
    const doc = await add(`${mark} purge-4`);
    const bundle = await caller().bundles.create({
      name: `Purge bundel ${mark} ${crypto.randomUUID()}`, kind: "manual" });
    await caller().bundles.addDocuments({ id: bundle.id, documentIds: [doc.id] });
    expect((await caller().documents.browse({ branch: { kind: "bundel", id: bundle.id } }))
      .rows.map((r) => r.id)).toContain(doc.id);
    await caller().documents.purge({ id: doc.id });
    const after = await caller().documents.browse({ branch: { kind: "bundel", id: bundle.id } });
    expect(after.rows.map((r) => r.id)).not.toContain(doc.id);
    // The zip's membership must agree with the table's, or the card downloads
    // a file the page says is not there — and the zip route would 409 on it.
    const listed = (await caller().bundles.list()).find((b) => b.id === bundle.id);
    expect(listed?.count).toBe(after.total);
  });
});
