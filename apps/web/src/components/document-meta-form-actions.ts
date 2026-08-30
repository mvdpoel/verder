export type DocStatus = "inbox" | "filed" | "discarded";

/**
 * Discard is always reversible, so the same button does both jobs: it reads
 * the current status and offers the opposite move.
 *
 * The status handed in must be the EFFECTIVE one. Discard is recorded in
 * document_status_changes and never written back to documents.status, which
 * keeps reading "inbox" forever — reading the column here would offer
 * "Discard" on an already-discarded document and leave Martin no way back.
 *
 * `previousStatus` is the status that preceded the current one. Undo restores
 * it rather than defaulting to "inbox": discarding a FILED document by mistake
 * and undoing a second later must not silently unfile it, dropping it back
 * into the vault inbox and the dashboard's inbox tile. A reversible action that
 * quietly changes something else is not reversible.
 */
export function discardAction(
  status: DocStatus, previousStatus: DocStatus,
): { label: string; next: DocStatus } {
  if (status !== "discarded") return { label: "Wegleggen", next: "discarded" };
  // Undoing into another discard would leave a button that changes nothing.
  return { label: "Terugzetten",
    next: previousStatus === "discarded" ? "inbox" : previousStatus };
}

/**
 * The "Van wie" select's options, pure and separate from the JSX that renders
 * them for the same reason `discardAction` is: a client component cannot be
 * unit-tested directly, but the logic that decides which party is
 * pre-selected can be.
 *
 * `selectedId` is `effectivePartyId`, not the raw ingest-time column — see
 * `effectiveDocument`.
 */
export function senderOptions(
  parties: { id: string; name: string }[], selectedId: string | null,
): { value: string; label: string; selected: boolean }[] {
  return parties.map((p) => ({ value: p.id, label: p.name, selected: p.id === selectedId }));
}
