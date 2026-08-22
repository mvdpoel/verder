import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// APP role: the triggers must work for the role the web app actually uses, and
// that role has NO INSERT grant on search_outbox (Task 2) — the SECURITY
// DEFINER function is the only thing that makes these rows land.
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
// WORKER role: document_texts is the one table below that the app role cannot
// write (migration 0016 gives it SELECT only) because extraction is the
// worker's job. Its trigger therefore has to be exercised as the worker.
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("search_outbox triggers", () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>["pool"];
  let workerDb: Db;
  let workerPool: ReturnType<typeof createDb>["pool"];
  let userId: string;

  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  beforeAll(async () => {
    ({ db, pool } = createDb(APP_URL));
    ({ db: workerDb, pool: workerPool } = createDb(WORKER_URL));
    const [u] = await db.insert(schema.users)
      .values({ email: `outbox${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });

  afterAll(async () => {
    await pool.end();
    await workerPool.end();
  });

  // The dev database is shared by every test file, so every assertion is scoped
  // to an entity id this test just created — never a global count.
  const outboxFor = (entityType: string, entityId: string) =>
    db.select().from(schema.searchOutbox)
      .where(and(eq(schema.searchOutbox.entityType, entityType),
        eq(schema.searchOutbox.entityId, entityId)));

  const makeDocument = async () => {
    const [doc] = await db.insert(schema.documents).values({
      sha256: sha(), title: "Brief van de rechtbank", mime: "application/pdf",
      sizeBytes: 1234, source: "upload", receivedAt: new Date("2026-08-01T09:00:00Z"),
    }).returning();
    return doc;
  };

  const makeEntry = async () => {
    const [entry] = await db.insert(schema.logEntries).values({
      occurredAt: new Date("2026-08-01T10:00:00Z"), channel: "email",
      direction: "inbound", summary: "Bericht van VerderGroep ontvangen",
      source: "manual", createdBy: userId,
    }).returning();
    return entry;
  };

  // `tracks` and `stops` are covered in tracks-schema.test.ts instead — they are
  // the only indexed tables that cannot be reached without the seeded map, and
  // that suite already owns the seed. `milestones` and `timeline_events` are
  // NOT covered anywhere any more: sub-project 6 retired both entity kinds and
  // migration 0023 drops their triggers, so a row here would be a job
  // search.drain can never complete.
  it("enqueues exactly one row per insert on each indexed entity table", async () => {
    const [party] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `VerderGroep ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("party", party.id)).toHaveLength(1);

    const doc = await makeDocument();
    expect(await outboxFor("document", doc.id)).toHaveLength(1);

    const entry = await makeEntry();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);

    const [email] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `outbox-test-${crypto.randomUUID()}`,
      gmailThreadId: `thread-${crypto.randomUUID()}`,
      fromAddr: "contact@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Opzegging bevestigd", sentAt: new Date("2026-08-01T11:00:00Z"),
      rawRfc822Sha256: sha(), bodyText: "Uw opzegging is verwerkt.",
    }).returning();
    expect(await outboxFor("email", email.id)).toHaveLength(1);

    const [item] = await db.insert(schema.financialItems).values({
      name: `Ziggo ${crypto.randomUUID()}`, category: "telecom", amountCents: 5500,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    expect(await outboxFor("financial_item", item.id)).toHaveLength(1);

    const [debt] = await db.insert(schema.debts)
      .values({ creditorName: `Intrum ${crypto.randomUUID()}`, claimedCents: 120000 }).returning();
    expect(await outboxFor("debt", debt.id)).toHaveLength(1);

    const [task] = await db.insert(schema.tasks)
      .values({ title: "Kopie paspoort opsturen", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);

    // A retired kind must NOT enqueue: 0023 dropped both triggers, because
    // loadAndRender throws on a type that left SEARCH_ENTITY_TYPES and the
    // drain would retry that row every 60 s forever.
    const [milestone] = await db.insert(schema.milestones)
      .values({ stage: "onboarding", title: "Onboarding gestart (outbox test)" }).returning();
    expect(await outboxFor("milestone", milestone.id)).toHaveLength(0);

    const [event] = await db.insert(schema.timelineEvents).values({
      title: "Verzoek verstuurd naar de rechtbank",
      happenedAt: new Date("2026-08-01T12:00:00Z"), kind: "process",
    }).returning();
    expect(await outboxFor("timeline_event", event.id)).toHaveLength(0);
  });

  it("enqueues a second row when an entity row is UPDATEd", async () => {
    const [task] = await db.insert(schema.tasks)
      .values({ title: "Bankafschrift zoeken", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);
    await db.update(schema.tasks).set({ details: "Q2 2026" })
      .where(eq(schema.tasks.id, task.id));
    expect(await outboxFor("task", task.id)).toHaveLength(2);
  });

  it("refreshes the parent document when a status change lands", async () => {
    const doc = await makeDocument();
    expect(await outboxFor("document", doc.id)).toHaveLength(1);
    // Approving a doc-meta suggestion writes here and never touches `documents`.
    await db.insert(schema.documentStatusChanges).values({
      documentId: doc.id, status: "filed", title: "Beschikking rechtbank",
      docType: "beschikking",
    });
    expect(await outboxFor("document", doc.id)).toHaveLength(2);
  });

  it("refreshes the parent document when its extracted text lands", async () => {
    const doc = await makeDocument();
    expect(await outboxFor("document", doc.id)).toHaveLength(1);
    // Extraction is asynchronous — the document is indexed on title and metadata
    // first, and its OCR/PDF text arrives later. Without this trigger the text
    // this whole sub-project exists to make searchable would sit in
    // document_texts referenced by no chunk. Found on the production backfill:
    // 18 documents indexed, 0 document_texts rows.
    await workerDb.insert(schema.documentTexts).values({
      documentId: doc.id, sha256: doc.sha256, text: "Uw dossiernummer is 24-1187.",
      extractor: "pdf-parse", charCount: 28,
    });
    expect(await outboxFor("document", doc.id)).toHaveLength(2);
  });

  it("refreshes the parent task when a status change lands", async () => {
    const [task] = await db.insert(schema.tasks)
      .values({ title: "Loonstrook uploaden", createdBy: userId }).returning();
    expect(await outboxFor("task", task.id)).toHaveLength(1);
    await db.insert(schema.taskStatusChanges)
      .values({ taskId: task.id, status: "in-progress", createdBy: userId });
    expect(await outboxFor("task", task.id)).toHaveLength(2);
  });

  it("refreshes the financial item a registry decision targets", async () => {
    const [item] = await db.insert(schema.financialItems).values({
      name: `Eneco ${crypto.randomUUID()}`, category: "energy", amountCents: 14280,
      billingCycle: "monthly", paymentChannel: "direct-debit",
    }).returning();
    expect(await outboxFor("financial_item", item.id)).toHaveLength(1);
    await db.insert(schema.registryDecisions).values({
      financialItemId: item.id, status: "mandatory",
      explanation: "Energie is een vaste last.", createdBy: userId,
    });
    expect(await outboxFor("financial_item", item.id)).toHaveLength(2);
  });

  it("refreshes the debt a registry decision targets, and not a financial item", async () => {
    const [debt] = await db.insert(schema.debts)
      .values({ creditorName: `Vesting ${crypto.randomUUID()}`, claimedCents: 84000 }).returning();
    expect(await outboxFor("debt", debt.id)).toHaveLength(1);
    await db.insert(schema.registryDecisions).values({
      debtId: debt.id, status: "acknowledged",
      explanation: "Vordering erkend na controle.", createdBy: userId,
    });
    expect(await outboxFor("debt", debt.id)).toHaveLength(2);
    // The routing branch must not fire the other way round.
    expect(await outboxFor("financial_item", debt.id)).toHaveLength(0);
  });

  it("refreshes the parent entry when a participant is linked", async () => {
    const entry = await makeEntry();
    const [party] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Bewindvoerder ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);
    await db.insert(schema.entryParticipants).values({ entryId: entry.id, partyId: party.id });
    expect(await outboxFor("entry", entry.id)).toHaveLength(2);
  });

  it("refreshes the parent entry when a document is linked", async () => {
    const entry = await makeEntry();
    const doc = await makeDocument();
    expect(await outboxFor("entry", entry.id)).toHaveLength(1);
    await db.insert(schema.entryDocuments).values({ entryId: entry.id, documentId: doc.id });
    expect(await outboxFor("entry", entry.id)).toHaveLength(2);
  });

  it("appends no ledger events — the index is derived, not evidence", async () => {
    const [party] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Ledgerloos ${crypto.randomUUID()}` }).returning();
    expect(await outboxFor("party", party.id)).toHaveLength(1);
    const events = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.entityId, party.id));
    expect(events).toHaveLength(0);
  });
});
