"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Label,
  PageTitle,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { CHANNEL_LABEL, CLARITY_LABEL, DIRECTION_LABEL } from "@/lib/entry-labels";

const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"] as const;

export function EntryForm({ correctId }: { correctId?: string }) {
  const router = useRouter();
  const parties = trpc.parties.list.useQuery();
  const original = trpc.entries.get.useQuery({ id: correctId! }, { enabled: !!correctId });
  const createParty = trpc.parties.create.useMutation({ onSuccess: () => parties.refetch() });
  const create = trpc.entries.create.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });
  const correct = trpc.entries.correct.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });
  // Every control here carries its label, so every control needs an id that is
  // stable across server and client render — that is exactly what useId is for.
  const uid = useId();

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
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-[10px]">
        <PageTitle className="leading-none">
          {correctId ? "Een regel corrigeren" : "Contactmoment vastleggen"}
        </PageTitle>
        {/*
          A correction never overwrites the original, and saying so is not a
          warning — it is the reason this log can be believed. Ink ramp, not
          amber: nothing here is waiting on Martin that the form itself is not
          already asking for.
        */}
        {correctId && (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Het origineel blijft staan; dit slaat een gekoppelde correctie op.
          </p>
        )}
      </div>

      <Panel lit className="flex flex-col gap-5 p-[26px]">
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Wanneer" htmlFor={`${uid}-when`}>
            <Input id={`${uid}-when`} type="datetime-local" value={form.occurredAt}
              onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} />
          </Field>
          <Field label="Kanaal" htmlFor={`${uid}-channel`}>
            <Select id={`${uid}-channel`} value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })}>
              {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>)}
            </Select>
          </Field>
          <Field label="Richting" htmlFor={`${uid}-direction`}>
            <Select id={`${uid}-direction`} value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value as typeof form.direction })}>
              {(["inbound", "outbound", "internal"] as const).map((d) => (
                <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Wat is er gebeurd (kort)" htmlFor={`${uid}-summary`}>
          <Input id={`${uid}-summary`} value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })} />
        </Field>
        <Field label="Toelichting" htmlFor={`${uid}-details`}>
          <Textarea id={`${uid}-details`} rows={5} value={form.details}
            onChange={(e) => setForm({ ...form, details: e.target.value })} />
        </Field>
      </Panel>

      <Panel className="p-[26px]">
        <fieldset>
          <Label as="legend">Wie erbij waren</Label>
          <div className="mt-4 grid gap-x-6 gap-y-[11px] sm:grid-cols-2 lg:grid-cols-3">
            {parties.data?.map((p) => (
              <Checkbox key={p.id} label={p.name}
                checked={form.participantPartyIds.includes(p.id)}
                onChange={(e) => setForm({ ...form, participantPartyIds: e.target.checked
                  ? [...form.participantPartyIds, p.id]
                  : form.participantPartyIds.filter((x) => x !== p.id) })} />
            ))}
          </div>
          <div className="mt-5 flex flex-col gap-[10px] border-t border-hairline pt-4 sm:flex-row sm:items-center">
            <div className="sm:grow">
              {/* The placeholder is the only name this control has ever had, so
                  it is also its accessible name — a filled-in field with no
                  label is unreadable months later. */}
              <Input placeholder="Persoon of organisatie toevoegen" aria-label="Persoon of organisatie toevoegen"
                value={newParty} onChange={(e) => setNewParty(e.target.value)} />
            </div>
            {/* A contact person is a person whose parent is the organization. This
                is not cosmetic: pollGmail builds its relevance filter from
                parties.email, so recording a contact's address is what makes
                their mail start being ingested. */}
            <div className="sm:w-[230px] sm:shrink-0">
              <Select value={newPartyParentId}
                onChange={(e) => setNewPartyParentId(e.target.value)}
                aria-label="Onderdeel van organisatie">
                <option value="">Geen bovenliggende organisatie</option>
                {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </div>
            <Button variant="ghost" size="sm" className="sm:shrink-0"
              onClick={() => { if (newParty) {
                createParty.mutate({ kind: "person", name: newParty, parentPartyId: newPartyParentId || null });
                setNewParty(""); setNewPartyParentId("");
              } }}>Toevoegen</Button>
          </div>
        </fieldset>
      </Panel>

      <Panel className="p-[26px]">
        <fieldset>
          <Label as="legend">Afgesproken acties</Label>
          {form.actionItems.map((a, i) => (
            <div key={i} className="mt-4 flex flex-col gap-[10px] sm:flex-row sm:items-center">
              <div className="sm:grow">
                <Input aria-label="Afgesproken actie" value={a.description}
                  onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, description: e.target.value } : x) })} />
              </div>
              <div className="sm:w-[230px] sm:shrink-0">
                <Select aria-label="Duidelijkheid" value={a.clarity}
                  onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, clarity: e.target.value as typeof a.clarity } : x) })}>
                  {(["clear", "ambiguous", "already-provided"] as const).map((c) => (
                    <option key={c} value={c}>{CLARITY_LABEL[c]}</option>
                  ))}
                </Select>
              </div>
            </div>
          ))}
          <div className="mt-4">
            <Button variant="ghost" size="sm"
              onClick={() => setForm({ ...form, actionItems: [...form.actionItems, { description: "", clarity: "clear" }] })}>+ actie</Button>
          </div>
        </fieldset>
      </Panel>

      {/* The one primary on this screen: saving is what the page is for. */}
      <div>
        <Button variant="primary"
          disabled={!form.summary || create.isPending || correct.isPending} onClick={submit}>
          {correctId ? "Correctie opslaan" : "Vastleggen in het dossier"}
        </Button>
      </div>
    </div>
  );
}
