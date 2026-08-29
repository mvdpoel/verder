import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { formatEuro, RegistryDebtsList, RegistryItemsList } from "@/components/registry-list";
import { buttonClass, PageTitle, Tabs } from "@/components/ui";

export default async function RegistryPage({ searchParams }: {
  searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab: "items" | "debts" = tabParam === "debts" ? "debts" : "items";
  const caller = await serverCaller();
  const stats = await caller.registry.stats();
  const items = tab === "items" ? await caller.registry.items.list() : [];
  // debts.list() carries its own eiser/intermediary/reported-to-Verder
  // projection, resolved server-side in one grouped query — no per-row fetch.
  const debts = tab === "debts" ? await caller.registry.debts.list() : [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <PageTitle>Registry</PageTitle>
          <p className="text-[13.5px] font-light text-ink-mute">
            <span className="font-mono text-ink">{stats.itemCount}</span> item{stats.itemCount === 1 ? "" : "s"}
            {" · "}<span className="font-mono text-ink">{formatEuro(stats.monthlyTotalCents)}</span>/mo total
            {" · "}<span className="font-mono text-ink">{formatEuro(stats.toCancelMonthlyCents)}</span>/mo marked to cancel
            {/* A pending decision is one of the few things in this app that is
                literally waiting on Martin, so the count carries the amber. */}
            {" · "}<span className={stats.pendingDecisions > 0 ? "font-mono text-attn" : "font-mono text-ink"}>
              {stats.pendingDecisions}
            </span> decision{stats.pendingDecisions === 1 ? "" : "s"} pending
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-[10px]">
          <Link href="/registry/new" className={buttonClass("primary")}>+ Add</Link>
          <Link href="/registry/import" className={buttonClass("ghost")}>Import statement</Link>
          <Link href="/registry/export" className={buttonClass("ghost")}>Export report</Link>
        </div>
      </div>
      <Tabs
        active={tab}
        items={[
          { key: "items", label: "Subscriptions & contracts", href: "/registry?tab=items" },
          { key: "debts", label: "Debts", href: "/registry?tab=debts" },
        ]}
      />
      {tab === "items"
        ? <RegistryItemsList items={items} />
        : <RegistryDebtsList debts={debts} />}
    </div>
  );
}
