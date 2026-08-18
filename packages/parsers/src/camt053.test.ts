import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCamt053 } from "./camt053";
import { detectSource } from "./types";

const fixture = readFileSync(new URL("../fixtures/abn.camt053.xml", import.meta.url));

describe("parseCamt053", () => {
  const result = parseCamt053(fixture);

  it("yields one row per TxDtls (a batched Ntry fans out) and lists errors instead of throwing", () => {
    expect(result.rows).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
  });

  it("parses a direct-debit debit entry with mandate id", () => {
    const row = result.rows[0];
    expect(row.rowIndex).toBe(0);
    expect(row.amountCents).toBe(-14280); // DBIT → negative
    expect(row.bookedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(row.counterpartyName).toBe("Vattenfall Klantenservice N.V.");
    expect(row.counterpartyIban).toBe("NL91ABNA0417164300");
    expect(row.mandateId).toBe("VF-000123456");
    expect(row.description).toBe("Termijnbedrag juli 2026");
  });

  it("parses a credit (refund) with debtor-side counterparty and joins Ustrd array", () => {
    const row = result.rows[1];
    expect(row.rowIndex).toBe(1);
    expect(row.amountCents).toBe(1399); // CRDT → positive
    expect(row.counterpartyName).toBe("Bol.com B.V.");
    expect(row.counterpartyIban).toBe("NL12INGB0001234567");
    expect(row.mandateId).toBeNull();
    expect(row.description).toBe("Retour bestelling 2026123456 Klantnummer 998877");
  });

  it("splits a batched entry into one row per TxDtls using the TxAmt amounts", () => {
    const apple = result.rows[2];
    expect(apple.rowIndex).toBe(2);
    expect(apple.amountCents).toBe(-1299);
    expect(apple.counterpartyName).toBe("APPLE.COM/BILL");
    expect(apple.counterpartyIban).toBe("IE12BOFI90000112345678");
    expect(apple.mandateId).toBe("APPLE-0001");

    const paypal = result.rows[3];
    expect(paypal.rowIndex).toBe(3);
    expect(paypal.amountCents).toBe(-1299);
    expect(paypal.counterpartyName).toBe("PayPal Europe S.a r.l. et Cie S.C.A");
    expect(paypal.counterpartyIban).toBeNull();
    expect(paypal.bookedAt.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("reports non-EUR entries as errors with their rowIndex, not rows", () => {
    const err = result.errors[0];
    expect(err.rowIndex).toBe(4);
    expect(err.message).toMatch(/currency|EUR/i);
    expect(err.raw).toContain("USD");
  });

  it("throws loudly on a file that is not CAMT.053 at all", () => {
    expect(() => parseCamt053(Buffer.from("this is not xml"))).toThrow();
  });
});

describe("detectSource (camt053)", () => {
  it("detects by content sniff regardless of filename", () => {
    expect(detectSource("statement.xml", fixture.subarray(0, 512))).toBe("abn-camt053");
    expect(detectSource("export.dat", fixture.subarray(0, 512))).toBe("abn-camt053");
  });
});
