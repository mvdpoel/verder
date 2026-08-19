"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

// Task facts form — create mode (/tasks/new) and edit mode (detail page).
// Facts are editable (a typo is a typo); the status history lives in the
// ledger-backed TaskStatusForm instead.

export type TaskFormOptions = {
  parties: { id: string; name: string }[];
  entries: { id: string; label: string }[];
  items: { id: string; name: string }[];
  debts: { id: string; creditorName: string }[];
  documents: { id: string; title: string }[];
};

export type TaskFacts = {
  id: string;
  title: string;
  details: string | null;
  assigneePartyId: string | null;
  dueAt: Date | null;
  entryId: string | null;
  financialItemId: string | null;
  debtId: string | null;
  documentId: string | null;
};

/** Date → value for an <input type="date">, local-date based. */
function toDateInput(d: Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function TaskForm({ task, options }: { task?: TaskFacts; options: TaskFormOptions }) {
  const router = useRouter();
  const create = trpc.tasks.create.useMutation({ onSuccess: (t) => router.push(`/tasks/${t.id}`) });
  const update = trpc.tasks.update.useMutation({ onSuccess: () => router.refresh() });
  const [form, setForm] = useState({
    title: task?.title ?? "",
    details: task?.details ?? "",
    dueAt: toDateInput(task?.dueAt ?? null),
    assigneePartyId: task?.assigneePartyId ?? "",
    entryId: task?.entryId ?? "",
    financialItemId: task?.financialItemId ?? "",
    debtId: task?.debtId ?? "",
    documentId: task?.documentId ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = () => {
    if (!form.title.trim()) return;
    const fields = {
      title: form.title.trim(),
      details: form.details.trim() || null,
      dueAt: form.dueAt ? new Date(form.dueAt) : null,
      assigneePartyId: form.assigneePartyId || null,
      entryId: form.entryId || null,
      financialItemId: form.financialItemId || null,
      debtId: form.debtId || null,
      documentId: form.documentId || null,
    };
    if (task) update.mutate({ id: task.id, ...fields });
    else create.mutate(fields);
  };

  const linkSelect = (label: string, value: string, key: keyof typeof form,
    opts: { id: string; text: string }[]) => (
    <label className="block text-sm">{label}
      <select className="w-full border rounded p-2" value={value}
        onChange={(e) => set({ [key]: e.target.value } as Partial<typeof form>)}>
        <option value="">— none —</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
      </select></label>
  );

  return (
    <section className="rounded border bg-white p-4 space-y-3">
      <h2 className="font-semibold">{task ? "The facts" : "New task"}</h2>
      {!task && (
        <p className="text-sm text-slate-600">
          One clear next step — writing it down is half the work.
        </p>
      )}
      <label className="block text-sm">Title<input className="w-full border rounded p-2"
        placeholder="e.g. Send copy of passport to VerderGroep"
        value={form.title} onChange={(e) => set({ title: e.target.value })} /></label>
      <label className="block text-sm">Details (optional)<textarea className="w-full border rounded p-2" rows={3}
        placeholder="anything future-you needs to actually do this"
        value={form.details} onChange={(e) => set({ details: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">Due date (optional)<input type="date" className="w-full border rounded p-2"
          value={form.dueAt} onChange={(e) => set({ dueAt: e.target.value })} /></label>
        <label className="block text-sm">Who&apos;s on it
          <select className="w-full border rounded p-2" value={form.assigneePartyId}
            onChange={(e) => set({ assigneePartyId: e.target.value })}>
            <option value="">— unassigned —</option>
            {options.parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {linkSelect("Logbook entry (optional)", form.entryId, "entryId",
          options.entries.map((e) => ({ id: e.id, text: e.label })))}
        {linkSelect("Registry item (optional)", form.financialItemId, "financialItemId",
          options.items.map((i) => ({ id: i.id, text: i.name })))}
        {linkSelect("Debt (optional)", form.debtId, "debtId",
          options.debts.map((d) => ({ id: d.id, text: d.creditorName })))}
        {linkSelect("Document (optional)", form.documentId, "documentId",
          options.documents.map((d) => ({ id: d.id, text: d.title })))}
      </div>
      {error && <p className="text-sm text-red-600">{error.message}</p>}
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!form.title.trim() || pending} onClick={submit}>
        {task ? "Save facts" : "Add task"}
      </button>
    </section>
  );
}
