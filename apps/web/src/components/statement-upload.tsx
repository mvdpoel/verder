"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Panel, TextLink } from "@/components/ui";

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
          : { filename: file.name, error: (body as { error?: string }).error ?? "uploaden mislukt" });
      } catch {
        next.push({ filename: file.name, error: "uploaden mislukt — probeer het nog een keer" });
      }
    }
    setResults((prev) => [...next, ...prev]);
    setBusy(false); router.refresh();
  };

  return (
    <div className="space-y-5">
      {/*
        The input is `sr-only` and not `hidden`: a `display: none` control is
        not focusable, which left the whole drop zone unreachable from the
        keyboard. `focus-within` puts the same cyan edge on the label that the
        input would have shown itself.
      */}
      <label
        className="block cursor-pointer rounded-panel border border-dashed border-edge-strong bg-field p-8 text-center text-[13.5px] font-light text-ink-mute transition-colors hover:border-signal/50 hover:text-ink-soft focus-within:border-signal"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        {busy
          ? <span className="micro animate-breathe">Je afschrift wordt gelezen…</span>
          : "Sleep hier een bank- of PayPal-afschrift heen (ABN CAMT.053, ABN TSV, ABN Excel, PayPal CSV), of klik om te kiezen"}
        <input type="file" multiple className="sr-only" onChange={(e) => void upload(e.target.files)} />
      </label>
      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((r, i) => (
            <Panel as="li" key={`${r.filename}-${i}`} className="p-[18px] text-[13px] font-light">
              <span className="font-mono text-[11.5px] tracking-[0.06em] text-ink-soft">{r.filename}</span>
              {r.summary ? (
                <>
                  <span className="text-ink-mute">
                    {" — "}{r.summary.inserted} {r.summary.inserted === 1 ? "transactie" : "transacties"} ingelezen
                    {r.summary.skipped > 0 && `, ${r.summary.skipped} al bekend`}
                    {r.summary.errors > 0 && `, ${r.summary.errors} ${r.summary.errors === 1 ? "regel" : "regels"} konden we niet lezen (veilig bewaard, niets kwijt)`}
                    {" · "}{r.summary.source}
                  </span>
                  <span className="mt-2 block leading-relaxed text-ink-mute">
                    Terugkerende afschrijvingen verschijnen binnen een paar minuten{" "}
                    <TextLink href="/queue">bij de voorstellen</TextLink>.
                  </span>
                </>
              ) : (
                /* Amber, and this is the documented exception to "amber means
                   waiting on Martin": an upload that failed is literally
                   waiting on him to try it again. Left inline rather than moved
                   into `FormError`: the em dash joins it to the filename above,
                   and a block would break the sentence. */
                <span className="text-attn"> — {r.error}</span>
              )}
            </Panel>
          ))}
        </ul>
      )}
    </div>
  );
}
