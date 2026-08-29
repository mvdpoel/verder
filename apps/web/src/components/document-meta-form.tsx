"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { discardAction, type DocStatus } from "./document-meta-form-actions";

export function DocumentMetaForm({ doc, entries }: {
  doc: { id: string; title: string; docType: string | null;
    status: DocStatus; previousStatus: DocStatus };
  entries: { id: string; summary: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.docType ?? "");
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
          Discarded — kept in the vault, hidden from lists and search.
          Undo the discard to edit it.
        </Notice>
      )}
      {/* Disabled while discarded: there is no save path on a discarded
          document (see below), so an editable box would just lose what was
          typed on the next refresh. */}
      <Field label="Title" htmlFor="doc-title">
        <Input id="doc-title" value={title} disabled={discarded}
          onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Type" htmlFor="doc-type">
        <Input id="doc-type" placeholder="contract, payslip, letter…" value={docType}
          disabled={discarded} onChange={(e) => setDocType(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-[10px]">
        {!discarded && (
          <Button variant="primary" disabled={update.isPending}
            onClick={() => update.mutate({ id: doc.id, status: "filed", title, docType: docType || undefined })}>
            {doc.status === "inbox" ? "File it ✔" : "Save changes"}
          </Button>
        )}
        {/* Quiet secondary action: discard is never the primary path, and it is
            always reversible — the same button offers the opposite move.
            The current title/type ride along so the transition does not reset
            them: effectiveDocument reads only the LATEST status change row.

            It leads the screen only in the one state where it is the ONLY move
            left: on a discarded document the save button is gone, and the way
            back must be the thing the eye lands on. Amber is not an option for
            either spelling — a discard waits on nobody. */}
        <Button variant={discarded ? "primary" : "ghost"} disabled={update.isPending}
          onClick={() => update.mutate({ id: doc.id, status: action.next,
            title: doc.title, docType: doc.docType ?? undefined })}>
          {action.label}
        </Button>
      </div>
      <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
        <Field label="Link to a logbook entry" htmlFor="doc-entry" className="w-full">
          <Select id="doc-entry" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">— pick an entry —</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.summary}</option>)}
          </Select>
        </Field>
        <Button disabled={!entryId || link.isPending}
          onClick={() => link.mutate({ documentId: doc.id, entryId })}>Link</Button>
      </div>
    </div>
  );
}
