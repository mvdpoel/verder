"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import type { DebtPartyRole } from "./registry-list";

// Editable edges for a debt: who is chasing it, what paperwork proves it, and
// whether Verder has been told. None of this is evidence (debts/debt_parties/
// debt_documents are display facts, not the ledger) so link/unlink/reported
// are plain mutations, same mutation-plus-router.refresh() pattern as
// item-facts-form.tsx. It reports, it does not judge: an unreported debt
// reads as a neutral fact, never a warning.

const ROLES: DebtPartyRole[] = ["eiser", "incasso", "deurwaarder", "gemachtigde"];

export type DebtPartyLink = {
  partyId: string;
  name: string;
  organization: string | null;
  role: DebtPartyRole;
  note: string | null;
};

export type DebtDocumentLink = { id: string; title: string; mime: string };

export function DebtPartiesForm({ debtId, parties, debtDocuments, reportedToVerderAt, reportedViaEntryId }: {
  debtId: string;
  parties: DebtPartyLink[];
  debtDocuments: DebtDocumentLink[];
  reportedToVerderAt: Date | null;
  reportedViaEntryId: string | null;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const allParties = trpc.parties.list.useQuery();
  const allDocuments = trpc.documents.list.useQuery({ limit: 100 });
  const entries = trpc.entries.list.useQuery({ limit: 100 });

  const linkParty = trpc.registry.debts.linkParty.useMutation({ onSuccess: refresh });
  const unlinkParty = trpc.registry.debts.unlinkParty.useMutation({ onSuccess: refresh });
  const linkDocument = trpc.registry.debts.linkDocument.useMutation({ onSuccess: refresh });
  const unlinkDocument = trpc.registry.debts.unlinkDocument.useMutation({ onSuccess: refresh });
  const setReported = trpc.registry.debts.setReported.useMutation({ onSuccess: refresh });

  const [newPartyId, setNewPartyId] = useState("");
  const [newRole, setNewRole] = useState<DebtPartyRole>("eiser");
  const [newNote, setNewNote] = useState("");
  const [newDocId, setNewDocId] = useState("");
  const [reportEntryId, setReportEntryId] = useState(reportedViaEntryId ?? "");

  const linkedDocIds = new Set(debtDocuments.map((d) => d.id));
  const availableDocuments = (allDocuments.data ?? []).filter((d) => !linkedDocIds.has(d.id));

  const addParty = () => {
    if (!newPartyId) return;
    linkParty.mutate({ debtId, partyId: newPartyId, role: newRole, note: newNote || undefined });
    setNewPartyId("");
    setNewNote("");
  };

  const addDocument = () => {
    if (!newDocId) return;
    linkDocument.mutate({ debtId, documentId: newDocId });
    setNewDocId("");
  };

  const markReported = () => {
    setReported.mutate({ debtId, reportedAt: new Date(), entryId: reportEntryId || null });
  };

  const clearReported = () => {
    setReported.mutate({ debtId, reportedAt: null });
    setReportEntryId("");
  };

  return (
    <>
      <section className="rounded border bg-white p-4 space-y-3">
        <h2 className="font-semibold">Parties</h2>
        {parties.length === 0
          ? <p className="text-sm text-slate-600">No parties linked yet.</p>
          : (
            <ul className="space-y-1">
              {parties.map((p) => (
                <li key={`${p.partyId}-${p.role}`} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="font-medium">{p.role}</span>: {p.name}
                    {p.organization && <span className="text-slate-500"> ({p.organization})</span>}
                    {p.note && <span className="text-slate-500"> — {p.note}</span>}
                  </span>
                  <button type="button" className="text-slate-400 hover:text-red-600"
                    disabled={unlinkParty.isPending}
                    onClick={() => unlinkParty.mutate({ debtId, partyId: p.partyId, role: p.role })}
                    aria-label={`Remove ${p.name} as ${p.role}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm">Party
            <select className="block border rounded p-2" value={newPartyId}
              onChange={(e) => setNewPartyId(e.target.value)}>
              <option value="">Choose…</option>
              {allParties.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Role
            <select className="block border rounded p-2" value={newRole}
              onChange={(e) => setNewRole(e.target.value as DebtPartyRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="text-sm">Note
            <input className="block border rounded p-2" placeholder="optional"
              value={newNote} onChange={(e) => setNewNote(e.target.value)} />
          </label>
          <button type="button" className="rounded border px-3 py-2 disabled:opacity-50"
            disabled={!newPartyId || linkParty.isPending} onClick={addParty}>
            Add
          </button>
        </div>
      </section>

      <section className="rounded border bg-white p-4 space-y-3">
        <h2 className="font-semibold">Paperwork</h2>
        {debtDocuments.length === 0
          ? <p className="text-sm text-slate-600">No documents filed against this debt yet.</p>
          : (
            <ul className="space-y-1">
              {debtDocuments.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/vault/${d.id}`} className="underline truncate">{d.title}</Link>
                  <button type="button" className="text-slate-400 hover:text-red-600"
                    disabled={unlinkDocument.isPending}
                    onClick={() => unlinkDocument.mutate({ debtId, documentId: d.id })}
                    aria-label={`Unlink ${d.title}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        <div className="flex gap-2 items-end">
          <label className="text-sm">Document
            <select className="block border rounded p-2" value={newDocId}
              onChange={(e) => setNewDocId(e.target.value)}>
              <option value="">Choose…</option>
              {availableDocuments.map((d) => <option key={d.id} value={d.id}>{d.effectiveTitle}</option>)}
            </select>
          </label>
          <button type="button" className="rounded border px-3 py-2 disabled:opacity-50"
            disabled={!newDocId || linkDocument.isPending} onClick={addDocument}>
            Link
          </button>
        </div>
      </section>

      <section className="rounded border bg-white p-4 space-y-3">
        <h2 className="font-semibold">Verder</h2>
        {/* Calm, not alarmed: an unreported debt is a fact to record, not a
            warning — Martin is the person this is about. */}
        {reportedToVerderAt
          ? (
            <p className="text-sm text-slate-600">
              Reported to Verder on {new Date(reportedToVerderAt).toLocaleDateString("nl-NL")}
              {reportedViaEntryId && (
                <> · <Link href={`/logbook/${reportedViaEntryId}`} className="underline">see the entry</Link></>
              )}
            </p>
          )
          : <p className="text-sm text-slate-600">Not reported to Verder yet.</p>}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm">Via entry (optional)
            <select className="block border rounded p-2" value={reportEntryId}
              onChange={(e) => setReportEntryId(e.target.value)}>
              <option value="">No specific entry</option>
              {entries.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {new Date(e.occurredAt).toLocaleDateString("nl-NL")} — {e.summary}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="rounded bg-slate-900 text-white px-3 py-2 disabled:opacity-50"
            disabled={setReported.isPending} onClick={markReported}>
            {reportedToVerderAt ? "Update reported date" : "Mark reported today"}
          </button>
          {reportedToVerderAt && (
            <button type="button" className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={setReported.isPending} onClick={clearReported}>
              Clear
            </button>
          )}
        </div>
      </section>
    </>
  );
}
