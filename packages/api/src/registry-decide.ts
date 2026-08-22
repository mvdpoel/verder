import { and, desc, eq, inArray } from "drizzle-orm";
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

/**
 * Current status of an item/debt: latest decision row, default "identified".
 *
 * "Latest" is defined by the ledger seq of each decision's registry.decision
 * event, NOT by createdAt: createdAt is the transaction timestamp, so two
 * decisions made in one transaction tie exactly, and under concurrency a
 * transaction that started earlier can commit later. The ledger seq is
 * strictly monotonic in recording order (appendLedgerEvent serializes on an
 * advisory lock), and every decision gets its event in the same transaction.
 * Any "latest decision" query elsewhere must order by seq the same way.
 */
export async function effectiveStatus(
  db: Db, target: { financialItemId?: string; debtId?: string }
): Promise<string> {
  if ((target.financialItemId ? 1 : 0) + (target.debtId ? 1 : 0) !== 1)
    throw new Error("Exactly one of financialItemId or debtId must be set");
  const where = target.financialItemId
    ? eq(schema.registryDecisions.financialItemId, target.financialItemId)
    : eq(schema.registryDecisions.debtId, target.debtId!);
  const [latest] = await db
    .select({ status: schema.registryDecisions.status })
    .from(schema.registryDecisions)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.registryDecisions.id),
      eq(schema.ledgerEvents.eventType, "registry.decision"),
    ))
    .where(where)
    .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
  return latest?.status ?? "identified";
}

/**
 * effectiveStatus for many financial items in ONE query.
 *
 * Every surface that lists the registry used to call effectiveStatus per row —
 * /money does it on both procedures, and money.series runs on every dashboard
 * render because the compact money block sits on the home page. One query per
 * item is fine at today's registry size and is not fine at three years of it.
 *
 * MUST STAY IN LOCKSTEP WITH effectiveStatus: same join, same "latest" (the
 * ledger seq of the registry.decision event, never createdAt — see the comment
 * above for why), same "identified" default for an item nobody has decided on.
 * DISTINCT ON keeps one row per item and Postgres requires the ORDER BY to
 * lead with the DISTINCT ON expression, so the seq ordering is the tiebreaker
 * behind it — which is exactly the LIMIT 1 the single-item version does.
 *
 * The returned Map has an entry for EVERY id asked about, so a caller never
 * has to re-apply the default and the two functions cannot drift on it.
 */
export async function effectiveStatuses(
  db: Db, financialItemIds: string[]
): Promise<Map<string, string>> {
  const statuses = new Map(financialItemIds.map((id) => [id, "identified"]));
  if (financialItemIds.length === 0) return statuses;
  const rows = await db
    .selectDistinctOn([schema.registryDecisions.financialItemId], {
      financialItemId: schema.registryDecisions.financialItemId,
      status: schema.registryDecisions.status,
    })
    .from(schema.registryDecisions)
    .innerJoin(schema.ledgerEvents, and(
      eq(schema.ledgerEvents.entityId, schema.registryDecisions.id),
      eq(schema.ledgerEvents.eventType, "registry.decision"),
    ))
    .where(inArray(schema.registryDecisions.financialItemId, financialItemIds))
    .orderBy(schema.registryDecisions.financialItemId, desc(schema.ledgerEvents.seq));
  for (const r of rows) if (r.financialItemId) statuses.set(r.financialItemId, r.status);
  return statuses;
}

/**
 * Serializes decisions per target: locks the financial_items/debts row
 * (SELECT ... FOR UPDATE) so a concurrent decide() on the same target blocks
 * until this transaction commits, then re-reads the committed status. Without
 * this, two transactions could both validate against the same stale status
 * and record a transition the matrix forbids — without an overrideReason.
 * Throws if the target row does not exist.
 */
async function lockTarget(
  tx: Db, target: { financialItemId?: string; debtId?: string }
): Promise<void> {
  const [row] = target.financialItemId
    ? await tx.select({ id: schema.financialItems.id }).from(schema.financialItems)
        .where(eq(schema.financialItems.id, target.financialItemId)).for("update")
    : await tx.select({ id: schema.debts.id }).from(schema.debts)
        .where(eq(schema.debts.id, target.debtId!)).for("update");
  if (!row)
    throw new Error(target.financialItemId
      ? `Financial item ${target.financialItemId} not found`
      : `Debt ${target.debtId} not found`);
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
  const target = { financialItemId: input.financialItemId, debtId: input.debtId };
  await lockTarget(tx, target);
  const current = await effectiveStatus(tx, target);
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
