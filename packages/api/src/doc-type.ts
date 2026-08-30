/**
 * `doc_type` is free text and stays free text: an enum would need a migration
 * every time the case produces a new kind of paper, and this case keeps
 * producing new kinds of paper. What the tree needs instead is a stable KEY, so
 * "Loonstrook" and "loonstrook" are one branch rather than two.
 */
export function docTypeKey(t: string | null | undefined): string {
  return (t ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The label for a branch: the spelling most of its rows use, ties broken
 * alphabetically so the label cannot flicker between page loads.
 */
export function docTypeLabel(variants: string[]): string {
  const counts = new Map<string, number>();
  for (const v of variants) {
    const t = v.trim();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "nl", { caseFirst: "upper" }))[0]?.[0] ?? "";
}
