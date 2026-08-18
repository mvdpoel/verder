"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

type Proposed = { occurredAt: string; channel: string; direction: "inbound" | "outbound";
  summary: string; details: string; participantNames: string[];
  actionItems: { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[];
  attachmentDocumentIds: string[] };

export function SuggestionCard({ s }: { s: { id: string; kind: string; model: string | null;
  proposed: unknown; rawEmail: { fromAddr: string; subject: string; bodyText: string } | null } }) {
  const router = useRouter();
  const p = s.proposed as Proposed | null;
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const approve = trpc.suggestions.approveEntry.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  return (
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        {s.rawEmail ? `Email from ${s.rawEmail.fromAddr}: “${s.rawEmail.subject}”` : "Detected item"}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      <label className="block text-sm">Summary<input className="w-full border rounded p-2"
        value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      {s.rawEmail && <details><summary className="cursor-pointer text-sm">Original email</summary>
        <pre className="text-xs whitespace-pre-wrap bg-slate-50 p-2 rounded">{s.rawEmail.bodyText}</pre></details>}
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1"
          onClick={() => approve.mutate({ id: s.id, entry: {
            occurredAt: new Date(p.occurredAt), channel: p.channel as "email", direction: p.direction,
            summary, details: details || undefined, source: "gmail-watch",
            participantPartyIds: [], documentIds: p.attachmentDocumentIds,
            actionItems: p.actionItems } })}>Add to the record</button>
        <button className="rounded border px-4 py-1" onClick={() => reject.mutate({ id: s.id })}>Not relevant</button>
      </div>
    </li>
  );
}
