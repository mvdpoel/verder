"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { discardAction, senderOptions, type DocStatus } from "./document-meta-form-actions";
import { DocumentPurge } from "./document-purge";

export function DocumentMetaForm({ doc, entries, parties, docTypes }: {
  doc: { id: string; title: string; docType: string | null; partyId: string | null;
    status: DocStatus; previousStatus: DocStatus };
  entries: { id: string; summary: string }[];
  parties: { id: string; name: string }[];
  docTypes: string[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.docType ?? "");
  const [partyId, setPartyId] = useState(doc.partyId ?? "");
  const [entryId, setEntryId] = useState("");
  const update = trpc.documents.update.useMutation({ onSuccess: () => router.refresh() });
  const link = trpc.documents.linkToEntry.useMutation({ onSuccess: () => router.refresh() });
  const discarded = doc.status === "discarded";
  const action = discardAction(doc.status, doc.previousStatus);
  return (
    <div className="flex flex-col gap-5">
      {/* Signal, not amber: a discarded document waits on nobody. This is the
          system explaining what it did with the file, which is the cyan voice. */}
      {discarded && (
        <Notice tone="signal">
          Weggelegd — blijft in de kluis, maar staat niet meer in de lijsten en
          in zoeken. Zet het terug om het weer te kunnen bewerken.
        </Notice>
      )}
      {/* Disabled while discarded: there is no save path on a discarded
          document (see below), so an editable box would just lose what was
          typed on the next refresh. */}
      <Field label="Titel" htmlFor="doc-title">
        <Input id="doc-title" value={title} disabled={discarded}
          onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Soort" htmlFor="doc-type">
        {/* A datalist, not a fixed vocabulary: it keeps the soorten already in
            use one keystroke away without blocking a new one Martin needs. */}
        <Input id="doc-type" list="doc-types" placeholder="contract, loonstrook, brief…"
          value={docType} disabled={discarded} onChange={(e) => setDocType(e.target.value)} />
        <datalist id="doc-types">
          {docTypes.map((t) => <option key={t} value={t} />)}
        </datalist>
      </Field>
      <Field label="Van wie" htmlFor="doc-party">
        <Select id="doc-party" value={partyId} disabled={discarded}
          onChange={(e) => setPartyId(e.target.value)}>
          <option value="">Onbekend</option>
          {senderOptions(parties, doc.partyId).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-[10px]">
        {!discarded && (
          <Button variant="primary" disabled={update.isPending}
            onClick={() => update.mutate({ id: doc.id, status: "filed", title,
              docType: docType || undefined, partyId: partyId || undefined })}>
            {doc.status === "inbox" ? "Opbergen ✔" : "Wijzigingen opslaan"}
          </Button>
        )}
        {/* Quiet secondary action: discard is never the primary path, and it is
            always reversible — the same button offers the opposite move.
            The current title/type/sender ride along so the transition does not
            reset them: effectiveDocument reads only the LATEST status change
            row, so a discard that omitted partyId here would write a row with
            no opinion on the sender and silently revert a corrected one back
            to the raw ingest-time value.

            It leads the screen only in the one state where it is the ONLY move
            left: on a discarded document the save button is gone, and the way
            back must be the thing the eye lands on. Amber is not an option for
            either spelling — a discard waits on nobody. */}
        <Button variant={discarded ? "primary" : "ghost"} disabled={update.isPending}
          onClick={() => update.mutate({ id: doc.id, status: action.next,
            title: doc.title, docType: doc.docType ?? undefined,
            partyId: doc.partyId ?? undefined })}>
          {action.label}
        </Button>
      </div>
      <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
        <Field label="Koppelen aan een logboekregel" htmlFor="doc-entry" className="w-full">
          <Select id="doc-entry" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">— kies een regel —</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.summary}</option>)}
          </Select>
        </Field>
        <Button disabled={!entryId || link.isPending}
          onClick={() => link.mutate({ documentId: doc.id, entryId })}>Koppelen</Button>
      </div>
      <DocumentPurge doc={{ id: doc.id }} />
    </div>
  );
}
