import Link from "next/link";
import { Chip, Empty, Micro, Panel } from "@/components/ui";
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
      <Empty title="Nothing found — try fewer words or widen the filters.">
        An empty result isn&apos;t a mistake; it may simply not be in the
        dossier yet.
      </Empty>
    );
  }
  return (
    // One panel holding hairline-separated rows, not a card per hit: a stack of
    // boxes reads as a stack of unrelated things, and these are one answer to
    // one question.
    <Panel>
      <ul className="px-[26px]">
        {hits.map((h) => (
          <li
            key={`${h.entityType}:${h.entityId}`}
            className="border-b border-hairline py-[15px] last:border-0">
            <div className="flex flex-wrap items-center gap-[10px]">
              <Chip tone={ENTITY_BADGE[h.entityType as keyof typeof ENTITY_BADGE] ?? ENTITY_BADGE.party}>
                {ENTITY_LABEL[h.entityType as keyof typeof ENTITY_LABEL] ?? h.entityType}
              </Chip>
              <Link
                href={h.href}
                className="text-[15px] font-light text-ink-soft transition-colors hover:text-signal-link">
                {h.title}
              </Link>
              {h.status && <Micro>{h.status}</Micro>}
              <Chip
                tone={MATCH_BADGE[h.matchedBy as keyof typeof MATCH_BADGE] ?? MATCH_BADGE.keyword}
                className="ml-auto">
                {MATCH_LABEL[h.matchedBy as keyof typeof MATCH_LABEL] ?? h.matchedBy}
              </Chip>
            </div>
            <p className="mt-[7px] text-[13.5px] font-light leading-relaxed text-ink-mute">
              {h.snippet}
            </p>
            {h.occurredAt && (
              <Micro className="mt-[6px]">
                {new Date(h.occurredAt).toLocaleDateString("nl-NL")}
              </Micro>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
