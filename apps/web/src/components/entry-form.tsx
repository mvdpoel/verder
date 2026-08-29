"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"] as const;

export function EntryForm({ correctId }: { correctId?: string }) {
  const router = useRouter();
  const parties = trpc.parties.list.useQuery();
  const original = trpc.entries.get.useQuery({ id: correctId! }, { enabled: !!correctId });
  const createParty = trpc.parties.create.useMutation({ onSuccess: () => parties.refetch() });
  const create = trpc.entries.create.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });
  const correct = trpc.entries.correct.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });

  const [form, setForm] = useState({
    occurredAt: new Date().toISOString().slice(0, 16),
    channel: "call" as (typeof CHANNELS)[number],
    direction: "inbound" as "inbound" | "outbound" | "internal",
    summary: "", details: "", participantPartyIds: [] as string[],
    actionItems: [] as { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[],
  });
  const [newParty, setNewParty] = useState("");
  const [newPartyParentId, setNewPartyParentId] = useState("");
  const organizations = parties.data?.filter((p) => p.kind === "organization") ?? [];

  // Pre-fill once when correcting
  const o = original.data;
  if (correctId && o && form.summary === "" && o.summary !== "") {
    setForm((f) => ({ ...f, summary: o.summary, details: o.details ?? "",
      channel: o.channel, direction: o.direction,
      occurredAt: new Date(o.occurredAt).toISOString().slice(0, 16),
      participantPartyIds: o.participants.map((p) => p.partyId) }));
  }

  const submit = () => {
    const payload = { ...form, occurredAt: new Date(form.occurredAt),
      details: form.details || undefined, documentIds: [], source: "manual" as const };
    if (correctId) correct.mutate({ ...payload, supersedesId: correctId });
    else create.mutate(payload);
  };

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">{correctId ? "Correct an entry" : "Log a contact moment"}</h1>
      {correctId && <p className="text-sm text-slate-600">The original stays on record; this saves a linked correction.</p>}
      <div className="grid grid-cols-3 gap-3">
        <label className="block">When<input type="datetime-local" className="w-full border rounded p-2"
          value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>
        <label className="block">Channel<select className="w-full border rounded p-2" value={form.channel}
          onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })}>
          {CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block">Direction<select className="w-full border rounded p-2" value={form.direction}
          onChange={(e) => setForm({ ...form, direction: e.target.value as typeof form.direction })}>
          <option>inbound</option><option>outbound</option><option>internal</option></select></label>
      </div>
      <label className="block">What happened (short)<input className="w-full border rounded p-2"
        value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
      <label className="block">Details<textarea className="w-full border rounded p-2" rows={5}
        value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
      <fieldset>
        <legend className="font-semibold">Who was involved</legend>
        {parties.data?.map((p) => (
          <label key={p.id} className="mr-4"><input type="checkbox"
            checked={form.participantPartyIds.includes(p.id)}
            onChange={(e) => setForm({ ...form, participantPartyIds: e.target.checked
              ? [...form.participantPartyIds, p.id]
              : form.participantPartyIds.filter((x) => x !== p.id) })} /> {p.name}</label>
        ))}
        <div className="flex gap-2 mt-2">
          <input className="border rounded p-2 flex-1" placeholder="Add a person or organization"
            value={newParty} onChange={(e) => setNewParty(e.target.value)} />
          {/* A contact person is a person whose parent is the organization. This
              is not cosmetic: pollGmail builds its relevance filter from
              parties.email, so recording a contact's address is what makes
              their mail start being ingested. */}
          <select className="border rounded p-2" value={newPartyParentId}
            onChange={(e) => setNewPartyParentId(e.target.value)}
            aria-label="Parent organisation">
            <option value="">No parent organisation</option>
            {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button type="button" className="rounded border px-3"
            onClick={() => { if (newParty) {
              createParty.mutate({ kind: "person", name: newParty, parentPartyId: newPartyParentId || null });
              setNewParty(""); setNewPartyParentId("");
            } }}>Add</button>
        </div>
      </fieldset>
      <fieldset>
        <legend className="font-semibold">Agreed actions</legend>
        {form.actionItems.map((a, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input className="border rounded p-2 flex-1" value={a.description}
              onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, description: e.target.value } : x) })} />
            <select className="border rounded p-2" value={a.clarity}
              onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, clarity: e.target.value as typeof a.clarity } : x) })}>
              <option>clear</option><option>ambiguous</option><option>already-provided</option></select>
          </div>
        ))}
        <button type="button" className="rounded border px-3 py-1"
          onClick={() => setForm({ ...form, actionItems: [...form.actionItems, { description: "", clarity: "clear" }] })}>+ action</button>
      </fieldset>
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!form.summary || create.isPending || correct.isPending} onClick={submit}>
        {correctId ? "Save correction" : "Save to the record"}
      </button>
    </div>
  );
}
