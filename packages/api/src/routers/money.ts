import { z } from "zod";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { effectiveStatuses } from "../registry-decide";
import { monthlyCents } from "./registry";
import { buildMoneySeries, monthKey, UNCATEGORIZED, type MoneyTx } from "../money-series";

/**
 * Derived-on-read: this router owns no state, writes nothing and appends no
 * ledger events. Every figure is a function of transactions + registry rows.
 */

async function loadItems(db: Db) {
  const items = await db.select().from(schema.financialItems);
  // One batched status query, not one per item: both procedures call this, and
  // money.series runs on every dashboard render.
  const statuses = await effectiveStatuses(db, items.map((i) => i.id));
  return items.map((i) => ({
    id: i.id, name: i.name, category: i.category,
    monthlyCents: monthlyCents(i), status: statuses.get(i.id) ?? "identified",
  }));
}

/**
 * Exactly the columns MoneyTx is made of. SELECT * also drags `rawRow` — the
 * full raw text of every statement line — and `description` across the wire for
 * figures that never read either.
 *
 * Deliberately NO row limit anywhere below: the series is the whole history by
 * construction, and a LIMIT that quietly truncated it would understate income
 * and draw months as empty that were not. Bound the work, never the truth.
 */
const MONEY_TX_COLUMNS = {
  id: schema.transactions.id,
  accountIban: schema.transactions.accountIban,
  bookedAt: schema.transactions.bookedAt,
  amountCents: schema.transactions.amountCents,
  counterpartyName: schema.transactions.counterpartyName,
  counterpartyIban: schema.transactions.counterpartyIban,
  mandateId: schema.transactions.mandateId,
  parseError: schema.transactions.parseError,
  financialItemId: schema.transactions.financialItemId,
  statementSha256: schema.transactions.statementSha256,
} satisfies Record<keyof MoneyTx, unknown>;

const DAY_MS = 86_400_000;

/**
 * A UTC window two days wider than the month on each side. It exists to be
 * WIDER than the answer: month membership is an Europe/Amsterdam question
 * (monthKey), and a booking stored at 23:30 UTC on 31 July is August here, so
 * an exact UTC window would drop rows the JS filter must still get to judge.
 * The SQL window bounds the read; monthKey still decides membership.
 */
function widenedMonthWindow(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  return { from: new Date(start - 2 * DAY_MS), to: new Date(end + 2 * DAY_MS) };
}

export const moneyRouter = router({
  series: protectedProcedure.query(async ({ ctx }) => {
    const rows: MoneyTx[] = await ctx.db.select(MONEY_TX_COLUMNS).from(schema.transactions);
    const items = await loadItems(ctx.db);
    const series = buildMoneySeries({ transactions: rows, items });
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
      // A drill click used to re-read the whole table and filter in JS. The
      // account narrows in SQL — eq() will not match NULL, so the unknown-
      // account card needs isNull() explicitly — and so does the widened date
      // window. The exact month test stays in JS on purpose: it is the
      // Amsterdam answer, and the two-day overhang above is precisely what
      // guarantees it still sees every row that could belong to this month.
      // Widen the SQL, decide in JS — narrowing the SQL to the exact month
      // would silently drop the boundary rows.
      const { from, to } = widenedMonthWindow(input.month);
      const candidates: MoneyTx[] = await ctx.db.select(MONEY_TX_COLUMNS)
        .from(schema.transactions)
        .where(and(
          input.accountIban === null
            ? isNull(schema.transactions.accountIban)
            : eq(schema.transactions.accountIban, input.accountIban),
          gte(schema.transactions.bookedAt, from),
          lt(schema.transactions.bookedAt, to),
        ));
      const rows = candidates.filter((t) => monthKey(t.bookedAt) === input.month);
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
