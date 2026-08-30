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
    return { tone: "ok", message: "Alles wat is vastgelegd, is doorzoekbaar." };
  }
  if (h.lastDrainAt === null) {
    return {
      tone: "bad",
      message: "De indexer heeft zich nog nooit gemeld. Nieuwe dingen worden nog niet doorzoekbaar — start de worker, dan haalt hij het in.",
    };
  }
  if (now - Date.parse(h.lastDrainAt) > DRAIN_STALE_MS) {
    return {
      tone: "bad",
      message: `De indexer draait niet meer sinds ${new Date(h.lastDrainAt).toLocaleString("nl-NL")} — wat daarna is vastgelegd, is nog niet doorzoekbaar. Er is niets kwijt; hij haalt het in zodra de worker weer draait.`,
    };
  }
  if (h.embedFailures > 0) {
    const noun = h.embedFailures === 1 ? "stuk" : "stukken";
    return {
      tone: "warn",
      message: `${h.embedFailures} ${noun} konden niet worden ge-embed — zoeken op woord is compleet, zoeken op betekenis is mager. De volgende indexronde probeert het opnieuw.`,
    };
  }
  return {
    tone: "warn",
    message: `${h.outboxDepth} records wachten om geïndexeerd te worden — de wachtrij loopt bij.`,
  };
}
