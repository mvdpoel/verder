"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { EVENT_KINDS, KIND_LABEL, type EventKind } from "./timeline-kinds";

// Inline editors for /timeline. Key events are a curated narrative and an
// editable display aid (NOT ledgered) — the linked logbook entries and
// documents stay the evidence, so fixing a wording here is as low-ceremony
// as fixing a typo.

export type TimelineEventData = {
  id: string;
  title: string;
  happenedAt: Date;
  kind: string;
  note: string | null;
};

/** Date → yyyy-mm-dd for a date input. */
function toDateInput(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

export function TimelineEventEditor({ event }: { event: TimelineEventData }) {
  const router = useRouter();
  const update = trpc.timeline.update.useMutation({ onSuccess: () => router.refresh() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: event.title,
    happenedAt: toDateInput(event.happenedAt),
    kind: event.kind,
    note: event.note ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const dirty = form.title !== event.title
    || form.happenedAt !== toDateInput(event.happenedAt)
    || form.kind !== event.kind
    || form.note !== (event.note ?? "");

  const save = () => {
    if (!form.title.trim() || !form.happenedAt) return;
    update.mutate({
      id: event.id,
      title: form.title.trim(),
      happenedAt: new Date(form.happenedAt),
      kind: form.kind as EventKind,
      note: form.note.trim() || null,
    });
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="text-sm text-slate-500 hover:underline" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded border bg-slate-50 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm flex-1 min-w-48">What happened
          <input className="w-full border rounded p-2" value={form.title}
            onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="block text-sm">Date
          <input type="date" className="border rounded p-2" value={form.happenedAt}
            onChange={(e) => set({ happenedAt: e.target.value })} /></label>
        <label className="block text-sm">Kind
          <select className="border rounded p-2" value={form.kind}
            onChange={(e) => set({ kind: e.target.value })}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select></label>
      </div>
      <label className="block text-sm">Note
        <input className="w-full border rounded p-2" placeholder="anything future-you should know"
          value={form.note} onChange={(e) => set({ note: e.target.value })} /></label>
      <div className="flex gap-2">
        <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
          disabled={!dirty || !form.title.trim() || !form.happenedAt || update.isPending}
          onClick={save}>Save</button>
        <button className="rounded border px-4 py-2 hover:bg-white" onClick={() => setOpen(false)}>
          Cancel</button>
      </div>
      {update.error && <p className="text-sm text-red-600">{update.error.message}</p>}
    </div>
  );
}

export function AddTimelineEventForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [happenedAt, setHappenedAt] = useState("");
  const [kind, setKind] = useState<EventKind>("process");
  const [note, setNote] = useState("");
  const create = trpc.timeline.create.useMutation({
    onSuccess: () => {
      setTitle(""); setHappenedAt(""); setKind("process"); setNote("");
      router.refresh();
    },
  });

  const add = () => {
    if (!title.trim() || !happenedAt) return;
    create.mutate({
      title: title.trim(),
      happenedAt: new Date(happenedAt),
      kind,
      note: note.trim() || null,
    });
  };

  return (
    <div className="rounded border bg-white p-4 space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm flex-1 min-w-48">What happened
          <input className="w-full border rounded p-2"
            placeholder="e.g. Verzoek verstuurd naar de rechtbank"
            value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Date
          <input type="date" className="border rounded p-2" value={happenedAt}
            onChange={(e) => setHappenedAt(e.target.value)} /></label>
        <label className="block text-sm">Kind
          <select className="border rounded p-2" value={kind}
            onChange={(e) => setKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select></label>
        <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
          disabled={!title.trim() || !happenedAt || create.isPending} onClick={add}>
          Add event
        </button>
      </div>
      <label className="block text-sm">Note (optional)
        <input className="w-full border rounded p-2" placeholder="context worth keeping"
          value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {create.error && <p className="text-sm text-red-600">{create.error.message}</p>}
    </div>
  );
}
