import Link from "next/link";

// Entity type → the screen that shows that record. Types with no detail screen
// (raw emails, parties) render as plain text rather than a dead link.
export const ENTITY_LABEL: Record<string, string> = {
  document: "Document", entry: "Logbook entry", email: "Email",
  financial_item: "Subscription", debt: "Debt", task: "Task",
  milestone: "Milestone", timeline_event: "Key event", party: "Party",
};

export function hrefForEntity(entityType: string, entityId: string): string | null {
  if (entityType === "document") return `/vault/${entityId}`;
  if (entityType === "entry") return `/logbook/${entityId}`;
  if (entityType === "task") return `/tasks/${entityId}`;
  if (entityType === "financial_item") return `/registry/${entityId}`;
  if (entityType === "debt") return `/registry/debts/${entityId}`;
  if (entityType === "milestone") return "/milestones";
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

/** What retrieval put in front of the model when this suggestion was built. */
export function RetrievedRefs({ refs }: { refs: unknown }) {
  if (!isRefArray(refs) || refs.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        The model saw these ({refs.length})
      </summary>
      <ul className="space-y-2 mt-2">
        {refs.map((r) => {
          const href = hrefForEntity(r.entityType, r.entityId);
          const title = <span className="font-medium">{r.title}</span>;
          return (
            <li key={`${r.entityType}:${r.entityId}`} className="text-xs text-slate-600">
              <span className="rounded px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-700">
                {ENTITY_LABEL[r.entityType] ?? r.entityType}
              </span>{" "}
              {href ? <Link href={href} className="underline">{title}</Link> : title}
              <span className="text-slate-400"> · score {r.score.toFixed(3)}</span>
              {r.snippet && <p className="text-slate-500 mt-0.5">{r.snippet}</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
