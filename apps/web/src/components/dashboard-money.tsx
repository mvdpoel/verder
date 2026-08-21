import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { MoneyChart } from "@/components/money-chart";
import { euro } from "@/components/money-format";
import { DASHBOARD_MONTHS, dashboardMoneySlice } from "@/lib/dashboard-money-slice";

/**
 * The money block on the dashboard: half a year of one account, in and out,
 * and a way through to /money.
 *
 * It shows LESS than /money on purpose. No drill, no legend, no projection and
 * no disclosures — a dashboard summary that quietly left out the incidental
 * credits and the coverage gaps would be a smaller version of the page telling
 * a rounder story, and this page's whole argument is that everything the bars
 * leave out is visible next to them. So the block draws the actual months and
 * nothing else, says which account it is showing, and hands the reader to
 * /money for the rest.
 */
export async function DashboardMoney() {
  const caller = await serverCaller();
  const { series, accountLabels } = await caller.money.series();
  const slice = dashboardMoneySlice(series);

  if (!slice) {
    return (
      <section>
        <h2 className="mb-2 font-semibold">Geld in en uit</h2>
        <p className="text-sm text-slate-500">
          Nog geen afschriften ingelezen —{" "}
          <Link className="hover:underline" href="/registry/import">
            importeer een bankafschrift
          </Link>{" "}
          en dit overzicht bouwt zichzelf op.
        </p>
      </section>
    );
  }

  const accountName = slice.accountIban
    ? (accountLabels[slice.accountIban] ?? slice.accountIban)
    : "onbekende rekening";
  const last = slice.months[slice.months.length - 1];
  const shown = { ...slice.account, months: slice.months, projected: [] };

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold">Geld in en uit</h2>
        <Link className="text-sm text-slate-500 hover:underline" href="/money">
          alle maanden en rekeningen →
        </Link>
      </div>
      {/* One link around the block, so the compact chart carries no links of
          its own — see MoneyChart's `compact` prop. */}
      <Link href="/money" className="block rounded border bg-white p-4 hover:bg-slate-50">
        <p className="truncate text-xs text-slate-500" title={accountName}>
          {accountName} ·{" "}
          {slice.months.length === 1
            ? "laatste maand"
            : `laatste ${Math.min(DASHBOARD_MONTHS, slice.months.length)} maanden`}
        </p>
        <div className="mt-2">
          <MoneyChart series={[shown]} accountLabels={accountLabels} compact />
        </div>
        <p className="mt-2 text-xs text-slate-500" style={{ fontVariantNumeric: "tabular-nums" }}>
          {last.month}: {euro(last.inCents)} vast inkomen · {euro(last.outCents)} uitgaven
          {last.coverage !== "complete" && " · mogelijk incompleet"}
        </p>
      </Link>
    </section>
  );
}
