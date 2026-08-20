import { describe, expect, it } from "vitest";
import { rrfFuse, RRF_K } from "./fuse";

describe("rrfFuse", () => {
  it("sums 1/(k+rank) for an id in both lists and flags it as both", () => {
    const fused = rrfFuse(
      [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
      [{ id: "b", rank: 1 }, { id: "c", rank: 2 }]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]).toMatchObject({ id: "b", inLexical: true, inSemantic: true });
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused[1]).toMatchObject({ id: "a", inLexical: true, inSemantic: false });
    expect(fused[2]).toMatchObject({ id: "c", inLexical: false, inSemantic: true });
  });

  it("passes a lexical-only result through in rank order", () => {
    const fused = rrfFuse([{ id: "a", rank: 1 }, { id: "b", rank: 2 }, { id: "c", rank: 3 }], []);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(fused.every((f) => f.inLexical && !f.inSemantic)).toBe(true);
    expect(fused[2].score).toBeCloseTo(1 / (RRF_K + 3), 12);
  });

  it("passes a semantic-only result through in rank order", () => {
    // Ollama down is the lexical-only case; a query with no tsquery match is
    // this one. Both must return results, not an empty page.
    const fused = rrfFuse([], [{ id: "x", rank: 1 }, { id: "y", rank: 2 }]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
    expect(fused.every((f) => f.inSemantic && !f.inLexical)).toBe(true);
  });

  it("breaks ties by id ascending, whichever list an id came from", () => {
    expect(rrfFuse([{ id: "b", rank: 1 }], [{ id: "a", rank: 1 }]).map((f) => f.id))
      .toEqual(["a", "b"]);
    expect(rrfFuse([{ id: "z", rank: 2 }], [{ id: "y", rank: 2 }]).map((f) => f.id))
      .toEqual(["y", "z"]);
  });

  it("takes an explicit k", () => {
    const [only] = rrfFuse([{ id: "x", rank: 1 }], [], 1);
    expect(only.score).toBeCloseTo(0.5, 12);
  });

  it("returns an empty array for two empty lists", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
