import { serverCaller } from "@/lib/trpc-server";
import { DocumentMetaForm } from "@/components/document-meta-form";

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
        {d.mime.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element -- vault files are served by our own auth-gated route; next/image optimization would bypass it
          ? <img src={`/api/files/${d.sha256}`} alt={d.effectiveTitle} className="max-w-full border rounded" />
          : <iframe src={`/api/files/${d.sha256}`} className="w-full h-[70vh] border rounded" title={d.effectiveTitle} />}
      </div>
      <DocumentMetaForm doc={{ id: d.id, title: d.effectiveTitle, docType: d.effectiveDocType,
        status: d.effectiveStatus }} entries={entries.map((e) => ({ id: e.id, summary: e.summary }))} />
    </div>
  );
}
