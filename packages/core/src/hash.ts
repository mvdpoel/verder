import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

export const GENESIS_HASH = "0".repeat(64);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface EventHashInput {
  seq: number;
  eventType: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
  prevHash: string;
}

export function computeEventHash(e: EventHashInput): string {
  const { seq, eventType, entityType, entityId, payloadHash, prevHash } = e;
  return sha256Hex(canonicalJson({ seq, eventType, entityType, entityId, payloadHash, prevHash }));
}
