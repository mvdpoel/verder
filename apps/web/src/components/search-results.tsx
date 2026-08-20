import Link from "next/link";
import { ENTITY_BADGE, ENTITY_LABEL, MATCH_BADGE, MATCH_LABEL } from "./search-kinds";

// Presentational (server-safe) result list. The snippet is plain text — Task 8
// builds it with ts_headline StartSel=«/StopSel=» precisely so nothing here has
// to render HTML that came out of the database.

export type SearchHitRow = {
  entityType: string;
  entityId: string;
  title: string;
  snippet: string;
  matchedBy: string;
  occurredAt: string | null;
  status: string | null;
  href: string;
};

export function SearchResults({ hits }: { hits: SearchHitRow[] }) {
  if (hits.length === 0) {
    return (
      <p className="text-slate-500">
        Nothing found — try fewer words or widen the filters. An empty result
        isn&apos;t a mistake; it may simply not be in the dossier yet.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {hits.map((h) => (
        <li key={`${h.entityType}:${h.entityId}`} className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${ENTITY_BADGE[h.entityType as keyof typeof ENTITY_BADGE] ?? ENTITY_BADGE.party}`}>
              {ENTITY_LABEL[h.entityType as keyof typeof ENTITY_LABEL] ?? h.entityType}
            </span>
            <Link href={h.href} className="font-medium hover:underline">{h.title}</Link>
            {h.status && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {h.status}
              </span>
            )}
            <span className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${MATCH_BADGE[h.matchedBy as keyof typeof MATCH_BADGE] ?? MATCH_BADGE.keyword}`}>
              {MATCH_LABEL[h.matchedBy as keyof typeof MATCH_LABEL] ?? h.matchedBy}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{h.snippet}</p>
          {h.occurredAt && (
            <p className="mt-1 text-xs text-slate-500">
              {new Date(h.occurredAt).toLocaleDateString("nl-NL")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
