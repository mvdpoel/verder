/**
 * Put the pages of a scanned document back in the order they were written in.
 *
 * A sheet feeder takes a stack in whatever order it was put in, so a six-page
 * letter arrives as 1,2,5,6,3,4 — which is what the Belastingdienst letter
 * about the beslagvrije voet actually did. The pages say so themselves:
 * Dutch official letters carry "Paginanummer 3 van 6" in the footer.
 *
 * REFUSES unless the evidence is complete. Every page must carry a marker, the
 * totals must agree with each other AND with the real page count, and the
 * numbers must form an exact permutation of 1..N. Anything less and the pages
 * are left alone: a letter in the wrong order is a nuisance, a letter silently
 * shuffled into a NEW wrong order is a document that misrepresents itself.
 */

/**
 * "Paginanummer 3 van 6", "Pagina 3 van 6", "Page 3 of 6", "blad 3 van 6",
 * and the bare "3 / 6" or "3 van 6".
 *
 * The bare form is why every check below is global: "INL230-07 / V013" is in
 * the footer of that same letter, and a reference number that happens to look
 * like a page marker cannot survive the permutation test.
 */
const MARKERS = [
  /(?:paginanummer|pagina|bladzijde|blad|page|pag\.?)\s*(\d{1,3})\s*(?:van|of|\/)\s*(\d{1,3})/gi,
  /(?<![\d.,\-\/])(\d{1,3})\s*(?:van|of)\s*(\d{1,3})(?![\d.,\-\/])/gi,
  /(?<![\d.,\-\/])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d.,\-\/])/g,
];

export interface PageMarker { page: number; total: number }

/** Every plausible "page n of total" in one page's text, best patterns first. */
export function findPageMarkers(text: string): PageMarker[] {
  const out: PageMarker[] = [];
  for (const re of MARKERS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const page = Number(m[1]), total = Number(m[2]);
      if (page >= 1 && total >= 1 && page <= total && total <= 200) out.push({ page, total });
    }
  }
  return out;
}

/**
 * The order the pages should be in, as source indices, or null to leave the
 * document alone.
 *
 * `result[i]` is the 0-based index of the page that belongs at position i, so
 * [0,1,4,5,2,3] means "page 3 of the letter is the fifth sheet scanned".
 * Returns null when the document is already in order, so a caller can treat a
 * non-null result as "there is work to do".
 */
export function detectPageOrder(pageTexts: string[]): number[] | null {
  const n = pageTexts.length;
  if (n < 2) return null;
  const perPage = pageTexts.map(findPageMarkers);

  // The total must be the real page count. A letter scanned WITHOUT its last
  // sheet says "van 6" on five pages, and reordering five pages as if they
  // were six would be inventing a document.
  const claimed = perPage.map((ms) => ms.find((m) => m.total === n));
  if (claimed.some((m) => m === undefined)) return null;

  const order = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const pos = claimed[i]!.page - 1;
    // Two sheets claiming the same page number: the markers are not what we
    // think they are, so trust none of them.
    if (pos < 0 || pos >= n || order[pos] !== -1) return null;
    order[pos] = i;
  }
  if (order.some((v) => v === -1)) return null;
  if (order.every((v, i) => v === i)) return null;
  return order;
}
