"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { type LinkOption, linkId, linkOptionList } from "@/lib/stop-links";

/**
 * Create and edit a halte.
 *
 * A stop may exist before anything in the ledger corresponds to it — that is
 * the point of `verwacht`. What it must never do is copy a fact: the title and
 * the note are Martin's words, and everything else is read live from whatever
 * the stop links to.
 *
 * The three link pickers are the third level of the map — the mail, the task
 * and the files hanging off a halte. They store an ID and nothing else: no
 * title, no date, no status is copied across, so a halte can be AHEAD of
 * reality but can never contradict it. Each one clears back to "geen".
 */

type StopData = {
  id: string; title: string; kind: string; state: string;
  happenedAt: Date | string | null; expectedAt: Date | string | null;
  note: string | null;
  entryId: string | null; taskId: string | null; documentId: string | null;
};

/**
 * What the halte is linked to RIGHT NOW, resolved by the router.
 *
 * It is passed in only so a link that sits outside the picker's page of
 * candidates still shows its own name instead of looking unset — saving a form
 * that silently dropped a link Martin could not see would be the worst kind of
 * quiet edit. Structural, so this file imports nothing from @verder/api.
 */
type StopLinks = {
  entry: { id: string; summary: string } | null;
  task: { id: string; title: string } | null;
  documents: { id: string; title: string }[];
} | null;

const nlDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("nl-NL") : "";

const STATES = [
  { value: "done", label: "gebeurd" },
  { value: "open", label: "loopt nog" },
];

const KINDS = [
  { value: "process", label: "proces" }, { value: "mail", label: "post/mail" },
  { value: "call", label: "telefoon" }, { value: "meeting", label: "gesprek" },
  { value: "document", label: "document" }, { value: "other", label: "overig" },
];

const toDateInput = (d: Date | string | null): string =>
  d ? new Date(d).toISOString().slice(0, 10) : "";
const fromDateInput = (v: string): Date | null => (v ? new Date(v) : null);

export function AddStopForm({
  trackId, orderIndex,
}: {
  trackId: string;
  /**
   * Where on the line the new halte lands. Left out, the router appends at
   * max+1 — which on the hoofdlijn means AFTER the *Einde bewindvoering*
   * anchor the migration parked at 1000000, so the page passes a position
   * whenever it is inserting before that goal.
   */
  orderIndex?: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState("done");
  const create = trpc.tracks.createStop.useMutation({
    onSuccess: () => { setOpen(false); setTitle(""); router.refresh(); },
  });

  if (!open) {
    return (
      <button className="text-xs text-blue-600 hover:underline" onClick={() => setOpen(true)}>
        + halte
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        className="rounded border px-2 py-1 text-sm"
        placeholder="Wat gebeurde er?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <select
        className="rounded border px-2 py-1 text-sm"
        value={state}
        onChange={(e) => setState(e.target.value)}
      >
        {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <button
        className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
        disabled={!title.trim() || create.isPending}
        onClick={() => create.mutate({
          trackId, title: title.trim(),
          state: state as "done" | "open" | "expected",
          orderIndex,
        })}
      >
        Toevoegen
      </button>
      <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
        annuleren
      </button>
      {/* Without this a refused insert just does nothing and the halte
          silently never appears. Span, not p: this row is inline. */}
      {create.error && (
        <span className="w-full text-sm text-red-700">{create.error.message}</span>
      )}
    </span>
  );
}

export function StopEditor({ stop, links }: { stop: StopData; links?: StopLinks }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: stop.title, kind: stop.kind, state: stop.state,
    happenedAt: toDateInput(stop.happenedAt),
    expectedAt: toDateInput(stop.expectedAt),
    note: stop.note ?? "",
    entryId: stop.entryId ?? "",
    taskId: stop.taskId ?? "",
    documentId: stop.documentId ?? "",
  });
  const [search, setSearch] = useState("");
  // Only while the editor is open: /timeline renders one of these per selected
  // halte and there is no reason to fetch candidates nobody asked for.
  const options = trpc.tracks.linkOptions.useQuery(
    { search: search.trim() || null },
    { enabled: open },
  );
  const update = trpc.tracks.updateStop.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (!open) {
    return (
      <button className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(true)}>
        halte bewerken
      </button>
    );
  }
  const linkedDoc = links?.documents.find((d) => d.id === stop.documentId);
  const currentDocument: LinkOption | null = linkedDoc
    ? { id: linkedDoc.id, label: linkedDoc.title }
    : null;
  return (
    <div className="space-y-2 rounded border p-3">
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <div className="flex flex-wrap gap-2">
        <select
          className="rounded border px-2 py-1 text-sm"
          value={form.state}
          onChange={(e) => setForm({ ...form, state: e.target.value })}
        >
          {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value })}
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <label className="text-xs text-slate-600">
          gebeurd op
          <input type="date" className="ml-1 rounded border px-2 py-1 text-sm"
            value={form.happenedAt}
            onChange={(e) => setForm({ ...form, happenedAt: e.target.value })} />
        </label>
        <label className="text-xs text-slate-600">
          verwacht op
          <input type="date" className="ml-1 rounded border px-2 py-1 text-sm"
            value={form.expectedAt}
            onChange={(e) => setForm({ ...form, expectedAt: e.target.value })} />
        </label>
      </div>
      <textarea
        className="w-full rounded border px-2 py-1 text-sm"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />

      {/* The third level: wat hangt er achter deze halte. Only IDs are saved —
          the name, the date and the status you see here are read live again on
          every render of the kaart. */}
      <fieldset className="space-y-2 rounded border border-dashed p-2">
        <legend className="px-1 text-xs text-slate-600">Wat hangt hieraan?</legend>
        <input
          className="w-full rounded border px-2 py-1 text-sm"
          placeholder="Zoeken in logboek, taken en bestanden…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="block text-xs text-slate-600">
          Logboek
          <select
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            value={form.entryId}
            onChange={(e) => setForm({ ...form, entryId: e.target.value })}
          >
            <option value="">— geen —</option>
            {linkOptionList(
              (options.data?.entries ?? []).map((e) => ({
                id: e.id, label: `${e.summary} · ${nlDate(e.occurredAt)}`,
              })),
              links?.entry ? { id: links.entry.id, label: links.entry.summary } : null,
            ).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="block text-xs text-slate-600">
          Taak
          <select
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            value={form.taskId}
            onChange={(e) => setForm({ ...form, taskId: e.target.value })}
          >
            <option value="">— geen —</option>
            {linkOptionList(
              (options.data?.tasks ?? []).map((t) => ({
                id: t.id, label: `${t.title} (${t.status})`,
              })),
              links?.task ? { id: links.task.id, label: links.task.title } : null,
            ).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="block text-xs text-slate-600">
          Bestand
          <select
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            value={form.documentId}
            onChange={(e) => setForm({ ...form, documentId: e.target.value })}
          >
            <option value="">— geen —</option>
            {linkOptionList(
              (options.data?.documents ?? []).map((d) => ({
                id: d.id, label: `${d.title} · ${nlDate(d.receivedAt)}`,
              })),
              // The document this halte points at itself, if the search did not
              // return it. The other files in `links.documents` came off the
              // mail or the entry — they are derived, not linkable.
              currentDocument,
            ).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        {options.isLoading && (
          <p className="text-xs text-slate-400">Bezig met ophalen…</p>
        )}
        {/* Without this, a failed lookup looks exactly like "er is niets om aan
            te koppelen" — and Martin would go build the halte's evidence again. */}
        {options.error && (
          <p className="text-xs text-red-700">
            Kon de koppelingen niet ophalen: {options.error.message}
          </p>
        )}
      </fieldset>

      <div className="flex gap-2">
        <button
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={!form.title.trim() || update.isPending}
          onClick={() => update.mutate({
            id: stop.id, title: form.title.trim(),
            kind: form.kind as "process" | "mail" | "call" | "meeting" | "document" | "other",
            state: form.state as "done" | "open" | "expected",
            happenedAt: fromDateInput(form.happenedAt),
            expectedAt: fromDateInput(form.expectedAt),
            note: form.note.trim() || null,
            // Empty string is "geen": explicit null, so a link can be REMOVED.
            // `undefined` would leave the old one in place forever.
            entryId: linkId(form.entryId),
            taskId: linkId(form.taskId),
            documentId: linkId(form.documentId),
          })}
        >
          Opslaan
        </button>
        <button className="text-sm text-slate-500" onClick={() => setOpen(false)}>
          annuleren
        </button>
      </div>
      {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
    </div>
  );
}
