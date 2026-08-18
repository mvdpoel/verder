import { describe, expect, it } from "vitest";
import { computeEventHash, GENESIS_HASH, sha256Hex } from "./hash";
import { verifyChain, type ChainEvent } from "./verify";

function buildChain(n: number): ChainEvent[] {
  const events: ChainEvent[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const base = { seq, eventType: "entry.created", entityType: "log_entry",
      entityId: `id-${seq}`, payloadHash: sha256Hex(`payload-${seq}`), prevHash };
    const eventHash = computeEventHash(base);
    events.push({ ...base, eventHash });
    prevHash = eventHash;
  }
  return events;
}

describe("verifyChain", () => {
  it("accepts a valid chain", async () => {
    expect(await verifyChain(buildChain(10))).toEqual({ ok: true, count: 10 });
  });
  it("accepts an empty chain", async () => {
    expect(await verifyChain([])).toEqual({ ok: true, count: 0 });
  });
  it("detects tampering with ANY field of ANY event", async () => {
    const fields = ["eventType", "entityType", "entityId", "payloadHash", "prevHash", "eventHash"] as const;
    for (let i = 0; i < 10; i++) {
      for (const f of fields) {
        const chain = buildChain(10);
        chain[i] = { ...chain[i], [f]: f === "eventType" ? "tampered" : "f".repeat(64) };
        const res = await verifyChain(chain);
        expect(res.ok, `tamper ${f}@${i} must fail`).toBe(false);
        if (!res.ok) expect(res.brokenAtSeq).toBeLessThanOrEqual(i + 2);
      }
    }
  });
  it("detects a deleted (gap) event", async () => {
    const chain = buildChain(5);
    chain.splice(2, 1);
    const res = await verifyChain(chain);
    expect(res).toMatchObject({ ok: false, reason: "gap", brokenAtSeq: 4 });
  });
  it("recomputes payload hashes when callback given", async () => {
    const chain = buildChain(3);
    const res = await verifyChain(chain, (e) =>
      e.seq === 2 ? "e".repeat(64) : e.payloadHash);
    expect(res).toMatchObject({ ok: false, reason: "payload_hash_mismatch", brokenAtSeq: 2 });
  });
});
