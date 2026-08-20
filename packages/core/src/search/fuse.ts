export const RRF_K = 60;

/** One entry of a ranked result list. rank is 1-based: the top hit has rank 1. */
export type RankedId = { id: string; rank: number };

export type FusedId = { id: string; score: number; inLexical: boolean; inSemantic: boolean };

/**
 * Reciprocal rank fusion: score(id) = Σ 1/(k + rank) over the lists the id
 * appears in. Deliberately computed here and not in SQL — it is the one piece
 * of ranking arithmetic worth unit-testing, and the inLexical/inSemantic flags
 * are what the result badge ("keyword / semantic / both") renders.
 *
 * Sorted by score descending, ties broken by id ascending so the same two
 * inputs always produce the same page order.
 */
export function rrfFuse(lexical: RankedId[], semantic: RankedId[], k: number = RRF_K): FusedId[] {
  const acc = new Map<string, FusedId>();
  const add = (list: RankedId[], flag: "inLexical" | "inSemantic"): void => {
    for (const { id, rank } of list) {
      const cur = acc.get(id) ?? { id, score: 0, inLexical: false, inSemantic: false };
      cur.score += 1 / (k + rank);
      cur[flag] = true;
      acc.set(id, cur);
    }
  };
  add(lexical, "inLexical");
  add(semantic, "inSemantic");
  return [...acc.values()].sort((a, b) =>
    b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
