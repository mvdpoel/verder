import { serverCaller } from "@/lib/trpc-server";
import { orNotFound } from "@/lib/not-found";
import { DocumentMetaForm } from "@/components/document-meta-form";
import { DocumentPreview } from "@/components/document-preview";
import { DocumentPurgeRetry } from "@/components/document-purge";
import { purgeTombstoneLine } from "@/components/document-purge-copy";
import { Notice, PageTitle, Panel } from "@/components/ui";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  // In parallel: none of these four depends on another. Sequentially these
  // were two round trips deep, and with no loading state that is two waits
  // on a blank screen — the same mistake the /files page's own block exists
  // to avoid.
  const [d, entries, parties, tree] = await Promise.all([
    orNotFound(caller.documents.get({ id })),
    caller.entries.list({ limit: 100 }),
    caller.parties.list(),
    caller.documents.tree(),
  ]);
  // "Zonder soort" (the empty key) is a to-do list, not a suggestion anyone
  // would type into the field — same filter `BundleCards` applies.
  const docTypes = tree.soort.filter((s) => s.key !== "").map((s) => s.label);
  return (
    <div className="flex flex-col gap-7">
      {/*
        The title and the hash lead the page full width rather than sitting in
        the left column: the hash is what identifies this document in the ledger,
        and it belongs to both halves of the screen, not to the preview.
      */}
      <header className="flex flex-col gap-[9px]">
        <PageTitle>
          {d.effectiveTitle}
        </PageTitle>
        <p className="micro break-all">sha256: {d.sha256}</p>
      </header>
      {/* One column below the breakpoint: a PDF and a form side by side at 600px
          each are two unreadable columns. */}
      {d.purge ? (
        /*
          A tombstone, not a two-column editor. There is no preview (the bytes
          are gone), nothing to edit and no way back — so the page's whole job
          is to say what was destroyed, when, and why.
        */
        <Panel className="p-[26px] flex flex-col gap-4">
          <Notice tone="signal">{purgeTombstoneLine(d.purge)}</Notice>
          <dl className="flex flex-col gap-2">
            <div><dt className="micro">Soort</dt><dd>{d.effectiveDocType ?? "Zonder soort"}</dd></div>
            <div><dt className="micro">Grootte</dt><dd>{d.purge.sizeBytes} bytes</dd></div>
            <div><dt className="micro">sha256</dt><dd className="micro break-all">{d.purge.sha256}</dd></div>
          </dl>
          {/* Amber, and this one earns it: an unfinished action waiting on
              somebody. The unlink runs after the purge transaction commits, so
              this state means it failed and the bytes are still on disk. */}
          {d.purge.bytesStillOnDisk && (
            <Notice tone="attn">
              Het bestand staat nog op schijf — de vernietiging is niet afgerond.
              <DocumentPurgeRetry id={d.id} />
            </Notice>
          )}
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel lit className="p-[22px]">
            <DocumentPreview doc={{ sha256: d.sha256, title: d.effectiveTitle, mime: d.mime,
              sizeBytes: d.sizeBytes }} />
          </Panel>
          <Panel className="p-[26px]">
            <DocumentMetaForm doc={{ id: d.id, title: d.effectiveTitle, docType: d.effectiveDocType,
              partyId: d.effectivePartyId, status: d.effectiveStatus, previousStatus: d.previousStatus }}
              entries={entries.map((e) => ({ id: e.id, summary: e.summary }))}
              parties={parties.map((p) => ({ id: p.id, name: p.name }))} docTypes={docTypes} />
          </Panel>
        </div>
      )}
    </div>
  );
}
