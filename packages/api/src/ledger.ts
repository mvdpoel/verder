import { desc, sql } from "drizzle-orm";
import { canonicalJson, computeEventHash, GENESIS_HASH, sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";

const LEDGER_LOCK_KEY = 42;

export interface AppendInput {
  eventType: string; entityType: string; entityId: string; payload: unknown;
}

// tx must be a transaction handle; caller inserts the entity in the SAME transaction.
export async function appendLedgerEvent(
  tx: Db, input: AppendInput
): Promise<{ seq: number; eventHash: string; payloadHash: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
  const [head] = await tx.select().from(schema.ledgerEvents)
    .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.eventHash ?? GENESIS_HASH;
  const payloadHash = sha256Hex(canonicalJson(input.payload));
  const eventHash = computeEventHash({
    seq, eventType: input.eventType, entityType: input.entityType,
    entityId: input.entityId, payloadHash, prevHash,
  });
  await tx.insert(schema.ledgerEvents).values({
    seq, eventType: input.eventType, entityType: input.entityType,
    entityId: input.entityId, payloadHash, prevHash, eventHash,
  });
  return { seq, eventHash, payloadHash };
}
