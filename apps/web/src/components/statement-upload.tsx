"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type IngestSummary = {
  statementSha256: string; inserted: number; skipped: number; errors: number; source: string;
};
type UploadResult = { filename: string; summary?: IngestSummary; error?: string };

/**
 * Statement drop zone: mirrors UploadDrop, but posts to /api/registry-import
 * (vault-first, then parse) and shows the per-file ingest summary.
 */
export function StatementUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const next: UploadResult[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.append("file", file);
      try {
        const res = await fetch("/api/registry-import", { method: "POST", body: fd });
        const body = await res.json();
        next.push(res.ok
          ? { filename: file.name, summary: body as IngestSummary }
          : { filename: file.name, error: (body as { error?: string }).error ?? "upload failed" });
      } catch {
        next.push({ filename: file.name, error: "upload failed — please try again" });
      }
    }
    setResults((prev) => [...next, ...prev]);
    setBusy(false); router.refresh();
  };

  return (
    <div className="space-y-4">
      <label className="block rounded border-2 border-dashed p-8 text-center cursor-pointer bg-white"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        {busy ? "Reading your statement…"
          : "Drop a bank or PayPal statement here (ABN CAMT.053, ABN TSV, ABN Excel, PayPal CSV) or click to choose"}
        <input type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
      </label>
      {results.length > 0 && (
        <ul className="space-y-2">
          {results.map((r, i) => (
            <li key={`${r.filename}-${i}`} className="rounded border bg-white p-3 text-sm">
              <span className="font-medium">{r.filename}</span>
              {r.summary ? (
                <>
                  <span className="text-slate-600">
                    {" — "}{r.summary.inserted} transaction{r.summary.inserted === 1 ? "" : "s"} imported
                    {r.summary.skipped > 0 && `, ${r.summary.skipped} already known`}
                    {r.summary.errors > 0 && `, ${r.summary.errors} row${r.summary.errors === 1 ? "" : "s"} we couldn't read (kept safely, nothing lost)`}
                    {" · "}{r.summary.source}
                  </span>
                  <span className="block text-slate-600 mt-1">
                    Recurring charges show up in the{" "}
                    <Link href="/queue" className="underline">review queue</Link> within a couple of minutes.
                  </span>
                </>
              ) : (
                <span className="text-red-700"> — {r.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
