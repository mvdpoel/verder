import { asc, eq } from "drizzle-orm";
import { chunkBody, sourceHash, type SearchEntityType } from "@verder/core";
import { schema, type Db } from "@verder/db";
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
