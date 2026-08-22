import { describe, expect, it } from "vitest";
import { ibanCheckDigits, normalizeAccount } from "./iban";

/**
 * The two notations ABN uses for ONE account, both taken from Martin's own
 * documents: the statement PDF heads it "Priverekening 56.65.67.741" and the
 * July payslip pays to "NL12ABNA0566567741". Left unnormalized, importing the
 * same account twice — once as CAMT.053, once as the Excel export — produces
 * two unrelated AccountSeries on /money: income under one, costs under the
 * other. That is the exact split the account dimension exists to prevent.
 */
describe("normalizeAccount", () => {
  it("turns ABN's legacy rekeningnummer into the official IBAN", () => {
    expect(normalizeAccount("56.65.67.741", "ABNA")).toBe("NL12ABNA0566567741");
    expect(normalizeAccount("566567741", "ABNA")).toBe("NL12ABNA0566567741");
    expect(normalizeAccount("56 65 67 741", "ABNA")).toBe("NL12ABNA0566567741");
  });

  it("leaves an IBAN alone, bar spacing and case", () => {
    expect(normalizeAccount("NL12ABNA0566567741", "ABNA")).toBe("NL12ABNA0566567741");
    expect(normalizeAccount("nl12 abna 0566 5677 41", "ABNA")).toBe("NL12ABNA0566567741");
    // A different bank's IBAN in an ABN export is still that bank's IBAN.
    expect(normalizeAccount("NL02REVO6821156565", "ABNA")).toBe("NL02REVO6821156565");
  });

  it("keeps anything it cannot convert, rather than inventing an account", () => {
    // Still a usable grouping key; it just will not match a CAMT IBAN. Better
    // than fabricating check digits for something that is not an account.
    expect(normalizeAccount("SPAARREKENING", "ABNA")).toBe("SPAARREKENING");
    expect(normalizeAccount("", "ABNA")).toBeNull();
    expect(normalizeAccount(null, "ABNA")).toBeNull();
    // 11 digits is not a Dutch account number — do not silently truncate it.
    expect(normalizeAccount("12345678901", "ABNA")).toBe("12345678901");
  });

  it("computes check digits the way the standard does", () => {
    // Verified against the payslip: NL12ABNA0566567741.
    expect(ibanCheckDigits("ABNA0566567741")).toBe("12");
    expect(ibanCheckDigits("REVO6821156565")).toBe("02");
    expect(ibanCheckDigits("RABO0312059892")).toBe("50");
  });
});
