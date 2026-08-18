import { serverCaller } from "@/lib/trpc-server";
import { formatEuro } from "@/components/registry-list";

// VerderGroep report — formal, official register (tone rule), print-styled,
// outside the (app) group so it renders without the app navigation.

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

const DEBT_STATUS_LABEL: Record<string, string> = {
  identified: "Geïnventariseerd",
  acknowledged: "Erkend",
  disputed: "Betwist",
  "in-settlement": "In afwikkeling",
  settled: "Afgewikkeld",
};

const CYCLE_LABEL: Record<string, string> = {
  monthly: "per maand",
  quarterly: "per kwartaal",
  yearly: "per jaar",
  irregular: "onregelmatig",
};

const th = "border-b border-black py-1 pr-4 text-left font-semibold";
const td = "border-b border-gray-300 py-1 pr-4 align-top";

export default async function RegistryExportPage() {
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
  const claimedTotalCents = report.debts.reduce((sum, d) => sum + d.claimedCents, 0);

  return (
    <main className="mx-auto max-w-3xl p-8 print:p-0 bg-white text-black">
      <header className="border-b pb-4 mb-6">
        <h1 className="text-2xl font-bold">Financieel overzicht — M. van der Poel</h1>
        <p className="text-sm">
          Opgesteld op {new Date(report.generatedAt).toLocaleString("nl-NL")} ·
          {" "}{report.items.length} post{report.items.length === 1 ? "" : "en"} ·
          {" "}{report.debts.length} schuld{report.debts.length === 1 ? "" : "en"}
        </p>
        <p className="text-xs break-all">Ledger head (SHA-256): {report.headHash ?? "—"}</p>
      </header>

      <section className="mb-8">
        <h2 className="text-lg font-bold mb-2">Abonnementen en doorlopende verplichtingen</h2>
        {groups.length === 0 && <p className="text-sm">Geen posten geregistreerd.</p>}
        {groups.map(({ status, rows }) => (
          <article key={status} className="mb-5 break-inside-avoid">
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
                    <td className={td}>{formatEuro(item.amountCents)} {CYCLE_LABEL[item.billingCycle] ?? item.billingCycle}</td>
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
              <td className="border-t-2 border-black py-1 pr-4">
                Totaal maandelijkse verplichtingen (exclusief beëindigd)
              </td>
              <td className="border-t-2 border-black py-1 text-right">{formatEuro(monthlyTotalCents)}</td>
            </tr>
            <tr>
              <td className="py-1 pr-4">Waarvan gemarkeerd voor opzegging</td>
              <td className="py-1 text-right">{formatEuro(toCancelMonthlyCents)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mb-8 break-inside-avoid">
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
                  <td className={td}>{formatEuro(debt.claimedCents)}</td>
                  <td className={td}>{debt.references ?? "—"}</td>
                  <td className={td}>{DEBT_STATUS_LABEL[debt.status] ?? debt.status}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="border-t-2 border-black py-1 pr-4">Totaal gevorderd</td>
                <td className="border-t-2 border-black py-1" />
                <td className="border-t-2 border-black py-1 pr-4">{formatEuro(claimedTotalCents)}</td>
                <td className="border-t-2 border-black py-1" colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <footer className="border-t pt-4 text-xs">
        This report was generated from an append-only, hash-chained log. Any alteration of past entries or files is detectable via the ledger head hash above.
      </footer>
    </main>
  );
}
