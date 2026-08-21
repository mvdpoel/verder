import { describe, expect, it } from "vitest";
import { DASHBOARD_MONTHS, dashboardMoneySlice } from "./dashboard-money-slice";

type M = { month: string; inCents: number; outCents: number };
const month = (m: string, inCents = 0, outCents = 0): M => ({ month: m, inCents, outCents });

const account = (accountIban: string | null, months: M[]) => ({ accountIban, months });

describe("dashboardMoneySlice", () => {
  it("has nothing to show when there is no series at all", () => {
    expect(dashboardMoneySlice([])).toBeNull();
  });

  it("keeps only the newest six months, in order", () => {
    const s = account("NL01", [
      month("2026-01"), month("2026-02"), month("2026-03"), month("2026-04"),
      month("2026-05"), month("2026-06"), month("2026-07"), month("2026-08"),
    ]);
    const slice = dashboardMoneySlice([s]);
    expect(slice?.months.map((m) => m.month)).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    expect(DASHBOARD_MONTHS).toBe(6);
  });

  it("shows every month when the account has fewer than six", () => {
    const slice = dashboardMoneySlice([account("NL01", [month("2026-07"), month("2026-08")])]);
    expect(slice?.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
  });

  it("picks the account with the newest data, not the one with the longest history", () => {
    // The bewind handover: a long-running beheerrekening that VerderGroep took
    // over, and a leefgeldrekening that only started in August. The dashboard
    // shows where the money is now.
    const beheer = account("NL01", [
      month("2026-01", 300_000), month("2026-02", 300_000), month("2026-03", 300_000),
      month("2026-04", 300_000), month("2026-05", 300_000), month("2026-06", 300_000),
      month("2026-07", 300_000),
    ]);
    const leefgeld = account("NL02", [month("2026-08", 40_000)]);
    expect(dashboardMoneySlice([beheer, leefgeld])?.accountIban).toBe("NL02");
    expect(dashboardMoneySlice([leefgeld, beheer])?.accountIban).toBe("NL02");
  });

  it("breaks a tie on money moved, so the handover month shows the busier account", () => {
    // Both accounts have August rows. The one the salary and the fixed costs
    // actually run through is the one worth six months of dashboard space.
    const beheer = account("NL01", [month("2026-08", 300_000, 210_000)]);
    const leefgeld = account("NL02", [month("2026-08", 40_000, 38_000)]);
    expect(dashboardMoneySlice([leefgeld, beheer])?.accountIban).toBe("NL01");
    expect(dashboardMoneySlice([beheer, leefgeld])?.accountIban).toBe("NL01");
  });

  it("is deterministic when two accounts moved exactly the same money", () => {
    const a = account("NL01", [month("2026-08", 100_000, 0)]);
    const b = account("NL02", [month("2026-08", 100_000, 0)]);
    expect(dashboardMoneySlice([a, b])?.accountIban).toBe("NL01");
    expect(dashboardMoneySlice([b, a])?.accountIban).toBe("NL01");
  });

  it("can land on the unknown account, and never crashes on its null iban", () => {
    const unknown = account(null, [month("2026-08", 100_000, 0)]);
    const known = account("NL01", [month("2026-07", 900_000, 0)]);
    expect(dashboardMoneySlice([known, unknown])?.accountIban).toBeNull();
  });

  it("ignores an account with no months rather than choosing it", () => {
    const empty = account("NL09", []);
    const real = account("NL01", [month("2026-08", 100_000, 0)]);
    expect(dashboardMoneySlice([empty, real])?.accountIban).toBe("NL01");
    expect(dashboardMoneySlice([empty])).toBeNull();
  });
});
