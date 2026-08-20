"use client";
import { trpc } from "@/lib/trpc-client";

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
  if (q.isError) return (
    <p className="rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm p-2">
      Could not check the vault right now — you can still approve and link later.
    </p>
  );
  if (!q.data) return (
    <p className="text-sm text-slate-500">Checking the vault for “{request}”…</p>
  );
  if (q.data.documents.length === 0) return (
    <p className="text-sm text-slate-500">
      Nothing in the vault looks like “{request}” yet.
    </p>
  );
  return (
    <div className="rounded bg-slate-50 border p-3 space-y-2">
      <p className="text-sm font-semibold">You may already have this 📎</p>
      <ul className="space-y-2">
        {q.data.documents.map((d) => (
          <li key={d.documentId} className="text-sm">
            <label className="flex gap-2 items-start">
              <input type="checkbox" className="mt-1"
                checked={selected.includes(d.documentId)}
                onChange={() => onToggle(d.documentId)} />
              <span>
                <span className="font-medium">{d.title}</span>
                <span className="text-slate-400"> · score {d.score.toFixed(3)}</span>
                <span className="block text-xs text-slate-500">{d.snippet}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        Ticked documents are linked to the record when you approve this card.
      </p>
    </div>
  );
}
