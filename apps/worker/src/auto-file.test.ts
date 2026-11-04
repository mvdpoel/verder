import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, desc, eq, sql } from "drizzle-orm";
import { type ChainEvent } from "@grip/core";
import { createDb, schema, type Db } from "@grip/db";
import { appendLedgerEvent } from "@grip/api/src/ledger";
import { effectiveDocument, ingestDocument } from "@grip/api/src/routers/documents";
import { makeLedgerRecompute, resolveDocumentUpdatedHashes } from "@grip/api/src/verification";
import { settleDocumentTexts } from "./test-support/document-texts";
import { autoApplyDocMeta } from "./auto-file";

// Worker role: the role suggest.docmeta meets in production.
const URL = "postgres://grip_worker:grip_worker@localhost:5432/grip";
const RUN = crypto.randomUUID();
const ON = { DOCMETA_AUTO_APPLY: "on" } as NodeJS.ProcessEnv;

describe("autoApplyDocMeta", () => {
  const { db, pool } = createDb(URL);
  afterAll(async () => { await pool.end(); });

  const sha = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

  async function doc(title = `scan-${RUN}-${crypto.randomUUID()}.pdf`) {
    const ref = `test:auto-file:${RUN}:${crypto.randomUUID()}`;
    const d = await db.transaction((tx) => ingestDocument(tx, {
      sha256: sha(), sizeBytes: 10, mime: "application/pdf",
      title, source: "nas-scan", sourceRef: ref, receivedAt: new Date() }));
    await settleDocumentTexts(db, ref);
    return d;
  }

  async function suggestion(documentId: string, over: {
    status?: "pending" | "needs-manual"; promptVersion?: string;
    proposed?: Record<string, unknown>;
  } = {}) {
    const [s] = await db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model: "qwen3.5:9b",
      status: over.status ?? "pending", promptVersion: over.promptVersion ?? "docmeta-v2",
      proposed: over.proposed ?? { title: "Loonstrook juli", docType: "Loonstrook", confident: true },
    }).returning();
    return s;
  }

  const eventsFor = async (documentId: string) =>
    db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, documentId)).orderBy(asc(schema.ledgerEvents.seq));
  const changesFor = async (documentId: string) =>
    db.select().from(schema.documentStatusChanges)
      .where(eq(schema.documentStatusChanges.documentId, documentId))
      .orderBy(asc(schema.documentStatusChanges.createdAt));
  const reload = async (id: string) =>
    (await db.select().from(schema.suggestions).where(eq(schema.suggestions.id, id)))[0];

  /** A rename the way documents.update writes it: Martin's row, actor NULL. */
  async function martinRenames(documentId: string, title: string) {
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.documentStatusChanges).values({
        documentId, status: "inbox", title }).returning();
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: documentId,
        payload: { id: documentId, status: "inbox", title, docType: null, partyId: null } });
      return row;
    });
  }

  /** auto-name's row: the app actor (APP_ACTOR), no suggestion. */
  async function gripRenames(documentId: string, title: string) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId, status: "inbox", title, actor: "verder", suggestionId: null });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: documentId,
        payload: { id: documentId, status: "inbox", title, docType: null, partyId: null,
          actor: "verder", suggestionId: null } });
    });
  }

  it("disabled appends nothing", async () => {
    const d = await doc();
    const s = await suggestion(d.id);
    const runsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(schema.workerRuns)
      .where(sql`${schema.workerRuns.worker} = 'auto-file' AND ${schema.workerRuns.detail}->>'suggestionId' = ${s.id}`);
    for (const env of [{} as NodeJS.ProcessEnv, { DOCMETA_AUTO_APPLY: "1" } as NodeJS.ProcessEnv,
      { DOCMETA_AUTO_APPLY: "ON" } as NodeJS.ProcessEnv]) {
      expect(await autoApplyDocMeta(db, s.id, env)).toEqual({ applied: false, reason: "disabled" });
    }
    expect(await eventsFor(d.id)).toHaveLength(1); // document.ingested only
    expect(await changesFor(d.id)).toHaveLength(0);
    expect((await reload(s.id)).status).toBe("pending");
    const runsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(schema.workerRuns)
      .where(sql`${schema.workerRuns.worker} = 'auto-file' AND ${schema.workerRuns.detail}->>'suggestionId' = ${s.id}`);
    expect(runsAfter[0].n).toBe(runsBefore[0].n);
  });

  it("needs-manual never applies", async () => {
    const d = await doc();
    const s = await suggestion(d.id, { status: "needs-manual" });
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "not-pending" });
    expect(await changesFor(d.id)).toHaveLength(0);
    expect((await reload(s.id)).status).toBe("needs-manual");
  });

  it("not confident never applies", async () => {
    for (const proposed of [
      { title: "Brief", docType: "Brief", confident: false },
      { title: "Brief", docType: "Brief" },
      { title: "Brief", docType: "Brief", confident: "true" },
    ]) {
      const d = await doc();
      const s = await suggestion(d.id, { proposed });
      expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "not-confident" });
      expect(await changesFor(d.id)).toHaveLength(0);
    }
  });

  it("an unmeasured prompt version never applies", async () => {
    const d = await doc();
    const s = await suggestion(d.id, { promptVersion: "docmeta-v1" });
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "prompt-version" });
    expect(await changesFor(d.id)).toHaveLength(0);
  });

  it("a confident answer with no soort never applies", async () => {
    for (const docType of [null, "", "   "]) {
      const d = await doc();
      const s = await suggestion(d.id, { proposed: { title: "Brief", docType, confident: true } });
      expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "no-soort" });
      expect(await changesFor(d.id)).toHaveLength(0);
    }
  });

  it("applies once and appends exactly one document.updated", async () => {
    const d = await doc();
    const s = await suggestion(d.id);
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: true, reason: "applied" });

    const events = await eventsFor(d.id);
    expect(events.map((e) => e.eventType)).toEqual(["document.ingested", "document.updated"]);
    const changes = await changesFor(d.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: "filed", title: d.title, docType: "Loonstrook",
      actor: "verder", suggestionId: s.id });

    const after = await reload(s.id);
    expect(after.status).toBe("auto-applied");
    expect(after.verdictAt).not.toBeNull();
    expect(after.finalPayload).toEqual({ title: d.title, docType: "Loonstrook",
      before: { status: "inbox", title: d.title, docType: null }, changeId: changes[0].id });

    const eff = await effectiveDocument(db, d.id);
    expect(eff.effectiveStatus).toBe("filed");
    expect(eff.effectiveDocType).toBe("Loonstrook");

    const [run] = await db.select().from(schema.workerRuns)
      .where(sql`${schema.workerRuns.worker} = 'auto-file' AND ${schema.workerRuns.detail}->>'suggestionId' = ${s.id}`)
      .orderBy(desc(schema.workerRuns.ranAt));
    expect(run.status).toBe("ok");
    expect(run.detail).toEqual({ suggestionId: s.id, applied: true, reason: "applied" });
  });

  it("keeps the effective title and applies only status and soort", async () => {
    const d = await doc();
    const named = `Loonstrook.mp.2026-07.Saurens.${RUN.slice(0, 8)}.pdf`;
    await gripRenames(d.id, named);
    const s = await suggestion(d.id, {
      proposed: { title: "Loonstrook van juli", docType: "Loonstrook", confident: true } });
    expect((await autoApplyDocMeta(db, s.id, ON)).applied).toBe(true);
    const eff = await effectiveDocument(db, d.id);
    expect(eff.effectiveTitle).toBe(named);
    expect(eff.effectiveStatus).toBe("filed");
    const changes = await changesFor(d.id);
    expect(changes.at(-1)).toMatchObject({ title: named, partyId: null });
    expect((await reload(s.id)).finalPayload).toMatchObject({ title: named,
      before: { status: "inbox", title: named, docType: null } });
  });

  it("second call is a no-op", async () => {
    const d = await doc();
    const s = await suggestion(d.id);
    expect((await autoApplyDocMeta(db, s.id, ON)).applied).toBe(true);
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "not-pending" });
    expect(await eventsFor(d.id)).toHaveLength(2);
    expect(await changesFor(d.id)).toHaveLength(1);
  });

  it("concurrent calls apply once", async () => {
    const d = await doc();
    const s = await suggestion(d.id);
    const out = await Promise.all([autoApplyDocMeta(db, s.id, ON), autoApplyDocMeta(db, s.id, ON)]);
    expect(out.filter((o) => o.applied)).toHaveLength(1);
    expect(await changesFor(d.id)).toHaveLength(1);
  });

  it("a Martin change since ingest blocks it", async () => {
    const d = await doc();
    await martinRenames(d.id, `Martin-${RUN}-${crypto.randomUUID()}.pdf`);
    const s = await suggestion(d.id);
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "touched-by-martin" });
    expect(await changesFor(d.id)).toHaveLength(1);
    expect((await reload(s.id)).status).toBe("pending");
  });

  it("a document no longer in the inbox blocks it", async () => {
    const d = await doc();
    // An app-actor row that moved it out of the inbox — the only way past the
    // touched-by-martin guard to a non-inbox status.
    await db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: d.id, status: "filed", title: d.title, actor: "verder" });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: d.id,
        payload: { id: d.id, status: "filed", title: d.title, docType: null, partyId: null,
          actor: "verder", suggestionId: null } });
    });
    const s = await suggestion(d.id);
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "not-inbox" });
  });

  it("purged document blocks it", async () => {
    const d = await doc();
    const [u] = await db.insert(schema.users)
      .values({ email: `${RUN}-${crypto.randomUUID()}-purger@test.local`, name: "Martin" }).returning();
    await db.insert(schema.documentPurges).values({
      documentId: d.id, sha256: d.sha256, sizeBytes: d.sizeBytes, reason: null, createdBy: u.id });
    const s = await suggestion(d.id);
    expect(await autoApplyDocMeta(db, s.id, ON)).toEqual({ applied: false, reason: "purged" });
    expect(await changesFor(d.id)).toHaveLength(0);
    expect((await reload(s.id)).status).toBe("pending");
  });

  it("a missing suggestion or another kind is refused", async () => {
    expect(await autoApplyDocMeta(db, crypto.randomUUID(), ON))
      .toEqual({ applied: false, reason: "not-found" });
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `auto-file-${RUN}-${crypto.randomUUID()}`, gmailThreadId: "t",
      fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "x", sentAt: new Date(), rawRfc822Sha256: "c".repeat(64), bodyText: "x" }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, status: "rejected", promptVersion: "docmeta-v2",
      proposed: { confident: true, docType: "Brief" } }).returning();
    expect(await autoApplyDocMeta(db, s.id, ON))
      .toEqual({ applied: false, reason: "not-document-meta" });
  });

  it("app-actor row verifies under nightly recompute", async () => {
    const d = await doc();
    const s = await suggestion(d.id);
    expect((await autoApplyDocMeta(db, s.id, ON)).applied).toBe(true);
    const rows = await eventsFor(d.id);
    const ev = rows.find((e) => e.eventType === "document.updated")!;
    const event: ChainEvent = { seq: ev.seq, eventType: ev.eventType,
      entityType: ev.entityType, entityId: ev.entityId,
      payloadHash: ev.payloadHash, prevHash: ev.prevHash, eventHash: ev.eventHash };
    const recompute = makeLedgerRecompute(db as Db, mkdtempSync(join(tmpdir(), "auto-file-vault-")), {
      linkedLater: new Map(), resolvedLinkHash: new Map(),
      resolvedStatusHash: await resolveDocumentUpdatedHashes(db, rows) });
    expect(await recompute(event)).toBe(ev.payloadHash);
  });
});
