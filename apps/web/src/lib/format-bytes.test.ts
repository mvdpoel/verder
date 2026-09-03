import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("renders bytes under 1024 with a B suffix", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders a value that rounds into kB", () => {
    expect(formatBytes(2048)).toBe("2.0 kB");
  });

  it("renders a value that rounds into MB", () => {
    expect(formatBytes(2453189)).toBe("2.3 MB");
  });

  it("uses one decimal only when the value is under 10 in its unit", () => {
    expect(formatBytes(9.5 * 1024)).toBe("9.5 kB");
    expect(formatBytes(15 * 1024)).toBe("15 kB");
  });
});
