import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../hash";

/**
 * Identity of a chunk's content. The drain re-embeds a chunk only when this
 * changes, so re-rendering an untouched record costs no GPU time. Hashed
 * through canonicalJson — the same pairing computeEventHash uses — so the
 * title/body boundary is part of the input and cannot be shifted unnoticed.
 */
export function sourceHash(title: string, body: string): string {
  return sha256Hex(canonicalJson({ title, body }));
}
