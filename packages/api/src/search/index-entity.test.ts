import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex, type SearchEntityType } from "@verder/core";
import { appendLedgerEvent } from "../ledger";
import { ingestDocument } from "../routers/documents";
import { insertEntry } from "../routers/entries";
import { decide } from "../registry-decide";
import { setTaskStatus } from "../task-decide";
import { EMBED_DIMENSIONS, type EmbedPort } from "./embed";
import { indexEntity, loadAndRender } from "./index-entity";

// verder_worker, not verder_app: the derived-index grants give the app role
// SELECT only on document_texts and search_chunks — writing them is the
// worker's job, and this loader runs inside the worker.
const DB_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

let db: Db;
let userId: string;

beforeAll(async () => {
  db = createDb(DB_URL).db;
  const [u] = await db.insert(schema.users)
    .values({ email: `loader${Date.now()}@test.local`, name: "Martin" }).returning();
  userId = u.id;
});

/** ~2.7 kB of letter text with paragraph breaks, so a 1200-character chunker
 *  has to produce more than one chunk. The two markers sit at the very start
 *  and the very end, so the first and last chunk are identifiable. */
function longLetter(marker: string): string {
  return [
    `DOSSIER-${marker} betreft de opzegging van uw abonnement.`,
    "a".repeat(650),
    "b".repeat(650),
    "c".repeat(650),
    "d".repeat(650),
    `SLOT-${marker} einde van de brief.`,
  ].join("\n\n");
}

/** A vault document plus the extracted text row that Task 3's
 *  storeDocumentText writes in production. */
async function makeDocument(marker: string, text: string) {
  const doc = await db.transaction((tx) => ingestDocument(tx, {
    sha256: sha256Hex(marker), sizeBytes: 12_345, mime: "application/pdf",
    title: `Brief Ziggo ${marker}.pdf`, source: "nas-scan", docType: "brief",
    receivedAt: new Date("2026-08-19T10:00:00Z"),
  }));
  await db.insert(schema.documentTexts).values({
    documentId: doc.id, sha256: doc.sha256, text, extractor: "ocr-pdf",
    charCount: text.length, truncated: false,
  });
  return doc;
}

describe("loadAndRender — documents", () => {
  it("reads the persisted extracted text and splits a long letter into several chunks", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));

    const chunks = await loadAndRender(db, "document", doc.id);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.entityType === "document")).toBe(true);
    expect(chunks.every((c) => c.entityId === doc.id)).toBe(true);
    expect(chunks.every((c) => c.title === `Brief Ziggo ${marker}.pdf`)).toBe(true);
    expect(chunks.every((c) => c.occurredAt?.toISOString() === "2026-08-19T10:00:00.000Z")).toBe(true);
    // The OCR'd text is actually in the index — this is the whole point of
    // persisting document_texts.
    expect(chunks[0].body).toContain(`DOSSIER-${marker}`);
    expect(chunks[chunks.length - 1].body).toContain(`SLOT-${marker}`);
    // One hash per chunk, all distinct: the drain re-embeds per chunk, so a
    // single shared hash would make a partial edit invisible.
    expect(chunks.every((c) => /^[0-9a-f]{64}$/.test(c.sourceHash))).toBe(true);
    expect(new Set(chunks.map((c) => c.sourceHash)).size).toBe(chunks.length);
    // No status change yet: the documents row's own status stands.
    expect(chunks[0].status).toBe("inbox");
  });

  it("takes title and status from document_status_changes once doc-meta is approved", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, `Korte brief ${marker}.`);
    // Exactly what suggestions.approveDocumentMeta does: the insert-only
    // evidence row plus its ledger event, in one transaction.
    await db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: doc.id, status: "filed",
        title: `Ziggo opzegbrief ${marker}.pdf`, docType: "opzegging",
      });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: doc.id,
        payload: { id: doc.id, status: "filed",
          title: `Ziggo opzegbrief ${marker}.pdf`, docType: "opzegging" },
      });
    });

    const chunks = await loadAndRender(db, "document", doc.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe(`Ziggo opzegbrief ${marker}.pdf`);
    expect(chunks[0].status).toBe("filed");
  });

  it("returns [] when the row no longer exists", async () => {
    expect(await loadAndRender(db, "document", randomUUID())).toEqual([]);
  });
});

describe("loadAndRender — related values and effective status", () => {
  it("renders a logbook entry with its participants and linked documents, ordered by name", async () => {
    const marker = randomUUID();
    const [org] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `VerderGroep ${marker}` }).returning();
    const [person] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Anna ${marker}` }).returning();
    const doc = await makeDocument(marker, `Bijlage ${marker}.`);
    const entry = await db.transaction((tx) => insertEntry(tx, userId, {
      occurredAt: new Date("2026-08-19T09:00:00Z"), channel: "email", direction: "inbound",
      summary: `Paspoort gevraagd ${marker}`, details: "Kopie paspoort opsturen.",
      source: "manual", participantPartyIds: [org.id, person.id],
      documentIds: [doc.id], actionItems: [],
    }, { eventType: "entry.created" }));

    const chunks = await loadAndRender(db, "entry", entry.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe(`Paspoort gevraagd ${marker}`);
    expect(chunks[0].body).toContain(`Anna ${marker}`);
    expect(chunks[0].body).toContain(`VerderGroep ${marker}`);
    expect(chunks[0].body).toContain(`Brief Ziggo ${marker}.pdf`);
    // Sorted by party name, not by join order: an unordered join lets Postgres
    // return the same participants in a different order on a later drain, which
    // changes the body, changes source_hash and re-embeds for nothing.
    expect(chunks[0].body.indexOf(`Anna ${marker}`))
      .toBeLessThan(chunks[0].body.indexOf(`VerderGroep ${marker}`));
    expect(chunks[0].status).toBeNull();
  });

  it("stamps the effective task status and the assignee name", async () => {
    const marker = randomUUID();
    const [assignee] = await db.insert(schema.parties)
      .values({ kind: "person", name: `Martin ${marker}` }).returning();
    const [task] = await db.insert(schema.tasks).values({
      title: `Kopie paspoort opsturen ${marker}`, details: "Naar VerderGroep mailen.",
      assigneePartyId: assignee.id, dueAt: new Date("2026-09-01T00:00:00Z"),
      createdBy: userId,
    }).returning();
    await db.transaction((tx) => setTaskStatus(tx, userId, {
      taskId: task.id, status: "in-progress", note: "Begonnen." }));

    const chunks = await loadAndRender(db, "task", task.id);

    expect(chunks).toHaveLength(1);
    // Status lives in task_status_changes; the tasks row itself has no status
    // column at all, so reading the row alone would index nothing.
    expect(chunks[0].status).toBe("in-progress");
    expect(chunks[0].body).toContain(`Martin ${marker}`);
    expect(chunks[0].occurredAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("stamps the effective financial-item status and the provider name", async () => {
    const marker = randomUUID();
    const [provider] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `Ziggo B.V. ${marker}` }).returning();
    const [item] = await db.insert(schema.financialItems).values({
      name: `Ziggo ${marker}`, category: "telecom", providerPartyId: provider.id,
      amountCents: 4250, billingCycle: "monthly", paymentChannel: "direct-debit",
      noticePeriod: "1 maand", cancellationMethod: "online",
      cancellationDetails: "Via Mijn Ziggo opzeggen.", accountNumber: "12345678",
    }).returning();
    await db.transaction((tx) => decide(tx, userId, {
      financialItemId: item.id, status: "to-cancel", explanation: "Niet noodzakelijk." }));

    const chunks = await loadAndRender(db, "financial_item", item.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].status).toBe("to-cancel");
    expect(chunks[0].body).toContain(`Ziggo B.V. ${marker}`);
  });

  it("stamps the effective debt status and the creditor party name", async () => {
    const marker = randomUUID();
    const [creditor] = await db.insert(schema.parties)
      .values({ kind: "organization", name: `Intrum ${marker}` }).returning();
    const [debt] = await db.insert(schema.debts).values({
      creditorPartyId: creditor.id, creditorName: `Intrum ${marker}`,
      claimedCents: 125_000, principalCents: 100_000, references_: `DOS-${marker}`,
    }).returning();
    await db.transaction((tx) => decide(tx, userId, {
      debtId: debt.id, status: "disputed", explanation: "Bedrag klopt niet." }));

    const chunks = await loadAndRender(db, "debt", debt.id);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].status).toBe("disputed");
    expect(chunks[0].body).toContain(`DOS-${marker}`);
  });

  it("renders e-mails, milestones, timeline events and parties with a null status", async () => {
    const marker = randomUUID();
    const [email] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${marker}`, gmailThreadId: `thr-${marker}`,
      fromAddr: "info@ziggo.nl", toAddr: "martin@vanderpoel.pro",
      subject: `Opzegging bevestigd ${marker}`, sentAt: new Date("2026-08-18T08:30:00Z"),
      rawRfc822Sha256: sha256Hex(`raw-${marker}`),
      bodyText: "Uw abonnement is opgezegd per 1 oktober.",
    }).returning();
    const [milestone] = await db.insert(schema.milestones).values({
      stage: "wsnp-start", title: `Toelating WSNP ${marker}`,
      expectedAt: new Date("2026-10-01T00:00:00Z"), note: "Zitting gepland.",
    }).returning();
    const [event] = await db.insert(schema.timelineEvents).values({
      title: `Intakegesprek ${marker}`, kind: "meeting",
      happenedAt: new Date("2026-08-05T13:00:00Z"),
    }).returning();
    const [party] = await db.insert(schema.parties).values({
      kind: "organization", name: `Bewind ${marker}`, email: "info@verdergroep.nl",
    }).returning();

    const cases: { type: SearchEntityType; id: string; title: string; contains: string }[] = [
      { type: "email", id: email.id, title: `Opzegging bevestigd ${marker}`,
        contains: "Uw abonnement is opgezegd per 1 oktober." },
      { type: "milestone", id: milestone.id, title: `Toelating WSNP ${marker}`,
        contains: "Zitting gepland." },
      { type: "timeline_event", id: event.id, title: `Intakegesprek ${marker}`,
        contains: `Intakegesprek ${marker}` },
      { type: "party", id: party.id, title: `Bewind ${marker}`,
        contains: "info@verdergroep.nl" },
    ];
    for (const c of cases) {
      const chunks = await loadAndRender(db, c.type, c.id);
      expect(chunks, c.type).toHaveLength(1);
      expect(chunks[0].title, c.type).toBe(c.title);
      expect(chunks[0].body, c.type).toContain(c.contains);
      expect(chunks[0].status, c.type).toBeNull();
    }
  });
});

/** A fake embedding client that records every text it is handed. */
function fakeEmbed() {
  const spy = vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))));
  return { spy, port: { embed: spy } satisfies EmbedPort };
}

const chunkRows = (entityId: string) =>
  db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, "document"),
      eq(schema.searchChunks.entityId, entityId)))
    .orderBy(asc(schema.searchChunks.chunkIndex));

describe("indexEntity", () => {
  it("upserts every chunk and embeds each one exactly once, with the document prefix", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    const { spy, port } = fakeEmbed();

    const result = await indexEntity({ db, embed: port }, "document", doc.id);

    expect(result.chunks).toBeGreaterThan(1);
    expect(result.embedded).toBe(result.chunks);
    expect(result.unchanged).toBe(0);
    const rows = await chunkRows(doc.id);
    expect(rows).toHaveLength(result.chunks);
    expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
    expect(rows.every((r) => r.embedding !== null)).toBe(true);
    expect(rows.every((r) => r.embedAttempts === 0)).toBe(true);
    expect(rows.every((r) => r.status === "inbox")).toBe(true);
    const texts = spy.mock.calls.flatMap(([batch]) => batch);
    expect(texts).toHaveLength(result.chunks);
    expect(texts.every((t) => t.startsWith("search_document: "))).toBe(true);
    // Chunks are indexed, not evidence: nothing is appended to the ledger.
    const ledger = await db.select().from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.eventType, "search.indexed"));
    expect(ledger).toHaveLength(0);
  });

  it("makes zero embed calls when the rendered content is unchanged", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);
    const before = await chunkRows(doc.id);

    const { spy, port } = fakeEmbed();
    const result = await indexEntity({ db, embed: port }, "document", doc.id);

    // The whole point of source_hash: re-indexing an untouched record costs no
    // GPU time at all, so the 60 s drain can run forever without loading Ollama.
    expect(spy).not.toHaveBeenCalled();
    expect(result.embedded).toBe(0);
    expect(result.unchanged).toBe(result.chunks);
    const after = await chunkRows(doc.id);
    expect(after.map((r) => r.indexedAt.getTime()))
      .toEqual(before.map((r) => r.indexedAt.getTime()));
  });

  it("deletes the orphan tail chunks when the source text shrinks", async () => {
    const marker = randomUUID();
    const doc = await makeDocument(marker, longLetter(marker));
    await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);
    expect((await chunkRows(doc.id)).length).toBeGreaterThan(1);

    // A re-scan of the same document that extracts far less text: the trailing
    // chunks would otherwise haunt results forever with text that is gone.
    await db.update(schema.documentTexts)
      .set({ text: `KORT-${marker}: één regel.`, charCount: 24 })
      .where(eq(schema.documentTexts.documentId, doc.id));

    const result = await indexEntity({ db, embed: fakeEmbed().port }, "document", doc.id);

    expect(result.chunks).toBe(1);
    const rows = await chunkRows(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkIndex).toBe(0);
    expect(rows[0].body).toContain(`KORT-${marker}`);
  });

  it("removes every chunk when the source row is gone", async () => {
    const ghost = randomUUID();
    await db.insert(schema.searchChunks).values({
      entityType: "document", entityId: ghost, chunkIndex: 0,
      title: "Verdwenen document", body: "Deze brief bestaat niet meer.",
      occurredAt: null, status: "inbox", sourceHash: "0".repeat(64),
    });

    const result = await indexEntity({ db, embed: fakeEmbed().port }, "document", ghost);

    expect(result).toEqual({ chunks: 0, embedded: 0, unchanged: 0 });
    expect(await chunkRows(ghost)).toHaveLength(0);
  });
});
