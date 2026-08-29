import { describe, expect, it } from "vitest";
import { formatEuro } from "./registry-list";

describe("formatEuro", () => {
  it("says an unknown amount is unknown, never € 0,00", () => {
    // The KvK aanmaning states no total. Rendering nothing as zero would put a
    // number in front of Martin that no creditor ever claimed.
    expect(formatEuro(null)).toBe("amount unknown");
  });

  it("still formats a real amount", () => {
    // The existing format is €2623.15 (dot separators, no thousands grouping)
    // — ~20 call sites across five pages, including the signed printable
    // export, already depend on it. Changing the separator style is out of
    // scope for this task; this asserts the real format, not the one the
    // brief guessed at.
    expect(formatEuro(262315)).toContain("2623.15");
  });

  it("formats a genuine zero as zero", () => {
    expect(formatEuro(0)).toContain("0.00");
  });
});
