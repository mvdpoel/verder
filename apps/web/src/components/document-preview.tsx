"use client";

import { trpc } from "@/lib/trpc-client";
import { previewKind, rowCountLabel } from "./preview-kind";

export interface PreviewDoc {
  sha256: string;
  title: string;
  mime: string;
}

const FRAME = { tall: "h-[70vh]", short: "h-48" } as const;

function DownloadLink({ doc }: { doc: PreviewDoc }) {
  return (
    <a href={`/api/files/${doc.sha256}`} download={doc.title}
      className="inline-block rounded border px-3 py-1 text-sm">
      Download
    </a>
  );
}

function SheetTable({ doc, height }: { doc: PreviewDoc; height: keyof typeof FRAME }) {
  const q = trpc.documents.sheetPreview.useQuery({ sha256: doc.sha256 });
  if (q.isPending) return <p className="text-sm text-slate-500">Reading spreadsheet…</p>;
  if (q.error) {
    return (
      <div className="rounded border p-4 space-y-2">
        <p className="text-sm text-slate-600">This spreadsheet could not be read: {q.error.message}</p>
        <DownloadLink doc={doc} />
      </div>
    );
  }
  const { rows, totalRows, totalSheets, sheetName, truncated } = q.data;
  const label = rowCountLabel(rows.length, totalRows, truncated);
  return (
    <div className="space-y-2">
      <div className={`${FRAME[height]} overflow-auto rounded border`}>
        <table className="min-w-full text-xs">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i === 0 ? "sticky top-0 bg-slate-100 font-medium" : "border-t"}>
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-nowrap px-2 py-1 align-top">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {sheetName}
        {totalSheets > 1 && ` · sheet 1 of ${totalSheets}`}
        {label && ` · ${label}`}
      </p>
      <DownloadLink doc={doc} />
    </div>
  );
}

/**
 * The single preview used by the vault page and the queue card. Before this
 * existed, both had the same two-way branch: image, or <iframe> for everything
 * else — so a spreadsheet served as octet-stream simply downloaded.
 */
export function DocumentPreview({ doc, height = "tall" }: {
  doc: PreviewDoc; height?: keyof typeof FRAME;
}) {
  switch (previewKind(doc.mime)) {
    case "image":
      return (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- vault files are served by our own auth-gated route; next/image optimization would bypass it */}
          <img src={`/api/files/${doc.sha256}`} alt={doc.title} className="max-w-full border rounded" />
          <DownloadLink doc={doc} />
        </div>
      );
    case "pdf":
      return (
        <div className="space-y-2">
          <iframe src={`/api/files/${doc.sha256}`} className={`w-full ${FRAME[height]} border rounded`}
            title={doc.title} />
          <DownloadLink doc={doc} />
        </div>
      );
    case "sheet":
      return <SheetTable doc={doc} height={height} />;
    case "file":
      return (
        <div className="rounded border p-4 space-y-2">
          <p className="text-sm font-medium break-all">{doc.title}</p>
          <p className="text-xs text-slate-500">{doc.mime || "unknown type"} · no preview available</p>
          <DownloadLink doc={doc} />
        </div>
      );
  }
}
