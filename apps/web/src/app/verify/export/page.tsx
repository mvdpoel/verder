import { notFound, redirect } from "next/navigation";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { CHANNEL_LABEL, CLARITY_LABEL, DIRECTION_LABEL, ENTRY_SOURCE_LABEL } from "@/lib/entry-labels";

/*
 * IN DUTCH, like /registry/export beside it and for the same reason: this is a
 * document Martin hands to VerderGroep, who are Dutch bewindvoerders, and copy
 * matches the file it is in. It was the last English thing in the app that
 * leaves the building — the app may be read in either language, but a report
 * addressed to someone else may not.
 *
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
  // These two pages sit OUTSIDE the (app) group, so the layout's session check
  // never runs for them and middleware.ts only proves a cookie EXISTS. An
  // untrusted session's cookie outlives its database row by design (30-day
  // max-age, 12-hour row), so without this the reader is handed an UNAUTHORIZED
  // crash page instead of the login screen — on the one document in this app
  // that gets printed and handed to somebody.
  if (!(await getSessionUserId())) redirect("/login");
  const { from, to } = await searchParams;
  // This URL is built by the verify panel, but it is also a plain link someone
  // can bookmark, retype or truncate. Without this, a missing or malformed date
  // reaches `z.coerce.date()` as an Invalid Date, comes back BAD_REQUEST and
  // renders as an unstyled crash — on a report page, which is the last place
  // anyone should meet one.
  const fromDate = new Date(from);
  const toDate = new Date(`${to}T23:59:59Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) notFound();
  const caller = await serverCaller();
  const exp = await caller.verify.exportRange({ from: fromDate, to: toDate });
  return (
    <div className="print-doc">
      <main className="mx-auto max-w-3xl p-8 print:p-0">
        <header className={`border-b ${RULE} pb-4 mb-6`}>
          <h1 className="text-2xl font-bold">Contact- en bewijsoverzicht — M. van der Poel</h1>
          <p className={`text-sm ${INK_MUTED}`}>Periode {new Date(exp.from).toLocaleDateString("nl-NL")} t/m {new Date(exp.to).toLocaleDateString("nl-NL")} · opgesteld op {new Date(exp.generatedAt).toLocaleString("nl-NL")} · {exp.entries.length} {exp.entries.length === 1 ? "regel" : "regels"}</p>
          {/* The head hash is what a reader checks this report against, so it is set in
              mono: in a proportional face 0/O and 1/l cannot be told apart by eye. */}
          <p className={`text-xs break-all font-mono ${INK_MUTED}`}>Controlehash van het dossier (SHA-256): {exp.headHash ?? "—"}</p>
        </header>
        {exp.entries.length === 0 && (
          <p className="text-sm">In deze periode is geen contact vastgelegd.</p>
        )}
        {exp.entries.map((e) => (
          <article key={e.id} className="mb-6 break-inside-avoid">
            <h2 className="font-semibold">{new Date(e.occurredAt).toLocaleString("nl-NL")} — {e.summary}</h2>
            <p className={`text-sm ${INK_MUTED}`}>Kanaal: {CHANNEL_LABEL[e.channel] ?? e.channel} ({DIRECTION_LABEL[e.direction] ?? e.direction}) · vastgelegd {new Date(e.recordedAt).toLocaleString("nl-NL")} · bron {ENTRY_SOURCE_LABEL[e.source] ?? e.source}{e.supersedesId ? " · correctie op een eerdere regel" : ""}</p>
            {e.participants.length > 0 && <p className={`text-sm ${INK_MUTED}`}>Betrokken: {e.participants.join(", ")}</p>}
            {e.details && <p className="text-sm whitespace-pre-wrap mt-1">{e.details}</p>}
            {e.actionItems.length > 0 && (
              <ul className="text-sm list-disc ml-5 mt-1">
                {e.actionItems.map((a) => <li key={a.id}>{a.description} ({CLARITY_LABEL[a.clarity] ?? a.clarity})</li>)}
              </ul>)}
            {e.documents.length > 0 && (
              <ul className={`text-xs ml-5 mt-1 ${INK_MUTED}`}>
                {e.documents.map((d) => <li key={d.sha256} className="break-all">📄 {d.title} — <span className="font-mono">SHA-256 {d.sha256}</span></li>)}
              </ul>)}
          </article>
        ))}
        <footer className={`border-t ${RULE} pt-4 text-xs ${INK_MUTED}`}>
          Dit overzicht is opgesteld uit een logboek dat alleen aangevuld kan worden en
          per regel met een hash aan de vorige vastzit. Wijziging van een eerdere regel of
          van een bijgevoegd bestand is aantoonbaar via de controlehash hierboven.
        </footer>
      </main>
    </div>
  );
}
