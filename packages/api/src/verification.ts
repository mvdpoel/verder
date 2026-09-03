import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { access, readFile } from "node:fs/promises";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent, type VerifyResult } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { readFilePath } from "./storage";
import { entryEventPayload } from "./routers/entries";
import { registryDecisionPayload } from "./registry-decide";
import { taskStatusPayload } from "./task-decide";
import { documentPurgePayload } from "./routers/documents";

export type FullVerificationResult = VerifyResult & {
  headHash: string | null;
  checkedFiles: number;
  /**
   * Documents whose bytes were destroyed on purpose. Counted SEPARATELY from
   * checkedFiles — a purged document is not a file that was checked — and
   * surfaced on /verify, because a design where files can vanish without the
   * verification page saying so is exactly the hole this avoids.
   */
  purgedFiles: number;
  /**
   * Of those, how many still have bytes on disk. The unlink runs after the
   * purge transaction commits, so this is normally 0 and a non-zero value means
   * an unlink failed — repairable by purging the document again.
   */
  purgedFilesOnDisk: number;
  /**
   * Of those, how many still have a `document_texts` row or any `search_chunks`
   * row — the two tables that hold a document's CONTENT outside the vault.
   *
   * THE SAME LAW purgedFilesOnDisk carries, applied to the rest of what a purge
   * destroys: the leftover is DETECTED, not assumed away. Three writers can put
   * these rows back after the purge transaction commits (suggest.docmeta's OCR,
   * the search drain's embed, extract-texts), each of them guarded by a
   * check-then-act that narrows the window without closing it — and a purge
   * fires no search_outbox trigger, so nothing re-enqueues the document and
   * nothing notices on its own. Non-zero means the text or the search entry of
   * a definitief verwijderd document is back; purging it again is the repair.
   */
  purgedContentLeftovers: number;
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
 * Recomputes the payload hash of a document.purged event from the live
 * document_purges row — editing a stored reason surfaces as a
 * payload_hash_mismatch at that event's seq. The same discipline
 * registryDecisionPayloadHash and taskStatusPayloadHash follow.
 */
export async function documentPurgePayloadHash(db: Db, documentId: string): Promise<string> {
  const [p] = await db.select().from(schema.documentPurges)
    .where(eq(schema.documentPurges.documentId, documentId));
  if (!p) return "missing-purge-row".padEnd(64, "0");
  return sha256Hex(canonicalJson(documentPurgePayload({
    documentId: p.documentId, sha256: p.sha256, sizeBytes: p.sizeBytes,
    reason: p.reason })));
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
  onFilePurged?: (stillOnDisk: boolean) => void;
  /**
   * entityIds with a document.purged event actually present IN THE LEDGER —
   * never derived from the document_purges table alone. `verder_app` holds
   * INSERT on document_purges, so a row by itself proves nothing: without
   * this, destroying a vault file and INSERTing a matching tombstone row (no
   * ledger event at all) would turn a genuine file-missing into a disclosed,
   * green purge. The same law resolveDocumentUpdatedHashes already enforces
   * one table over — "an UPDATE on that table hides a document from every
   * surface while /verify reports ok" — applied here to INSERT instead.
   */
  purgedEntityIds?: Set<string>;
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
  let purgedFiles = 0;
  let purgedFilesOnDisk = 0;
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
  // The set the document.ingested branch trusts for "was this really purged?"
  // — built from the LEDGER rows, not from document_purges. See the doc
  // comment on LedgerRecomputeContext.purgedEntityIds for the attack this
  // closes.
  const purgedEntityIds = new Set(
    rows.filter((e) => e.eventType === "document.purged").map((e) => e.entityId));
  const res = await verifyChain(events, makeLedgerRecompute(db, vaultDir, {
    linkedLater, resolvedLinkHash, resolvedStatusHash, purgedEntityIds,
    onFileChecked: () => { checkedFiles++; },
    onFilePurged: (stillOnDisk) => { purgedFiles++; if (stillOnDisk) purgedFilesOnDisk++; } }));
  return { ...res, headHash: rows.at(-1)?.eventHash ?? null,
    checkedFiles, purgedFiles, purgedFilesOnDisk,
    purgedContentLeftovers: await countPurgedContentLeftovers(db, purgedEntityIds) };
}

/**
 * How many purged documents still hold content in a derived table.
 *
 * Driven by the LEDGER-derived id set, never by `document_purges` alone — the
 * same discipline the document.ingested branch follows, and for the same
 * reason: `verder_app` holds INSERT on that table, so a row by itself proves
 * nothing about whether a purge happened.
 *
 * One query rather than a per-event check: this is a property of the store as
 * it stands now, not of any single event, and the ids are already in hand.
 */
async function countPurgedContentLeftovers(
  db: Db, purgedEntityIds: Set<string>,
): Promise<number> {
  if (purgedEntityIds.size === 0) return 0;
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.documentPurges)
    .where(and(
      inArray(schema.documentPurges.documentId, [...purgedEntityIds]),
      // THE OUTER PARENTHESES AROUND THE OR ARE LOAD-BEARING. Both EXISTS
      // clauses reach drizzle as ONE raw operand, and drizzle parenthesises
      // the and() list as a whole and never its operands — so without them
      // AND binds tighter than OR and the emitted predicate reads
      // `(inLedgerSet AND text) OR chunks`, counting ANY document_purges row
      // whose chunks survive, ledger-backed or not. That is precisely the
      // discipline the doc comment above claims to enforce.
      sql`(EXISTS (SELECT 1 FROM document_texts t
                   WHERE t.document_id = document_purges.document_id)
        OR EXISTS (SELECT 1 FROM search_chunks c
                   WHERE c.entity_type = 'document'
                     AND c.entity_id = document_purges.document_id))`));
  return row.n;
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
    if (e.eventType === "document.purged")
      return documentPurgePayloadHash(db, e.entityId);
    if (e.eventType !== "document.ingested") return e.payloadHash;
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.id, e.entityId));
    if (!doc) return "missing-document-row".padEnd(64, "0");
    const [purged] = await db.select().from(schema.documentPurges)
      .where(eq(schema.documentPurges.documentId, e.entityId));
    // BOTH a purge row AND a matching document.purged event IN THE LEDGER are
    // required — a row is never enough on its own. An orphan row (no ledger
    // event, e.g. INSERTed directly, or left behind after its event was
    // deleted) is never visited by any dispatch branch above, so trusting the
    // row alone would let it launder a destroyed file as a disclosed purge.
    if (purged && ctx.purgedEntityIds?.has(e.entityId)) {
      /*
       * The bytes are gone ON PURPOSE and the document.purged event is the
       * record of it. Verify against that record instead: the sha256 the purge
       * names must still be the sha256 the ingest recorded, or the tombstone is
       * describing a different document than the one it is attached to.
       *
       * Deleting the purge row (or its ledger event) does NOT launder the
       * deletion: this branch is simply not taken, and the file read below
       * reports file-missing exactly as it does for any other vanished file.
       */
      if (purged.sha256 !== doc.sha256) return "purge-sha-mismatch".padEnd(64, "0");
      // Counted only once the tombstone checks out — a tampered one must not
      // land in the disclosure figures as if it were a legitimate purge.
      ctx.onFilePurged?.(await access(readFilePath(vaultDir, purged.sha256))
        .then(() => true, () => false));
      return e.payloadHash;
    }
    try {
      const buf = await readFile(readFilePath(vaultDir, doc.sha256));
      ctx.onFileChecked?.();
      return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
    } catch { return "file-missing".padEnd(64, "0"); }
  };
}
