"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

// Inline editors for the /milestones maintenance screen. Milestones are an
// editable display aid (NOT ledgered) — the underlying facts stay in the
// logbook and vault, so editing here is as low-ceremony as fixing a typo.

export type MilestoneRowData = {
  id: string;
  stage: string;
  title: string;
  happenedAt: Date | null;
  expectedAt: Date | null;
  done: boolean;
  note: string | null;
};

/** Date | null → yyyy-mm-dd for a date input. */
function toDateInput(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "";
}

/** yyyy-mm-dd input value → Date | null for the API. */
function fromDateInput(v: string): Date | null {
  return v ? new Date(v) : null;
}

export function MilestoneRowEditor({ milestone }: { milestone: MilestoneRowData }) {
  const router = useRouter();
  const update = trpc.milestones.update.useMutation({ onSuccess: () => router.refresh() });
  const [form, setForm] = useState({
    title: milestone.title,
    expectedAt: toDateInput(milestone.expectedAt),
    happenedAt: toDateInput(milestone.happenedAt),
    done: milestone.done,
    note: milestone.note ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const dirty = form.title !== milestone.title
    || form.expectedAt !== toDateInput(milestone.expectedAt)
    || form.happenedAt !== toDateInput(milestone.happenedAt)
    || form.done !== milestone.done
    || form.note !== (milestone.note ?? "");

  const save = () => {
    if (!form.title.trim()) return;
    update.mutate({
      id: milestone.id,
      title: form.title.trim(),
      expectedAt: fromDateInput(form.expectedAt),
      happenedAt: fromDateInput(form.happenedAt),
      done: form.done,
      note: form.note.trim() || null,
    });
  };

  return (
    <li className="rounded border bg-white p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm pb-2">
          <input type="checkbox" checked={form.done}
            onChange={(e) => set({ done: e.target.checked })} />
          done
        </label>
        <label className="block text-sm flex-1 min-w-48">Milestone
          <input className="w-full border rounded p-2" value={form.title}
            onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="block text-sm">Expected
          <input type="date" className="border rounded p-2" value={form.expectedAt}
            onChange={(e) => set({ expectedAt: e.target.value })} /></label>
        <label className="block text-sm">Happened
          <input type="date" className="border rounded p-2" value={form.happenedAt}
            onChange={(e) => set({ happenedAt: e.target.value })} /></label>
        <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
          disabled={!dirty || !form.title.trim() || update.isPending} onClick={save}>
          Save
        </button>
      </div>
      <label className="block text-sm mt-2">Note
        <input className="w-full border rounded p-2" placeholder="anything future-you should know"
          value={form.note} onChange={(e) => set({ note: e.target.value })} /></label>
      {update.error && <p className="mt-1 text-sm text-red-600">{update.error.message}</p>}
    </li>
  );
}

export function AddMilestoneForm({ stage }: { stage: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const create = trpc.milestones.create.useMutation({
    onSuccess: () => { setTitle(""); setExpectedAt(""); router.refresh(); },
  });

  const add = () => {
    if (!title.trim()) return;
    create.mutate({
      stage: stage as "application" | "accepted" | "onboarding" | "wsnp-start" | "settlement" | "clean-slate",
      title: title.trim(),
      expectedAt: fromDateInput(expectedAt),
      done: false,
    });
  };

  return (
    <div className="mt-2">
      <div className="flex items-end gap-3">
        <label className="block text-sm flex-1">
          <input className="w-full border rounded p-2" placeholder="+ milestone — e.g. Intake gesprek"
            value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Expected
          <input type="date" className="border rounded p-2" value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)} /></label>
        <button className="rounded border px-4 py-2 hover:bg-slate-100 disabled:opacity-50"
          disabled={!title.trim() || create.isPending} onClick={add}>
          Add
        </button>
      </div>
      {create.error && <p className="mt-1 text-sm text-red-600">{create.error.message}</p>}
    </div>
  );
}
