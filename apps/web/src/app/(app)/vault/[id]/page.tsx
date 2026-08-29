import { serverCaller } from "@/lib/trpc-server";
import { DocumentMetaForm } from "@/components/document-meta-form";
import { DocumentPreview } from "@/components/document-preview";
import { PageTitle, Panel } from "@/components/ui";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const d = await caller.documents.get({ id });
  const entries = await caller.entries.list({ limit: 100 });
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
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel lit className="p-[22px]">
          <DocumentPreview doc={{ sha256: d.sha256, title: d.effectiveTitle, mime: d.mime,
            sizeBytes: d.sizeBytes }} />
        </Panel>
        <Panel className="p-[26px]">
          <DocumentMetaForm doc={{ id: d.id, title: d.effectiveTitle, docType: d.effectiveDocType,
            status: d.effectiveStatus, previousStatus: d.previousStatus }} entries={entries.map((e) => ({ id: e.id, summary: e.summary }))} />
        </Panel>
      </div>
    </div>
  );
}
