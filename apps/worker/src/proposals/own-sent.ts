import { and, eq, inArray, or } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { normaliseMessageId } from "../mail/message-id";

type RawRow = typeof schema.rawEmails.$inferSelect;

/**
 * The proposal whose sent mail this raw email IS — `sending` included, because
 * the re-ingest can overtake a slow or crashed `finishSent` (Task 16). Matched
 * on the RFC 5322 Message-ID verder generated (stored with or without its
 * brackets; normalised on both sides) or on the Gmail id the send returned.
 */
export async function proposalForOwnSentMail(
  db: Db, row: Pick<RawRow, "messageId" | "gmailMessageId">,
): Promise<string | null> {
  const mid = row.messageId ? normaliseMessageId(row.messageId) : null;
  const match = [
    eq(schema.proposals.gmailMessageId, row.gmailMessageId),
    ...(mid ? [inArray(schema.proposals.messageId, [mid, `<${mid}>`])] : []),
  ];
  const [p] = await db.select({ id: schema.proposals.id }).from(schema.proposals)
    .where(and(inArray(schema.proposals.status, ["sending", "sent"]), or(...match)))
    .limit(1);
  return p?.id ?? null;
}

