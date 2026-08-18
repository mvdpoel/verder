import { computeEventHash, GENESIS_HASH } from "./hash";

export interface ChainEvent {
  seq: number; eventType: string; entityType: string; entityId: string;
  payloadHash: string; prevHash: string; eventHash: string;
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number;
      reason: "gap" | "prev_hash_mismatch" | "event_hash_mismatch" | "payload_hash_mismatch" };

export async function verifyChain(
  events: ChainEvent[],
  recomputePayloadHash?: (e: ChainEvent) => string | Promise<string>
): Promise<VerifyResult> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of events) {
    if (e.seq !== expectedSeq)
      return { ok: false, brokenAtSeq: e.seq, reason: "gap" };
    if (e.prevHash !== prevHash)
      return { ok: false, brokenAtSeq: e.seq, reason: "prev_hash_mismatch" };
    const { eventHash: _stored, ...rest } = e;
    if (computeEventHash(rest) !== e.eventHash)
      return { ok: false, brokenAtSeq: e.seq, reason: "event_hash_mismatch" };
    if (recomputePayloadHash) {
      const live = await recomputePayloadHash(e);
      if (live !== e.payloadHash)
        return { ok: false, brokenAtSeq: e.seq, reason: "payload_hash_mismatch" };
    }
    prevHash = e.eventHash;
    expectedSeq++;
  }
  return { ok: true, count: events.length };
}
