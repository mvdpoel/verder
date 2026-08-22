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

/**
 * One credit that was kept OUT of the income bar, in the shape the page needs
 * to name it. A total on its own is not a disclosure: a reader who sees
 * "€ 1.697,63 incidenteel" cannot check it, and Martin cannot tell a
 * belastingteruggave from a credit the rules got wrong. The list is what makes
 * the month reconcile in public.
 */
export interface DisclosedRow {
  id: string; bookedAt: Date; amountCents: number; counterpartyName: string | null;
}

export interface MonthSeries {
  month: string; coverage: Coverage;
  inCents: number; outCents: number;
  outByCategory: { category: string; cents: number }[];
  incidentalCents: number; internalCents: number; parseErrorRows: number;
  /** The rows behind `internalCents`, oldest first. Sums to it, by construction. */
  internalRows: DisclosedRow[];
  /** The rows behind `incidentalCents`, oldest first. Sums to it, by construction. */
  incidentalRows: DisclosedRow[];
}

/** Debits with no registry item behind them pool here. */
export const UNCATEGORIZED = "overig";

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
});

/** "2026-07-31" in Amsterdam time. en-CA is ISO order, so string compare is chronological. */
export function dayKey(d: Date): string {
  return DAY_FMT.format(d);
}

/** "2026-07" in Amsterdam time — a 23:30 UTC booking on 31 July is August here. */
export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

/**
 * The Amsterdam calendar day after this one. The key is already Amsterdam-local,
 * so this is civil-date arithmetic and UTC is only being used as a calendar —
 * no offset and no 23-hour DST night can shift the answer, because no instant
 * is ever formed.
 */
function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** First and last Amsterdam calendar day of a "YYYY-MM". Day 0 of the next month is this one's last. */
function monthDayBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  return { first: `${month}-01`, last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/**
 * Coverage is inferred per statement file: the first and last booking in it
 * bound the period it can speak for. This UNDERSTATES a quiet month (a
 * statement covering all of June whose first booking is the 4th reads as
 * partial), which is the safe direction: it says "possibly incomplete" when
 * unsure and never claims completeness it cannot support.
 *
 * The arithmetic is in Amsterdam CALENDAR DAYS, not instants. Two reasons, both
 * measured: a period split across two statements (1–15 and 16–30 June) ABUTS
 * rather than overlaps, and merging on overlap alone reported a fully covered
 * June as partial; and comparing UTC instants against a month bucketed by
 * monthKey — which is Amsterdam — disagreed by the UTC offset, so a statement
 * whose first booking is 01:00 UTC on the 1st failed a `<= UTC midnight` test
 * for a month it demonstrably starts in. Invisible while every parser produces
 * date-only midnight bookings, and a lie the moment one does not.
 */
export function coverageForMonths(txs: MoneyTx[], months: string[]): Map<string, Coverage> {
  const ranges = new Map<string, { from: string; to: string }>();
  for (const t of txs) {
    if (t.parseError) continue; // an unreadable row's date is not evidence of coverage
    const day = dayKey(t.bookedAt);
    const r = ranges.get(t.statementSha256);
    if (!r) ranges.set(t.statementSha256, { from: day, to: day });
    else {
      if (day < r.from) r.from = day;
      if (day > r.to) r.to = day;
    }
  }
  const merged = [...ranges.values()]
    // Ties break on `to` so the merge never depends on statement insertion order.
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .reduce<{ from: string; to: string }[]>((acc, r) => {
      const last = acc[acc.length - 1];
      // Abutting counts: a statement starting the day after the previous one
      // ended leaves no day unaccounted for between them.
      if (last && r.from <= nextDay(last.to)) {
        if (r.to > last.to) last.to = r.to;
      } else acc.push({ ...r });
      return acc;
    }, []);

  const out = new Map<string, Coverage>();
  for (const month of months) {
    const { first, last } = monthDayBounds(month);
    const hasRows = txs.some((t) => monthKey(t.bookedAt) === month);
    if (!hasRows) { out.set(month, "none"); continue; }
    const complete = merged.some((r) => r.from <= first && r.to >= last);
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
 * How far a new counterparty's full-period amount may sit from the old one and
 * still count as the same income continuing.
 *
 * MEASURED, no longer a guess. Martin's own job change, 10 June 2026:
 * TrueFullstaq's full period was € 2.660,68 and Saurens Marketing's is
 * € 3.556,42 — a 33,7% raise. The original 0.25 refused to link them, so the
 * chart told him his income had ended and something smaller had begun. 1/2
 * clears that with room, and the link still requires the same cadence, the old
 * line to have stopped, and the new one to start within one cadence of it —
 * three conditions a toeslag arriving beside a salary cannot satisfy.
 *
 * Held as an integer ratio, not a float: the comparison is in cents, and
 * detectRecurring one package over deliberately does the same.
 */
export const INCOME_CONTINUATION_TOLERANCE_NUM = 1;
export const INCOME_CONTINUATION_TOLERANCE_DEN = 2;

const DAY_MS = 86_400_000;
/** How far apart a matched pair may sit before it stops looking like one move. */
const INTERNAL_WINDOW_DAYS = 5;
/**
 * How far apart the two legs' amounts may sit: 1%, held as an integer ratio.
 * The old form multiplied a 0.01 float back up by 100 to get there; money math
 * in this repo never touches a float, and detectRecurring one package over
 * spells its 40% band the same way.
 */
const INTERNAL_AMOUNT_TOLERANCE_NUM = 1;
const INTERNAL_AMOUNT_TOLERANCE_DEN = 100;

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
 *
 * A matched debit is CONSUMED — the same discipline resolveDocumentUpdatedHashes
 * in verification.ts had to learn, for the same reason: without it one row
 * vouches for two. Here that meant a single € 500 transfer out disqualifying
 * TWO € 500 credits, so one debit erased € 1.000 of income and the disclosure
 * claimed twice what had moved. Understating income is the failure this whole
 * file exists to prevent, so the pairing must be one-to-one.
 *
 * Credits are walked oldest-first (id breaks the tie) and each takes the
 * NEAREST-IN-TIME unclaimed leg, tie-broken on debit id: a transfer out and
 * straight back is the pair a reader would draw, and neither the answer nor
 * the disclosure may depend on the order rows came out of the database.
 */
export function splitInternalTransfers(
  txs: MoneyTx[]
): { internal: Set<string>; internalCents: number } {
  const debits = txs.filter((t) => !t.parseError && t.amountCents < 0 && t.counterpartyIban);
  const credits = txs
    .filter((t) => !t.parseError && t.amountCents > 0 && t.counterpartyIban)
    .sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || a.id.localeCompare(b.id));

  const consumed = new Set<string>();
  const internal = new Set<string>();
  let internalCents = 0;
  for (const credit of credits) {
    let best: MoneyTx | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const d of debits) {
      if (consumed.has(d.id)) continue;
      if (d.counterpartyIban !== credit.counterpartyIban) continue;
      const gap = Math.abs(d.bookedAt.getTime() - credit.bookedAt.getTime());
      if (gap > INTERNAL_WINDOW_DAYS * DAY_MS) continue;
      const sizeDelta = Math.abs(Math.abs(d.amountCents) - credit.amountCents);
      if (sizeDelta * INTERNAL_AMOUNT_TOLERANCE_DEN >
        credit.amountCents * INTERNAL_AMOUNT_TOLERANCE_NUM) continue;
      if (gap < bestGap || (gap === bestGap && best !== null && d.id < best.id)) {
        best = d;
        bestGap = gap;
      }
    }
    if (best) {
      consumed.add(best.id);
      internal.add(credit.id);
      internalCents += credit.amountCents;
    }
  }
  return { internal, internalCents };
}

/** Cadence in days, for deciding whether one line picks up where another stopped. */
const CADENCE_DAYS: Record<RecurringCandidate["cadence"], number> = {
  weekly: 7, monthly: 30, quarterly: 91, yearly: 365,
};

/**
 * What a FULL period of this line pays — the figure worth projecting, and the
 * one worth comparing across a job change. Part-months sit below it and must
 * not drag it down: the mean of Martin's part-month June (€ 2.487,71) and his
 * full July (€ 3.556,42) is € 3.022,06, which under-reported his income by
 * € 534,36 a month on the first implementation.
 *
 * Rule: take the largest amount the line has ever paid, keep every amount
 * within FULL_PERIOD_BAND_PCT of it, and return their median. One unusually
 * large payment therefore cannot set the figure on its own unless it is the
 * only full period there is.
 *
 * THE KNOWN HOLE: a lump vakantiegeld larger than the monthly salary is alone
 * in the top band and so sets it, and the line would be projected forward at
 * holiday pay. It does not touch Martin — Saurens pays his 8% monthly, inside
 * the € 5.250 gross — but it is real for anyone whose employer pays it in May.
 *
 * THE OBVIOUS FIX IS REFUSED, ON EVIDENCE. Falling back to the median of the
 * rest when exactly one amount sits in the top band and the line has ≥3 rows
 * was proposed and MEASURED against money-series.real.test.ts, which is a
 * transcript of Martin's real statement. TrueFullstaq's line is
 * [64_800, 266_068, 111_865] — one amount in the top band, three rows, exactly
 * the trigger — and the fallback returns € 883,32 instead of € 2.660,68. The
 * continuation link to Saurens Marketing then fails its size test (the delta,
 * € 2.673,10, is far outside half of € 883,32), the chart splits into a line
 * that stopped and a smaller one that started, and the projection turns into
 * € 4.439,74 by counting a job he had already left. Telling Martin his income
 * ended and something smaller began is the precise failure this file was
 * written to prevent, so the hole stays open until there is a rule that closes
 * it without touching a real part-month. A future rewrite has to face those
 * numbers: money-series.test.ts pins the triple.
 */
const FULL_PERIOD_BAND_PCT = 15;

export function fullPeriodAmount(amounts: number[]): number {
  if (amounts.length === 0) return 0;
  const max = Math.max(...amounts);
  const full = amounts.filter((a) => (max - a) * 100 <= max * FULL_PERIOD_BAND_PCT);
  const sorted = [...full].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.trunc((sorted[mid - 1] + sorted[mid]) / 2);
}

const toDetectInput = (t: MoneyTx) => ({
  id: t.id, rowIndex: 0, bookedAt: t.bookedAt, amountCents: t.amountCents,
  counterpartyName: t.counterpartyName, counterpartyIban: t.counterpartyIban,
  description: null, mandateId: t.mandateId, accountIban: t.accountIban,
});

/**
 * The name a line is shown under: the one most of its rows carry, not the one
 * its newest row happens to carry. detectRecurring names a group after its LAST
 * row, so a single differently-worded credit ("TrueFullstaq BV vakantiegeld")
 * would relabel three months of salary. Ties go to the earliest row's name.
 */
function modalName(rows: MoneyTx[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime())) {
    if (!r.counterpartyName) continue;
    counts.set(r.counterpartyName, (counts.get(r.counterpartyName) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [name, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = name;
  return best ?? fallback;
}

/**
 * Recurring credits, with successor lines folded into their predecessor.
 * A job change replaces the counterparty entirely; without this, the months
 * either side of the switch show no income at all.
 */
export function incomeLines(txs: MoneyTx[]): IncomeLine[] {
  const { internal } = splitInternalTransfers(txs);
  const credits = txs.filter((t) => !t.parseError && t.amountCents > 0 && !internal.has(t.id));
  // No eviction. Money from a counterparty that pays you on a cadence IS that
  // line's income, whatever the amount: a part-month at either end of a job
  // change is salary, not a footnote. "Recurring only" is enforced by the
  // COUNTERPARTY having a cadence — a one-off from a stranger (a
  // belastingteruggave) still never reaches a bar.
  const found = detectRecurring(credits.map(toDetectInput), { direction: "credit" });

  const byId = new Map(credits.map((t) => [t.id, t]));
  const lines: IncomeLine[] = found
    .map((c) => ({
      key: c.key,
      labels: [modalName(
        c.transactionIds.map((id) => byId.get(id)).filter((t): t is MoneyTx => t !== undefined),
        c.counterpartyName ?? c.key
      )],
      cadence: c.cadence,
      typicalAmountCents: fullPeriodAmount(
        c.transactionIds.map((id) => byId.get(id)?.amountCents ?? 0)
      ),
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
      // Full period against full period, so a ramp-in month on either side of
      // the switch cannot break the link. Integer cents, no float.
      const sizeDelta = Math.abs(b.typicalAmountCents - a.typicalAmountCents);
      const similar = sizeDelta * INCOME_CONTINUATION_TOLERANCE_DEN
        <= a.typicalAmountCents * INCOME_CONTINUATION_TOLERANCE_NUM;
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

export interface ProjectedMonth {
  month: string; inCents: number; outCents: number; outAfterCancelCents: number;
}

export interface AccountSeries {
  accountIban: string | null;
  months: MonthSeries[];
  projected: ProjectedMonth[];
  incomeLines: IncomeLine[];
  /** Newest month wholly inside the statement coverage — the projection's base. */
  lastCompleteMonth: string | null;
}

const DEFAULT_HORIZON_MONTHS = 3;

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y * 12) + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The map key an account is filed under; "" is the unknown account. */
const accountKeyOf = (t: MoneyTx) => t.accountIban ?? "";

/**
 * Which account pays each contracted item, decided from evidence: the account
 * of the most recent debit carrying that item's id.
 *
 * The registry total must be attributed, not broadcast. Adding every item to
 * every account's projection double-counts the whole contracted total the
 * moment a second account exists — and a second account is the entire reason
 * this dimension exists, because under bewind the beheerrekening pays the
 * contracts while the leefgeldrekening pays groceries.
 *
 * An item nobody has been seen paying has no evidence behind it. Dropping it
 * would understate the projection (a registry seeded from the mail before its
 * first statement arrives would project nothing at all), so it falls back to
 * the account with the largest debit volume — the one demonstrably paying the
 * bills. That fallback is a GUESS, and it corrects itself the moment one real
 * debit links the item to an account.
 */
function accountOfItems(txs: MoneyTx[], liveItems: MoneyItem[]): Map<string, string> {
  const latest = new Map<string, { at: number; account: string }>();
  const debitVolume = new Map<string, number>();
  const rowVolume = new Map<string, number>();
  for (const t of txs) {
    if (t.parseError) continue;
    const account = accountKeyOf(t);
    rowVolume.set(account, (rowVolume.get(account) ?? 0) + Math.abs(t.amountCents));
    if (t.amountCents >= 0) continue;
    debitVolume.set(account, (debitVolume.get(account) ?? 0) + Math.abs(t.amountCents));
    if (!t.financialItemId) continue;
    const at = t.bookedAt.getTime();
    const prev = latest.get(t.financialItemId);
    // Ties break on the account key so the answer never depends on row order.
    if (!prev || at > prev.at || (at === prev.at && account < prev.account)) {
      latest.set(t.financialItemId, { at, account });
    }
  }
  const [fallback] = [...rowVolume.keys()].sort((a, b) =>
    (debitVolume.get(b) ?? 0) - (debitVolume.get(a) ?? 0) ||
    (rowVolume.get(b) ?? 0) - (rowVolume.get(a) ?? 0) ||
    a.localeCompare(b));
  return new Map(liveItems.map((i) => [i.id, latest.get(i.id)?.account ?? fallback ?? ""]));
}

/** A line's cadence amount expressed per month, in integer cents. */
function monthlyFromCadence(line: IncomeLine): number {
  switch (line.cadence) {
    // 52 payments spread over 12 months — not 4, which would understate a
    // weekly leefgeld by roughly a month a year.
    case "weekly": return Math.trunc((line.typicalAmountCents * 52) / 12);
    case "monthly": return line.typicalAmountCents;
    case "quarterly": return Math.trunc(line.typicalAmountCents / 3);
    case "yearly": return Math.trunc(line.typicalAmountCents / 12);
  }
}

/** The disclosure needs the row's identity and nothing else; the rest stays server-side. */
const disclosedRow = (t: MoneyTx): DisclosedRow => ({
  id: t.id, bookedAt: t.bookedAt, amountCents: t.amountCents,
  counterpartyName: t.counterpartyName,
});

/** Oldest first, id breaking the tie: a list under a chart must not reshuffle between reads. */
const byBookedAtThenId = (a: DisclosedRow, b: DisclosedRow) =>
  a.bookedAt.getTime() - b.bookedAt.getTime() || a.id.localeCompare(b.id);

/**
 * One series per account. Accounts are never merged: under bewind the same
 * person's money moves between a beheerrekening and a leefgeldrekening, and a
 * single stream would draw a collapse at the handover that never happened.
 * Rows with no account (PayPal, unreadable rows) form their own series.
 */
export function buildMoneySeries(input: {
  transactions: MoneyTx[]; items: MoneyItem[]; horizonMonths?: number;
}): AccountSeries[] {
  const horizon = input.horizonMonths ?? DEFAULT_HORIZON_MONTHS;
  const byAccount = new Map<string, MoneyTx[]>();
  for (const t of input.transactions) {
    const key = accountKeyOf(t);
    // Push, never rebuild: copying the bucket per row is O(n²), and three years
    // of statements is the load this page was designed for.
    const bucket = byAccount.get(key);
    if (bucket) bucket.push(t);
    else byAccount.set(key, [t]);
  }

  // Contracted costs are projected onto the account that pays them, once. An
  // account that pays no contract projects zero costs, not the registry total.
  const liveItems = input.items.filter((i) => i.status !== "canceled");
  const itemAccount = accountOfItems(input.transactions, liveItems);
  const projectedOutByAccount = new Map<string, { out: number; afterCancel: number }>();
  for (const item of liveItems) {
    const key = itemAccount.get(item.id) ?? "";
    const bucket = projectedOutByAccount.get(key) ?? { out: 0, afterCancel: 0 };
    bucket.out += item.monthlyCents;
    if (item.status !== "to-cancel") bucket.afterCancel += item.monthlyCents;
    projectedOutByAccount.set(key, bucket);
  }

  const series: AccountSeries[] = [];
  for (const [accountKey, txs] of byAccount) {
    // The x-axis comes from the rows that could be READ. An import error is
    // stored with the moment of import, not the booking it failed to parse, so
    // one unreadable line otherwise stretches this account's chart from the
    // statement to today: months of hatched emptiness that never happened, on
    // a page about whether the money is enough. An account with nothing BUT
    // unreadable rows keeps its import-dated range — a failed import must be
    // visible, not silently absent.
    const dated = txs.filter((t) => !t.parseError);
    const monthsPresent = [
      ...new Set((dated.length > 0 ? dated : txs).map((t) => monthKey(t.bookedAt))),
    ].sort();
    const months = monthRange(monthsPresent[0], monthsPresent[monthsPresent.length - 1]);
    const coverage = coverageForMonths(txs, months);
    const outByMonth = outSeries(txs, input.items);
    const lines = incomeLines(txs);
    const { internal } = splitInternalTransfers(txs);
    const countedIn = new Set(lines.flatMap((l) => l.transactionIds));

    const monthSeries: MonthSeries[] = months.map((month) => {
      const rows = txs.filter((t) => monthKey(t.bookedAt) === month);
      const outByCategory = outByMonth.get(month) ?? [];
      // Disclosed, never counted: vakantiegeld, a 13e maand, an OpsMate
      // invoice, and money that only moved between Martin's own accounts. The
      // footnote is how the month still reconciles — so the TOTALS are summed
      // from these lists rather than filtered a second time. Two predicates
      // for one figure is how a disclosure quietly stops adding up.
      const incidental = rows.filter((t) =>
        !t.parseError && t.amountCents > 0 && !countedIn.has(t.id) && !internal.has(t.id));
      const internalRows = rows.filter((t) => internal.has(t.id));
      return {
        month,
        coverage: coverage.get(month) ?? "none",
        inCents: rows.filter((t) => countedIn.has(t.id))
          .reduce((s, t) => s + t.amountCents, 0),
        outCents: outByCategory.reduce((s, c) => s + c.cents, 0),
        outByCategory,
        incidentalCents: incidental.reduce((s, t) => s + t.amountCents, 0),
        internalCents: internalRows.reduce((s, t) => s + t.amountCents, 0),
        internalRows: internalRows.map(disclosedRow).sort(byBookedAtThenId),
        incidentalRows: incidental.map(disclosedRow).sort(byBookedAtThenId),
        parseErrorRows: rows.filter((t) => t.parseError).length,
      };
    });

    const lastCompleteMonth =
      [...monthSeries].reverse().find((m) => m.coverage === "complete")?.month ?? null;

    const projected: ProjectedMonth[] = [];
    if (lastCompleteMonth) {
      // A line with nothing in the last complete month has stopped: a job that
      // ended must not keep paying on a chart.
      const active = lines.filter((l) => monthKey(l.lastAt) >= lastCompleteMonth);
      const inCents = active.reduce((s, l) => s + monthlyFromCadence(l), 0);
      const out = projectedOutByAccount.get(accountKey) ?? { out: 0, afterCancel: 0 };
      for (let n = 1; n <= horizon; n++) {
        projected.push({
          month: addMonths(lastCompleteMonth, n),
          inCents,
          outCents: out.out,
          outAfterCancelCents: out.afterCancel,
        });
      }
    }

    series.push({
      accountIban: accountKey === "" ? null : accountKey,
      months: monthSeries, projected, incomeLines: lines, lastCompleteMonth,
    });
  }
  return series.sort((a, b) => (a.accountIban ?? "").localeCompare(b.accountIban ?? ""));
}
