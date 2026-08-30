import { describe, expect, it } from "vitest";
import { DRAIN_STALE_MS } from "@verder/api/src/search/health";
import { indexHealthState } from "./index-health-state";

const now = new Date("2026-08-20T12:00:00Z").getTime();
const healthy = {
  chunks: 1200, outboxDepth: 0, embedFailures: 0,
  lastDrainAt: new Date(now - 30_000).toISOString(),
  degraded: false,
};

describe("indexHealthState", () => {
  it("is green when the API says the index is not degraded", () => {
    const s = indexHealthState(healthy, now);
    expect(s.tone).toBe("ok");
    expect(s.message).toContain("doorzoekbaar");
  });

  it("is red when the drain has never reported", () => {
    const s = indexHealthState({ ...healthy, lastDrainAt: null, degraded: true }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("nog nooit gemeld");
  });

  it("is red when the drain is stale", () => {
    const s = indexHealthState({
      ...healthy, degraded: true,
      lastDrainAt: new Date(now - DRAIN_STALE_MS - 1000).toISOString(),
    }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("draait niet meer sinds");
  });

  it("is amber when embeddings failed but the drain is alive", () => {
    const s = indexHealthState({ ...healthy, embedFailures: 4, degraded: true }, now);
    expect(s.tone).toBe("warn");
    expect(s.message).toContain("4 stukken konden niet worden ge-embed");
  });

  it("is amber when the queue is deep", () => {
    const s = indexHealthState({ ...healthy, outboxDepth: 900, degraded: true }, now);
    expect(s.tone).toBe("warn");
    expect(s.message).toContain("900 records wachten");
  });

  // A stalled drain outranks failed embeddings: if nothing is draining, the
  // failure count is stale too, and "4 chunks failed" while the indexer is dead
  // would be a lie by omission.
  it("reports the stalled drain when both are wrong", () => {
    const s = indexHealthState({
      ...healthy, embedFailures: 4, degraded: true,
      lastDrainAt: new Date(now - DRAIN_STALE_MS - 1000).toISOString(),
    }, now);
    expect(s.tone).toBe("bad");
    expect(s.message).toContain("draait niet meer sinds");
  });
});
