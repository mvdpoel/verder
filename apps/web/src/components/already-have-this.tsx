"use client";
import { trpc } from "@/lib/trpc-client";
import { Label, Notice } from "@/components/ui";

/**
 * "We may already have this." Deep retrieval over the vault for the document
 * this suggestion asks for. Picking a document only marks it — the link is
 * made by the card's existing approve mutation, so nothing enters the record
 * without Martin's verdict. No email is drafted or sent.
 *
 * The query is gated twice. The parent renders this component only when
 * `s.documentRequest` is non-null, AND `enabled` keeps the hook from firing
 * even if a future caller forgets that; `refetchOnWindowFocus: false` plus a
 * five-minute `staleTime` stop a 20 s rerank from re-running every time Martin
 * tabs back to the queue.
 *
 * Visually this is supporting evidence under a proposal, so it is recessed
 * (void ground inside the card's glass) and carries no amber: a vault hit is
 * the system offering something, never something waiting on Martin.
 */
export function AlreadyHaveThis({ suggestionId, request, selected, onToggle }: {
  suggestionId: string; request: string;
  selected: string[]; onToggle: (documentId: string) => void;
}) {
  const q = trpc.search.alreadyHave.useQuery(
    { suggestionId },
    { enabled: Boolean(request), staleTime: 5 * 60_000, refetchOnWindowFocus: false },
  );
  if (!request) return null;
  // A vault that cannot be reached is the system reporting on itself — cyan,
  // not amber: the card can still be approved and linked later.
  if (q.isError) return (
    <Notice tone="signal">
      Could not check the vault right now — you can still approve and link later.
    </Notice>
  );
  if (!q.data) return (
    <p className="font-mono text-[10px] tracking-[0.14em] text-ink-dim">
      Checking the vault for “{request}”…
    </p>
  );
  if (q.data.documents.length === 0) return (
    <p className="text-[13px] font-light text-ink-label">
      Nothing in the vault looks like “{request}” yet.
    </p>
  );
  return (
    <div className="flex flex-col gap-[13px] rounded-panel border border-edge bg-void/60 p-[18px]">
      <Label className="text-signal">You may already have this 📎</Label>
      <ul className="flex flex-col gap-[11px]">
        {q.data.documents.map((d) => (
          <li key={d.documentId}>
            {/*
              Hand-rolled rather than the `Checkbox` primitive: that one centres
              its box against a single-line label, and a hit here is a title, a
              score and a snippet stacked three lines deep.
            */}
            <label className="flex cursor-pointer items-start gap-[11px]">
              <input type="checkbox" className="mt-[3px] size-[15px] shrink-0 accent-signal"
                checked={selected.includes(d.documentId)}
                onChange={() => onToggle(d.documentId)} />
              <span className="min-w-0">
                <span className="text-[13.5px] font-light text-ink-soft">{d.title}</span>
                <span className="ml-[7px] font-mono text-[10px] tracking-[0.12em] text-ink-faint">
                  · score {d.score.toFixed(3)}
                </span>
                <span className="mt-[3px] block text-xs font-light leading-relaxed text-ink-dim">
                  {d.snippet}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs font-light text-ink-label">
        Ticked documents are linked to the record when you approve this card.
      </p>
    </div>
  );
}
