import { DRAIN_STALE_MS, type IndexHealth } from "@verder/api/src/search/health";

export type IndexHealthTone = "ok" | "warn" | "bad";

/**
 * One honest verdict for the /verify card. The green case is gated on the API's
 * own `degraded` flag so the card and the API can never disagree; the branches
 * below only explain WHICH of the three conditions behind that flag fired, in
 * severity order. The final branch is the remaining cause (a deep queue), not a
 * fallback: readIndexHealth sets `degraded` from exactly stale-drain,
 * embedFailures and outboxDepth.
 */
export function indexHealthState(
  h: IndexHealth, now: number,
): { tone: IndexHealthTone; message: string } {
  if (!h.degraded) {
    return { tone: "ok", message: "Everything written is searchable." };
  }
  if (h.lastDrainAt === null) {
    return {
      tone: "bad",
      message: "The indexer has never reported. Nothing new is becoming searchable yet — start the worker and it will catch up.",
    };
  }
  if (now - Date.parse(h.lastDrainAt) > DRAIN_STALE_MS) {
    return {
      tone: "bad",
      message: `The indexer hasn't run since ${new Date(h.lastDrainAt).toLocaleString("nl-NL")} — anything written after that isn't searchable yet. Nothing is lost; it catches up as soon as the worker is back.`,
    };
  }
  if (h.embedFailures > 0) {
    const noun = h.embedFailures === 1 ? "chunk" : "chunks";
    return {
      tone: "warn",
      message: `${h.embedFailures} ${noun} could not be embedded — keyword search is complete, semantic search is thin. The next index run retries them.`,
    };
  }
  return {
    tone: "warn",
    message: `${h.outboxDepth} records are waiting to be indexed — the queue is catching up.`,
  };
}
