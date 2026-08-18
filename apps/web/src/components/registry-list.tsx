import Link from "next/link";

// Presentational (server-safe) lists for the registry overview.
// Money is integer cents everywhere; formatting stays in integer math.

export type RegistryItemRow = {
  id: string;
  name: string;
  category: string;
  amountCents: number;
  billingCycle: string;
  paymentChannel: string;
  discoveredVia: string;
  effectiveStatus: string;
  monthlyCents: number;
};

export type RegistryDebtRow = {
  id: string;
  creditorName: string;
  claimedCents: number;
  effectiveStatus: string;
};

export const ITEM_STATUS_ORDER = [
  "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled",
] as const;

export const DEBT_STATUS_ORDER = [
  "identified", "acknowledged", "disputed", "in-settlement", "settled",
] as const;

const ITEM_STATUS_BADGE: Record<string, string> = {
  identified: "bg-slate-100 text-slate-700",
  mandatory: "bg-red-100 text-red-700",
  allowed: "bg-green-100 text-green-700",
  requested: "bg-amber-100 text-amber-700",
  "to-cancel": "bg-orange-100 text-orange-700",
  canceled: "bg-gray-100 text-gray-500 line-through",
};

const DEBT_STATUS_BADGE: Record<string, string> = {
  identified: "bg-slate-100 text-slate-700",
  acknowledged: "bg-blue-100 text-blue-700",
  disputed: "bg-red-100 text-red-700",
  "in-settlement": "bg-amber-100 text-amber-700",
  settled: "bg-green-100 text-green-700",
};

const ITEM_GROUP_LABEL: Record<string, string> = {
  identified: "Identified — waiting for a first decision",
  mandatory: "Mandatory — these have to stay",
  allowed: "Allowed — approved to keep",
  requested: "Requested — waiting for a verdict",
  "to-cancel": "To cancel — on the way out",
  canceled: "Canceled — done and dusted",
};

/** €-format integer cents without float arithmetic. */
export function formatEuro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function StatusBadge({ status, kind }: { status: string; kind: "item" | "debt" }) {
  const cls = (kind === "item" ? ITEM_STATUS_BADGE : DEBT_STATUS_BADGE)[status]
    ?? "bg-slate-100 text-slate-700";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

function SourceBadge({ source }: { source: string }) {
  return <span className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-500">via {source}</span>;
}

const EMPTY_STATE = "Nothing here yet — import a bank statement and let's find out together what's out there.";

export function RegistryItemsList({ items }: { items: RegistryItemRow[] }) {
  if (items.length === 0) return <p className="text-slate-600">{EMPTY_STATE}</p>;
  const groups = ITEM_STATUS_ORDER
    .map((status) => ({ status, rows: items.filter((i) => i.effectiveStatus === status) }))
    .filter((g) => g.rows.length > 0);
  return (
    <div className="space-y-6">
      {groups.map(({ status, rows }) => {
        const rollupCents = rows.reduce((sum, r) => sum + r.monthlyCents, 0);
        return (
          <section key={status}>
            <h2 className="mb-2 flex items-center gap-2 font-semibold">
              {ITEM_GROUP_LABEL[status] ?? status}
              <span className="text-sm font-normal text-slate-500">{formatEuro(rollupCents)}/mo</span>
            </h2>
            <ul className="space-y-2">
              {rows.map((item) => (
                <li key={item.id} className="rounded border bg-white p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Link href={`/registry/${item.id}`} className="font-medium hover:underline truncate">
                      {item.name}
                    </Link>
                    <StatusBadge status={item.effectiveStatus} kind="item" />
                    <SourceBadge source={item.discoveredVia} />
                  </div>
                  <span className="shrink-0 text-sm text-slate-500">
                    {item.category} · {formatEuro(item.amountCents)}/{item.billingCycle} · {formatEuro(item.monthlyCents)}/mo
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function RegistryDebtsList({ debts }: { debts: RegistryDebtRow[] }) {
  if (debts.length === 0) return <p className="text-slate-600">{EMPTY_STATE}</p>;
  const ordered = [...debts].sort((a, b) =>
    DEBT_STATUS_ORDER.indexOf(a.effectiveStatus as (typeof DEBT_STATUS_ORDER)[number])
    - DEBT_STATUS_ORDER.indexOf(b.effectiveStatus as (typeof DEBT_STATUS_ORDER)[number]));
  return (
    <ul className="space-y-2">
      {ordered.map((debt) => (
        <li key={debt.id} className="rounded border bg-white p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href={`/registry/debts/${debt.id}`} className="font-medium hover:underline truncate">
              {debt.creditorName}
            </Link>
            <StatusBadge status={debt.effectiveStatus} kind="debt" />
          </div>
          <span className="shrink-0 text-sm text-slate-500">claimed {formatEuro(debt.claimedCents)}</span>
        </li>
      ))}
    </ul>
  );
}
