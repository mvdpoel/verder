/**
 * Derivation for the /money page. PURE: no database, no I/O, no imports from
 * @verder/db. Everything the page shows is a function of rows already in the
 * ledger, which is why this sub-project appends no evidence of its own.
 *
 * All money is integer cents. Amounts arrive signed (debits negative) and are
 * reported as positive magnitudes on both sides of the chart.
 */

import { detectRecurring, type RecurringCandidate } from "@verder/parsers";

export interface MoneyTx {
  id: string; accountIban: string | null; bookedAt: Date; amountCents: number;
  counterpartyName: string | null; counterpartyIban: string | null;
  mandateId: string | null; parseError: boolean;
  financialItemId: string | null; statementSha256: string;
}

export interface MoneyItem {
  id: string; name: string; category: string; monthlyCents: number; status: string;
}

export type Coverage = "complete" | "partial" | "none";

export interface MonthSeries {
  month: string; coverage: Coverage;
  inCents: number; outCents: number;
  outByCategory: { category: string; cents: number }[];
  incidentalCents: number; internalCents: number; parseErrorRows: number;
}

/** Debits with no registry item behind them pool here. */
export const UNCATEGORIZED = "overig";

const MONTH_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit",
});

/** "2026-07" in Amsterdam time — a 23:30 UTC booking on 31 July is August here. */
export function monthKey(d: Date): string {
  return MONTH_FMT.format(d).slice(0, 7);
}

/** [start, endExclusive) of a "YYYY-MM" as UTC instants of the Amsterdam month. */
function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  // Amsterdam is UTC+1/+2; building from UTC midnight and letting monthKey
  // decide membership keeps this free of a timezone library.
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return { start, end };
}

/**
 * Coverage is inferred per statement file: the first and last booking in it
 * bound the period it can speak for. This UNDERSTATES a quiet month (a
 * statement covering all of June whose first booking is the 4th reads as
 * partial), which is the safe direction: it says "possibly incomplete" when
 * unsure and never claims completeness it cannot support.
 */
export function coverageForMonths(txs: MoneyTx[], months: string[]): Map<string, Coverage> {
  const ranges = new Map<string, { from: Date; to: Date }>();
  for (const t of txs) {
    if (t.parseError) continue; // an unreadable row's date is not evidence of coverage
    const r = ranges.get(t.statementSha256);
    if (!r) ranges.set(t.statementSha256, { from: t.bookedAt, to: t.bookedAt });
    else {
      if (t.bookedAt < r.from) r.from = t.bookedAt;
      if (t.bookedAt > r.to) r.to = t.bookedAt;
    }
  }
  const merged = [...ranges.values()]
    .sort((a, b) => a.from.getTime() - b.from.getTime())
    .reduce<{ from: Date; to: Date }[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.from.getTime() <= last.to.getTime()) {
        if (r.to > last.to) last.to = r.to;
      } else acc.push({ from: new Date(r.from), to: new Date(r.to) });
      return acc;
    }, []);

  const out = new Map<string, Coverage>();
  for (const month of months) {
    const { start, end } = monthBounds(month);
    const lastDay = new Date(end.getTime() - 86_400_000);
    const hasRows = txs.some((t) => monthKey(t.bookedAt) === month);
    if (!hasRows) { out.set(month, "none"); continue; }
    const complete = merged.some((r) => r.from <= start && r.to >= lastDay);
    out.set(month, complete ? "complete" : "partial");
  }
  return out;
}

/** Debits per month, grouped by the category of the item they are linked to. */
export function outSeries(
  txs: MoneyTx[], items: MoneyItem[]
): Map<string, MonthSeries["outByCategory"]> {
  const categoryOf = new Map(items.map((i) => [i.id, i.category]));
  const perMonth = new Map<string, Map<string, number>>();
  for (const t of txs) {
    if (t.parseError || t.amountCents >= 0) continue;
    const month = monthKey(t.bookedAt);
    const category = (t.financialItemId && categoryOf.get(t.financialItemId)) || UNCATEGORIZED;
    const bucket = perMonth.get(month) ?? new Map<string, number>();
    bucket.set(category, (bucket.get(category) ?? 0) + Math.abs(t.amountCents));
    perMonth.set(month, bucket);
  }
  return new Map(
    [...perMonth].map(([month, bucket]) => [
      month,
      // UNCATEGORIZED sorts last; the rest alphabetically, so the stack order
      // is stable across months and the eye can follow a band.
      [...bucket].map(([category, cents]) => ({ category, cents })).sort((a, b) =>
        a.category === UNCATEGORIZED ? 1 : b.category === UNCATEGORIZED ? -1
          : a.category.localeCompare(b.category)),
    ])
  );
}

/**
 * How far a new counterparty's amount may sit from the old one and still count
 * as the same income continuing. 0.25 is a GUESS: it is wide enough for the
 * pay change Martin actually had in June 2026 and narrow enough that a toeslag
 * cannot be swallowed by a salary. Re-measure against the real ABN export
 * before trusting it — a wrong value fails visibly (one line splits in two, or
 * two lines merge into one), never silently.
 */
export const INCOME_CONTINUATION_TOLERANCE = 0.25;

const DAY_MS = 86_400_000;
/** How far apart a matched pair may sit before it stops looking like one move. */
const INTERNAL_WINDOW_DAYS = 5;
/** How far apart the two legs' amounts may sit: 1%, in integer math. */
const INTERNAL_AMOUNT_TOLERANCE = 0.01;

export interface IncomeLine {
  key: string; labels: string[];
  cadence: RecurringCandidate["cadence"];
  typicalAmountCents: number; firstAt: Date; lastAt: Date; transactionIds: string[];
}

/**
 * Money that left and came straight back (or the reverse) is not income. Both
 * legs must name the same counterparty IBAN, sit within five days, and match
 * in size to within 1%. Only the CREDIT leg is returned: the debit leg is a
 * real payment out of this account and stays in the costs bar.
 */
export function splitInternalTransfers(
  txs: MoneyTx[]
): { internal: Set<string>; internalCents: number } {
  const debits = txs.filter((t) => !t.parseError && t.amountCents < 0 && t.counterpartyIban);
  const internal = new Set<string>();
  let internalCents = 0;
  for (const credit of txs) {
    if (credit.parseError || credit.amountCents <= 0 || !credit.counterpartyIban) continue;
    const match = debits.find((d) =>
      d.counterpartyIban === credit.counterpartyIban &&
      Math.abs(d.bookedAt.getTime() - credit.bookedAt.getTime()) <= INTERNAL_WINDOW_DAYS * DAY_MS &&
      Math.abs(Math.abs(d.amountCents) - credit.amountCents) * 100 <=
        credit.amountCents * (INTERNAL_AMOUNT_TOLERANCE * 100)
    );
    if (match) { internal.add(credit.id); internalCents += credit.amountCents; }
  }
  return { internal, internalCents };
}

/** Cadence in days, for deciding whether one line picks up where another stopped. */
const CADENCE_DAYS: Record<RecurringCandidate["cadence"], number> = {
  monthly: 30, quarterly: 91, yearly: 365,
};

/**
 * Recurring credits, with successor lines folded into their predecessor.
 * A job change replaces the counterparty entirely; without this, the months
 * either side of the switch show no income at all.
 */
export function incomeLines(txs: MoneyTx[]): IncomeLine[] {
  const { internal } = splitInternalTransfers(txs);
  const credits = txs.filter((t) => !t.parseError && t.amountCents > 0 && !internal.has(t.id));
  const found = detectRecurring(
    credits.map((t) => ({
      id: t.id, rowIndex: 0, bookedAt: t.bookedAt, amountCents: t.amountCents,
      counterpartyName: t.counterpartyName, counterpartyIban: t.counterpartyIban,
      description: null, mandateId: t.mandateId, accountIban: t.accountIban,
    })),
    { direction: "credit" }
  );

  const lines: IncomeLine[] = found
    .map((c) => ({
      key: c.key, labels: [c.counterpartyName ?? c.key], cadence: c.cadence,
      typicalAmountCents: c.typicalAmountCents,
      firstAt: c.firstAt, lastAt: c.lastAt, transactionIds: [...c.transactionIds],
    }))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());

  // Fold successors into predecessors, oldest first, so a chain of two job
  // changes collapses into one line rather than two.
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    if (!a) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (!b) continue;
      const gapDays = (b.firstAt.getTime() - a.lastAt.getTime()) / DAY_MS;
      const withinOneCadence = gapDays > 0 && gapDays <= CADENCE_DAYS[a.cadence] * 1.5;
      const sizeDelta = Math.abs(b.typicalAmountCents - a.typicalAmountCents);
      const similar = sizeDelta <= a.typicalAmountCents * INCOME_CONTINUATION_TOLERANCE;
      if (!withinOneCadence || !similar || a.lastAt >= b.firstAt) continue;
      a.labels = [...a.labels, ...b.labels];
      a.transactionIds = [...a.transactionIds, ...b.transactionIds];
      a.lastAt = b.lastAt;
      // The running line's amount is what will be projected forward.
      a.typicalAmountCents = b.typicalAmountCents;
      a.cadence = b.cadence;
      lines[j] = undefined as unknown as IncomeLine;
    }
  }
  return lines.filter(Boolean);
}
