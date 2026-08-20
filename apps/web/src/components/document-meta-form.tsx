"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { discardAction, type DocStatus } from "./document-meta-form-actions";

export function DocumentMetaForm({ doc, entries }: {
  doc: { id: string; title: string; docType: string | null;
    status: DocStatus; previousStatus: DocStatus };
  entries: { id: string; summary: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.docType ?? "");
  const [entryId, setEntryId] = useState("");
  const update = trpc.documents.update.useMutation({ onSuccess: () => router.refresh() });
  const link = trpc.documents.linkToEntry.useMutation({ onSuccess: () => router.refresh() });
  const discarded = doc.status === "discarded";
  const action = discardAction(doc.status, doc.previousStatus);
  return (
    <div className="space-y-4">
      {discarded && (
        <p className="text-sm text-slate-600">
          Discarded — kept in the vault, hidden from lists and search.
          Undo the discard to edit it.
        </p>
      )}
      {/* Disabled while discarded: there is no save path on a discarded
          document (see below), so an editable box would just lose what was
          typed on the next refresh. */}
      <label className="block">Title<input className="w-full border rounded p-2 disabled:bg-slate-100 disabled:text-slate-500"
        value={title} disabled={discarded}
        onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block">Type<input className="w-full border rounded p-2 disabled:bg-slate-100 disabled:text-slate-500"
        placeholder="contract, payslip, letter…" value={docType} disabled={discarded}
        onChange={(e) => setDocType(e.target.value)} /></label>
      <div className="flex items-center gap-2">
        {!discarded && (
          <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: doc.id, status: "filed", title, docType: docType || undefined })}>
            {doc.status === "inbox" ? "File it ✔" : "Save changes"}
          </button>
        )}
        {/* Quiet secondary action: discard is never the primary path, and it is
            always reversible — the same button offers the opposite move.
            The current title/type ride along so the transition does not reset
            them: effectiveDocument reads only the LATEST status change row. */}
        <button className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: doc.id, status: action.next,
            title: doc.title, docType: doc.docType ?? undefined })}>
          {action.label}
        </button>
      </div>
      <div className="pt-4 border-t">
        <label className="block">Link to a logbook entry
          <select className="w-full border rounded p-2" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">— pick an entry —</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.summary}</option>)}
          </select></label>
        <button className="mt-2 rounded border px-4 py-2 disabled:opacity-50"
          disabled={!entryId || link.isPending}
          onClick={() => link.mutate({ documentId: doc.id, entryId })}>Link</button>
      </div>
    </div>
  );
}
