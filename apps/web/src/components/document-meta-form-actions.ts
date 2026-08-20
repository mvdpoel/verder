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
  if (status !== "discarded") return { label: "Discard", next: "discarded" };
  // Undoing into another discard would leave a button that changes nothing.
  return { label: "Undo discard",
    next: previousStatus === "discarded" ? "inbox" : previousStatus };
}
