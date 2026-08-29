"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

/**
 * Create and edit a spoor. Tracks are an editable display aid (NOT ledgered) —
 * the evidence stays in the logbook and the vault — so editing here is as
 * low-ceremony as fixing a typo.
 */

type StopOption = { id: string; title: string; trackId: string };
type TrackData = {
  id: string; title: string; status: string;
  parentTrackId: string | null; branchesAtStopId: string | null;
  mergesAtStopId: string | null; note: string | null;
};

const STATUSES = [
  { value: "open", label: "loopt nog" },
  { value: "done", label: "afgerond" },
  // "ended" is a clean outcome: handled and closed, never rejoined.
  { value: "ended", label: "geëindigd (komt niet terug op de hoofdlijn)" },
];

export function AddTrackForm({ stops }: { stops: StopOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", branchesAtStopId: "", note: "" });
  const create = trpc.tracks.createTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (!open) {
    return (
      <button className="text-sm text-blue-600 hover:underline" onClick={() => setOpen(true)}>
        + nieuw zijspoor
      </button>
    );
  }
  const branchStop = stops.find((s) => s.id === form.branchesAtStopId);
  return (
    <div className="space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        placeholder="Waar gaat dit spoor over? (bijv. Ontruiming)"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <label className="block text-xs text-slate-600">
        Vertrekt bij welke halte?
        <select
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          value={form.branchesAtStopId}
          onChange={(e) => setForm({ ...form, branchesAtStopId: e.target.value })}
        >
          <option value="">— kies een halte —</option>
          {stops.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        placeholder="Notitie (optioneel)"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || !branchStop || create.isPending}
          onClick={() => {
            // The button is disabled without one, but the guard is what makes
            // the parent/branch pair provably consistent: a zijspoor always
            // departs from a halte on the track it belongs to.
            if (!branchStop) return;
            create.mutate({
              title: form.title.trim(),
              parentTrackId: branchStop.trackId,
              branchesAtStopId: branchStop.id,
              note: form.note.trim() || null,
            });
          }}
        >
          Aanmaken
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {create.error && <p className="text-sm text-red-700">{create.error.message}</p>}
    </div>
  );
}

export function TrackEditor({ track, stops }: { track: TrackData; stops: StopOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: track.title,
    status: track.status,
    branchesAtStopId: track.branchesAtStopId ?? "",
    mergesAtStopId: track.mergesAtStopId ?? "",
    note: track.note ?? "",
  });
  const update = trpc.tracks.updateTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (!open) {
    return (
      <button className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(true)}>
        bewerken
      </button>
    );
  }
  // Only stops on the PARENT track can be a branch or a merge point: a spoor
  // leaves the line it belongs to and rejoins that same line, never a third
  // one. The router refuses anything else with a sentence in Dutch — this list
  // is what keeps him from ever reading it.
  const pointOptions = stops.filter((s) => s.trackId === track.parentTrackId);
  return (
    <div className="mt-2 w-full space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <label className="block text-xs text-slate-600">
        Status
        <select
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
        >
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      {/* The two ends of a zijspoor, side by side. The branch point exists
          because migration 0026 nulled every one of them: the map draws a
          spoor's departure from its own oldest halte, so the pointer is
          semantic only — "dit spoor komt uit DIE gebeurtenis voort". NULL is
          the honest default and stays reachable, because for most sporen
          nobody ever wrote the origin down and the app may not invent one.
          Neither control is shown for the hoofdlijn: it leaves nothing and
          comes back on nothing, and the router refuses both. */}
      {track.parentTrackId && (
        <>
          <label className="block text-xs text-slate-600">
            Vertrekt bij welke halte?
            <select
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              value={form.branchesAtStopId}
              onChange={(e) => setForm({ ...form, branchesAtStopId: e.target.value })}
            >
              <option value="">— niet vastgelegd —</option>
              {pointOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </label>
          <label className="block text-xs text-slate-600">
            Komt terug op de hoofdlijn bij
            <select
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              value={form.mergesAtStopId}
              onChange={(e) => setForm({ ...form, mergesAtStopId: e.target.value })}
            >
              <option value="">— komt niet terug, dit spoor eindigt —</option>
              {pointOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </label>
        </>
      )}
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || update.isPending}
          onClick={() => update.mutate({
            id: track.id,
            title: form.title.trim(),
            status: form.status as "open" | "done" | "ended",
            // Empty string is "niet vastgelegd": an explicit null, so a branch
            // point can be REMOVED again. `undefined` would leave the old one
            // in place forever — the same rule the stop editor's link pickers
            // follow.
            branchesAtStopId: form.branchesAtStopId || null,
            mergesAtStopId: form.mergesAtStopId || null,
            note: form.note.trim() || null,
          })}
        >
          Opslaan
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {/* A refused merge or a refused ancestry change must say WHY in a
          sentence — the router writes those in Dutch, so show them as-is. */}
      {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
    </div>
  );
}
