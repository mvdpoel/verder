import { describe, expect, it } from "vitest";
import { decimalToCents } from "./money";

describe("decimalToCents", () => {
  it("parses comma-decimal (NL)", () => {
    expect(decimalToCents("142,80")).toBe(14280);
    expect(decimalToCents("0,50")).toBe(50);
    expect(decimalToCents("0,5")).toBe(50);
  });

  it("parses dot-decimal", () => {
    expect(decimalToCents("142.80")).toBe(14280);
    expect(decimalToCents("13.9")).toBe(1390);
  });

  it("parses signed amounts", () => {
    expect(decimalToCents("-13,99")).toBe(-1399);
    expect(decimalToCents("-1234.56")).toBe(-123456);
    expect(decimalToCents("+10,00")).toBe(1000);
  });

  it("parses NL thousands separator", () => {
    expect(decimalToCents("1.234,56")).toBe(123456);
    expect(decimalToCents("-1.234,56")).toBe(-123456);
    expect(decimalToCents("12.345.678,90")).toBe(1234567890);
  });

  it("parses US thousands separator", () => {
    expect(decimalToCents("1,234.56")).toBe(123456);
  });

  it("parses bare integers", () => {
    expect(decimalToCents("142")).toBe(14200);
    expect(decimalToCents("-3")).toBe(-300);
    expect(decimalToCents("0")).toBe(0);
  });

  it("treats a lone 3-digit tail as thousands grouping", () => {
    expect(decimalToCents("1.234")).toBe(123400);
    expect(decimalToCents("12,345")).toBe(1234500);
  });

  it("is exact where float math would drift", () => {
    // 19.99 * 100 === 1998.9999999999998 in float land
    expect(decimalToCents("19,99")).toBe(1999);
    expect(decimalToCents("0,29")).toBe(29);
    expect(decimalToCents("4,35")).toBe(435);
  });

  it("throws on garbage", () => {
    for (const bad of [
      "",
      "  ",
      "abc",
      "12,3a",
      "12.3.4",
      "1,23,45",
      "12,",
      ",50",
      "1.2345",
      "--5",
      "12,3456",
      "1.23.456,00",
      "€ 12,00",
    ]) {
      expect(() => decimalToCents(bad), `should throw: ${JSON.stringify(bad)}`).toThrow();
    }
  });
});
