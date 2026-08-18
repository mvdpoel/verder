import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { formatEuro, RegistryDebtsList, RegistryItemsList } from "@/components/registry-list";

export default async function RegistryPage({ searchParams }: {
  searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab: "items" | "debts" = tabParam === "debts" ? "debts" : "items";
  const caller = await serverCaller();
  const stats = await caller.registry.stats();
  const items = tab === "items" ? await caller.registry.items.list() : [];
  const debts = tab === "debts" ? await caller.registry.debts.list() : [];

  const tabClass = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Registry</h1>
        <div className="flex gap-2">
          <Link href="/registry/new" className="rounded bg-slate-900 text-white px-4 py-2">+ Add</Link>
          <Link href="/registry/import" className="rounded border px-4 py-2 hover:bg-slate-100">Import statement</Link>
          <Link href="/registry/export" className="rounded border px-4 py-2 hover:bg-slate-100">Export report</Link>
        </div>
      </div>
      <p className="text-slate-600">
        {stats.itemCount} item{stats.itemCount === 1 ? "" : "s"} · {formatEuro(stats.monthlyTotalCents)}/mo total
        · {formatEuro(stats.toCancelMonthlyCents)}/mo marked to cancel
        · {stats.pendingDecisions} decision{stats.pendingDecisions === 1 ? "" : "s"} pending
      </p>
      <nav className="flex gap-2 border-b pb-2">
        <Link href="/registry?tab=items" className={tabClass(tab === "items")}>Subscriptions &amp; contracts</Link>
        <Link href="/registry?tab=debts" className={tabClass(tab === "debts")}>Debts</Link>
      </nav>
      {tab === "items"
        ? <RegistryItemsList items={items} />
        : <RegistryDebtsList debts={debts} />}
    </div>
  );
}
