import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { ingestRawEmail, type GmailPort } from "./gmail";
import { recordRun } from "./heartbeat";
import { buildReceiptPrompt, RECEIPT_PROMPT_VERSION } from "./prompts";
import type { LlmPort } from "./ollama";

/**
 * Aggregator resolution: an APPLE.COM/BILL or PayPal statement line hides the
 * real subscription. For each of the last few charge dates a targeted Gmail
 * search fetches the matching receipt; receipts ingest through the same
 * evidence-first path as the watcher (raw RFC822 → vault) but never enqueue
 * suggest.entry. Line items resolve the suggestion; no receipt → needs-manual,
 * never a silent drop.
 */

const lineItemSchema = z.object({ name: z.string().min(1), amountCents: z.number().int() });
// Ollama's JSON mode prefers an object envelope; accept a bare array too.
const lineItemsSchema = z.union([
  z.object({ items: z.array(lineItemSchema) }).transform((o) => o.items),
  z.array(lineItemSchema),
]);

/** Gmail search date format, UTC: YYYY/MM/DD. */
function gmailDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function receiptQuery(aggregator: "apple" | "paypal", chargeDate: Date): string {
  const after = gmailDate(new Date(chargeDate.getTime() - 2 * DAY_MS));
  const before = gmailDate(new Date(chargeDate.getTime() + 2 * DAY_MS));
  const from = aggregator === "apple"
    ? "from:apple.com"
    : "(from:paypal.nl OR from:paypal.com)";
  return `${from} after:${after} before:${before}`;
}

export async function resolveAggregator(
  deps: { db: Db; gmail: GmailPort; llm: LlmPort; vaultDir: string },
  suggestionId: string,
): Promise<void> {
  const failures: { id: string; message: string }[] = [];
  try {
    const [s] = await deps.db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, suggestionId));
    if (!s || s.kind !== "registry-item") return;
    // Martin's verdict is final: a late or retried resolve job must never
    // resurrect a rejected card or rewrite proposed after approval — the
    // recorded suggestion-vs-verdict diff is evidence (golden rule).
    if (s.verdictAt !== null || (s.status !== "pending" && s.status !== "needs-manual")) {
      await recordRun(deps.db, "receipts", "ok",
        { suggestionId, outcome: "skipped", reason: `verdict already given (${s.status})` });
      return;
    }
    const proposed = (s.proposed ?? {}) as Record<string, unknown>;
    const aggregator = proposed.aggregator;
    if ((aggregator !== "apple" && aggregator !== "paypal") || proposed.resolved !== false) return;

    // Last <=3 charge dates, newest first — the receipt for the most recent
    // charge is the freshest picture of what the subscription is today.
    const txIds = Array.isArray(proposed.transactionIds) ? proposed.transactionIds as string[] : [];
    const charges = txIds.length === 0 ? [] :
      await deps.db.select({ bookedAt: schema.transactions.bookedAt })
        .from(schema.transactions).where(inArray(schema.transactions.id, txIds));
    const chargeDates = charges.map((c) => c.bookedAt)
      .sort((a, b) => b.getTime() - a.getTime()).slice(0, 3);

    const receiptRawEmailIds: string[] = [];
    for (const date of chargeDates) {
      const ids = await deps.gmail.listMessageIds(receiptQuery(aggregator, date));
      for (const id of ids) {
        // One bad receipt must not block the rest (gmail.ts discipline).
        try {
          const [seen] = await deps.db.select().from(schema.rawEmails)
            .where(eq(schema.rawEmails.gmailMessageId, id));
          const rawEmailId = seen
            ? seen.id
            : await ingestRawEmail(deps, await deps.gmail.getMessage(id), { skipSuggest: true });
          if (!receiptRawEmailIds.includes(rawEmailId)) receiptRawEmailIds.push(rawEmailId);
        } catch (err) {
          failures.push({ id, message: String(err) });
        }
      }
    }

    if (receiptRawEmailIds.length === 0) {
      // Degrade to needs-manual — the candidate surfaces for Martin's eyes,
      // it is never dropped.
      await deps.db.update(schema.suggestions).set({
        status: "needs-manual",
        proposed: { ...proposed, note: "payee unknown — check PayPal/Apple account" },
      }).where(eq(schema.suggestions.id, s.id));
      await recordRun(deps.db, "receipts", failures.length ? "error" : "ok",
        { suggestionId, receipts: 0, outcome: "needs-manual", failures });
      return;
    }

    // Extract line items from the newest receipt.
    const [receipt] = await deps.db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, receiptRawEmailIds[0]));
    let items: { name: string; amountCents: number }[] = [];
    let extractError: string | null = null;
    try {
      items = lineItemsSchema.parse(await deps.llm.chatJson(
        buildReceiptPrompt({ subject: receipt.subject, bodyText: receipt.bodyText })));
    } catch (err) {
      extractError = String(err);
    }

    const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
    const resolvedBase = {
      ...proposed, resolved: true, receiptRawEmailIds,
      receiptPromptVersion: RECEIPT_PROMPT_VERSION,
    };
    if (extractError !== null || items.length === 0) {
      // Receipt evidence is secured, but the AI could not read line items:
      // keep the original classification and hand it to Martin.
      await deps.db.update(schema.suggestions).set({
        status: "needs-manual", proposed: resolvedBase,
      }).where(eq(schema.suggestions.id, s.id));
      await recordRun(deps.db, "receipts", extractError !== null ? "error" : "ok",
        { suggestionId, receipts: receiptRawEmailIds.length, items: 0,
          outcome: "needs-manual", ...(extractError !== null ? { message: `extract: ${extractError}` } : {}),
          failures });
      return;
    }

    // First line item resolves this suggestion; extra items fan out into
    // additional suggestions carrying the same evidence.
    await deps.db.update(schema.suggestions).set({
      proposed: { ...resolvedBase, name: items[0].name, amountCents: items[0].amountCents },
    }).where(eq(schema.suggestions.id, s.id));
    for (let i = 1; i < items.length; i++) {
      await deps.db.insert(schema.suggestions).values({
        kind: "registry-item", model, promptVersion: RECEIPT_PROMPT_VERSION,
        proposed: { ...resolvedBase, key: `${String(proposed.key)}#${i}`,
          name: items[i].name, amountCents: items[i].amountCents },
      });
    }
    await recordRun(deps.db, "receipts", failures.length ? "error" : "ok",
      { suggestionId, receipts: receiptRawEmailIds.length, items: items.length, failures });
  } catch (err) {
    await recordRun(deps.db, "receipts", "error", { suggestionId, message: String(err) });
    throw err;
  }
}
