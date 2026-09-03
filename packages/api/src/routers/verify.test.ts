import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, ensureCaseMap, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";
import { runFullVerification } from "../verification";
import { assertSafeToTruncate } from "../test-db-guard";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// document_texts and search_chunks are worker-owned (0016): verder_app holds
// SELECT and, since 0034, DELETE — never INSERT. The leftover test below has to
// write them the way the racing production writers do.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("verify router", () => {
  let db: Db; let userId: string; let vaultDir: string;
  beforeAll(async () => {
    // Whole-chain verification needs a coherent chain. Other test files
    // register documents whose vault files never existed on disk, so wipe the
    // evidence tables first (admin role — the app role has no DELETE grants).
    // vitest.config.ts disables file parallelism so this cannot race them.
    // Never truncate a non-local database (DATABASE_URL could point at the
    // real evidence ledger) — fail loudly instead.
    assertSafeToTruncate(ADMIN_URL);
    const admin = createDb(ADMIN_URL);
    await admin.db.execute(sql`TRUNCATE ledger_events, log_entries, documents, parties CASCADE`);
    await admin.pool.end();
    db = createDb(APP_URL).db;
    vaultDir = mkdtempSync(join(tmpdir(), "vault-verify-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await db.insert(schema.users)
      .values({ email: `v${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    // Put the case map back. stops.entry_id and stops.document_id reference two
    // of the tables truncated above, so the CASCADE takes every stop, and then
    // every track (tracks reference stops through branches_at_stop_id).
    // MEASURED: 6 tracks and 12 stops to zero in one run of this file. The seed
    // otherwise lives only inside migration 0023, which never runs again — so
    // without this the dev app is left with no map and no way to get one back.
    await ensureCaseMap(db);
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("verifies the whole chain including document files", async () => {
    const c = caller();
    const buf = Buffer.from(`evidence-${Date.now()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verify me", source: "upload", receivedAt: new Date() });
    const res = await c.verify.run();
    expect(res.ok).toBe(true);
    expect(res.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.checkedFiles).toBeGreaterThan(0);
  });

  it("exportRange returns entries with joined context", async () => {
    const c = caller();
    const p = await c.parties.create({ kind: "person", name: "Case Manager" });
    await c.entries.create({ occurredAt: new Date(), channel: "meeting",
      direction: "internal", summary: "Export test entry",
      participantPartyIds: [p.id], documentIds: [], actionItems: [] });
    const exp = await c.verify.exportRange({
      from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
    expect(exp.headHash).toBeTruthy();
    expect(exp.entries.some((e) => e.summary === "Export test entry")).toBe(true);
    const found = exp.entries.find((e) => e.summary === "Export test entry");
    expect(found?.participants).toContain("Case Manager");
  });

  it("stays green after documents.linkToEntry adds a doc to an existing entry", async () => {
    const c = caller();
    const mkDoc = async (label: string) => {
      const buf = Buffer.from(`${label}-${Date.now()}`);
      const sha = sha256Hex(buf);
      const abs = join(vaultDir, relPathFor(sha));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      return c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
        mime: "text/plain", title: label, source: "upload", receivedAt: new Date() });
    };
    const docA = await mkDoc("linked-at-creation");
    const docB = await mkDoc("linked-later");
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "email",
      direction: "inbound", summary: "Entry that gains a document later",
      participantPartyIds: [], documentIds: [docA.id], actionItems: [] });
    expect((await c.verify.run()).ok).toBe(true);
    await c.documents.linkToEntry({ documentId: docB.id, entryId: entry.id });
    const res = await c.verify.run();
    expect(res).toMatchObject({ ok: true });
  });

  it("detects a document link added directly to the DB without a ledger event", async () => {
    const c = caller();
    const buf = Buffer.from(`sneaky-${Date.now()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const doc = await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Sneaky doc", source: "upload", receivedAt: new Date() });
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "letter",
      direction: "inbound", summary: "Entry targeted by direct link tampering",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`INSERT INTO entry_documents (entry_id, document_id)
        VALUES (${entry.id}, ${doc.id})`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      await admin.db.execute(sql`DELETE FROM entry_documents
        WHERE entry_id = ${entry.id} AND document_id = ${doc.id}`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("router and runFullVerification report identical results (green and tampered)", async () => {
    const c = caller();
    // Green case: same result object from both entry points.
    const viaRouter = await c.verify.run();
    const direct = await runFullVerification(db, vaultDir);
    expect(direct).toEqual(viaRouter);
    expect(direct.ok).toBe(true);
    // Tampered case: both must flag the same seq for the same reason.
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "other",
      direction: "internal", summary: "Parity check entry",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'parity-tampered' WHERE id = ${entry.id}`);
      const brokenRouter = await c.verify.run();
      const brokenDirect = await runFullVerification(db, vaultDir);
      expect(brokenDirect).toEqual(brokenRouter);
      expect(brokenDirect.ok).toBe(false);
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'Parity check entry' WHERE id = ${entry.id}`);
      expect((await runFullVerification(db, vaultDir)).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  it("detects tampering with a stored log entry row", async () => {
    const c = caller();
    const entry = await c.entries.create({ occurredAt: new Date(), channel: "call",
      direction: "inbound", summary: "Original untampered summary",
      participantPartyIds: [], documentIds: [], actionItems: [] });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'tampered' WHERE id = ${entry.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      // Restore so the chain is coherent again for later tests.
      await admin.db.execute(
        sql`UPDATE log_entries SET summary = 'Original untampered summary' WHERE id = ${entry.id}`);
      const restored = await c.verify.run();
      expect(restored.ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });
  /** A document with bytes on disk, ready to be purged. */
  async function mkVaultDoc(label: string) {
    const c = caller();
    const buf = Buffer.from(`${label}-${crypto.randomUUID()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: label, source: "upload", receivedAt: new Date() });
  }

  it("stays green after a purge, and counts it instead of hashing it", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge and verify");
    const before = await c.verify.run();
    expect(before.ok).toBe(true);
    await c.documents.purge({ id: doc.id, reason: "dubbel gescand" });
    const after = await c.verify.run();
    expect(after.ok).toBe(true);
    // The file is no longer hashed, and the deletion is DISCLOSED rather than
    // silently absorbed. A design where files vanish without /verify saying so
    // is the hole this whole sub-project avoids.
    expect(after.checkedFiles).toBe(before.checkedFiles - 1);
    expect(after.purgedFiles).toBe(before.purgedFiles + 1);
    expect(after.purgedFilesOnDisk).toBe(0);
  });

  it("counts a purge whose bytes survived the unlink", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge that left bytes");
    await c.documents.purge({ id: doc.id });
    const fresh = await c.documents.get({ id: doc.id });
    const abs = join(vaultDir, relPathFor(fresh.sha256));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from("leftover"));
    try {
      const res = await c.verify.run();
      expect(res.ok).toBe(true);
      expect(res.purgedFilesOnDisk).toBe(1);
    } finally {
      // Otherwise this leftover file outlives the test: purgedFilesOnDisk
      // would stay >=1 for the rest of the file, and "stays green after a
      // purge" only asserts it back down to 0 because it happens to run
      // first — an order dependency this cleanup removes.
      await unlink(abs);
    }
  });

  /**
   * THE LEFTOVER IS DETECTED, NOT ASSUMED AWAY — the law this design already
   * applies to the vault file, applied to the other two tables the purge
   * destroys. Three writers can put them back (suggest.docmeta's OCR, the
   * search drain's embed, extract-texts), every guard against them is
   * check-then-act, and a purge fires no search_outbox trigger, so nothing
   * notices on its own. /verify is the surface that has to say so.
   */
  it("counts a purged document whose text or chunks came back", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge leftover rows");
    await c.documents.purge({ id: doc.id });
    expect((await c.verify.run()).purgedContentLeftovers).toBe(0);

    const worker = createDb(WORKER_URL);
    try {
      await worker.db.execute(sql`INSERT INTO document_texts
        (document_id, sha256, text, extractor, char_count)
        VALUES (${doc.id}, ${doc.sha256}, ${'teruggekomen inhoud'}, 'none', 19)`);
      await worker.db.execute(sql`INSERT INTO search_chunks
        (entity_type, entity_id, chunk_index, title, body, source_hash)
        VALUES ('document', ${doc.id}, 0, 'Purge leftover rows',
                ${'teruggekomen inhoud'}, 'leftover')`);
      const res = await c.verify.run();
      // Still green — the CHAIN is intact, and this is a repairable leftover
      // rather than tampering. It is disclosed, not turned into a failure.
      expect(res.ok).toBe(true);
      expect(res.purgedContentLeftovers).toBe(1);
    } finally {
      await worker.pool.end();
    }

    // The repair, which is also this test's cleanup: a second purge re-runs
    // both DELETEs.
    await c.documents.purge({ id: doc.id });
    expect((await c.verify.run()).purgedContentLeftovers).toBe(0);
  });

  /**
   * THE COUNT IS LEDGER-DRIVEN ALL THE WAY DOWN, not only in the id set it is
   * handed. `verder_app` holds INSERT on document_purges, so a row vouching for
   * a purge that never happened is one INSERT away — the same attack the
   * "refuses to treat an orphan purge row as a purge" test below covers for the
   * chain, aimed at the leftover count instead.
   *
   * It is a test the obvious one cannot replace: the case above is ledger-backed
   * AND has both leftovers, so it counts 1 under either reading of the
   * predicate. Only an orphan row with surviving chunks separates
   * `inLedgerSet AND (text OR chunks)` from the operator-precedence reading
   * `(inLedgerSet AND text) OR chunks`, which counts any purge row whose chunks
   * survive no matter who wrote it.
   */
  it("does not count leftovers under an orphan purge row", async () => {
    const c = caller();
    // A genuine, fully-swept purge: purgedEntityIds must be non-empty or the
    // count short-circuits to 0 and the test proves nothing.
    const real = await mkVaultDoc("Echte purge naast de wees");
    await c.documents.purge({ id: real.id });
    const before = (await c.verify.run()).purgedContentLeftovers;

    const orphan = await mkVaultDoc("Wees-purge met chunk");
    const admin = createDb(ADMIN_URL);
    const worker = createDb(WORKER_URL);
    try {
      // Bytes stay on disk: this document was never purged, so the chain must
      // stay green and the only thing under test is the leftover count.
      await admin.db.execute(sql`INSERT INTO document_purges
        (document_id, sha256, size_bytes, reason, created_by)
        VALUES (${orphan.id}, ${orphan.sha256}, ${orphan.sizeBytes},
                'geen echte purge', ${userId})`);
      await worker.db.execute(sql`INSERT INTO search_chunks
        (entity_type, entity_id, chunk_index, title, body, source_hash)
        VALUES ('document', ${orphan.id}, 0, 'Wees-purge met chunk',
                ${'inhoud die nooit gepurged is'}, 'orphan')`);

      const res = await c.verify.run();
      expect(res.purgedContentLeftovers).toBe(before);
    } finally {
      await admin.db.execute(
        sql`DELETE FROM document_purges WHERE document_id = ${orphan.id}`);
      await admin.db.execute(
        sql`DELETE FROM search_chunks WHERE entity_id = ${orphan.id}`);
      await admin.pool.end();
      await worker.pool.end();
    }
  });

  // The whole reason this shape was chosen over deleting the row: an entry's
  // ledgered payload carries documentIds, and entry_documents is untouched.
  it("stays green when the purged document is cited by a logbook entry", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Cited then purged");
    await c.entries.create({ occurredAt: new Date(), channel: "email",
      direction: "inbound", summary: "Entry citing a document that gets purged",
      participantPartyIds: [], documentIds: [doc.id], actionItems: [] });
    expect((await c.verify.run()).ok).toBe(true);
    await c.documents.purge({ id: doc.id });
    const res = await c.verify.run();
    expect(res).toMatchObject({ ok: true });
  });

  it("detects an edited purge reason", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge to be tampered");
    await c.documents.purge({ id: doc.id, reason: "de echte reden" });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE document_purges SET reason = 'herschreven'
        WHERE document_id = ${doc.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      await admin.db.execute(sql`UPDATE document_purges SET reason = 'de echte reden'
        WHERE document_id = ${doc.id}`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  // A purge cannot be laundered by removing its record: without the purge row
  // the ingested branch falls through to the file read and reports the bytes
  // missing, exactly as it does for any other vanished file.
  it("detects a purge record deleted to hide a destroyed file", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge record to be deleted");
    await c.documents.purge({ id: doc.id });
    const admin = createDb(ADMIN_URL);
    try {
      const [row] = (await admin.db.execute(
        sql`SELECT sha256, size_bytes, reason FROM document_purges
            WHERE document_id = ${doc.id}`)).rows as
        { sha256: string; size_bytes: string; reason: string | null }[];
      await admin.db.execute(sql`DELETE FROM document_purges WHERE document_id = ${doc.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      // Restore, so the rest of this file's chain stays green.
      await admin.db.execute(sql`INSERT INTO document_purges
        (document_id, sha256, size_bytes, reason, created_by)
        VALUES (${doc.id}, ${row.sha256}, ${row.size_bytes}, ${row.reason}, ${userId})`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  // IMPORTANT (Task 3 review): verification must be driven by the LEDGER,
  // never by the presence of a document_purges row. `verder_app` holds
  // INSERT on that table, so an attacker could destroy a vault file and
  // INSERT a matching tombstone row with no ledger event at all — the row
  // alone must never be trusted, because an orphan row is never visited by
  // any dispatch branch. Reproduced here by deleting an otherwise-genuine
  // purge's document.purged LEDGER EVENT while leaving its document_purges
  // row untouched, which leaves the store in exactly that shape.
  it("detects a purge row with no matching ledger event", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge event to be deleted");
    await c.documents.purge({ id: doc.id });
    const admin = createDb(ADMIN_URL);
    try {
      const [ev] = (await admin.db.execute(
        sql`SELECT seq, event_type, entity_type, entity_id, payload_hash, prev_hash,
                   event_hash, created_at
            FROM ledger_events WHERE entity_id = ${doc.id} AND event_type = 'document.purged'`))
        .rows as { seq: string; event_type: string; entity_type: string; entity_id: string;
          payload_hash: string; prev_hash: string; event_hash: string; created_at: string }[];
      await admin.db.execute(sql`DELETE FROM ledger_events WHERE seq = ${ev.seq}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      // The REASON, not merely "not ok": the ingested branch falls through to
      // the file read and reports the bytes missing, which is what proves the
      // orphan row bought nothing. Asserting ok alone would also pass if the
      // chain had simply broken elsewhere.
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      // Restore, so the rest of this file's chain stays green.
      await admin.db.execute(sql`INSERT INTO ledger_events
        (seq, event_type, entity_type, entity_id, payload_hash, prev_hash, event_hash, created_at)
        VALUES (${ev.seq}, ${ev.event_type}, ${ev.entity_type}, ${ev.entity_id},
                ${ev.payload_hash}, ${ev.prev_hash}, ${ev.event_hash}, ${ev.created_at})`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  /**
   * THE ATTACK ITSELF, rather than a proxy for it. The test above reaches the
   * ledger-driven guard by DELETING a genuine purge's event, which only works
   * because that event happens to be the chain head — a coincidence of
   * ordering, not the shape an attacker produces. This is the real one:
   * `verder_app` holds INSERT on document_purges, so destroying a vault file
   * and vouching for it with a tombstone row that no ledger event backs is one
   * INSERT away. It must buy nothing.
   */
  it("refuses to treat an orphan purge row as a purge", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Orphan purge row");
    const abs = join(vaultDir, relPathFor(doc.sha256));
    const bytes = await readFile(abs);
    const admin = createDb(ADMIN_URL);
    try {
      await unlink(abs);
      await admin.db.execute(sql`INSERT INTO document_purges
        (document_id, sha256, size_bytes, reason, created_by)
        VALUES (${doc.id}, ${doc.sha256}, ${doc.sizeBytes}, 'geen echte purge', ${userId})`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");

      // Restore both halves, so the rest of this file's chain stays green.
      await admin.db.execute(sql`DELETE FROM document_purges WHERE document_id = ${doc.id}`);
      await writeFile(abs, bytes);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });

  // MINOR 4 (Task 3 review): purge-sha-mismatch is a real dispatch line
  // (makeLedgerRecompute's document.ingested branch) and an untested one is
  // exactly the sub-project 2 lesson this file's own doc comment on
  // makeLedgerRecompute names. Reachable via an admin UPDATE on
  // document_purges.sha256; the chain reports the break at the EARLIER
  // document.ingested seq, not the later document.purged seq, because
  // verifyChain stops at the first broken event it finds.
  it("detects a purge tombstone naming the wrong sha256", async () => {
    const c = caller();
    const doc = await mkVaultDoc("Purge sha to be tampered");
    await c.documents.purge({ id: doc.id });
    const admin = createDb(ADMIN_URL);
    try {
      await admin.db.execute(sql`UPDATE document_purges SET sha256 = repeat('f', 64)
        WHERE document_id = ${doc.id}`);
      const broken = await c.verify.run();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.reason).toBe("payload_hash_mismatch");
      await admin.db.execute(sql`UPDATE document_purges SET sha256 = ${doc.sha256}
        WHERE document_id = ${doc.id}`);
      expect((await c.verify.run()).ok).toBe(true);
    } finally {
      await admin.pool.end();
    }
  });
});
