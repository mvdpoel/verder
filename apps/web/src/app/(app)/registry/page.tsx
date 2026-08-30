import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { formatEuro, RegistryDebtsList, RegistryItemsList } from "@/components/registry-list";
import { buttonClass, PageTitle, Tabs } from "@/components/ui";

export default async function RegistryPage({ searchParams }: {
  searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab: "items" | "debts" = tabParam === "debts" ? "debts" : "items";
  const caller = await serverCaller();
  // Only the open tab's list is fetched, and it goes out alongside the totals
  // rather than after them.
  // debts.list() carries its own eiser/intermediary/reported-to-Verder
  // projection, resolved server-side in one grouped query — no per-row fetch.
  const [stats, items, debts] = await Promise.all([
    caller.registry.stats(),
    tab === "items" ? caller.registry.items.list() : [],
    tab === "debts" ? caller.registry.debts.list() : [],
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <PageTitle>Register</PageTitle>
          <p className="text-[13.5px] font-light text-ink-mute">
            <span className="font-mono text-ink">{stats.itemCount}</span> {stats.itemCount === 1 ? "post" : "posten"}
            {" · "}<span className="font-mono text-ink">{formatEuro(stats.monthlyTotalCents)}</span>/mnd totaal
            {" · "}<span className="font-mono text-ink">{formatEuro(stats.toCancelMonthlyCents)}</span>/mnd op te zeggen
            {/* A pending decision is one of the few things in this app that is
                literally waiting on Martin, so the count carries the amber. */}
            {" · "}<span className={stats.pendingDecisions > 0 ? "font-mono text-attn" : "font-mono text-ink"}>
              {stats.pendingDecisions}
            </span> {stats.pendingDecisions === 1 ? "besluit" : "besluiten"} te nemen
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-[10px]">
          <Link href="/registry/new" className={buttonClass("primary")}>+ Post</Link>
          <Link href="/registry/import" className={buttonClass("ghost")}>Afschrift inlezen</Link>
          <Link href="/registry/export" className={buttonClass("ghost")}>Overzicht exporteren</Link>
        </div>
      </div>
      <Tabs
        active={tab}
        items={[
          { key: "items", label: "Abonnementen & contracten", href: "/registry?tab=items" },
          { key: "debts", label: "Vorderingen", href: "/registry?tab=debts" },
        ]}
      />
      {tab === "items"
        ? <RegistryItemsList items={items} />
        : <RegistryDebtsList debts={debts} />}
    </div>
  );
}
