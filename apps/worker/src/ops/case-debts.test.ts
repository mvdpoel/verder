import { describe, expect, it } from "vitest";
import { DEBT_SEED } from "./case-debts";

describe("case debts seed", () => {
  it("names exactly one eiser for every debt", () => {
    // The eiser is who the money is owed to. A debt with none is a debt with no
    // creditor; a debt with two is almost always the intermediary miscoded.
    for (const d of DEBT_SEED) {
      const eisers = d.parties.filter((p) => p.role === "eiser");
      expect(eisers, `${d.creditorName}`).toHaveLength(1);
    }
  });

  it("gives the two intermediated debts an intermediary", () => {
    const byName = new Map(DEBT_SEED.map((d) => [d.creditorName, d]));
    expect(byName.get("PLM Investments II B.V.")!.parties
      .find((p) => p.role === "incasso")?.name).toBe("Trust and Law Incassoservices");
    expect(byName.get("Het CAK")!.parties
      .find((p) => p.role === "deurwaarder")?.name).toBe("Stam Gerechtsdeurwaarders");
  });

  it("leaves the KvK amount unknown rather than calling it zero", () => {
    const kvk = DEBT_SEED.find((d) => d.creditorName === "Kamer van Koophandel")!;
    expect(kvk.claimedCents).toBeNull();
  });

  it("records the amounts and references that the notices actually state", () => {
    const plm = DEBT_SEED.find((d) => d.creditorName === "PLM Investments II B.V.")!;
    expect(plm.claimedCents).toBe(262315);
    expect(plm.principalCents).toBe(219789);
    expect(plm.references).toBe("26TNL-001031");
    const cak = DEBT_SEED.find((d) => d.creditorName === "Het CAK")!;
    expect(cak.claimedCents).toBe(114161);
  });

  it("reuses the intermediary parties the case already has, by exact name", () => {
    // Trust and Law and Stam are already in `parties` from PARTY_SEED. A name
    // that does not match theirs creates a second row for the same firm.
    const names = DEBT_SEED.flatMap((d) => d.parties.map((p) => p.name));
    expect(names).toContain("Trust and Law Incassoservices");
    expect(names).toContain("Stam Gerechtsdeurwaarders");
  });
});
