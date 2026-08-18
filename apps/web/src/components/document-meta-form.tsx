"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function DocumentMetaForm({ doc, entries }: {
  doc: { id: string; title: string; docType: string | null; status: "inbox" | "filed" };
  entries: { id: string; summary: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.docType ?? "");
  const [entryId, setEntryId] = useState("");
  const update = trpc.documents.update.useMutation({ onSuccess: () => router.refresh() });
  const link = trpc.documents.linkToEntry.useMutation({ onSuccess: () => router.refresh() });
  return (
    <div className="space-y-4">
      <label className="block">Title<input className="w-full border rounded p-2" value={title}
        onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block">Type<input className="w-full border rounded p-2" placeholder="contract, payslip, letter…"
        value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
      <button className="rounded bg-slate-900 text-white px-4 py-2"
        onClick={() => update.mutate({ id: doc.id, status: "filed", title, docType: docType || undefined })}>
        {doc.status === "inbox" ? "File it ✔" : "Save changes"}
      </button>
      <div className="pt-4 border-t">
        <label className="block">Link to a logbook entry
          <select className="w-full border rounded p-2" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">— pick an entry —</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.summary}</option>)}
          </select></label>
        <button className="mt-2 rounded border px-4 py-2" disabled={!entryId}
          onClick={() => link.mutate({ documentId: doc.id, entryId })}>Link</button>
      </div>
    </div>
  );
}
