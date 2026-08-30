import { describe, expect, it } from "vitest";
import { formatEuro } from "./registry-list";

describe("formatEuro", () => {
  it("says an unknown amount is unknown, never € 0,00", () => {
    // The KvK aanmaning states no total. Rendering nothing as zero would put a
    // number in front of Martin that no creditor ever claimed.
    expect(formatEuro(null)).toBe("bedrag onbekend");
  });

  it("writes money the way the rest of the app does", () => {
    // This used to assert "2623.15" — an English decimal point and no thousands
    // grouping — while /money wrote the same amount as "€ 2.623,15". The two
    // formatters have been merged onto `euro()`, so the registry, the dashboard
    // and the signed export now agree with the chart.
    expect(formatEuro(262315)).toBe("€ 2.623,15");
  });

  it("formats a genuine zero as zero", () => {
    expect(formatEuro(0)).toBe("€ 0,00");
  });

  it("keeps a negative amount negative", () => {
    expect(formatEuro(-500)).toBe("−€ 5,00");
  });
});
