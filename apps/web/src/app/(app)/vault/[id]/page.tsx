import { serverCaller } from "@/lib/trpc-server";
import { DocumentMetaForm } from "@/components/document-meta-form";
import { DocumentPreview } from "@/components/document-preview";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const d = await caller.documents.get({ id });
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div className="grid grid-cols-2 gap-8">
      <div>
        <h1 className="text-xl font-bold mb-1">{d.effectiveTitle}</h1>
        <p className="text-xs text-slate-500 mb-4 break-all">sha256: {d.sha256}</p>
        <DocumentPreview doc={{ sha256: d.sha256, title: d.effectiveTitle, mime: d.mime,
          sizeBytes: d.sizeBytes }} />
      </div>
      <DocumentMetaForm doc={{ id: d.id, title: d.effectiveTitle, docType: d.effectiveDocType,
        status: d.effectiveStatus }} entries={entries.map((e) => ({ id: e.id, summary: e.summary }))} />
    </div>
  );
}
