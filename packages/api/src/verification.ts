import { asc, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent, type VerifyResult } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { readFilePath } from "./storage";
import { entryEventPayload } from "./routers/entries";
import { registryDecisionPayload } from "./registry-decide";

export type FullVerificationResult = VerifyResult & {
  headHash: string | null;
  checkedFiles: number;
};

/**
 * Recomputes the payload hash of a registry.decision event from the live
 * registry_decisions row — any edit to a stored decision surfaces as a
 * payload_hash_mismatch at that event's seq. Shared by runFullVerification
 * and the registry tamper tests.
 */
export async function registryDecisionPayloadHash(db: Db, decisionId: string): Promise<string> {
  const [decision] = await db.select().from(schema.registryDecisions)
    .where(eq(schema.registryDecisions.id, decisionId));
  if (!decision) return "missing-decision-row".padEnd(64, "0");
  return sha256Hex(canonicalJson(registryDecisionPayload(decision)));
}

/**
 * Full ledger verification: walks the whole chain, recomputing payload hashes
 * from the live rows (entries, participants, documents, action items) and the
 * vault files on disk. Shared by the verify tRPC router and the nightly
 * verification script — both must always report identical results.
 */
export async function runFullVerification(db: Db, vaultDir: string): Promise<FullVerificationResult> {
  const rows = await db.select().from(schema.ledgerEvents)
    .orderBy(asc(schema.ledgerEvents.seq));
  const events: ChainEvent[] = rows.map((e) => ({
    seq: e.seq, eventType: e.eventType, entityType: e.entityType,
    entityId: e.entityId, payloadHash: e.payloadHash,
    prevHash: e.prevHash, eventHash: e.eventHash }));
  let checkedFiles = 0;
  // Documents can be legitimately linked to an entry AFTER its creation via
  // documents.linkToEntry, which appends a document.linked event. The
  // entry.created/entry.corrected rebuild below therefore must not compare
  // against the current entry_documents rows as-is — later links would read
  // as tampering. Resolve each document.linked event back to its
  // (entry, document) pair by matching its payload hash against the live
  // link rows for that document, and exclude those pairs from the rebuild.
  const linkedLater = new Map<string, Set<string>>(); // entryId -> documentIds
  const resolvedLinkHash = new Map<number, string>(); // seq -> payloadHash
  for (const e of rows) {
    if (e.eventType !== "document.linked") continue;
    const candidates = await db.select().from(schema.entryDocuments)
      .where(eq(schema.entryDocuments.documentId, e.entityId));
    for (const c of candidates) {
      const h = sha256Hex(canonicalJson({ documentId: c.documentId, entryId: c.entryId }));
      if (h !== e.payloadHash) continue;
      resolvedLinkHash.set(e.seq, h);
      const set = linkedLater.get(c.entryId) ?? new Set<string>();
      set.add(c.documentId);
      linkedLater.set(c.entryId, set);
      break;
    }
  }
  const res = await verifyChain(events, async (e) => {
    if (e.eventType === "document.linked")
      // No live entry_documents row hashes to this event's payload: the
      // link row was deleted or altered after the fact.
      return resolvedLinkHash.get(e.seq) ?? "link-row-missing".padEnd(64, "0");
    if (e.eventType === "entry.created" || e.eventType === "entry.corrected") {
      // Rebuild the canonical payload from the live rows — any edit to a
      // stored entry (or its participants/documents/action items) surfaces
      // as a payload_hash_mismatch at this seq.
      const [entry] = await db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.id, e.entityId));
      if (!entry) return "missing-entry-row".padEnd(64, "0");
      const parts = await db.select().from(schema.entryParticipants)
        .where(eq(schema.entryParticipants.entryId, entry.id));
      const docs = await db.select().from(schema.entryDocuments)
        .where(eq(schema.entryDocuments.entryId, entry.id));
      const items = await db.select().from(schema.actionItems)
        .where(eq(schema.actionItems.entryId, entry.id));
      const later = linkedLater.get(entry.id);
      return sha256Hex(canonicalJson(entryEventPayload({
        id: entry.id, occurredAt: entry.occurredAt,
        channel: entry.channel, direction: entry.direction,
        summary: entry.summary, details: entry.details,
        source: entry.source, sourceRef: entry.sourceRef,
        supersedesId: entry.supersedesId,
        participantPartyIds: parts.map((p) => p.partyId),
        documentIds: docs.map((d) => d.documentId).filter((id) => !later?.has(id)),
        actionItems: items.map((a) => ({ description: a.description,
          ownerPartyId: a.ownerPartyId, dueAt: a.dueAt, clarity: a.clarity })),
      })));
    }
    if (e.eventType === "registry.decision")
      return registryDecisionPayloadHash(db, e.entityId);
    if (e.eventType !== "document.ingested") return e.payloadHash;
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, e.entityId));
    if (!doc) return "missing-document-row".padEnd(64, "0");
    try {
      const buf = await readFile(readFilePath(vaultDir, doc.sha256));
      checkedFiles++;
      return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
    } catch { return "file-missing".padEnd(64, "0"); }
  });
  return { ...res, headHash: rows.at(-1)?.eventHash ?? null, checkedFiles };
}
