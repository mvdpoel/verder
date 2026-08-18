import { describe, expect, it } from "vitest";
import { computeEventHash, GENESIS_HASH, sha256Hex } from "./hash";

describe("hashing", () => {
  it("sha256Hex matches known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
  it("computeEventHash is order-independent on input object", () => {
    const e = { seq: 1, eventType: "entry.created", entityType: "log_entry",
      entityId: "00000000-0000-0000-0000-000000000001",
      payloadHash: sha256Hex("p"), prevHash: GENESIS_HASH };
    expect(computeEventHash(e)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventHash({ ...e })).toBe(computeEventHash(e));
  });
  it("changes when any field changes", () => {
    const e = { seq: 1, eventType: "entry.created", entityType: "log_entry",
      entityId: "id", payloadHash: sha256Hex("p"), prevHash: GENESIS_HASH };
    expect(computeEventHash({ ...e, seq: 2 })).not.toBe(computeEventHash(e));
  });
});
