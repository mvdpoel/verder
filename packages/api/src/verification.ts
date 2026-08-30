import { asc, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent, type VerifyResult } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { readFilePath } from "./storage";
import { entryEventPayload } from "./routers/entries";
import { registryDecisionPayload } from "./registry-decide";
import { taskStatusPayload } from "./task-decide";

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
 * Recomputes the payload hash of a task.status event from the live
 * task_status_changes row — any edit to a stored status change surfaces as a
 * payload_hash_mismatch at that event's seq. Shared by runFullVerification
 * and the task tamper tests.
 */
export async function taskStatusPayloadHash(db: Db, changeId: string): Promise<string> {
  const [change] = await db.select().from(schema.taskStatusChanges)
    .where(eq(schema.taskStatusChanges.id, changeId));
  if (!change) return "missing-task-status-row".padEnd(64, "0");
  return sha256Hex(canonicalJson(taskStatusPayload(change)));
}

/**
 * The canonical payload a document.updated event carries, rebuilt from a live
 * document_status_changes row.
 *
 * This is a COMPATIBILITY LANE, not the current shape: every writer
 * (`documents.update`, `suggestions.approveDocumentMeta`, the
 * discard-signature-images backfill) has carried `partyId` since Task 3 (the
 * sender) — see `documentStatusChangePayloadWithParty` below, which is what
 * all of them actually write now. This narrower shape exists only because a
 * row written before the column existed has a payload hash baked in that
 * never had a `partyId` key, and that hash can never be recomputed to match
 * anything else. `resolveDocumentUpdatedHashes` only ever tries this shape
 * for a row whose live `party_id` is NULL — see the guard there for why that
 * is safe.
 */
export function documentStatusChangePayload(c: {
  documentId: string; status: string; title: string | null; docType: string | null;
}) {
  return { id: c.documentId, status: c.status, title: c.title, docType: c.docType };
}

/**
 * The shape every writer of a document.updated event has used since Task 3
 * (the sender): the same payload plus `partyId`, always present as a key
 * (null when no sender applies). This is the ONLY shape any writer produces
 * going forward — see `documentStatusChangePayload` above for the narrower,
 * pre-Task-3 shape `resolveDocumentUpdatedHashes` still has to recognise.
 */
export function documentStatusChangePayloadWithParty(c: {
  documentId: string; status: string; title: string | null; docType: string | null;
  partyId: string | null;
}) {
  return { ...documentStatusChangePayload(c), partyId: c.partyId };
}

/**
 * Resolves every document.updated event back to the document_status_changes row
 * that produced it, so tampering with a stored status change surfaces as a
 * payload_hash_mismatch instead of being echoed back green.
 *
 * This matters more than it looks: a document's EFFECTIVE status is read from
 * the latest status-change row by every surface in the app, so an UPDATE on
 * that table can flip a court decision to `discarded` and make it vanish from
 * the vault list, the queue, the ⌘K palette and search — while /verify still
 * reports ok, because document.updated used to fall through to
 * `return e.payloadHash`.
 *
 * A matched row is CONSUMED. Two events can legitimately carry an identical
 * payload (discard, undo, discard again), and matching by hash alone would let
 * one surviving row vouch for both — so a tampered duplicate would hide behind
 * its twin. Events are walked in seq order, oldest first, which is the order
 * the rows were written in.
 *
 * Each row yields up to TWO candidate hashes: the wide shape always, and the
 * narrow (pre-`partyId`) shape ONLY WHEN the row's live `party_id IS NULL`.
 * That guard is what closes the hole a naive "try both, always" version would
 * leave open: `documentStatusChangePayload` never reads `partyId` at all, so
 * without the guard an admin UPDATE that set `party_id` on an untouched row
 * would leave the narrow candidate's hash completely unchanged — matching the
 * row's original (narrow-era) stored hash regardless of what was just written
 * into its sender column, and reporting the tamper as ok. Every row written
 * before the `party_id` column existed has `party_id = NULL` and always will
 * (nothing backfills document_status_changes.party_id), so `party_id IS NULL`
 * is an exact, self-maintaining test for "this row may still be narrow-era" —
 * and the moment an attacker (or anyone) writes a non-null `party_id` onto
 * such a row, the guard drops the narrow candidate and only the wide one
 * remains, which that row's original narrow-shape hash cannot match.
 *
 * A genuinely wide-era row with no resolved sender also has `party_id IS
 * NULL`, so both candidates are computed for it too — harmless, because its
 * stored hash was written by a wide-shape writer and only the wide candidate
 * can ever match it; the narrow candidate is simply never claimed.
 *
 * A match on either candidate consumes BOTH, so the row still vouches for
 * exactly one event.
 */
export async function resolveDocumentUpdatedHashes(
  db: Db,
  rows: { seq: number; eventType: string; entityId: string; payloadHash: string }[],
): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();
  // documentId -> per-row [narrow, wide] hash pairs not yet claimed.
  // narrow is null when the row's live party_id is non-null — see the
  // function docblock for why that must exclude it from matching.
  const unconsumed = new Map<string, [string | null, string][]>();
  for (const e of rows) {
    if (e.eventType !== "document.updated") continue;
    let candidates = unconsumed.get(e.entityId);
    if (!candidates) {
      const changes = await db.select().from(schema.documentStatusChanges)
        .where(eq(schema.documentStatusChanges.documentId, e.entityId))
        .orderBy(asc(schema.documentStatusChanges.createdAt));
      candidates = changes.map((c) => [
        c.partyId === null ? sha256Hex(canonicalJson(documentStatusChangePayload(c))) : null,
        sha256Hex(canonicalJson(documentStatusChangePayloadWithParty(c))),
      ]);
      unconsumed.set(e.entityId, candidates);
    }
    const i = candidates.findIndex(([narrow, wide]) =>
      (narrow !== null && narrow === e.payloadHash) || wide === e.payloadHash);
    // No live row hashes to this event's payload: the status change was edited
    // or removed after the fact. Leave it unresolved so the dispatch flags it.
    if (i === -1) continue;
    candidates.splice(i, 1);
    resolved.set(e.seq, e.payloadHash);
  }
  return resolved;
}

/**
 * Context for makeLedgerRecompute: pre-resolved document.linked and
 * document.updated events (see runFullVerification) and an optional counter
 * hook for verified vault files.
 */
export interface LedgerRecomputeContext {
  linkedLater: Map<string, Set<string>>; // entryId -> documentIds linked after creation
  resolvedLinkHash: Map<number, string>; // seq -> payloadHash of document.linked events
  resolvedStatusHash: Map<number, string>; // seq -> payloadHash of document.updated events
  onFileChecked?: () => void;
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
  const resolvedStatusHash = await resolveDocumentUpdatedHashes(db, rows);
  const res = await verifyChain(events, makeLedgerRecompute(db, vaultDir, {
    linkedLater, resolvedLinkHash, resolvedStatusHash,
    onFileChecked: () => { checkedFiles++; } }));
  return { ...res, headHash: rows.at(-1)?.eventHash ?? null, checkedFiles };
}

/**
 * Builds the per-event payload-hash recompute callback used by
 * runFullVerification — the single dispatch table mapping each ledger event
 * type to its live-row rebuild. Exported so tests can exercise the ACTUAL
 * dispatch (e.g. the task.status branch) without needing a whole-chain-green
 * database: an untested dispatch line here means tampering with that event
 * type's rows would go undetected (the sub-project 2 lesson).
 */
export function makeLedgerRecompute(
  db: Db, vaultDir: string, ctx: LedgerRecomputeContext
): (e: ChainEvent) => Promise<string> {
  return async (e) => {
    if (e.eventType === "document.linked")
      // No live entry_documents row hashes to this event's payload: the
      // link row was deleted or altered after the fact.
      return ctx.resolvedLinkHash.get(e.seq) ?? "link-row-missing".padEnd(64, "0");
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
      const later = ctx.linkedLater.get(entry.id);
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
    if (e.eventType === "document.updated")
      // No live document_status_changes row hashes to this event's payload: the
      // status change was edited or removed after it was ledgered. Never fall
      // through to `return e.payloadHash` — that would echo the stored hash and
      // report a hidden document as green.
      return ctx.resolvedStatusHash.get(e.seq) ?? "status-change-row-missing".padEnd(64, "0");
    if (e.eventType === "registry.decision")
      return registryDecisionPayloadHash(db, e.entityId);
    if (e.eventType === "task.status")
      return taskStatusPayloadHash(db, e.entityId);
    if (e.eventType !== "document.ingested") return e.payloadHash;
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, e.entityId));
    if (!doc) return "missing-document-row".padEnd(64, "0");
    try {
      const buf = await readFile(readFilePath(vaultDir, doc.sha256));
      ctx.onFileChecked?.();
      return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
    } catch { return "file-missing".padEnd(64, "0"); }
  };
}
