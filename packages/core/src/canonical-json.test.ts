import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } }))
      .toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it("is stable regardless of key insertion order", () => {
    const one = canonicalJson({ a: 1, b: 2 });
    const two = canonicalJson({ b: 2, a: 1 });
    expect(one).toBe(two);
  });
  it("rejects undefined and NaN", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});
