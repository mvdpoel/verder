import { z } from "zod";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveStatus } from "../registry-decide";
import { monthlyCents } from "./registry";
import { buildMoneySeries, monthKey, UNCATEGORIZED, type MoneyTx } from "../money-series";

/**
 * Derived-on-read: this router owns no state, writes nothing and appends no
 * ledger events. Every figure is a function of transactions + registry rows.
 */

async function loadItems(db: Parameters<typeof effectiveStatus>[0]) {
  const items = await db.select().from(schema.financialItems);
  const statuses = await Promise.all(
    items.map((i) => effectiveStatus(db, { financialItemId: i.id }))
  );
  return items.map((i, n) => ({
    id: i.id, name: i.name, category: i.category,
    monthlyCents: monthlyCents(i), status: statuses[n],
  }));
}

function toMoneyTx(r: typeof schema.transactions.$inferSelect): MoneyTx {
  return {
    id: r.id, accountIban: r.accountIban, bookedAt: r.bookedAt, amountCents: r.amountCents,
    counterpartyName: r.counterpartyName, counterpartyIban: r.counterpartyIban,
    mandateId: r.mandateId, parseError: r.parseError,
    financialItemId: r.financialItemId, statementSha256: r.statementSha256,
  };
}

export const moneyRouter = router({
  series: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(schema.transactions);
    const items = await loadItems(ctx.db);
    const series = buildMoneySeries({ transactions: rows.map(toMoneyTx), items });
    // There is no table naming accounts, and inventing one would be an
    // assertion this sub-project is not allowed to make. Until a real label
    // exists an account is shown under its own IBAN; the map is here so the
    // page never has to decide, and so a real source of names can be added
    // later without changing the page.
    const accountLabels: Record<string, string> = {};
    for (const s of series) {
      if (!s.accountIban) continue;
      accountLabels[s.accountIban] = s.accountIban;
    }
    return { series, accountLabels };
  }),

  month: protectedProcedure
    .input(z.object({
      accountIban: z.string().nullable(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    }))
    .query(async ({ ctx, input }) => {
      const rows = (await ctx.db.select().from(schema.transactions))
        .map(toMoneyTx)
        .filter((t) => (t.accountIban ?? null) === input.accountIban &&
          monthKey(t.bookedAt) === input.month);
      const items = await loadItems(ctx.db);
      const itemById = new Map(items.map((i) => [i.id, i]));

      const categories = new Map<string, {
        category: string; cents: number;
        transactions: { id: string; bookedAt: Date; amountCents: number;
          counterpartyName: string | null; itemName: string | null; statementSha256: string }[];
      }>();
      for (const t of rows) {
        if (t.parseError || t.amountCents >= 0) continue;
        const item = t.financialItemId ? itemById.get(t.financialItemId) : undefined;
        const category = item?.category ?? UNCATEGORIZED;
        const bucket = categories.get(category) ??
          { category, cents: 0, transactions: [] };
        bucket.cents += Math.abs(t.amountCents);
        bucket.transactions.push({
          id: t.id, bookedAt: t.bookedAt, amountCents: t.amountCents,
          counterpartyName: t.counterpartyName, itemName: item?.name ?? null,
          statementSha256: t.statementSha256,
        });
        categories.set(category, bucket);
      }
      return {
        month: input.month,
        accountIban: input.accountIban,
        categories: [...categories.values()].sort((a, b) => b.cents - a.cents),
        parseErrorRows: rows.filter((t) => t.parseError).length,
      };
    }),
});
