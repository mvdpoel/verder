"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

type Proposed = { occurredAt: string; channel: string; direction: "inbound" | "outbound";
  summary: string; details: string; participantNames: string[];
  actionItems: { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[];
  attachmentDocumentIds: string[] };
type ProposedDocMeta = { title: string; docType: string | null };

type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };

export function SuggestionCard({ s }: { s: Suggestion }) {
  if (s.kind === "document-meta") return <DocMetaCard s={s} />;
  return <EntryCard s={s} />;
}

function EntryCard({ s }: { s: Suggestion }) {
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

function DocMetaCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedDocMeta | null;
  const [title, setTitle] = useState(p?.title ?? s.document?.title ?? "");
  const [docType, setDocType] = useState(p?.docType ?? "");
  const approve = trpc.suggestions.approveDocumentMeta.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p || !s.document) return null;
  return (
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        {`Scanned document “${s.document.title}”`}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      {s.document.mime.startsWith("image/")
        ? <img src={`/api/files/${s.document.sha256}`} alt={s.document.title}
            className="max-h-48 border rounded" />
        : <iframe src={`/api/files/${s.document.sha256}`} className="w-full h-48 border rounded"
            title={s.document.title} />}
      <label className="block text-sm">Title<input className="w-full border rounded p-2"
        value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block text-sm">Type<input className="w-full border rounded p-2"
        value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1"
          onClick={() => approve.mutate({ id: s.id, title, docType: docType || undefined })}>
          Looks right</button>
        <button className="rounded border px-4 py-1" onClick={() => reject.mutate({ id: s.id })}>Not relevant</button>
      </div>
    </li>
  );
}
