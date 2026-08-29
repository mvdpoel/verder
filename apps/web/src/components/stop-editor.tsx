"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { type LinkOption, linkId, linkOptionList } from "@/lib/stop-links";
import {
  Button,
  Field,
  FormError,
  Input,
  Label,
  Micro,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";

/**
 * Create and edit a halte.
 *
 * A stop may exist before anything in the ledger corresponds to it — a halte
 * that is `loopt nog` is exactly that. What it must never do is copy a fact:
 * the title and the note are Martin's words, and everything else is read live
 * from whatever the stop links to.
 *
 * The editor offers two states and one date. `verwacht` and `verwacht op` are
 * gone with migration 0026: the page's axis is time, and a stop the future has
 * not reached has no date to put on it.
 *
 * The three link pickers are the third level of the map — the mail, the task
 * and the files hanging off a halte. They store an ID and nothing else: no
 * title, no date, no status is copied across, so a halte can be AHEAD of
 * reality but can never contradict it. Each one clears back to "geen".
 *
 * This is the page's ONE primary button: /timeline renders exactly one halte
 * editor (keyed on the selected stop), so the glow cannot end up doubled the
 * way it would on the per-spoor editors.
 */

type StopData = {
  id: string; title: string; kind: string; state: string;
  happenedAt: Date | string | null;
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

/**
 * A new halte always lands at the END of its spoor: the router appends at
 * max+1. There is no `orderIndex` prop any more — the hoofdlijn lost the
 * *Einde bewindvoering* anchor that used to sit at 1000000 and forced callers
 * to insert before it, and the vertical map orders by DATE, not by position.
 */
export function AddStopForm({ trackId }: { trackId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState("done");
  const ids = useId();
  const create = trpc.tracks.createStop.useMutation({
    onSuccess: () => { setOpen(false); setTitle(""); router.refresh(); },
  });

  if (!open) {
    return (
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        + halte
      </Button>
    );
  }
  return (
    <Panel className="mt-2 w-full p-[18px]">
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Halte" htmlFor={`${ids}-title`}>
            <Input
              id={`${ids}-title`}
              placeholder="Wat gebeurde er?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Status" htmlFor={`${ids}-state`}>
            <Select
              id={`${ids}-state`}
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!title.trim() || create.isPending}
            onClick={() => create.mutate({
              trackId, title: title.trim(),
              state: state as "done" | "open" | "expected",
            })}
          >
            Toevoegen
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
            annuleren
          </Button>
        </div>
        {/* Without this a refused insert just does nothing and the halte
            silently never appears. Amber for the same reason `Field` puts its
            error there: a form that will not save is waiting on Martin. */}
        {create.error && (
          <FormError>{create.error.message}</FormError>
        )}
      </div>
    </Panel>
  );
}

export function StopEditor({ stop, links }: { stop: StopData; links?: StopLinks }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: stop.title, kind: stop.kind, state: stop.state,
    happenedAt: toDateInput(stop.happenedAt),
    note: stop.note ?? "",
    entryId: stop.entryId ?? "",
    taskId: stop.taskId ?? "",
    documentId: stop.documentId ?? "",
  });
  const [search, setSearch] = useState("");
  const ids = useId();
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
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        halte bewerken
      </Button>
    );
  }
  const linkedDoc = links?.documents.find((d) => d.id === stop.documentId);
  const currentDocument: LinkOption | null = linkedDoc
    ? { id: linkedDoc.id, label: linkedDoc.title }
    : null;
  return (
    <Panel className="p-[18px]">
      <div className="flex flex-col gap-4">
        <Field label="Titel" htmlFor={`${ids}-title`}>
          <Input
            id={`${ids}-title`}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Status" htmlFor={`${ids}-state`}>
            <Select
              id={`${ids}-state`}
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
            >
              {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="Soort" htmlFor={`${ids}-kind`}>
            <Select
              id={`${ids}-kind`}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </Field>
          <Field label="gebeurd op" htmlFor={`${ids}-date`}>
            <Input
              id={`${ids}-date`}
              type="date"
              value={form.happenedAt}
              onChange={(e) => setForm({ ...form, happenedAt: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Notitie" htmlFor={`${ids}-note`}>
          <Textarea
            id={`${ids}-note`}
            rows={3}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>

        {/* The third level: wat hangt er achter deze halte. Only IDs are saved —
            the name, the date and the status you see here are read live again on
            every render of the kaart. */}
        <fieldset className="flex flex-col gap-4 rounded-panel border border-dashed border-edge-strong p-4">
          {/* The real <legend>, carrying the system's label type: it names the
              group for a screen reader as well as for the eye, which a <div>
              styled the same way would not. */}
          <Label as="legend" className="px-1">Wat hangt hieraan?</Label>
          <Field label="Zoeken" htmlFor={`${ids}-search`}>
            <Input
              id={`${ids}-search`}
              placeholder="Zoeken in logboek, taken en bestanden…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Logboek" htmlFor={`${ids}-entry`}>
            <Select
              id={`${ids}-entry`}
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
            </Select>
          </Field>
          <Field label="Taak" htmlFor={`${ids}-task`}>
            <Select
              id={`${ids}-task`}
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
            </Select>
          </Field>
          <Field label="Bestand" htmlFor={`${ids}-document`}>
            <Select
              id={`${ids}-document`}
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
            </Select>
          </Field>
          {options.isLoading && <Micro>Bezig met ophalen…</Micro>}
          {/* Without this, a failed lookup looks exactly like "er is niets om aan
              te koppelen" — and Martin would go build the halte's evidence again.
              Cyan and NOT amber: a lookup that failed is the system reporting on
              itself, and the halte still saves. Amber would claim Martin owes
              this list something, which is the one thing amber may never do —
              the same call `already-have-this.tsx` and the search notice make. */}
          {options.error && (
            <p className="text-[12px] font-light leading-relaxed text-signal">
              Kon de koppelingen niet ophalen: {options.error.message}
            </p>
          )}
        </fieldset>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!form.title.trim() || update.isPending}
            onClick={() => update.mutate({
              id: stop.id, title: form.title.trim(),
              kind: form.kind as "process" | "mail" | "call" | "meeting" | "document" | "other",
              state: form.state as "done" | "open" | "expected",
              happenedAt: fromDateInput(form.happenedAt),
              // `expectedAt` is deliberately NOT sent. The column and the router
              // field still exist, and an undefined field is left untouched by
              // the update — so an old expected date is preserved in the row and
              // simply never shown, rather than being quietly erased by an editor
              // that no longer asks about it.
              note: form.note.trim() || null,
              // Empty string is "geen": explicit null, so a link can be REMOVED.
              // `undefined` would leave the old one in place forever.
              entryId: linkId(form.entryId),
              taskId: linkId(form.taskId),
              documentId: linkId(form.documentId),
            })}
          >
            Opslaan
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
            annuleren
          </Button>
        </div>
        {update.error && (
          <FormError>{update.error.message}</FormError>
        )}
      </div>
    </Panel>
  );
}
