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

/** Minimal CAMT.053 document wrapper for hand-built Ntry snippets. */
function doc(ntries: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt><Stmt><Id>TEST</Id>${ntries}</Stmt></BkToCstmrStmt>
</Document>`
  );
}

const batchedEntry = (middleTxAmt: string) => `
  <Ntry>
    <Amt Ccy="EUR">30.00</Amt>
    <CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2026-07-01</Dt></BookgDt>
    <NtryDtls>
      <TxDtls>
        <AmtDtls><TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt></AmtDtls>
        <RltdPties><Cdtr><Nm>Alpha</Nm></Cdtr></RltdPties>
      </TxDtls>
      <TxDtls>
        <AmtDtls><TxAmt>${middleTxAmt}</TxAmt></AmtDtls>
        <RltdPties><Cdtr><Nm>Bravo</Nm></Cdtr></RltdPties>
      </TxDtls>
      <TxDtls>
        <AmtDtls><TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt></AmtDtls>
        <RltdPties><Cdtr><Nm>Charlie</Nm></Cdtr></RltdPties>
      </TxDtls>
    </NtryDtls>
  </Ntry>`;

describe("parseCamt053 per-TxDtls error isolation", () => {
  it("keeps valid TxDtls after a bad one in the same batched entry (non-EUR middle)", () => {
    const result = parseCamt053(doc(batchedEntry(`<Amt Ccy="USD">10.00</Amt>`)));
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.counterpartyName)).toEqual(["Alpha", "Charlie"]);
    expect(result.rows.map((r) => r.amountCents)).toEqual([-1000, -1000]);
    expect(result.rows.map((r) => r.rowIndex)).toEqual([0, 2]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rowIndex).toBe(1);
    expect(result.errors[0].message).toMatch(/currency|EUR/i);
  });

  it("leaves no rowIndex hole when a garbage TxAmt fails mid-entry", () => {
    const result = parseCamt053(doc(batchedEntry(`<Amt Ccy="EUR">kapot</Amt>`)));
    expect(result.rows.map((r) => r.rowIndex)).toEqual([0, 2]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rowIndex).toBe(1); // consumed by the failed TxDtls, not skipped
    const used = [...result.rows.map((r) => r.rowIndex), ...result.errors.map((e) => e.rowIndex)];
    expect([...used].sort((a, b) => a - b)).toEqual([0, 1, 2]); // contiguous
  });

  it("still reports an entry-level failure (bad CdtDbtInd) as a single error", () => {
    const result = parseCamt053(
      doc(
        `<Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>WAT</CdtDbtInd><BookgDt><Dt>2026-07-01</Dt></BookgDt></Ntry>`
      )
    );
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/CdtDbtInd/);
  });

  it("routes rolled-over booking dates (2026-02-31) to errors, not rows", () => {
    const result = parseCamt053(
      doc(
        `<Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-02-31</Dt></BookgDt></Ntry>`
      )
    );
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/BookgDt/);
  });
});

describe("parseCamt053 entry-amount fallback", () => {
  const noTxAmtBatch = `
  <Ntry>
    <Amt Ccy="EUR">30.00</Amt>
    <CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2026-07-01</Dt></BookgDt>
    <NtryDtls>
      <TxDtls><RltdPties><Cdtr><Nm>Alpha</Nm></Cdtr></RltdPties></TxDtls>
      <TxDtls><RltdPties><Cdtr><Nm>Bravo</Nm></Cdtr></RltdPties></TxDtls>
    </NtryDtls>
  </Ntry>`;

  it("never fans the entry Amt out over multiple TxDtls (would double-count)", () => {
    const result = parseCamt053(doc(noTxAmtBatch));
    expect(result.rows).toHaveLength(0); // NOT two rows of -3000 each
    expect(result.errors).toHaveLength(2); // each unattributable TxDtls gets its own error
    expect(result.errors.map((e) => e.rowIndex)).toEqual([0, 1]);
    for (const err of result.errors) expect(err.message).toMatch(/TxAmt/);
  });

  it("still uses the entry Amt when there is exactly one TxDtls without TxAmt", () => {
    const result = parseCamt053(
      doc(
        `<Ntry><Amt Ccy="EUR">30.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-07-01</Dt></BookgDt>
         <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Solo</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>`
      )
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].amountCents).toBe(-3000);
    expect(result.errors).toHaveLength(0);
  });
});

describe("detectSource (camt053)", () => {
  it("detects by content sniff regardless of filename", () => {
    expect(detectSource("statement.xml", fixture.subarray(0, 512))).toBe("abn-camt053");
    expect(detectSource("export.dat", fixture.subarray(0, 512))).toBe("abn-camt053");
  });
});
