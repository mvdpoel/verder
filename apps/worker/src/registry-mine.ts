import { z } from "zod";
import { inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { detectRecurring, normalizeName, type RecurringCandidate } from "@verder/parsers";
import { recordRun } from "./heartbeat";
import { buildRegistryPrompt, REGISTRY_PROMPT_VERSION } from "./prompts";
import type { LlmPort } from "./ollama";

/**
 * Registry mining sweep (cron, every 2 min): un-mined statement transactions →
 * recurring candidates → dedup against existing items and ALL prior suggestions
 * (a rejected candidate never reappears) → Ollama classification → suggestions.
 * Miners never write to the registry itself; only Martin's approval does.
 */

const CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;

const llmRegistrySchema = z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
  isDebtCollector: z.boolean().default(false),
});

type TxRow = typeof schema.transactions.$inferSelect;

function basePayload(c: RecurringCandidate, sourceById: Map<string, TxRow["source"]>) {
  const sources = c.transactionIds.map((id) => sourceById.get(id));
  const viaPaypalCsv = sources.some((s) => s === "paypal-csv");
  const paymentChannel =
    c.aggregator === "apple" ? "apple" :
    c.aggregator === "paypal" || viaPaypalCsv ? "paypal" :
    c.mandateId ? "direct-debit" : "invoice";
  const discoveredVia = c.aggregator ?? (viaPaypalCsv ? "paypal" : "bank");
  return {
    key: c.key,
    groupBy: c.groupBy,
    counterpartyName: c.counterpartyName,
    counterpartyIban: c.counterpartyIban,
    mandateId: c.mandateId,
    transactionIds: c.transactionIds,
    chargeCount: c.chargeCount,
    typicalAmountCents: c.typicalAmountCents,
    firstAt: c.firstAt.toISOString(),
    lastAt: c.lastAt.toISOString(),
    receiptRawEmailIds: [] as string[],
    aggregator: c.aggregator,
    resolved: c.aggregator === null,
    paymentChannel,
    discoveredVia,
  };
}

export async function mineRegistry(deps: {
  db: Db; llm: LlmPort;
  /** pg-boss send for `receipts.resolve` (Task 8); optional so tests and the
   * period before Task 8 lands stay safe — failures are recorded, not thrown. */
  enqueueResolve?: (suggestionId: string) => Promise<void>;
}): Promise<{ candidates: number; suggested: number }> {
  const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  let suggested = 0;
  let linked = 0;
  const failures: { key: string; message: string }[] = [];
  let candidates: RecurringCandidate[] = [];
  try {
    const unmined = await deps.db.select().from(schema.transactions)
      .where(sql`${schema.transactions.financialItemId} IS NULL AND ${schema.transactions.parseError} = false`);
    const sourceById = new Map(unmined.map((t) => [t.id, t.source]));
    candidates = detectRecurring(unmined.map((t) => ({
      id: t.id, rowIndex: t.rowIndex, bookedAt: t.bookedAt, amountCents: t.amountCents,
      counterpartyName: t.counterpartyName, counterpartyIban: t.counterpartyIban,
      description: t.description, mandateId: t.mandateId, source: t.source,
    })));

    // Existing-item identity: mandates/IBANs live on already-linked transactions
    // (financial_items has no such columns); names on the items themselves.
    const linkedTxs = await deps.db.select({
      financialItemId: schema.transactions.financialItemId,
      mandateId: schema.transactions.mandateId,
      counterpartyIban: schema.transactions.counterpartyIban,
    }).from(schema.transactions).where(isNotNull(schema.transactions.financialItemId));
    const byMandate = new Map<string, string>();
    const byIban = new Map<string, string>();
    for (const t of linkedTxs) {
      if (t.mandateId) byMandate.set(t.mandateId, t.financialItemId!);
      if (t.counterpartyIban) byIban.set(t.counterpartyIban, t.financialItemId!);
    }
    const items = await deps.db.select({ id: schema.financialItems.id, name: schema.financialItems.name })
      .from(schema.financialItems);
    // Empty normalized names (digits/punctuation-only) carry no identity:
    // mapping "" would falsely link unrelated candidates to that item.
    const byName = new Map<string, string>();
    for (const i of items) {
      const n = normalizeName(i.name);
      if (n) byName.set(n, i.id);
    }

    // Dedup spine: every key ever suggested, ANY status — rejected included.
    const priorKeys = new Set(
      (await deps.db.select({ key: sql<string | null>`${schema.suggestions.proposed} ->> 'key'` })
        .from(schema.suggestions)
        .where(inArray(schema.suggestions.kind, ["registry-item", "debt"])))
        .map((r) => r.key).filter((k): k is string => k !== null));

    for (const c of candidates) {
      // One bad candidate must not block the sweep (gmail.ts discipline).
      try {
        // Same guard on lookup: a counterparty name that normalizes to ""
        // proves nothing and must never match an item.
        const normName = c.counterpartyName ? normalizeName(c.counterpartyName) : "";
        const matchedItemId =
          (c.mandateId && byMandate.get(c.mandateId)) ||
          (c.counterpartyIban && byIban.get(c.counterpartyIban)) ||
          (normName && byName.get(normName)) ||
          null;
        if (matchedItemId) {
          // Known item: the new charges are auto-linked evidence, no suggestion.
          await deps.db.update(schema.transactions)
            .set({ financialItemId: matchedItemId })
            .where(inArray(schema.transactions.id, c.transactionIds));
          linked += c.transactionIds.length;
          continue;
        }
        if (priorKeys.has(c.key)) continue;

        const base = basePayload(c, sourceById);
        let suggestionId: string;
        try {
          const parsed = llmRegistrySchema.parse(await deps.llm.chatJson(buildRegistryPrompt(c)));
          const kind = parsed.isDebtCollector ? "debt" as const : "registry-item" as const;
          const proposed = kind === "debt"
            ? { ...base, creditorName: parsed.name, claimedCents: Math.abs(c.typicalAmountCents),
                references: null }
            : { ...base, name: parsed.name, category: parsed.category,
                amountCents: Math.abs(c.typicalAmountCents), billingCycle: c.cadence };
          const [s] = await deps.db.insert(schema.suggestions).values({
            kind, model, promptVersion: REGISTRY_PROMPT_VERSION, proposed }).returning();
          suggestionId = s.id;
        } catch (err) {
          // AI is suggestion-only and optional: classification failure degrades
          // to a needs-manual card, never a dropped candidate.
          const [s] = await deps.db.insert(schema.suggestions).values({
            kind: "registry-item", model, promptVersion: REGISTRY_PROMPT_VERSION,
            status: "needs-manual",
            proposed: { ...base, name: c.counterpartyName ?? c.key, category: "other",
              amountCents: Math.abs(c.typicalAmountCents), billingCycle: c.cadence } }).returning();
          suggestionId = s.id;
          failures.push({ key: c.key, message: `classify: ${String(err)}` });
        }
        priorKeys.add(c.key);
        suggested++;
        if (c.aggregator && deps.enqueueResolve) {
          // Guarded: the receipts.resolve queue may not exist yet (Task 8).
          try { await deps.enqueueResolve(suggestionId); }
          catch (err) { failures.push({ key: c.key, message: `enqueue receipts.resolve: ${String(err)}` }); }
        }
      } catch (err) {
        failures.push({ key: c.key, message: String(err) });
      }
    }
    await recordRun(deps.db, "registry-mine", failures.length ? "error" : "ok",
      { candidates: candidates.length, suggested, linked, failures });
  } catch (err) {
    await recordRun(deps.db, "registry-mine", "error", { message: String(err) });
    throw err;
  }
  return { candidates: candidates.length, suggested };
}
