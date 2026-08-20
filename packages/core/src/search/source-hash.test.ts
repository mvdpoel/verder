import { describe, expect, it } from "vitest";
import { sourceHash } from "./source-hash";

describe("sourceHash", () => {
  it("is stable for identical content and changes with either field", () => {
    const a = sourceHash("Ziggo", "Naam: Ziggo.");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("Ziggo", "Naam: Ziggo.")).toBe(a);
    expect(sourceHash("Ziggo", "Naam: Ziggo. Status: opgezegd.")).not.toBe(a);
    expect(sourceHash("Ziggo B.V.", "Naam: Ziggo.")).not.toBe(a);
  });

  it("cannot be forged by moving characters across the title/body boundary", () => {
    // Plain concatenation would make these two identical, and an edit that only
    // shifted the boundary would silently skip re-embedding.
    expect(sourceHash("ab", "c")).not.toBe(sourceHash("a", "bc"));
  });
});
