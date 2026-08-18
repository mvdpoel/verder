import { describe, expect, it } from "vitest";
import { detectRecurring, normalizeName } from "./recurring";
import type { ParsedRow, StatementSource } from "./types";

type Tx = ParsedRow & { id: string; source?: StatementSource };

let seq = 0;
function tx(
  bookedAt: string,
  amountCents: number,
  opts: {
    id?: string;
    name?: string;
    iban?: string;
    mandate?: string;
    source?: StatementSource;
  } = {}
): Tx {
  return {
    id: opts.id ?? `tx-${++seq}`,
    rowIndex: 0,
    bookedAt: new Date(bookedAt),
    amountCents,
    counterpartyName: opts.name ?? null,
    counterpartyIban: opts.iban ?? null,
    description: null,
    mandateId: opts.mandate ?? null,
    ...(opts.source ? { source: opts.source } : {}),
  };
}

describe("normalizeName", () => {
  it("lowercases, strips digits and punctuation, collapses whitespace runs", () => {
    expect(normalizeName("Ziggo Services B.V. 12345")).toBe("ziggo services bv");
    expect(normalizeName("ZIGGO   SERVICES BV")).toBe("ziggo services bv");
    expect(normalizeName("  Eneco - Zakelijk 2026  ")).toBe("eneco zakelijk");
  });
});

describe("detectRecurring — cadence", () => {
  it("detects monthly despite day drift (28th/30th/1st)", () => {
    const iban = "NL91ABNA0417164300";
    const txs = [
      tx("2026-01-28", -1499, { iban, name: "Ziggo Services BV" }),
      tx("2026-02-28", -1499, { iban, name: "Ziggo Services BV" }), // 31d
      tx("2026-03-30", -1499, { iban, name: "Ziggo Services BV" }), // 30d
      tx("2026-05-01", -1499, { iban, name: "Ziggo Services BV" }), // 32d
    ];
    const out = detectRecurring(txs);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.cadence).toBe("monthly");
    expect(c.groupBy).toBe("iban");
    expect(c.key).toBe(iban);
    expect(c.counterpartyIban).toBe(iban);
    expect(c.counterpartyName).toBe("Ziggo Services BV");
    expect(c.mandateId).toBeNull();
    expect(c.chargeCount).toBe(4);
    expect(c.typicalAmountCents).toBe(-1499);
    expect(c.firstAt.toISOString()).toBe("2026-01-28T00:00:00.000Z");
    expect(c.lastAt.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(c.transactionIds).toEqual(txs.map((t) => t.id));
    expect(c.aggregator).toBeNull();
  });

  it("detects quarterly (gaps 88d/92d)", () => {
    const iban = "NL02RABO0123456789";
    const out = detectRecurring([
      tx("2026-01-05", -12000, { iban, name: "Verzekeraar" }),
      tx("2026-04-03", -12000, { iban, name: "Verzekeraar" }),
      tx("2026-07-04", -12000, { iban, name: "Verzekeraar" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cadence).toBe("quarterly");
  });

  it("detects yearly (365d gap)", () => {
    const out = detectRecurring([
      tx("2025-06-01", -9900, { name: "Domeinregistrar" }),
      tx("2026-06-01", -9900, { name: "Domeinregistrar" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cadence).toBe("yearly");
    expect(out[0].groupBy).toBe("name");
  });

  it("rejects cadences outside all tolerance windows", () => {
    // weekly-ish (7d) and a 50d median must both be rejected
    expect(
      detectRecurring([
        tx("2026-01-01", -500, { name: "Snackbar" }),
        tx("2026-01-08", -500, { name: "Snackbar" }),
        tx("2026-01-15", -500, { name: "Snackbar" }),
      ])
    ).toHaveLength(0);
    expect(
      detectRecurring([
        tx("2026-01-01", -500, { name: "Grillroom" }),
        tx("2026-02-20", -500, { name: "Grillroom" }),
      ])
    ).toHaveLength(0);
  });

  it("never produces a candidate from fewer than 2 charges", () => {
    expect(detectRecurring([tx("2026-01-01", -999, { name: "Solo" })])).toHaveLength(0);
    // a refund does not count as a second charge
    expect(
      detectRecurring([
        tx("2026-01-01", -999, { name: "Solo" }),
        tx("2026-02-01", 999, { name: "Solo" }),
      ])
    ).toHaveLength(0);
    expect(detectRecurring([])).toHaveLength(0);
  });
});

describe("detectRecurring — amounts", () => {
  it("accepts amount drift within 40% of the median", () => {
    const out = detectRecurring([
      tx("2026-01-01", -1000, { name: "Eneco" }),
      tx("2026-02-01", -1300, { name: "Eneco" }),
      tx("2026-03-01", -1400, { name: "Eneco" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].typicalAmountCents).toBe(-1300);
  });

  it("rejects a non-mandate group when any charge drifts beyond 40% of the median", () => {
    const out = detectRecurring([
      tx("2026-01-01", -1000, { name: "Eneco" }),
      tx("2026-02-01", -1300, { name: "Eneco" }),
      tx("2026-03-01", -2000, { name: "Eneco" }), // 700 > 40% of 1300
    ]);
    expect(out).toHaveLength(0);
  });

  it("an identical mandate overrides the amount rule (energy bills vary)", () => {
    const out = detectRecurring([
      tx("2026-01-01", -1000, { name: "Eneco", mandate: "MND-001" }),
      tx("2026-02-01", -1300, { name: "Eneco", mandate: "MND-001" }),
      tx("2026-03-01", -9000, { name: "Eneco", mandate: "MND-001" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].groupBy).toBe("mandate");
    expect(out[0].key).toBe("MND-001");
    expect(out[0].mandateId).toBe("MND-001");
    expect(out[0].typicalAmountCents).toBe(-1300);
  });

  it("computes an integer median for an even number of charges", () => {
    const out = detectRecurring([
      tx("2026-01-01", -999, { name: "Middel" }),
      tx("2026-02-01", -1001, { name: "Middel" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].typicalAmountCents).toBe(-1000);
    expect(Number.isInteger(out[0].typicalAmountCents)).toBe(true);
  });

  it("excludes refunds from count, typical amount, and evidence", () => {
    const refund = tx("2026-02-15", 999, { name: "Netflix", id: "tx-refund" });
    const charges = [
      tx("2026-01-01", -999, { name: "Netflix" }),
      tx("2026-02-01", -999, { name: "Netflix" }),
      tx("2026-03-01", -999, { name: "Netflix" }),
    ];
    const out = detectRecurring([charges[0], refund, charges[1], charges[2]]);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.chargeCount).toBe(3);
    expect(c.typicalAmountCents).toBe(-999);
    expect(c.transactionIds).toEqual(charges.map((t) => t.id));
    expect(c.transactionIds).not.toContain("tx-refund");
  });
});

describe("detectRecurring — grouping", () => {
  it("prefers mandate over IBAN over name", () => {
    const out = detectRecurring([
      tx("2026-01-01", -500, { name: "KPN", iban: "NL91ABNA0417164300", mandate: "M-9" }),
      tx("2026-02-01", -500, { name: "KPN", iban: "NL91ABNA0417164300", mandate: "M-9" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].groupBy).toBe("mandate");
    expect(out[0].key).toBe("M-9");
    expect(out[0].counterpartyIban).toBe("NL91ABNA0417164300");
  });

  it("groups by normalized name when mandate and IBAN are absent", () => {
    const out = detectRecurring([
      tx("2026-01-01", -1099, { name: "Ziggo Services B.V. 123" }),
      tx("2026-02-01", -1099, { name: "ZIGGO SERVICES BV" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].groupBy).toBe("name");
    expect(out[0].key).toBe("ziggo services bv");
    expect(out[0].chargeCount).toBe(2);
  });

  it("skips rows with no mandate, IBAN, or name without crashing", () => {
    expect(
      detectRecurring([tx("2026-01-01", -500), tx("2026-02-01", -500)])
    ).toHaveLength(0);
  });

  it("returns multiple candidates sorted deterministically by key", () => {
    const txs = [
      tx("2026-01-01", -500, { name: "Bbb" }),
      tx("2026-02-01", -500, { name: "Bbb" }),
      tx("2026-01-01", -700, { name: "Aaa" }),
      tx("2026-02-01", -700, { name: "Aaa" }),
    ];
    const out = detectRecurring(txs);
    expect(out.map((c) => c.key)).toEqual(["aaa", "bbb"]);
    // input order must not matter
    const reversed = detectRecurring([...txs].reverse());
    expect(reversed.map((c) => c.key)).toEqual(["aaa", "bbb"]);
  });
});

describe("detectRecurring — aggregators", () => {
  it("flags APPLE.COM/BILL as apple", () => {
    const out = detectRecurring([
      tx("2026-01-05", -299, { name: "APPLE.COM/BILL", iban: "IE12BOFI90000112345678" }),
      tx("2026-02-05", -299, { name: "APPLE.COM/BILL", iban: "IE12BOFI90000112345678" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].aggregator).toBe("apple");
  });

  it("flags a PayPal counterparty on a bank-sourced row as paypal", () => {
    const out = detectRecurring([
      tx("2026-01-03", -1250, {
        name: "PayPal Europe S.a.r.l. et Cie S.C.A",
        source: "abn-camt053",
      }),
      tx("2026-02-03", -1250, {
        name: "PayPal Europe S.a.r.l. et Cie S.C.A",
        source: "abn-camt053",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].aggregator).toBe("paypal");
  });

  it("treats rows without a source as bank-sourced for the paypal rule", () => {
    const out = detectRecurring([
      tx("2026-01-03", -1250, { name: "PayPal Europe S.a.r.l." }),
      tx("2026-02-03", -1250, { name: "PayPal Europe S.a.r.l." }),
    ]);
    expect(out[0].aggregator).toBe("paypal");
  });

  it("does not flag paypal-csv rows as the paypal aggregate line", () => {
    const out = detectRecurring([
      tx("2026-01-03", -1399, { name: "Spotify AB", source: "paypal-csv" }),
      tx("2026-02-03", -1399, { name: "Spotify AB", source: "paypal-csv" }),
    ]);
    expect(out[0].aggregator).toBeNull();

    const fee = detectRecurring([
      tx("2026-01-03", -100, { name: "PayPal Fee", source: "paypal-csv" }),
      tx("2026-02-03", -100, { name: "PayPal Fee", source: "paypal-csv" }),
    ]);
    expect(fee[0].aggregator).toBeNull();
  });

  it("leaves ordinary counterparties unflagged", () => {
    const out = detectRecurring([
      tx("2026-01-01", -999, { name: "Netflix International BV", source: "abn-tsv" }),
      tx("2026-02-01", -999, { name: "Netflix International BV", source: "abn-tsv" }),
    ]);
    expect(out[0].aggregator).toBeNull();
  });
});
