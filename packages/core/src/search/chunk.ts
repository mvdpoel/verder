export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;

/**
 * Splits a rendered body into overlapping chunks. Pure, no I/O.
 *
 * Works on code points, not UTF-16 units, so an accent or an emoji is never cut
 * in half. Prefers a blank-line (paragraph) boundary in the second half of the
 * window — cutting at the first blank line would produce stub chunks — and
 * otherwise cuts at the size limit. Consecutive chunks overlap by CHUNK_OVERLAP
 * so a sentence spanning a cut is still retrievable from at least one chunk.
 */
export function chunkBody(body: string): string[] {
  const trimmed = body.trim();
  // Every record gets at least one chunk: the title is indexed alongside the
  // body, so a record with no body text must still be findable. Never [].
  if (trimmed.length === 0) return [""];
  const cps = Array.from(trimmed);
  if (cps.length <= CHUNK_SIZE) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < cps.length) {
    let end = Math.min(start + CHUNK_SIZE, cps.length);
    if (end < cps.length) {
      let br = -1;
      for (let i = end - 2; i > start; i--) {
        if (cps[i] === "\n" && cps[i + 1] === "\n") { br = i; break; }
      }
      if (br > start + CHUNK_SIZE / 2) end = br;
    }
    const piece = cps.slice(start, end).join("").trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= cps.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}
