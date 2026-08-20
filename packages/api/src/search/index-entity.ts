import { and, asc, eq, gte, sql } from "drizzle-orm";
import { chunkBody, sourceHash, type SearchEntityType } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { asDocument, type EmbedPort } from "./embed";
import { effectiveStatus } from "../registry-decide";
import { effectiveTaskStatus } from "../task-decide";
import { effectiveDocument } from "../routers/documents";
import {
  renderDebt, renderDocument, renderEmail, renderEntry, renderFinancialItem,
  renderMilestone, renderParty, renderTask, renderTimelineEvent, type Rendered,
} from "./render";

/**
 * The bridge between the evidence tables and the search index: one entity id in,
 * index-ready chunks out.
 *
 * The renderers in render.ts are pure — they take a row plus the values the
 * caller already resolved. This file is the caller: it loads the row, the
 * extracted text, the effective status and the related party names, hands them
 * to the right renderer, chunks the rendered body and hashes each chunk.
 *
 * Status is resolved with the SAME helpers the rest of the app uses
 * (effectiveDocument, effectiveTaskStatus, effectiveStatus) and then stamped on
 * every chunk. Query-time status filtering reads that one denormalized column
 * instead of four per-entity-type subqueries.
 */

export type RenderedChunk = {
  entityType: SearchEntityType;
  entityId: string;
  chunkIndex: number;
  title: string;
  body: string;
  occurredAt: Date | null;
  status: string | null;
  sourceHash: string;
};

/** Party display name for a nullable FK — the renderers take the name, not the id. */
async function partyName(db: Db, partyId: string | null): Promise<string | null> {
  if (!partyId) return null;
  const [party] = await db.select({ name: schema.parties.name }).from(schema.parties)
    .where(eq(schema.parties.id, partyId));
  return party?.name ?? null;
}

/** null when the entity's row is gone — the caller turns that into []. */
async function renderRow(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<Rendered | null> {
  switch (entityType) {
    case "document": {
      // effectiveDocument throws "Document not found" when the row is gone, and
      // loadAndRender must return [] instead, so existence is checked first.
      const [row] = await db.select({ id: schema.documents.id }).from(schema.documents)
        .where(eq(schema.documents.id, entityId));
      if (!row) return null;
      // Title, doc type and status all move to document_status_changes the
      // moment a doc-meta suggestion is approved — the documents row itself is
      // never updated. effectiveDocument is the one helper that resolves that,
      // and re-deriving it here would drift from the rest of the app.
      const doc = await effectiveDocument(db, entityId);
      const [extracted] = await db.select({ text: schema.documentTexts.text })
        .from(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, entityId));
      return renderDocument(
        { title: doc.effectiveTitle, docType: doc.effectiveDocType,
          mime: doc.mime, receivedAt: doc.receivedAt },
        // No extracted text yet (extraction runs asynchronously, or the file is
        // not text at all): the document is still indexed on title and metadata.
        { status: doc.effectiveStatus, text: extracted?.text ?? "" });
    }
    case "entry": {
      const [entry] = await db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.id, entityId));
      if (!entry) return null;
      // Ordered by name and by title: without ORDER BY, Postgres may return the
      // same rows in a different order on a later drain, which rewrites the
      // body, changes source_hash and burns GPU time re-embedding identical text.
      const participants = await db.select({ name: schema.parties.name })
        .from(schema.entryParticipants)
        .innerJoin(schema.parties, eq(schema.parties.id, schema.entryParticipants.partyId))
        .where(eq(schema.entryParticipants.entryId, entityId))
        .orderBy(asc(schema.parties.name));
      const documents = await db.select({ title: schema.documents.title })
        .from(schema.entryDocuments)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.entryDocuments.documentId))
        .where(eq(schema.entryDocuments.entryId, entityId))
        .orderBy(asc(schema.documents.title));
      return renderEntry(entry, {
        participantNames: participants.map((p) => p.name),
        documentTitles: documents.map((d) => d.title),
      });
    }
    case "email": {
      const [email] = await db.select().from(schema.rawEmails)
        .where(eq(schema.rawEmails.id, entityId));
      return email ? renderEmail(email) : null;
    }
    case "financial_item": {
      const [item] = await db.select().from(schema.financialItems)
        .where(eq(schema.financialItems.id, entityId));
      if (!item) return null;
      // Status lives in registry_decisions, ordered by ledger seq — never in the
      // financial_items row. effectiveStatus is that query; do not inline it.
      return renderFinancialItem(item, {
        status: await effectiveStatus(db, { financialItemId: item.id }),
        providerName: await partyName(db, item.providerPartyId),
      });
    }
    case "debt": {
      const [debt] = await db.select().from(schema.debts)
        .where(eq(schema.debts.id, entityId));
      if (!debt) return null;
      return renderDebt(debt, {
        status: await effectiveStatus(db, { debtId: debt.id }),
        creditorPartyName: await partyName(db, debt.creditorPartyId),
      });
    }
    case "task": {
      const [task] = await db.select().from(schema.tasks)
        .where(eq(schema.tasks.id, entityId));
      if (!task) return null;
      // Status lives in task_status_changes, ordered by ledger seq.
      return renderTask(task, {
        status: await effectiveTaskStatus(db, task.id),
        assigneeName: await partyName(db, task.assigneePartyId),
      });
    }
    case "milestone": {
      const [milestone] = await db.select().from(schema.milestones)
        .where(eq(schema.milestones.id, entityId));
      return milestone ? renderMilestone(milestone) : null;
    }
    case "timeline_event": {
      const [event] = await db.select().from(schema.timelineEvents)
        .where(eq(schema.timelineEvents.id, entityId));
      return event ? renderTimelineEvent(event) : null;
    }
    case "party": {
      const [party] = await db.select().from(schema.parties)
        .where(eq(schema.parties.id, entityId));
      return party ? renderParty(party) : null;
    }
    default: {
      // SearchEntityType is a closed union: this is unreachable, and the never
      // assignment makes adding a tenth entity type a compile error here rather
      // than a silently unindexed record.
      const exhaustive: never = entityType;
      throw new Error(`loadAndRender: unsupported entity type "${String(exhaustive)}"`);
    }
  }
}

/**
 * Loads one entity, renders it, chunks it and hashes each chunk.
 * Returns [] when the row no longer exists, which is how indexEntity learns to
 * drop every chunk it still holds for that entity.
 */
export async function loadAndRender(
  db: Db, entityType: SearchEntityType, entityId: string,
): Promise<RenderedChunk[]> {
  const rendered = await renderRow(db, entityType, entityId);
  if (!rendered) return [];
  return chunkBody(rendered.body).map((body, chunkIndex) => ({
    entityType, entityId, chunkIndex,
    title: rendered.title, body,
    occurredAt: rendered.occurredAt, status: rendered.status,
    // Per chunk, not per entity: the drain re-embeds chunk by chunk, so a hash
    // covering the whole entity would hide which chunk actually changed.
    sourceHash: sourceHash(rendered.title, body),
  }));
}

/**
 * Brings search_chunks in line with one entity's current content.
 *
 * Re-embeds ONLY chunks whose source_hash changed (or whose previous embedding
 * failed). A chunk whose text is identical but whose denormalized status or
 * date has moved is rewritten WITHOUT re-embedding — source_hash covers title
 * and body, and the status renders into the top of the body only, so a
 * multi-chunk record would otherwise keep a stale status on every chunk but the
 * first. It upserts them on (entity_type, entity_id, chunk_index), and deletes
 * chunks past the new chunk count so a shortened record leaves no orphans
 * behind. When the source row is gone, loadAndRender returns [] and every chunk
 * for that entity is deleted — which is also what `reindex --prune` relies on.
 *
 * UPDATE and DELETE here are legal and deliberate: the index is DERIVED, not
 * evidence. It appends no ledger events, and `reindex` rebuilds all of it from
 * the source records.
 *
 * An embedding FAILURE never throws out of this function. EmbedPort signals a
 * failure per text with `null` (realEmbedPort already retried three times), so a
 * dead Ollama yields chunks that land with embedding NULL and embed_attempts
 * incremented, and stay findable by full text until a later pass succeeds.
 * Callers read the failure count as `chunks - embedded - unchanged`.
 *
 * A THROW from the port is a different thing entirely — a crashed client, a bug
 * — and is deliberately NOT caught here: it propagates so the caller can isolate
 * the fault to this one entity (search.drain retains its outbox row and records
 * an `error` run) instead of silently indexing it vector-less forever.
 */
export async function indexEntity(
  deps: { db: Db; embed: EmbedPort },
  entityType: SearchEntityType, entityId: string,
): Promise<{ chunks: number; embedded: number; unchanged: number }> {
  const rendered = await loadAndRender(deps.db, entityType, entityId);
  const existing = await deps.db.select().from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.entityType, entityType),
      eq(schema.searchChunks.entityId, entityId)));
  const byIndex = new Map(existing.map((c) => [c.chunkIndex, c]));

  const pending: RenderedChunk[] = [];
  // Chunks whose TEXT is unchanged but whose denormalized status (or date) has
  // moved. They must not be re-embedded — but they must be rewritten.
  const metadataOnly: RenderedChunk[] = [];
  let unchanged = 0;
  for (const chunk of rendered) {
    const prev = byIndex.get(chunk.chunkIndex);
    // Identical text that already carries a vector is left completely alone.
    // A NULL embedding means a previous attempt failed, so it is retried.
    if (prev && prev.sourceHash === chunk.sourceHash && prev.embedding !== null) {
      unchanged++;
      // …with one exception. source_hash covers title + body, and the status
      // renders into the TOP of the body only, so discarding a document that
      // chunked into five pieces changes chunk 0's text and nothing else. The
      // remaining four keep their hash — and used to keep their stale status
      // with it, while retrieve() reads EVERY chunk and collapses to the best
      // one. A single stale row was enough to hand a discarded document back
      // in search results. Refresh the columns, skip the GPU.
      if (prev.status !== chunk.status
        || (prev.occurredAt?.getTime() ?? null) !== (chunk.occurredAt?.getTime() ?? null)) {
        metadataOnly.push(chunk);
      }
      continue;
    }
    pending.push(chunk);
  }

  for (const chunk of metadataOnly) {
    await deps.db.update(schema.searchChunks)
      .set({ status: chunk.status, occurredAt: chunk.occurredAt, indexedAt: new Date() })
      .where(and(eq(schema.searchChunks.entityType, chunk.entityType),
        eq(schema.searchChunks.entityId, chunk.entityId),
        eq(schema.searchChunks.chunkIndex, chunk.chunkIndex)));
  }

  let vectors: (number[] | null)[] = [];
  if (pending.length > 0) {
    // Ollama down is NOT an exception: the port returns null per text and the
    // chunks below land lexically, to be re-embedded on a later pass. A throw
    // here is a crashed client, so it is left to propagate to the caller.
    vectors = await deps.embed.embed(
      pending.map((c) => asDocument(`${c.title}\n${c.body}`)));
  }

  let embedded = 0;
  for (const [i, chunk] of pending.entries()) {
    const embedding = vectors[i] ?? null;
    await deps.db.insert(schema.searchChunks).values({
      entityType: chunk.entityType, entityId: chunk.entityId,
      chunkIndex: chunk.chunkIndex, title: chunk.title, body: chunk.body,
      occurredAt: chunk.occurredAt, status: chunk.status,
      embedding, sourceHash: chunk.sourceHash,
      embedAttempts: embedding ? 0 : 1, indexedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.searchChunks.entityType, schema.searchChunks.entityId,
        schema.searchChunks.chunkIndex],
      set: {
        title: chunk.title, body: chunk.body, occurredAt: chunk.occurredAt,
        status: chunk.status, embedding, sourceHash: chunk.sourceHash,
        // Failed attempts keep counting up so index health can surface a chunk
        // that never embeds; a success resets the counter.
        embedAttempts: embedding ? 0 : sql`${schema.searchChunks.embedAttempts} + 1`,
        indexedAt: new Date(),
      },
    });
    if (embedding) embedded++;
  }

  if (existing.some((c) => c.chunkIndex >= rendered.length)) {
    await deps.db.delete(schema.searchChunks).where(and(
      eq(schema.searchChunks.entityType, entityType),
      eq(schema.searchChunks.entityId, entityId),
      gte(schema.searchChunks.chunkIndex, rendered.length)));
  }

  return { chunks: rendered.length, embedded, unchanged };
}
