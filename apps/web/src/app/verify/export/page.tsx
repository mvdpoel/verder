import { serverCaller } from "@/lib/trpc-server";

export default async function ExportPage({ searchParams }: {
  searchParams: Promise<{ from: string; to: string }> }) {
  const { from, to } = await searchParams;
  const caller = await serverCaller();
  const exp = await caller.verify.exportRange({ from: new Date(from), to: new Date(`${to}T23:59:59Z`) });
  return (
    <main className="mx-auto max-w-3xl p-8 print:p-0 bg-white text-black">
      <header className="border-b pb-4 mb-6">
        <h1 className="text-2xl font-bold">Contact & Evidence Report — M. van der Poel</h1>
        <p className="text-sm">Period {new Date(exp.from).toLocaleDateString("nl-NL")} – {new Date(exp.to).toLocaleDateString("nl-NL")} · generated {new Date(exp.generatedAt).toLocaleString("nl-NL")}</p>
        <p className="text-xs break-all">Ledger head (SHA-256): {exp.headHash ?? "—"}</p>
      </header>
      {exp.entries.map((e) => (
        <article key={e.id} className="mb-6 break-inside-avoid">
          <h2 className="font-semibold">{new Date(e.occurredAt).toLocaleString("nl-NL")} — {e.summary}</h2>
          <p className="text-sm">Channel: {e.channel} ({e.direction}) · logged {new Date(e.recordedAt).toLocaleString("nl-NL")} · source {e.source}{e.supersedesId ? " · correction of an earlier entry" : ""}</p>
          {e.participants.length > 0 && <p className="text-sm">Present/involved: {e.participants.join(", ")}</p>}
          {e.details && <p className="text-sm whitespace-pre-wrap mt-1">{e.details}</p>}
          {e.actionItems.length > 0 && (
            <ul className="text-sm list-disc ml-5 mt-1">
              {e.actionItems.map((a) => <li key={a.id}>{a.description} ({a.clarity})</li>)}
            </ul>)}
          {e.documents.length > 0 && (
            <ul className="text-xs ml-5 mt-1">
              {e.documents.map((d) => <li key={d.sha256} className="break-all">📄 {d.title} — SHA-256 {d.sha256}</li>)}
            </ul>)}
        </article>
      ))}
      <footer className="border-t pt-4 text-xs">
        This report was generated from an append-only, hash-chained log. Any alteration of past entries or files is detectable via the ledger head hash above.
      </footer>
    </main>
  );
}
