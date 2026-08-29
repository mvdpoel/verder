"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button, Field, FormError, Input, Panel, Select, Textarea } from "@/components/ui";

/**
 * Create and edit a spoor. Tracks are an editable display aid (NOT ledgered) —
 * the evidence stays in the logbook and the vault — so editing here is as
 * low-ceremony as fixing a typo.
 *
 * No `variant="primary"` on either save button: /timeline can have one of these
 * open per spoor at the same time, and the glow only means "press here" while
 * there is one of it on the screen. The page spends its single primary on the
 * halte editor, which can only ever exist once.
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
  const ids = useId();
  const create = trpc.tracks.createTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (!open) {
    return (
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        + nieuw zijspoor
      </Button>
    );
  }
  const branchStop = stops.find((s) => s.id === form.branchesAtStopId);
  return (
    <Panel className="w-full p-[18px]">
      <div className="flex flex-col gap-4">
        {/* The controls carry a visible name of their own now: a placeholder
            disappears the moment you type, and this form is re-read months
            later. The placeholders stay — they are the example, not the name. */}
        <Field label="Zijspoor" htmlFor={`${ids}-title`}>
          <Input
            id={`${ids}-title`}
            placeholder="Waar gaat dit spoor over? (bijv. Ontruiming)"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label="Vertrekt bij welke halte?" htmlFor={`${ids}-branch`}>
          <Select
            id={`${ids}-branch`}
            value={form.branchesAtStopId}
            onChange={(e) => setForm({ ...form, branchesAtStopId: e.target.value })}
          >
            <option value="">— kies een halte —</option>
            {stops.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select>
        </Field>
        <Field label="Notitie" htmlFor={`${ids}-note`}>
          <Textarea
            id={`${ids}-note`}
            rows={3}
            placeholder="Notitie (optioneel)"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
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
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
            annuleren
          </Button>
        </div>
        {/* Amber, and legitimately so: a refused save is the form waiting on
            Martin to change something. It is the same exception `Field` makes
            for an invalid control. */}
        {create.error && (
          <FormError>{create.error.message}</FormError>
        )}
      </div>
    </Panel>
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
  const ids = useId();
  const update = trpc.tracks.updateTrack.useMutation({
    onSuccess: () => { setOpen(false); router.refresh(); },
  });

  if (!open) {
    return (
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        bewerken
      </Button>
    );
  }
  // Only stops on the PARENT track can be a branch or a merge point: a spoor
  // leaves the line it belongs to and rejoins that same line, never a third
  // one. The router refuses anything else with a sentence in Dutch — this list
  // is what keeps him from ever reading it.
  const pointOptions = stops.filter((s) => s.trackId === track.parentTrackId);
  return (
    <Panel className="mt-2 w-full p-[18px]">
      <div className="flex flex-col gap-4">
        <Field label="Titel" htmlFor={`${ids}-title`}>
          <Input
            id={`${ids}-title`}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label="Status" htmlFor={`${ids}-status`}>
          <Select
            id={`${ids}-status`}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        {/* The two ends of a zijspoor, side by side. The branch point exists
            because migration 0026 nulled every one of them: the map draws a
            spoor's departure from its own oldest halte, so the pointer is
            semantic only — "dit spoor komt uit DIE gebeurtenis voort". NULL is
            the honest default and stays reachable, because for most sporen
            nobody ever wrote the origin down and the app may not invent one.
            Neither control is shown for the hoofdlijn: it leaves nothing and
            comes back on nothing, and the router refuses both. */}
        {track.parentTrackId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vertrekt bij welke halte?" htmlFor={`${ids}-branch`}>
              <Select
                id={`${ids}-branch`}
                value={form.branchesAtStopId}
                onChange={(e) => setForm({ ...form, branchesAtStopId: e.target.value })}
              >
                <option value="">— niet vastgelegd —</option>
                {pointOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </Select>
            </Field>
            <Field label="Komt terug op de hoofdlijn bij" htmlFor={`${ids}-merge`}>
              <Select
                id={`${ids}-merge`}
                value={form.mergesAtStopId}
                onChange={(e) => setForm({ ...form, mergesAtStopId: e.target.value })}
              >
                <option value="">— komt niet terug, dit spoor eindigt —</option>
                {pointOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Notitie" htmlFor={`${ids}-note`}>
          <Textarea
            id={`${ids}-note`}
            rows={3}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
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
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
            annuleren
          </Button>
        </div>
        {/* A refused merge or a refused ancestry change must say WHY in a
            sentence — the router writes those in Dutch, so show them as-is. */}
        {update.error && (
          <FormError>{update.error.message}</FormError>
        )}
      </div>
    </Panel>
  );
}
