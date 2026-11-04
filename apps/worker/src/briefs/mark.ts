import { sql } from "drizzle-orm";
import type { Db } from "@grip/db";

/**
 * A relevant mail from this party was just ingested: its brief is out of date.
 * Marks the party — and the organisation a contact person writes for — as
 * `pending`, inside the INGEST transaction, so a mail and the request to
 * re-brief land together or not at all. One row per party: a second mail
 * re-marks the same row, so ten mails queue one draft, not ten.
 *
 * The previous summary is KEPT on the row but no longer shown (the phone shows
 * `ready` only), because a newer mail may have made it wrong.
 *
 * NOT EVIDENCE: no ledger event.
 */
export async function markBriefPending(tx: Db, partyId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO party_briefs (party_id, status, requested_at, updated_at)
    SELECT id, 'pending', now(), now() FROM parties
    WHERE id = ${partyId}::uuid
       OR id = (SELECT parent_party_id FROM parties WHERE id = ${partyId}::uuid)
    ON CONFLICT (party_id) DO UPDATE
      SET status = 'pending', requested_at = now(), updated_at = now(), error = NULL`);
}
