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

export type DebtPartyRole = "eiser" | "incasso" | "deurwaarder" | "gemachtigde";

export type RegistryDebtPartyRow = {
  partyId: string;
  name: string;
  organization: string | null;
  role: DebtPartyRole;
  note: string | null;
};

export type RegistryDebtRow = {
  id: string;
  creditorName: string;
  claimedCents: number | null;
  effectiveStatus: string;
  // Who is chasing this debt (eiser) and who is acting for them
  // (incasso/deurwaarder/gemachtigde) — Task 2's debt_parties edge.
  parties: RegistryDebtPartyRow[];
  // Whether Martin has told Verder about this debt yet. null means not yet —
  // reported calmly, never as a warning: three creditors are already chasing
  // him and this screen's job is to state what is recorded, not to alarm.
  reportedToVerderAt: Date | null;
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

/**
 * €-format integer cents without float arithmetic. `null` means the notice
 * never stated an amount (the KvK aanmaning is the real example) — rendering
 * that as €0,00 would put a number in front of Martin that no creditor ever
 * claimed, so it renders as text instead.
 */
export function formatEuro(cents: number | null): string {
  if (cents === null) return "amount unknown";
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

export type DecisionRow = {
  id: string;
  status: string;
  explanation: string;
  createdAt: Date;
  documentId: string | null;
  blockerNote: string | null;
  overrideReason: string | null;
};

/** Read-only ledger-backed decision timeline, newest first. */
export function DecisionTimeline({ decisions, kind, docTitles }: {
  decisions: DecisionRow[];
  kind: "item" | "debt";
  docTitles: Map<string, string>;
}) {
  if (decisions.length === 0) {
    return <p className="text-sm text-slate-600">No decisions yet — that&apos;s fine, it starts as &quot;identified&quot;. The first call is yours to make below.</p>;
  }
  return (
    <ol className="space-y-3">
      {decisions.map((d) => (
        <li key={d.id} className="rounded border bg-white p-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={d.status} kind={kind} />
            <span className="text-xs text-slate-500">
              {new Date(d.createdAt).toLocaleString("nl-NL")}
            </span>
            {d.documentId && (
              <Link href={`/vault/${d.documentId}`} className="text-xs underline text-slate-600">
                {docTitles.get(d.documentId) ?? "document"}
              </Link>
            )}
          </div>
          <p className="mt-1 text-sm whitespace-pre-wrap">{d.explanation}</p>
          {d.blockerNote && (
            <p className="mt-1 text-xs text-amber-700">Blocker: {d.blockerNote}</p>
          )}
          {d.overrideReason && (
            <p className="mt-1 text-xs text-slate-500">Off the usual path — {d.overrideReason}</p>
          )}
        </li>
      ))}
    </ol>
  );
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
      {ordered.map((debt) => {
        const eiserNames = debt.parties.filter((p) => p.role === "eiser").map((p) => p.name);
        const intermediaries = debt.parties.filter((p) => p.role !== "eiser")
          .map((p) => `${p.role}: ${p.name}`);
        return (
          <li key={debt.id} className="rounded border bg-white p-3 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Link href={`/registry/debts/${debt.id}`} className="font-medium hover:underline truncate">
                  {debt.creditorName}
                </Link>
                <StatusBadge status={debt.effectiveStatus} kind="debt" />
              </div>
              <span className="shrink-0 text-sm text-slate-500">
                {debt.claimedCents === null ? "amount unknown" : `claimed ${formatEuro(debt.claimedCents)}`}
              </span>
            </div>
            {(eiserNames.length > 0 || intermediaries.length > 0 || !debt.reportedToVerderAt) && (
              <p className="text-xs text-slate-500">
                {eiserNames.length > 0 && <>eiser: {eiserNames.join(", ")}</>}
                {intermediaries.length > 0 && <>{eiserNames.length > 0 && " · "}{intermediaries.join(" · ")}</>}
                {!debt.reportedToVerderAt && <>{(eiserNames.length > 0 || intermediaries.length > 0) && " · "}not reported to Verder yet</>}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
