import { SEARCH_ENTITY_TYPES } from "@verder/core/search/entity-types";

// Pure palette logic, kept out of the client component so it can be tested
// under vitest's node environment (this repo has no DOM test setup).

export interface PaletteHit {
  entityType: string;
  entityId: string;
  title: string;
  href: string;
}
export interface PaletteGroup { entityType: string; hits: PaletteHit[] }

/**
 * Groups hits by record type in the fixed SEARCH_ENTITY_TYPES order, so the
 * sections never reshuffle between keystrokes while Martin is aiming at one.
 */
export function groupHits(hits: PaletteHit[]): PaletteGroup[] {
  return (SEARCH_ENTITY_TYPES as readonly string[])
    .map((entityType) => ({
      entityType,
      hits: hits.filter((h) => h.entityType === entityType),
    }))
    .filter((g) => g.hits.length > 0);
}

/** The groups flattened back into one list — the order the arrow keys walk. */
export function flatOrder(groups: PaletteGroup[]): PaletteHit[] {
  return groups.flatMap((g) => g.hits);
}

/**
 * Arrow-key cursor. Wraps at both ends, and returns 0 for an empty list so the
 * caller never has to guard the index it renders with.
 */
export function nextIndex(
  length: number, current: number, key: "ArrowDown" | "ArrowUp",
): number {
  if (length === 0) return 0;
  const delta = key === "ArrowDown" ? 1 : -1;
  return (current + delta + length) % length;
}
