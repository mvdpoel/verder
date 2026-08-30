import { Chip, TextLink } from "@/components/ui";

// Entity type → the screen that shows that record. Types with no detail screen
// (raw emails, parties) render as plain text rather than a dead link.
export const ENTITY_LABEL: Record<string, string> = {
  document: "Document", entry: "Logboekregel", email: "E-mail",
  financial_item: "Post", debt: "Vordering", task: "Taak",
  timeline_event: "Gebeurtenis", party: "Partij",
};

export function hrefForEntity(entityType: string, entityId: string): string | null {
  if (entityType === "document") return `/files/${entityId}`;
  if (entityType === "entry") return `/logbook/${entityId}`;
  if (entityType === "task") return `/tasks/${entityId}`;
  if (entityType === "financial_item") return `/registry/${entityId}`;
  if (entityType === "debt") return `/registry/debts/${entityId}`;
  if (entityType === "timeline_event") return "/timeline";
  return null;
}

type Ref = { entityType: string; entityId: string; title: string; score: number; snippet: string };

// The column is plain jsonb, so the client must not trust its shape.
function isRefArray(value: unknown): value is Ref[] {
  return Array.isArray(value) && value.every((r) =>
    typeof r === "object" && r !== null
    && typeof (r as Ref).entityType === "string"
    && typeof (r as Ref).entityId === "string"
    && typeof (r as Ref).title === "string"
    && typeof (r as Ref).score === "number");
}

/**
 * What retrieval put in front of the model when this suggestion was built.
 *
 * Citations are SUPPORTING evidence, so the whole block stays quieter than the
 * proposal it hangs under: a mono micro disclosure that is closed by default,
 * scores in the faintest ink there is, and the title carrying the only colour —
 * cyan, because a citation you can open is the system pointing at itself.
 */
export function RetrievedRefs({ refs }: { refs: unknown }) {
  if (!isRefArray(refs) || refs.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim transition-colors hover:text-signal">
        Dit lag voor het model ({refs.length})
      </summary>
      <ul className="mt-[12px] flex flex-col gap-[11px]">
        {refs.map((r) => {
          const href = hrefForEntity(r.entityType, r.entityId);
          const title = href
            ? (
              <TextLink href={href} className="text-[13px] font-light">
                {r.title}
              </TextLink>
            )
            : <span className="text-[13px] font-light text-ink-soft">{r.title}</span>;
          return (
            <li key={`${r.entityType}:${r.entityId}`} className="flex flex-col gap-[4px]">
              <div className="flex flex-wrap items-center gap-[9px]">
                <Chip tone="faint">{ENTITY_LABEL[r.entityType] ?? r.entityType}</Chip>
                {title}
                <span className="font-mono text-[10px] tracking-[0.12em] text-ink-faint">
                  · score {r.score.toFixed(3)}
                </span>
              </div>
              {r.snippet && (
                <p className="text-xs font-light leading-relaxed text-ink-dim">{r.snippet}</p>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
