"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import {
  Button,
  Field,
  FormError,
  Input,
  Panel,
  PanelHead,
  Select,
  Textarea,
} from "@/components/ui";

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
  // Every control is labelled, so every control needs an id that is unique on
  // the page — the detail screen renders this form beside another one.
  const uid = useId();
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
    opts: { id: string; text: string }[]) => {
    const id = `${uid}-${key}`;
    return (
      <Field label={label} htmlFor={id}>
        <Select id={id} value={value}
          onChange={(e) => set({ [key]: e.target.value } as Partial<typeof form>)}>
          <option value="">— none —</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
        </Select>
      </Field>
    );
  };

  return (
    /*
     * `lit` in create mode only: on /tasks/new this panel IS the page, while on
     * the detail screen the ledger-backed status form leads and there may be
     * exactly one lit panel per screen.
     */
    <Panel lit={!task} className="p-[26px]">
      <div className="flex flex-col gap-[18px]">
        <PanelHead labelAs="h2" label={task ? "De gegevens" : "Nieuwe taak"} />
        {!task && (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Eén duidelijke volgende stap — opschrijven is het halve werk.
          </p>
        )}
        <Field label="Titel" htmlFor={`${uid}-title`}>
          <Input id={`${uid}-title`}
            placeholder="bijv. Kopie paspoort naar VerderGroep sturen"
            value={form.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Toelichting (optioneel)" htmlFor={`${uid}-details`}>
          <Textarea id={`${uid}-details`} rows={3}
            placeholder="alles wat je later nodig hebt om dit echt te doen"
            value={form.details} onChange={(e) => set({ details: e.target.value })} />
        </Field>
        <div className="grid gap-[18px] sm:grid-cols-2">
          <Field label="Uiterlijk op (optioneel)" htmlFor={`${uid}-due`}>
            <Input id={`${uid}-due`} type="date"
              value={form.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />
          </Field>
          <Field label="Wie doet het" htmlFor={`${uid}-assignee`}>
            <Select id={`${uid}-assignee`} value={form.assigneePartyId}
              onChange={(e) => set({ assigneePartyId: e.target.value })}>
              <option value="">— nog niemand —</option>
              {options.parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-[18px] sm:grid-cols-2">
          {linkSelect("Logboekregel (optioneel)", form.entryId, "entryId",
            options.entries.map((e) => ({ id: e.id, text: e.label })))}
          {linkSelect("Post in het register (optioneel)", form.financialItemId, "financialItemId",
            options.items.map((i) => ({ id: i.id, text: i.name })))}
          {linkSelect("Vordering (optioneel)", form.debtId, "debtId",
            options.debts.map((d) => ({ id: d.id, text: d.creditorName })))}
          {linkSelect("Document (optioneel)", form.documentId, "documentId",
            options.documents.map((d) => ({ id: d.id, text: d.title })))}
        </div>
        {/* A form that will not submit is waiting on Martin — the one thing amber says. */}
        {error && (
          <FormError>
            {error.message}
          </FormError>
        )}
        <div>
          <Button variant={task ? "ghost" : "primary"}
            disabled={!form.title.trim() || pending} onClick={submit}>
            {task ? "Gegevens opslaan" : "Taak toevoegen"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
