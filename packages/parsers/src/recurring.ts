import type { ParsedRow, StatementSource } from "./types";

/**
 * Recurring-charge detection over imported statement rows. Pure code, no AI:
 * groups debits by mandate ▸ counterparty IBAN ▸ normalized name, then keeps
 * groups with ≥2 charges, a stable cadence (day-drift tolerated), and similar
 * amounts (unless a direct-debit mandate proves identity — energy bills vary).
 */
export interface RecurringCandidate {
  /** mandateId ?? iban ?? normalized name */
  key: string;
  groupBy: "mandate" | "iban" | "name";
  counterpartyName: string | null;
  counterpartyIban: string | null;
  mandateId: string | null;
  cadence: "monthly" | "quarterly" | "yearly";
  /** median of the group's amounts, integer cents — negative in the debit direction, positive in the credit direction */
  typicalAmountCents: number;
  chargeCount: number;
  firstAt: Date;
  lastAt: Date;
  transactionIds: string[];
  /** APPLE.COM/BILL name match, or a PayPal counterparty on a bank-sourced row */
  aggregator: "apple" | "paypal" | null;
}

/**
 * Rows may optionally carry their statement `source`; it is only used to keep
 * paypal-csv rows from being mistaken for the PayPal aggregate line a bank
 * statement shows. Rows without a source are treated as bank-sourced.
 */
type InputTx = ParsedRow & { id: string; source?: StatementSource };

const DAY_MS = 86_400_000;

/** Lowercase, strip digits and punctuation, collapse whitespace runs. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Middle element; for an even count, the mean of the middle two truncated toward zero (stays integer cents). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.trunc((sorted[mid - 1] + sorted[mid]) / 2);
}

function cadenceOf(medianGapDays: number): RecurringCandidate["cadence"] | null {
  if (medianGapDays >= 25 && medianGapDays <= 35) return "monthly";
  if (medianGapDays >= 80 && medianGapDays <= 100) return "quarterly";
  if (medianGapDays >= 350 && medianGapDays <= 380) return "yearly";
  return null;
}

export interface DetectRecurringOptions {
  /**
   * Which side to group. Debits are charges (the default, and what every
   * caller before the money page wanted); credits are income. Defaults to
   * "debit" so existing callers cannot change behaviour by accident.
   */
  direction?: "debit" | "credit";
}

export function detectRecurring(
  txs: InputTx[],
  opts: DetectRecurringOptions = {}
): RecurringCandidate[] {
  const wantCredits = opts.direction === "credit";
  // One side only: a refund must never skew a charge group, and a charge must
  // never skew an income line.
  const charges = txs.filter((t) => (wantCredits ? t.amountCents > 0 : t.amountCents < 0));

  const groups = new Map<
    string,
    { groupBy: RecurringCandidate["groupBy"]; key: string; rows: InputTx[] }
  >();
  for (const t of charges) {
    let groupBy: RecurringCandidate["groupBy"];
    let key: string;
    if (t.mandateId) {
      groupBy = "mandate";
      key = t.mandateId;
    } else if (t.counterpartyIban) {
      groupBy = "iban";
      key = t.counterpartyIban;
    } else if (t.counterpartyName) {
      key = normalizeName(t.counterpartyName);
      if (!key) continue;
      groupBy = "name";
    } else {
      continue; // nothing to group on
    }
    const mapKey = `${groupBy}:${key}`;
    const group = groups.get(mapKey);
    if (group) group.rows.push(t);
    else groups.set(mapKey, { groupBy, key, rows: [t] });
  }

  const candidates: RecurringCandidate[] = [];
  for (const { groupBy, key, rows } of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort(
      (a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || a.id.localeCompare(b.id)
    );

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].bookedAt.getTime() - sorted[i - 1].bookedAt.getTime()) / DAY_MS);
    }
    const cadence = cadenceOf(median(gaps));
    if (!cadence) continue;

    const amounts = sorted.map((r) => r.amountCents);
    const typicalAmountCents = median(amounts);
    if (groupBy !== "mandate") {
      // every charge within 40% of the median (integer math: |a−m|/|m| ≤ 4/10)
      const ok = amounts.every(
        (a) => Math.abs(a - typicalAmountCents) * 10 <= Math.abs(typicalAmountCents) * 4
      );
      if (!ok) continue;
    }

    const last = sorted[sorted.length - 1];
    const counterpartyName =
      last.counterpartyName ??
      sorted.find((r) => r.counterpartyName !== null)?.counterpartyName ??
      null;
    const counterpartyIban =
      last.counterpartyIban ??
      sorted.find((r) => r.counterpartyIban !== null)?.counterpartyIban ??
      null;
    const mandateId = groupBy === "mandate" ? key : null;

    let aggregator: RecurringCandidate["aggregator"] = null;
    if (sorted.some((r) => r.counterpartyName && /apple\.com\/bill/i.test(r.counterpartyName))) {
      aggregator = "apple";
    } else if (
      sorted.some(
        (r) =>
          r.counterpartyName &&
          /paypal/i.test(r.counterpartyName) &&
          r.source !== "paypal-csv" // bank-sourced (or unknown-source) rows only
      )
    ) {
      aggregator = "paypal";
    }

    candidates.push({
      key,
      groupBy,
      counterpartyName,
      counterpartyIban,
      mandateId,
      cadence,
      typicalAmountCents,
      chargeCount: sorted.length,
      firstAt: sorted[0].bookedAt,
      lastAt: last.bookedAt,
      transactionIds: sorted.map((r) => r.id),
      aggregator,
    });
  }

  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return candidates;
}
