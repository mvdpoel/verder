export type DocStatus = "inbox" | "filed" | "discarded";

/**
 * Discard is always reversible, so the same button does both jobs: it reads
 * the current status and offers the opposite move.
 *
 * The status handed in must be the EFFECTIVE one. Discard is recorded in
 * document_status_changes and never written back to documents.status, which
 * keeps reading "inbox" forever — reading the column here would offer
 * "Discard" on an already-discarded document and leave Martin no way back.
 */
export function discardAction(status: DocStatus): { label: string; next: DocStatus } {
  return status === "discarded"
    ? { label: "Undo discard", next: "inbox" }
    : { label: "Discard", next: "discarded" };
}
