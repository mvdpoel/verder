import { redirect } from "next/navigation";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import {
  BILLING_CYCLE_LABEL, DEBT_STATUS_LABEL, formatEuro,
} from "@/components/registry-list";

// VerderGroep report — formal, official register (tone rule), print-styled,
// outside the (app) group so it renders without the app navigation.
//
// This page is PAPER, not screen: the app's field is dark and its type is the
// display face, but this is a document Martin hands to Verder or puts through a
// printer. `print-doc` in globals.css restores a white page, dark ink and an
// ordinary sans face, and it must sit on a FULL-WIDTH wrapper — put it on the
// max-w-3xl column and the white page becomes a white strip on a black field.
//
// The colours below are therefore deliberately NOT design tokens: every token in
// this system is tuned for the dark field and would be invisible here. They are
// the paper palette, spelled out locally, and nothing else uses them. The bare
// `border-b`/`border-t` this file used before resolved to currentColor, which is
// not a decision anyone made.

const RULE = "border-[#0f172a]";
const RULE_LIGHT = "border-[#cbd5e1]";
const INK_MUTED = "text-[#475569]";

const ITEM_STATUS_ORDER = [
  "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled",
] as const;

const ITEM_STATUS_LABEL: Record<string, string> = {
  identified: "Geïnventariseerd — nog geen besluit",
  mandatory: "Noodzakelijk",
  allowed: "Toegestaan",
  requested: "Aangevraagd",
  "to-cancel": "Op te zeggen",
  canceled: "Beëindigd",
};

// DEBT_STATUS_LABEL and the billing cycles come from components/registry-list,
// which is where the screens read them too. This file kept its own copies, and
// a report that names a status differently from the page it was printed from is
// the drift that costs a conversation with the bewindvoerder.
//
// ITEM_STATUS_LABEL below is NOT the shared one and is deliberately its own:
// these are the section HEADINGS of a formal document ("Geïnventariseerd — nog
// geen besluit"), not the one-word chip a screen puts beside a row.
const th = `border-b ${RULE} py-1 pr-4 text-left font-semibold`;
const td = `border-b ${RULE_LIGHT} py-1 pr-4 align-top`;

export default async function RegistryExportPage() {
  // These two pages sit OUTSIDE the (app) group, so the layout's session check
  // never runs for them and middleware.ts only proves a cookie EXISTS. An
  // untrusted session's cookie outlives its database row by design (30-day
  // max-age, 12-hour row), so without this the reader is handed an UNAUTHORIZED
  // crash page instead of the login screen — on the one document in this app
  // that gets printed and handed to somebody.
  if (!(await getSessionUserId())) redirect("/login");
  const caller = await serverCaller();
  const report = await caller.registry.exportReport();

  const groups = ITEM_STATUS_ORDER
    .map((status) => ({ status, rows: report.items.filter((i) => i.status === status) }))
    .filter((g) => g.rows.length > 0);
  // Integer-cent sums only — canceled items no longer cost anything.
  const monthlyTotalCents = report.items
    .filter((i) => i.status !== "canceled")
    .reduce((sum, i) => sum + i.monthlyCents, 0);
  const toCancelMonthlyCents = report.items
    .filter((i) => i.status === "to-cancel")
    .reduce((sum, i) => sum + i.monthlyCents, 0);
  // Some notices (the KvK aanmaning) state no total. Summing only the known
  // amounts while presenting the result as THE total would report a smaller
  // debt burden than the notices actually state — so the total is disclosed
  // alongside how many debts it does not cover, the same discipline the money
  // page's disclosure blocks enforce.
  const debtsWithClaimedAmount = report.debts.filter((d) => d.claimedCents !== null);
  const claimedTotalCents = debtsWithClaimedAmount
    .reduce((sum, d) => sum + (d.claimedCents as number), 0);
  const debtsWithoutClaimedAmount = report.debts.length - debtsWithClaimedAmount.length;

  return (
    <div className="print-doc">
      <main className="mx-auto max-w-3xl p-8 print:p-0">
        <header className={`border-b ${RULE} pb-4 mb-6`}>
          <h1 className="text-2xl font-bold">Financieel overzicht — M. van der Poel</h1>
          <p className={`text-sm ${INK_MUTED}`}>
            Opgesteld op {new Date(report.generatedAt).toLocaleString("nl-NL")} ·
            {" "}{report.items.length} post{report.items.length === 1 ? "" : "en"} ·
            {" "}{report.debts.length} schuld{report.debts.length === 1 ? "" : "en"}
          </p>
          {/* The head hash is what a reader checks this report against, so it is set in
              mono: in a proportional face 0/O and 1/l cannot be told apart by eye. */}
          <p className={`text-xs break-all font-mono ${INK_MUTED}`}>Controlehash van het dossier (SHA-256): {report.headHash ?? "—"}</p>
        </header>

        {/* The tables scroll inside their own section on a narrow screen rather than
            pushing the whole document sideways — but overflow is reset for print,
            where a clipped column would silently drop a figure from the report. */}
        <section className="mb-8 overflow-x-auto print:overflow-x-visible">
          <h2 className="text-lg font-bold mb-2">Abonnementen en doorlopende verplichtingen</h2>
          {groups.length === 0 && <p className="text-sm">Geen posten geregistreerd.</p>}
          {groups.map(({ status, rows }) => (
            <article key={status} className="mb-5 break-inside-avoid overflow-x-auto print:overflow-x-visible">
              <h3 className="font-semibold mb-1">{ITEM_STATUS_LABEL[status] ?? status}</h3>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Post</th>
                    <th className={th}>Aanbieder</th>
                    <th className={th}>Kosten</th>
                    <th className={th}>Per maand</th>
                    <th className={th}>Toelichting (laatste besluit)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.id}>
                      <td className={td}>{item.name}</td>
                      <td className={td}>{item.providerName ?? "—"}</td>
                      <td className={td}>{formatEuro(item.amountCents)} {BILLING_CYCLE_LABEL[item.billingCycle] ?? item.billingCycle}</td>
                      <td className={td}>{formatEuro(item.monthlyCents)}</td>
                      <td className={td}>{item.latestExplanation ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
          <table className="w-full text-sm border-collapse mt-2">
            <tbody>
              <tr className="font-semibold">
                <td className={`border-t-2 ${RULE} py-1 pr-4`}>
                  Totaal maandelijkse verplichtingen (exclusief beëindigd)
                </td>
                <td className={`border-t-2 ${RULE} py-1 text-right`}>{formatEuro(monthlyTotalCents)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-4">Waarvan gemarkeerd voor opzegging</td>
                <td className="py-1 text-right">{formatEuro(toCancelMonthlyCents)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="mb-8 break-inside-avoid overflow-x-auto print:overflow-x-visible">
          <h2 className="text-lg font-bold mb-2">Schulden</h2>
          {report.debts.length === 0 ? (
            <p className="text-sm">Geen schulden geregistreerd.</p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className={th}>Schuldeiser</th>
                  <th className={th}>Hoofdsom</th>
                  <th className={th}>Gevorderd</th>
                  <th className={th}>Kenmerk</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.debts.map((debt) => (
                  <tr key={debt.id}>
                    <td className={td}>{debt.creditorName}</td>
                    <td className={td}>{debt.principalCents == null ? "—" : formatEuro(debt.principalCents)}</td>
                    <td className={td}>{debt.claimedCents == null ? "—" : formatEuro(debt.claimedCents)}</td>
                    <td className={td}>{debt.references ?? "—"}</td>
                    <td className={td}>{DEBT_STATUS_LABEL[debt.status] ?? debt.status}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`border-t-2 ${RULE} py-1 pr-4`}>Totaal gevorderd (bekende bedragen)</td>
                  <td className={`border-t-2 ${RULE} py-1`} />
                  <td className={`border-t-2 ${RULE} py-1 pr-4`}>{formatEuro(claimedTotalCents)}</td>
                  <td className={`border-t-2 ${RULE} py-1`} colSpan={2} />
                </tr>
                {debtsWithoutClaimedAmount > 0 && (
                  <tr>
                    <td className={`py-1 pr-4 text-xs ${INK_MUTED}`} colSpan={5}>
                      Waarvan {debtsWithoutClaimedAmount} schuld{debtsWithoutClaimedAmount === 1 ? "" : "en"} zonder vermeld bedrag, niet in dit totaal meegeteld
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>

        <footer className={`border-t ${RULE} pt-4 text-xs ${INK_MUTED}`}>
          Dit overzicht is opgesteld uit een logboek dat alleen aangevuld kan worden en
          per regel met een hash aan de vorige vastzit. Wijziging van een eerdere regel of
          van een bijgevoegd bestand is aantoonbaar via de controlehash hierboven.
        </footer>
      </main>
    </div>
  );
}
