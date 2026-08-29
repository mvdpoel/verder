import { serverCaller } from "@/lib/trpc-server";

/*
 * This page is PAPER, not screen. The app's field is dark and its type is the
 * display face; a report Martin hands to Verder (or puts through a printer) is
 * white with ordinary sans ink. `print-doc` in globals.css restores exactly
 * that, and it has to sit on a full-width wrapper — put it on the max-w-3xl
 * column and the white page becomes a white strip on a black field.
 *
 * The colours below are therefore deliberately NOT design tokens: every token
 * in this system is tuned for the dark field and would be invisible here. They
 * are the paper palette, spelled out locally, and nothing else uses them. The
 * bare `border-b`/`border-t` this file used before resolved to currentColor,
 * which is not a decision anyone made.
 */
const RULE = "border-[#0f172a]";
const INK_MUTED = "text-[#475569]";

export default async function ExportPage({ searchParams }: {
  searchParams: Promise<{ from: string; to: string }> }) {
  const { from, to } = await searchParams;
  const caller = await serverCaller();
  const exp = await caller.verify.exportRange({ from: new Date(from), to: new Date(`${to}T23:59:59Z`) });
  return (
    <div className="print-doc">
      <main className="mx-auto max-w-3xl p-8 print:p-0">
        <header className={`border-b ${RULE} pb-4 mb-6`}>
          <h1 className="text-2xl font-bold">Contact & Evidence Report — M. van der Poel</h1>
          <p className={`text-sm ${INK_MUTED}`}>Period {new Date(exp.from).toLocaleDateString("nl-NL")} – {new Date(exp.to).toLocaleDateString("nl-NL")} · generated {new Date(exp.generatedAt).toLocaleString("nl-NL")}</p>
          {/* The head hash is what a reader checks this report against, so it is set in
              mono: in a proportional face 0/O and 1/l cannot be told apart by eye. */}
          <p className={`text-xs break-all font-mono ${INK_MUTED}`}>Ledger head (SHA-256): {exp.headHash ?? "—"}</p>
        </header>
        {exp.entries.map((e) => (
          <article key={e.id} className="mb-6 break-inside-avoid">
            <h2 className="font-semibold">{new Date(e.occurredAt).toLocaleString("nl-NL")} — {e.summary}</h2>
            <p className={`text-sm ${INK_MUTED}`}>Channel: {e.channel} ({e.direction}) · logged {new Date(e.recordedAt).toLocaleString("nl-NL")} · source {e.source}{e.supersedesId ? " · correction of an earlier entry" : ""}</p>
            {e.participants.length > 0 && <p className={`text-sm ${INK_MUTED}`}>Present/involved: {e.participants.join(", ")}</p>}
            {e.details && <p className="text-sm whitespace-pre-wrap mt-1">{e.details}</p>}
            {e.actionItems.length > 0 && (
              <ul className="text-sm list-disc ml-5 mt-1">
                {e.actionItems.map((a) => <li key={a.id}>{a.description} ({a.clarity})</li>)}
              </ul>)}
            {e.documents.length > 0 && (
              <ul className={`text-xs ml-5 mt-1 ${INK_MUTED}`}>
                {e.documents.map((d) => <li key={d.sha256} className="break-all">📄 {d.title} — <span className="font-mono">SHA-256 {d.sha256}</span></li>)}
              </ul>)}
          </article>
        ))}
        <footer className={`border-t ${RULE} pt-4 text-xs ${INK_MUTED}`}>
          This report was generated from an append-only, hash-chained log. Any alteration of past entries or files is detectable via the ledger head hash above.
        </footer>
      </main>
    </div>
  );
}
