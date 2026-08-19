"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { EVENT_KINDS, KIND_LABEL, type EventKind } from "./timeline-kinds";

// "Add to timeline" on a logbook entry: the entry stays the evidence, the key
// event is the story you'd tell about it. Prefilled from the entry, but the
// title is editable — a summary is a record, a timeline title is a sentence.

/** A logbook channel suggests, but never dictates, the key-event kind. */
export function kindForChannel(channel: string): EventKind {
  switch (channel) {
    case "call": case "voicemail": return "call";
    case "meeting": return "meeting";
    case "email": case "whatsapp": case "letter": return "mail";
    default: return "other";
  }
}

export function AddToTimeline(
  { entryId, summary, occurredAt, channel, alreadyOnTimeline }:
  { entryId: string; summary: string; occurredAt: string; channel: string;
    alreadyOnTimeline: boolean },
) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(summary);
  const [happenedAt, setHappenedAt] = useState(new Date(occurredAt).toISOString().slice(0, 10));
  const [kind, setKind] = useState<EventKind>(kindForChannel(channel));
  const [note, setNote] = useState("");
  // router.refresh() re-runs the server component, which re-reads the link
  // state — so the "on the timeline" confirmation needs no client query.
  const create = trpc.timeline.create.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (alreadyOnTimeline) {
    return (
      <p className="text-sm text-slate-600">
        ✓ On the timeline —{" "}
        <Link className="underline" href="/timeline">see the story so far</Link>
      </p>
    );
  }

  if (!open) {
    return (
      <button className="inline-block rounded border px-4 py-2 hover:bg-slate-100"
        onClick={() => setOpen(true)}>
        Add to timeline
      </button>
    );
  }

  return (
    <div className="rounded border bg-slate-50 p-3 space-y-2">
      <p className="text-sm text-slate-600">
        This entry stays the evidence — the timeline just tells the story of it.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm flex-1 min-w-48">What happened
          <input className="w-full border rounded p-2" value={title}
            onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Date
          <input type="date" className="border rounded p-2" value={happenedAt}
            onChange={(e) => setHappenedAt(e.target.value)} /></label>
        <label className="block text-sm">Kind
          <select className="border rounded p-2" value={kind}
            onChange={(e) => setKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select></label>
      </div>
      <label className="block text-sm">Note (optional)
        <input className="w-full border rounded p-2" placeholder="context worth keeping"
          value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="flex gap-2">
        <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
          disabled={!title.trim() || !happenedAt || create.isPending}
          onClick={() => create.mutate({
            title: title.trim(), happenedAt: new Date(happenedAt), kind,
            note: note.trim() || null, entryId,
          })}>
          Add to timeline
        </button>
        <button className="rounded border px-4 py-2 hover:bg-white" onClick={() => setOpen(false)}>
          Cancel</button>
      </div>
      {create.error && <p className="text-sm text-red-600">{create.error.message}</p>}
    </div>
  );
}
