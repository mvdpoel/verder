"use client";

import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc-client";
import { buttonClass } from "@/components/ui";
import { formatBytes } from "@/lib/format-bytes";
import { needsSniffing, previewKind, rowCountLabel } from "./preview-kind";

export interface PreviewDoc {
  sha256: string;
  title: string;
  mime: string;
  sizeBytes?: number;
}

const FRAME = { tall: "h-[70vh]", short: "h-48" } as const;

/**
 * The quiet frame around a rendered document. A PDF page and a photographed
 * letter are white, and a white rectangle dropped straight onto this field has
 * no edge at all — it reads as a hole rather than as a page.
 */
const PAGE = "rounded-panel border border-edge";

function DownloadLink({ doc }: { doc: PreviewDoc }) {
  return (
    <a href={`/api/files/${doc.sha256}`} download={doc.title} className={buttonClass("ghost", "sm")}>
      Downloaden
    </a>
  );
}

function FileCard({ doc, reason }: { doc: PreviewDoc; reason?: string }) {
  return (
    <div className={`${PAGE} flex flex-col items-start gap-[10px] p-[18px]`}>
      <p className="break-all text-[13.5px] font-light text-ink-soft">{doc.title}</p>
      <p className="micro">
        {doc.mime || "onbekend bestandstype"}
        {doc.sizeBytes !== undefined && ` · ${formatBytes(doc.sizeBytes)}`}
        {` · ${reason ?? "geen voorbeeld beschikbaar"}`}
      </p>
      <DownloadLink doc={doc} />
    </div>
  );
}

function SheetTable({ doc, height, fallback }: {
  doc: PreviewDoc; height: keyof typeof FRAME; fallback?: ReactNode;
}) {
  const q = trpc.documents.sheetPreview.useQuery({ sha256: doc.sha256 });
  if (q.isPending) return <p className="micro">Bezig het werkblad te lezen…</p>;
  if (q.error) {
    // When we only GUESSED this was a spreadsheet (the stored mime said
    // nothing), a refusal is the answer to the guess, not an error to report.
    if (fallback) return <>{fallback}</>;
    return (
      // Not amber: nothing here waits on Martin. The file is intact and the
      // download beside the message is the whole way out.
      <div className={`${PAGE} flex flex-col items-start gap-[10px] p-[18px]`}>
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">Dit werkblad kon niet gelezen worden: {q.error.message}</p>
        <DownloadLink doc={doc} />
      </div>
    );
  }
  const { rows, totalSheets, sheetName, truncated } = q.data;
  const label = rowCountLabel(rows.length, truncated);
  return (
    <div className="flex flex-col items-start gap-3">
      <div className={`${FRAME[height]} ${PAGE} w-full overflow-auto`}>
        <table className="min-w-full border-collapse">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i === 0 ? "" : "border-t border-hairline"}>
                {row.map((cell, j) => (
                  // sticky belongs on the CELLS: browsers do not honour
                  // position:sticky on a <tr>, so a sticky row scrolls away.
                  // The header's background has to be OPAQUE (`bg-void`, not a
                  // panel tint) or the rows scroll through it.
                  <td key={j} className={`whitespace-nowrap px-[10px] py-[6px] align-top font-mono text-[11px] ${
                    i === 0 ? "sticky top-0 bg-void text-ink-label" : "text-ink-soft"}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="micro">
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
        <div className="flex flex-col items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- vault files are served by our own auth-gated route; next/image optimization would bypass it */}
          <img src={`/api/files/${doc.sha256}`} alt={doc.title} className={`${PAGE} max-w-full`} />
          <DownloadLink doc={doc} />
        </div>
      );
    case "pdf":
      return (
        <div className="flex flex-col items-start gap-3">
          <iframe src={`/api/files/${doc.sha256}`} className={`w-full ${FRAME[height]} ${PAGE}`}
            title={doc.title} />
          <DownloadLink doc={doc} />
        </div>
      );
    case "sheet":
      return <SheetTable doc={doc} height={height} />;
    case "file":
      // A mime that says nothing is not an answer. ABN's "Excel" export is
      // stored as application/octet-stream and `documents` is append-only, so
      // that row will never say anything else — the server looks at the bytes
      // and either returns a table or refuses, and a refusal falls back to the
      // download card.
      return needsSniffing(doc.mime)
        ? <SheetTable doc={doc} height={height} fallback={<FileCard doc={doc} />} />
        : <FileCard doc={doc} />;
  }
}
