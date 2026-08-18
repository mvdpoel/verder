import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { appendLedgerEvent } from "./ledger";
import { isValidTransition } from "./registry-status";

export type RegistryDecision = typeof schema.registryDecisions.$inferSelect;

export interface DecideInput {
  financialItemId?: string;
  debtId?: string;
  status: string;
  explanation: string;
  documentId?: string;
  blockerNote?: string;
  overrideReason?: string;
}

/**
 * Canonical ledger payload for registry.decision events. The verifier rebuilds
 * this from the live registry_decisions row to detect tampering, so any change
 * to this shape invalidates existing chains — never change it.
 */
export function registryDecisionPayload(d: RegistryDecision) {
  return {
    id: d.id,
    financialItemId: d.financialItemId ?? null,
    debtId: d.debtId ?? null,
    status: d.status,
    explanation: d.explanation,
    documentId: d.documentId ?? null,
    blockerNote: d.blockerNote ?? null,
    overrideReason: d.overrideReason ?? null,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Current status of an item/debt: latest decision row, default "identified". */
export async function effectiveStatus(
  db: Db, target: { financialItemId?: string; debtId?: string }
): Promise<string> {
  if ((target.financialItemId ? 1 : 0) + (target.debtId ? 1 : 0) !== 1)
    throw new Error("Exactly one of financialItemId or debtId must be set");
  const where = target.financialItemId
    ? eq(schema.registryDecisions.financialItemId, target.financialItemId)
    : eq(schema.registryDecisions.debtId, target.debtId!);
  const [latest] = await db.select().from(schema.registryDecisions)
    .where(where).orderBy(desc(schema.registryDecisions.createdAt)).limit(1);
  return latest?.status ?? "identified";
}

/**
 * Records a status decision for a financial item or debt: validates the
 * transition against the current effective status, inserts the insert-only
 * decision row and appends the registry.decision ledger event in the SAME
 * transaction (tx must be a transaction handle).
 *
 * An invalid transition throws unless an overrideReason is given — the
 * override is then itself part of the recorded decision.
 */
export async function decide(
  tx: Db, userId: string, input: DecideInput
): Promise<RegistryDecision> {
  if ((input.financialItemId ? 1 : 0) + (input.debtId ? 1 : 0) !== 1)
    throw new Error("Exactly one of financialItemId or debtId must be set");
  const kind = input.financialItemId ? "item" : "debt";
  const current = await effectiveStatus(tx, {
    financialItemId: input.financialItemId, debtId: input.debtId });
  if (!isValidTransition(kind, current, input.status) && !input.overrideReason)
    throw new Error(
      `Invalid ${kind} status transition "${current}" → "${input.status}" — ` +
      "provide an overrideReason to record it anyway");
  const [decision] = await tx.insert(schema.registryDecisions).values({
    financialItemId: input.financialItemId,
    debtId: input.debtId,
    status: input.status,
    explanation: input.explanation,
    documentId: input.documentId,
    blockerNote: input.blockerNote,
    overrideReason: input.overrideReason,
    createdBy: userId,
  }).returning();
  await appendLedgerEvent(tx, {
    eventType: "registry.decision",
    entityType: "registry_decision",
    entityId: decision.id,
    payload: registryDecisionPayload(decision),
  });
  return decision;
}
