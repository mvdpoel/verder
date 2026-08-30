import {
  SEARCH_ENTITY_TYPES, SEARCH_STATUSES,
  type SearchEntityType, type SearchStatus,
} from "@verder/core";

// Everything /search needs comes from the URL, so a bookmarked or shared search
// renders identically with JavaScript disabled. Unknown types, malformed dates
// and unknown statuses are dropped here rather than forwarded to the router and
// rejected there with a BAD_REQUEST Martin would have to decode.

export const PAGE_SIZE = 20;

export interface ParsedSearch {
  q: string;
  entityTypes: SearchEntityType[];
  from: string;              // "YYYY-MM-DD" or "" — feeds <input type="date">
  to: string;
  partyId: string;           // "" when absent
  status: SearchStatus | ""; // "" when absent
  cursor: string;            // opaque router cursor, "" when absent
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function one(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? "").trim();
}
function many(v: string | string[] | undefined): string[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

export function parseSearchParams(
  sp: Record<string, string | string[] | undefined>,
): ParsedSearch {
  const from = one(sp.from);
  const to = one(sp.to);
  const status = one(sp.status);
  return {
    q: one(sp.q),
    entityTypes: many(sp.type).filter((t): t is SearchEntityType =>
      (SEARCH_ENTITY_TYPES as readonly string[]).includes(t)),
    from: DATE_RE.test(from) ? from : "",
    to: DATE_RE.test(to) ? to : "",
    partyId: one(sp.party),
    status: (SEARCH_STATUSES as readonly string[]).includes(status)
      ? (status as SearchStatus) : "",
    cursor: one(sp.cursor),
  };
}

/** Rebuilds the /search URL, optionally replacing the opaque cursor. */
export function buildSearchHref(
  p: ParsedSearch, override: { cursor?: string | null } = {},
): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  for (const t of p.entityTypes) qs.append("type", t);
  if (p.from) qs.set("from", p.from);
  if (p.to) qs.set("to", p.to);
  if (p.partyId) qs.set("party", p.partyId);
  if (p.status) qs.set("status", p.status);
  const cursor = "cursor" in override ? override.cursor : p.cursor;
  if (cursor) qs.set("cursor", cursor);
  return `/search?${qs.toString()}`;
}

/**
 * The router's input is flat — no `filters` wrapper — and every optional field
 * must be absent rather than an empty string, or zod rejects it.
 */
export function toQueryInput(p: ParsedSearch): {
  q: string; entityTypes?: SearchEntityType[]; from?: string; to?: string;
  partyId?: string; status?: SearchStatus; cursor?: string;
  limit: number; mode: "fast";
} {
  return {
    q: p.q,
    entityTypes: p.entityTypes.length ? p.entityTypes : undefined,
    from: p.from || undefined,
    to: p.to || undefined,
    partyId: p.partyId || undefined,
    status: p.status || undefined,
    cursor: p.cursor || undefined,
    limit: PAGE_SIZE,
    mode: "fast",
  };
}

/**
 * Honest note about semantic coverage. The keyword half of the index is always
 * complete; only the vector half can be missing — when the query embedding
 * fails, `retrieve` returns semanticAvailable: false and the fused ranking is
 * lexical only. Martin gets told which half he is looking at instead of being
 * handed a silently thinner list.
 */
export function semanticNotice(result: { semanticAvailable: boolean }): string | null {
  if (result.semanticAvailable) return null;
  return "Zoeken op betekenis kan nu even niet — die helft van de index is "
    + "niet bereikbaar. De resultaten op woord hieronder zijn compleet en er is "
    + "niets kwijt; probeer dezelfde zoekopdracht opnieuw zodra het model weer "
    + "draait.";
}
